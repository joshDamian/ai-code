#!/usr/bin/env node
// The listener that makes a Start button in a browser possible.
//
// A page cannot spawn a process, so a Start button in the dashboard only exists if
// something is already listening on the port the page was loaded from. That is what
// this is: it holds the port while the server is down, answers with a page that says
// so, and hands the port over when it is asked to start the server.
//
// It is not a supervisor in the process-management sense. It runs no agents, opens no
// database, and imports nothing from src/server.mjs - importing that module binds the
// port, which is the one thing this process must not do while it is deciding whether
// to. What it owns is the port and the one child it starts.
//
// Run it by hand to watch it work:
//   PORT=4399 AI_CODE_ROOT=$(mktemp -d) node src/supervisor.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Where the code is. The installer's LaunchAgent passes the release directory as the
// first argument; without one, this file's own parent directory is it, which is what
// makes `node src/supervisor.mjs` work from a checkout.
const here = path.dirname(fileURLToPath(import.meta.url));
const installRoot = path.resolve(process.argv[2] || path.join(here, '..'));
const serverScript = path.join(installRoot, 'src', 'server.mjs');
const stoppedPage = path.join(installRoot, 'web', 'server-off.html');
// Where the server's own data lives, which is not where its code does. Passed to the
// child explicitly rather than inherited by accident from the working directory.
const root = process.env.AI_CODE_ROOT || installRoot;
const port = Number(process.env.PORT || 4317);
// The address is loopback always, whatever AI_CODE_HOST says elsewhere: everything
// this process serves is a local control surface, and the one thing a wider bind
// would buy is a stopped page - and a Start button - on the network.
const address = '127.0.0.1';

// Where the server's own output goes, which is the only place the reason a start
// failed is recorded: launchd's copy above captures this process, and the child it
// starts is detached with nothing else reading its stdout.
const logs = process.env.AI_CODE_LOG_DIR || path.join(os.homedir(), 'Library', 'Logs', 'ai-code');
const serverLog = path.join(logs, 'server.log');

// How often the port is reconsidered, and how long a start is waited on before the
// port is taken back. A start that hangs before binding is the case the timeout is
// for: the alternative is a port held by nobody.
const TICK_MS = Number(process.env.AI_CODE_SUPERVISOR_TICK_MS) || 1000;
const START_TIMEOUT_MS = 30000;

// So a client can tell this process from the dashboard, on every response. It is how
// the dashboard knows a 404 is "the server is down" rather than "no such route" - both
// arrive as a 404 from the same host and port.
const MARKER = 'x-ai-code-supervisor';

// Duplicated from src/server.mjs rather than imported. Importing that module would
// bind the port, and extracting the guard into a third module would be a file whose
// only reader is this one; the two lines are cheaper than either.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/;

function fromLocalhost(req) {
  if (!LOCAL_HOST.test(req.headers.host || '')) return false;
  const origin = req.headers.origin;
  // Absent for a client that is not a browser - curl, the test suite - which leaves
  // the Host check as the whole of the guard for it.
  if (!origin) return true;
  try {
    return LOCAL_HOST.test(new URL(origin).host);
  } catch {
    return false;
  }
}

const stamp = () => new Date().toISOString();
const log = (msg) => process.stdout.write(`[supervisor] ${stamp()} ${msg}\n`);

// `holding` - this process has the port and is serving the stopped page.
// `starting` - a child has been spawned and the port released to it; the port is
//              deliberately not bound from this state, because the moment between the
//              listener closing and the child binding is exactly when it is free.
// `passive`  - something else holds the port, this process or another. Either a
//              server, in which case there is nothing to do, or nothing at all, in
//              which case the next tick binds.
let state = 'passive';
let listener = null;
let child = null;
let startingAt = 0;

function send(res, status, type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  res.writeHead(status, { 'content-type': type, 'content-length': body.length });
  res.end(body);
}

const json = (res, x, status = 200) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(x));

// Every response this process makes carries the marker, and none of them is worth
// caching: the stopped page answers the same URL the dashboard does, so a cached copy
// is a page that says the server is down while it is up.
function handle(req, res) {
  res.setHeader(MARKER, '1');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('connection', 'close');

  let pathname = '';
  try {
    pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    return json(res, { error: 'bad request' }, 400);
  }

  if (pathname === '/api/supervisor/status') {
    return json(res, { state, port, pid: process.pid, installRoot, root });
  }

  if (pathname === '/api/supervisor/start') {
    if (req.method !== 'POST') return json(res, { error: 'not found' }, 404);
    // Loopback or nothing, the same narrowing the server's own stop route applies: a
    // page on the network must not be able to start a process on this machine, and a
    // page loaded from this machine may.
    if (!fromLocalhost(req)) return json(res, { error: 'The server can only be started from this machine.' }, 403);
    if (state !== 'holding') return json(res, { error: 'The server is already starting.' }, 409);
    start();
    return json(res, { starting: true, port }, 202);
  }

  // Anything else under /api is the dashboard's API, which is not here. A 404 rather
  // than a proxy: there is nothing to proxy to.
  if (/^\/api(\/|$)/.test(pathname)) return json(res, { error: 'The dashboard server is not running.' }, 404);

  if (pathname === '/' || pathname === '/index.html') {
    let page;
    try {
      page = fs.readFileSync(stoppedPage);
    } catch {
      return send(res, 500, 'text/plain; charset=utf-8', `The stopped page is missing from ${stoppedPage}\n`);
    }
    return send(res, 200, 'text/html; charset=utf-8', page);
  }

  return send(res, 404, 'text/plain; charset=utf-8', 'not found\n');
}

// Binding is the test. A listen that fails with EADDRINUSE is the answer "someone
// else's server has the port", which is the same question a connect probe asks and
// without the race between the probe and the bind.
function tryBind() {
  return new Promise((resolve) => {
    const s = http.createServer(handle);
    const failed = () => resolve(null);
    s.once('error', failed);
    s.listen(port, address, () => {
      s.removeListener('error', failed);
      s.on('error', (e) => log(`listener error: ${e.message}`));
      resolve(s);
    });
  });
}

// Whether a *server* is listening. Used while a start is in flight, where the question
// is not "can this process bind" but "has the child got there yet" - and this process's
// own listener answers the same host and port, so an answer is not enough. The marker
// is what separates the two, and reading our own 404 as a server that came up is how a
// supervisor holding the port talks itself into believing it is not.
function answering() {
  return new Promise((resolve) => {
    const req = http.get({ host: address, port, path: '/api/overview', timeout: 1000 }, (res) => {
      res.resume();
      resolve(!res.headers[MARKER]);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function closeListener() {
  if (!listener) return;
  const l = listener;
  listener = null;
  l.close(() => {});
  // `close` stops accepting but leaves established connections; a stopped page is one
  // request per connection, so the idle ones are the ones to drop.
  l.closeIdleConnections();
}

function start() {
  state = 'starting';
  startingAt = Date.now();
  log(`starting the server on :${port} (root ${root})`);
  try {
    fs.mkdirSync(logs, { recursive: true });
  } catch {
    // The child's stdio below is the only thing that needs it, and a log that cannot
    // be written is a reason to start without one rather than to not start.
  }
  let out = 'ignore';
  try {
    out = fs.openSync(serverLog, 'a');
  } catch {
    log(`could not open ${serverLog}; the server's own output is going nowhere`);
  }
  // The server generates and persists its own token, and reads one from the
  // environment first. A token inherited here would silently re-key an install whose
  // phone has already paired, so it is dropped rather than passed through.
  const env = { ...process.env, PORT: String(port), AI_CODE_ROOT: root };
  delete env.AI_CODE_TOKEN;
  child = spawn(process.execPath, [serverScript], { cwd: installRoot, detached: true, env, stdio: ['ignore', out, out] });
  // Detached and unref'd: this process is not the server's parent for lifetime
  // purposes, and a server that outlives a supervisor restart is the point. `exit`
  // still arrives - unref only stops the child from holding this process's loop open.
  child.unref();
  if (typeof out === 'number') fs.closeSync(out);
  // Only while this process is still waiting on the start. A server that is asked to
  // stop releases the port before it exits, and the tick in between has already taken
  // it back - demoting from there would leave this process holding a port it does not
  // believe it holds, and refusing every start request by that same belief.
  const gone = (why) => {
    log(why);
    child = null;
    if (state === 'starting') state = 'passive';
  };
  child.on('error', (e) => gone(`the server could not be spawned: ${e.message}`));
  child.on('exit', (code, signal) => gone(`the server exited (${signal || code})`));
  // After the response that asked for this, and after the requests already in flight.
  closeListener();
}

async function tick() {
  // A bound listener is this process holding the port, and that is the fact; `state` is
  // only a summary of it. Re-derived every tick rather than trusted, because the two
  // can be pulled apart by an event that arrives during an await, and the state a start
  // request is judged against is the one that must not be wrong.
  if (listener) {
    state = 'holding';
    return;
  }
  if (state === 'starting') {
    if (await answering()) {
      state = 'passive';
      log(`the server is up on :${port}`);
      return;
    }
    // A child that never binds - a bad root, a missing database, a crash loop - must
    // not leave the port held by nobody, so the timeout is the way back to holding.
    if (Date.now() - startingAt > START_TIMEOUT_MS) {
      log(`the server did not answer within ${START_TIMEOUT_MS}ms; holding the port again`);
      state = 'passive';
    }
    return;
  }
  // Passive. A server answering is the answer: nothing to bind.
  if (await answering()) return;
  // A start may have been asked for while that probe was in flight. Binding behind a
  // child that is already booting is what makes it die of EADDRINUSE.
  if (state !== 'passive') return;
  const bound = await tryBind();
  if (bound) {
    listener = bound;
    state = 'holding';
    log(`holding :${port}; serving the stopped page`);
  }
}

function bye(signal) {
  log(`exiting (${signal})`);
  // The child is detached, so nothing else would stop it - and a test that ends this
  // process would otherwise leave a real server running on the port it was told to
  // use, which is the failure the whole suite is written to avoid.
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
  if (listener) listener.close();
  process.exit(0);
}
process.on('SIGTERM', () => bye('SIGTERM'));
process.on('SIGINT', () => bye('SIGINT'));

log(`watching :${port} from ${installRoot}`);
tick();
// Not unref'd: in `passive` this interval is the only handle keeping the process
// alive, and a supervisor that exited while a server it did not start was running
// would not be there to take the port back when that server stopped.
setInterval(tick, TICK_MS);
