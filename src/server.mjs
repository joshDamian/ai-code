import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Service } from './service.mjs';
import { Runner } from './runner.mjs';
import { TerminalSessions, TERMINAL_TARGETS, terminalTargets } from './terminal.mjs';

const root = process.env.AI_CODE_ROOT || process.cwd();
// One Service for the whole process. Every request shares it, so the in-process
// run registry (`svc.active`) is visible to the cancel route.
// The mock provider is how an install with no real provider still runs a task,
// and it is the only way to drive this server end to end without spawning a real
// agent. Off unless the environment asks for it, so no real install can route to
// it by accident.
const svc = new Service(root, { allowMock: process.env.AI_CODE_ALLOW_MOCK === '1' });
// The background queue, and the only thing in the system that runs work the
// request that asked for it is not waiting on. Sharing the process with the
// Service is what lets it count a provider's in-flight runs, whichever started them.
const runner = new Runner(svc);
svc.runner = runner;
// The interactive shells. In this process rather than in each connection, because a
// session outlives the socket that opened it (see src/terminal.mjs).
const terminals = new TerminalSessions({ reapMs: Number(process.env.AI_CODE_TERMINAL_REAP_MS) || undefined });
// A terminal is arbitrary command execution, so it is refused to every caller that did
// not arrive on loopback - a token is not enough for this one, which is what keeps a
// phone from opening a shell on the machine. The switch is here so an install that does
// not want the feature at all can say so without patching the code.
const terminalEnabled = !process.env.AI_CODE_DISABLE_TERMINAL;
const port = Number(process.env.PORT || 4317);

// Where the server binds. Loopback by default, which is what this process has always
// meant to do and until now did not say - `listen(port)` binds every interface, so the
// dashboard was reachable from the LAN by accident. A reachable bind is opt-in and
// costs an explicitly named token.
const host = process.env.AI_CODE_HOST || '127.0.0.1';
// An address `listen` accepts, so no brackets on the IPv6 form - the Host header's own
// regex, which does carry them, is separate and lives with the gate.
const loopbackHost = /^(localhost|127\.\d+\.\d+\.\d+|::1)$/;
const loopbackBind = loopbackHost.test(host);
// A bind that is not loopback is reachable by anything on the network, so it does not
// get to run on a token this process invented and printed to a log nobody is reading.
// Naming the token is the acknowledgement that the address is exposed. The loopback
// bind keeps the generated one, which is the path the phone actually takes: it reaches
// `tailscale serve`, which proxies to loopback from loopback.
if (!loopbackBind && !process.env.AI_CODE_TOKEN) {
  console.error(
    `AI_CODE_HOST=${host} is reachable off this machine, so AI_CODE_TOKEN must name the token explicitly.\n` +
      'Leave AI_CODE_HOST unset and reach this from another device with `tailscale serve`.'
  );
  process.exit(1);
}

// The token every non-loopback caller presents. `AI_CODE_TOKEN` for an install that
// manages its own secret; otherwise one is generated on first start and kept, so a
// phone that paired once stays paired across restarts. The loopback exemption below is
// what keeps the desktop dashboard, the TUI and the CLI working with no token at all.
const token =
  process.env.AI_CODE_TOKEN || svc.store.getSetting('api_token') || svc.store.setSetting('api_token', crypto.randomBytes(32).toString('base64url'));
// Compared as digests rather than as strings: the digest is what makes the two sides
// the same length whatever was presented, which is both why `timingSafeEqual` cannot
// throw here and why the token's own length does not leak into the timing.
const tokenDigest = crypto.createHash('sha256').update(token).digest();

// The browser's Origin header is the one that matters. CORS does not cover WebSocket
// upgrades, so a page served from anywhere can open a socket to localhost - and a
// token in a query string is not a substitute, since a WebSocket cannot set a header
// and a URL leaks into history. Neither is a reason to accept a shell: a browser tab
// the user is not looking at cannot start one if the origin is checked, and DNS
// rebinding cannot fake a Host of localhost into a same-origin connection.
//
// So this is the primitive for both consumers: the token gate above exempts a request
// that arrived this way, and the terminal route refuses everything that did not. Two
// different answers built on the same question, which is the point.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/;

function fromLocalhost(req) {
  if (!LOCAL_HOST.test(req.headers.host || '')) return false;
  const origin = req.headers.origin;
  // Absent for a client that is not a browser - curl, the test suite, the TUI - which
  // leaves the Host check as the whole of the guard for it.
  if (!origin) return true;
  try {
    return LOCAL_HOST.test(new URL(origin).host);
  } catch {
    return false;
  }
}

// A browser can set a header on `fetch` but not on `EventSource` or a WebSocket, so the
// query string is accepted too. The gate reads it on every route rather than only on the
// two that need it: it is the same secret either way, and a route list would be one more
// thing to keep in step with the router. This server writes no request log, so the URL
// is not recorded.
function presentedToken(req, u) {
  const header = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return header ? header[1].trim() : u.searchParams.get('token') || '';
}

function tokenMatches(presented) {
  if (!presented) return false;
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(presented).digest(), tokenDigest);
}

// The checkout a task belongs to. Not `root`, which is where this process was started
// and where the database lives: projects are registered with a path of their own, and
// a port reads and writes the project's repository. Anything that has to name the
// repo a task's branch lands on has to ask for it here.
const repoOf = (task) => svc.project(task.project_id).path;

// No `access-control-allow-origin`. The dashboard is same-origin, the TUI and the CLI
// are not browsers, and a wildcard on an API that starts agent runs - and, before the
// gate below, on one that did not even ask for a token - let any page the user happened
// to have open read this server. Nothing needs it; the phone arrives same-origin too,
// through `tailscale serve`.
const json = (res, x, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(x));
};

const body = (req) =>
  new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch (e) {
        reject(e);
      }
    });
  });

const routeTask = /^\/api\/tasks\/([^/]+)\/(plan|approve|execute|implement|test|review|repair|reject|replan|retry|refine|diff|port|cancel|close|show|activity|link|feedback|decisions)$/;
// The one route that always queues rather than blocks. Matched before routeTask,
// whose pattern has no room for the extra path segment.
const routeBackground = /^\/api\/tasks\/([^/]+)\/execute\/background$/;
const routeRun = /^\/api\/runs\/([^/]+)\/events$/;

const sse = (res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // The stream ends on its own: the tick cap closes it on a resting task, and the
  // browser reconnects. Without this the gap before it does is the browser's default
  // of about three seconds, during which the tab is showing a state nobody is
  // updating - and the reconnect replays from STREAM_TAIL, so nothing is missed.
  res.write('retry: 1000\n\n');
};

// The activity tab replays a bounded backlog on connect, not the whole journal.
const STREAM_TAIL = 500;
// Absolute cap on a stream's life. A task that never reaches a terminal state
// (a cancelled task reverts to APPROVED) would otherwise hold the connection open
// indefinitely.
const STREAM_MAX_TICKS = 360;

// The states in which work is happening or about to. A task in one of these is
// live even if no agent is running this instant - the test command runs in the
// gap between two runs and is still the task being worked on.
const WORKING_STATES = new Set(['PLANNING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'REPAIRING']);

// Server-sent events. Frame types: `meta` once on connect, `event` per new event,
// and `state` on every tick so the client always ends on the current state.
function taskStream(req, res, id) {
  sse(res);
  let last = 0;
  let seeded = false;
  let ticks = 0;
  // Whether this stream has ever seen the task move. A cancelled task reverts to
  // APPROVED, so "not working" alone cannot end the stream: a task that was
  // never working would end it on the first tick, and the Activity tab would
  // lose its live tail the moment someone opened it on a resting task.
  let sawLive = false;
  const timer = setInterval(() => {
    try {
      const task = svc.task(id);
      if (!seeded) {
        seeded = true;
        res.write(`event: meta\ndata: ${JSON.stringify({ tail: STREAM_TAIL, total: svc.store.countTaskEvents(id) })}\n\n`);
      }
      // The first tick sends the tail; after that, only what arrived since `last`.
      const events = seeded && !last ? svc.store.tailTaskEvents(id, STREAM_TAIL) : svc.store.listTaskEvents(id, last);
      for (const e of events) {
        last = Math.max(last, e.id);
        res.write(`event: event\ndata: ${JSON.stringify(e)}\n\n`);
      }
      // Asked once, and used for both the frame and the check below it, so the two
      // cannot come from queries milliseconds apart - a task whose run ended between
      // them would be sent as live in a frame that then terminates the stream.
      //
      // `live` is the run itself rather than a boolean, because the view needs to know
      // *what* is running: which role, since when, and from which provider it fell
      // back. Computing that client-side is what put a stale answer in the tab.
      const live = svc.liveRun(id);
      // Written before the termination check, so the last frame a client sees is
      // the terminal state rather than the one before it.
      res.write(`event: state\ndata: ${JSON.stringify({ task, live })}\n\n`);

      const busy = WORKING_STATES.has(task.state) || !!live;
      if (busy) sawLive = true;
      const done = ['COMPLETE', 'FAILED'].includes(task.state) || (!busy && sawLive);
      if (done || ticks++ > STREAM_MAX_TICKS) {
        clearInterval(timer);
        res.end();
      }
    } catch (e) {
      clearInterval(timer);
      res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
      res.end();
    }
  }, 500);
  req.on('close', () => clearInterval(timer));
}

// A chat turn's progress, in the frame shapes the task stream already uses:
// `meta` once on connect with the whole transcript, `message` per new chat
// message, `event` per agent event of the run answering the question, and `state`
// on every tick.
//
// The `event` frames are the run's own events, which is why a chat run is recorded
// at all: the reader watches the agent read the repository while it composes an
// answer, through the same formatters the activity tab uses. The events table is
// keyed on a run id, so this reads them by the id the question carries - which is
// the same id its row in `chat_runs` has.
function chatStream(req, res, id) {
  sse(res);
  let lastSeq = 0;
  let lastEvent = 0;
  let seeded = false;
  let ticks = 0;
  // Whether this stream has ever seen a question being answered. A session with
  // nothing in flight is the resting case, and ending there would have the browser
  // reconnect once a second for as long as the page is open - the same reason the
  // task stream waits until it has seen the task move.
  let sawAnswering = false;
  const timer = setInterval(() => {
    try {
      const session = svc.store.getChatSession(id);
      if (!session) {
        clearInterval(timer);
        res.write(`event: error\ndata: ${JSON.stringify({ error: 'Chat session not found' })}\n\n`);
        return res.end();
      }
      // The question still waiting for an answer, and so the run answering it. Read
      // from the message table rather than from this process's memory, so a reload,
      // a second dashboard and the process that started the run all name the same
      // run - and `event` frames are therefore the same events.
      const pending = svc.store.pendingChatMessage(id);
      const runId = pending?.run_id || null;
      const job = svc.store.listJobs(id)[0] || null;
      if (!seeded) {
        seeded = true;
        res.write(`event: meta\ndata: ${JSON.stringify({ session, messages: svc.store.listChatMessages(id) })}\n\n`);
      }
      // The first tick sends the transcript again, because the client's cursor
      // starts at zero and meta is the frame a reconnect gets. Both are cheap and
      // the client keys by message id, so a duplicate is not a duplicate row.
      for (const m of svc.store.listChatMessages(id, lastSeq)) {
        lastSeq = Math.max(lastSeq, m.seq);
        res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
      }
      for (const e of runId ? svc.store.listEvents(runId, lastEvent) : []) {
        lastEvent = Math.max(lastEvent, e.id);
        res.write(`event: event\ndata: ${JSON.stringify(e)}\n\n`);
      }
      // Answering is a run in flight, not a question without an answer: a question
      // whose run never started - routing failed, the server was restarted - is
      // waiting forever, and the job row is what says so.
      const queued = job && (job.state === 'queued' || job.state === 'running');
      const answering = !!runId && (!!queued || svc.store.hasLiveLease(runId));
      if (answering) sawAnswering = true;
      // Written before the termination check, so the last frame a client sees is
      // the settled state rather than the one before it.
      res.write(`event: state\ndata: ${JSON.stringify({ session, runId, answering, job })}\n\n`);
      // The answer landing is the end of the work this stream exists for. The tick
      // cap covers the resting session and the one whose run died with the process:
      // the client reads the job row out of the state frame and stops on a terminal
      // one, so neither has to hold the connection open.
      if ((sawAnswering && !answering) || ticks++ > STREAM_MAX_TICKS) {
        clearInterval(timer);
        res.end();
      }
    } catch (e) {
      clearInterval(timer);
      res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
      res.end();
    }
  }, 500);
  req.on('close', () => clearInterval(timer));
}

// ---------------------------------------------------------------------------
// Web Push
//
// The notification stream below only reaches a tab that is open, and a phone with the
// dashboard backgrounded is the case Web Push exists for. That means VAPID: one keypair
// per install, the private half kept in the database beside the token, the public half
// handed to the browser so it can subscribe with the push service.
//
// Loaded defensively rather than imported at the top, because everything else in this
// file - the token gate, the PWA shell, every route - has to keep working on a checkout
// where `npm install` has not been run since web-push was added. A missing optional
// dependency should cost push and nothing else.
let webpush = null;
let vapid = null;
try {
  webpush = (await import('web-push')).default;
  const stored = { publicKey: svc.store.getSetting('vapid_public'), privateKey: svc.store.getSetting('vapid_private') };
  const keys = stored.publicKey && stored.privateKey ? stored : webpush.generateVAPIDKeys();
  if (keys !== stored) {
    svc.store.setSetting('vapid_public', keys.publicKey);
    svc.store.setSetting('vapid_private', keys.privateKey);
  }
  // A push service wants a way to contact whoever is sending, and only ever uses it to
  // complain about traffic. There is no address to give it, so this is a placeholder
  // rather than a lie about a real mailbox.
  webpush.setVapidDetails('mailto:noreply@example.com', keys.publicKey, keys.privateKey);
  vapid = keys;
} catch {
  // Push is off. Every route below says so rather than throwing.
}

// The role labels, in the browser's own words. Duplicated from
// web/components/notify.mjs rather than shared: this composes a payload read on a lock
// screen, which is not the dashboard's DOM, and the two are allowed to differ.
const ROLE_LABEL = {
  planner: 'Planning',
  implementer: 'Implementation',
  reviewer: 'Review',
  repair: 'Repair',
  'context-enrich': 'Context enrichment',
  chat: 'Chat',
};

// What a finished run says, composed once. Same shape as the in-page notifier, plus the
// ids a push needs to open the right screen - a notification that cannot be tapped
// through to the thing it is about is a notification the user has to go hunting after.
function runEndPayload(run, task) {
  const succeeded = run.status === 'succeeded';
  const role = ROLE_LABEL[run.role] || run.role || 'Run';
  return {
    title: `${role} ${succeeded ? 'completed' : 'failed'}`,
    body: `${role}${task?.title ? `: ${task.title}` : ''} — ${succeeded ? 'succeeded' : run.error || 'failed'}`,
    runId: run.id,
    taskId: task?.id || null,
  };
}

// One run-end, to every subscribed browser. Failures here are the push service's and
// are not the caller's problem - the run is already over and its row already written.
// A 404 or a 410 is the one answer that means this subscription is dead for good (the
// app was removed, or the browser rotated the endpoint), so that row is dropped;
// anything else is left in place to fail again next time.
async function pushRunEnd(payload) {
  if (!vapid) return;
  const subs = svc.store.listPushSubscriptions();
  if (!subs.length) return;
  const payloadJson = JSON.stringify(payload);
  await Promise.allSettled(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payloadJson);
      } catch (e) {
        if (e?.statusCode === 404 || e?.statusCode === 410) svc.store.deletePushSubscription(s.endpoint);
      }
    })
  );
}

// Every attached notification stream, and the runs already announced. Module-level
// rather than per-connection: a completion has to fan out when no browser is attached
// at all - which is exactly the backgrounded-phone case, and a per-connection watcher
// would push zero times for it. It is also what keeps N open tabs from producing N
// pushes for one run.
const notifiers = new Set();
const announcedRuns = new Set();

function publishRunEnd(run, task) {
  const frame = `event: run-end\ndata: ${JSON.stringify({ run, task: task ? { id: task.id, title: task.title } : null })}\n\n`;
  for (const res of notifiers) {
    try {
      res.write(frame);
    } catch {
      // The socket is gone; its own close handler removes it.
    }
  }
  // Not awaited: the SSE frame is already out, and a push is minutes of network away
  // from mattering. A rejected promise here would be an unhandled rejection for a
  // notification nobody is waiting on.
  pushRunEnd(runEndPayload(run, task)).catch(() => {});
}

// Runs that have finished and not been announced. The seed is everything already
// finished in the store, so history stays quiet: a run that ended while the server was
// down is not news, and re-announcing every old run on startup is a lock screen full of
// notifications nobody can act on.
//
// A run still in flight at startup is deliberately left out of the seed, even though it
// is already in the store. Another process may be driving it - a foreground `ai-code
// task execute`, or the TUI starting this server mid-run - and its completion is exactly
// what this watcher exists to carry. Seeding it would mark it announced while it was
// still running, and the tick below skips a run it has already announced: no SSE frame,
// no push, silent. It is added to the set when a tick sees it leave 'running'.
//
// "Finished and not yet announced" rather than a 'running' -> other transition, because
// a run is written to the store already running and only ever leaves that status when
// it is done. A transition check has to see the run while it is still live, and a run
// that begins and ends inside one tick never is - which a mock does in a tenth of the
// interval, and a real agent can do on a retry that fails immediately.
function watchRuns() {
  for (const r of svc.store.listRuns()) if (r.status !== 'running') announcedRuns.add(r.id);
  const timer = setInterval(() => {
    try {
      for (const r of svc.store.listRuns()) {
        if (r.status === 'running' || announcedRuns.has(r.id)) continue;
        announcedRuns.add(r.id);
        publishRunEnd(r, r.task_id ? svc.store.getTask(r.task_id) : null);
      }
    } catch {
      // Store read failed; skip this tick.
    }
  }, 1000);
  // Never the reason the process stays alive. The listening socket is.
  timer.unref();
}
watchRuns();

// The per-connection half. The watcher above is global and already running; a stream
// only has to register itself as a destination and deregister when it goes away.
function notificationStream(req, res) {
  sse(res);
  notifiers.add(res);
  req.on('close', () => notifiers.delete(res));
}

const webDir = new URL('../web/', import.meta.url).pathname;
// The dashboard and the CLI share one set of formatters. The one file is
// published to the browser rather than copied into the web bundle, where it would
// drift. An allowlist rather than a mount of src/: nothing else in there is
// browser-safe, and a directory mount would publish all of it.
const SHARED_MODULES = { '/shared/format.mjs': new URL('../src/format.mjs', import.meta.url).pathname };
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  // The PWA manifest. Without the entry it is served as octet-stream, which Chrome
  // accepts and installability checks do not.
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);

    // Anything outside /api is the dashboard's static bundle.
    if (!/^\/api(\/|$)/.test(u.pathname)) {
      if (SHARED_MODULES[u.pathname]) {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        return res.end(fs.readFileSync(SHARED_MODULES[u.pathname]));
      }
      const staticPath = path.join(webDir, u.pathname === '/' ? 'index.html' : u.pathname);
      const ext = path.extname(staticPath);
      // The startsWith check keeps a traversal path from escaping the web root.
      if (ext && staticPath.startsWith(webDir) && fs.existsSync(staticPath)) {
        res.writeHead(200, { 'content-type': (mimeTypes[ext] || 'application/octet-stream') + '; charset=utf-8' });
        return res.end(fs.readFileSync(staticPath));
      }
    }

    // -------------------------------------------------------------------------
    // The token gate.
    //
    // Everything under /api needs a token unless it arrived on loopback. The static
    // branch above is deliberately outside it: the login screen, the manifest, the
    // service worker and the icons are exactly what a phone loads *before* it has a
    // token, so gating them would leave nothing to pair with.
    //
    // The exemption is the Host header, not the socket, and that is the whole reason
    // this works behind Tailscale: `tailscale serve` proxies to loopback from
    // loopback, so a socket check could not tell the phone apart from the desktop,
    // while the Host header it forwards still says the machine's own name. The
    // desktop browser sends `Host: localhost:4317` and the TUI and CLI send the same,
    // so all three stay tokenless with no change on their side.
    //
    // The posture has a caveat, and it is the same one the terminal guard documents
    // below: a non-browser client on the tailnet can set `Host: localhost` by hand and
    // inherit the exemption. For a single user's own tailnet that is the same trust
    // boundary the terminal already sits behind, and the alternative - requiring the
    // token on loopback too - would break the desktop dashboard, the TUI and the CLI
    // to defend against the tailnet the user already controls.
    if (!fromLocalhost(req) && !tokenMatches(presentedToken(req, u))) {
      return json(res, { error: 'unauthorized' }, 401);
    }

    if (u.pathname === '/api/notifications') {
      return notificationStream(req, res);
    }

    // Web Push. The key is public by construction - a browser cannot subscribe
    // without it - and these two writes are what a phone does once, while pairing.
    // Available with or without a token check above, which is the point: subscribing
    // is the one API call a freshly paired phone makes first.
    if (u.pathname === '/api/push/key') {
      if (!vapid) return json(res, { error: 'push is not available on this install' }, 503);
      return json(res, { key: vapid.publicKey });
    }
    if (u.pathname === '/api/push/subscribe') {
      if (!vapid) return json(res, { error: 'push is not available on this install' }, 503);
      const s = await body(req);
      if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) return json(res, { error: 'endpoint and keys are required' }, 400);
      svc.store.addPushSubscription({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } });
      return json(res, { ok: true, subscriptions: svc.store.listPushSubscriptions().length }, 201);
    }
    if (u.pathname === '/api/push/unsubscribe') {
      const s = await body(req);
      if (!s?.endpoint) return json(res, { error: 'endpoint is required' }, 400);
      return json(res, { ok: true, removed: svc.store.deletePushSubscription(s.endpoint) });
    }

    if (u.pathname === '/api/overview') {
      return json(res, {
        projects: svc.store.listProjects(),
        tasks: svc.store.listTasks(),
        runs: svc.store.listRuns(),
        providers: svc.store.listProviders(),
        models: svc.store.listModels(),
        automations: svc.store.listAutomations(),
        routing: svc.getRouting(),
        health: svc.providerHealthList(),
        // Only the ones still moving. A finished job is history, and the overview
        // is the view that answers "what is happening right now".
        jobs: svc.store.activeJobs(),
      });
    }

    if (u.pathname === '/api/projects') {
      if (req.method === 'GET') return json(res, svc.store.listProjects());
      const b = await body(req);
      // `create` is the intake's flag and not the dashboard form's: a person adding
      // a project they already have keeps the refusal that names the bad path.
      return json(res, svc.initProject(b.name, b.path, { create: !!b.create }), 201);
    }

    // Intake. A chat, not a task - so it is started and then queued like one, and
    // the client watches the drafting turn on the same conversation stream every
    // other chat uses. Nothing reaches the task list from here.
    if (u.pathname === '/api/intake') {
      const b = await body(req);
      const started = svc.startIntake(b.idea, { name: b.name });
      return json(res, { ...started, job: runner.enqueue(started.session.id, 'intake') }, 202);
    }

    // The spec: what the project is for, revisioned and gated like a plan. A POST is
    // the proposal of a change, which waits in `spec_draft` until one of the two
    // verbs below moves it.
    const sp = u.pathname.match(/^\/api\/projects\/([^/]+)\/spec(?:\/(approve|reject))?$/);
    if (sp) {
      const id = sp[1];
      if (!sp[2]) {
        if (req.method === 'GET') {
          const project = svc.project(id);
          return json(res, { spec: project.spec || null, draft: project.spec_draft || null, revision: svc.specRevision(project) });
        }
        const b = await body(req);
        return json(res, svc.proposeSpec(id, b.spec), 201);
      }
      const b = await body(req);
      // `path` only ever moves a project that came from an intake, and only on the
      // write that creates the repository - see approveSpec.
      return json(res, sp[2] === 'approve' ? svc.approveSpec(id, { path: b.path }) : svc.rejectSpec(id));
    }

    // The drafts waiting on a project, and the two things a person can do with one.
    // Approving is the whole of "this task should exist": it creates the task and
    // prepares it, so the draft lands in the normal plan -> approve -> execute flow.
    const dr = u.pathname.match(/^\/api\/projects\/([^/]+)\/drafts(?:\/([^/]+)\/approve)?$/);
    if (dr) {
      if (!dr[2]) return json(res, svc.drafts(dr[1]));
      return json(res, svc.approveDraft(dr[1], dr[2]), 201);
    }
    const dd = u.pathname.match(/^\/api\/projects\/([^/]+)\/drafts\/([^/]+)$/);
    if (dd && req.method === 'DELETE') return json(res, svc.dropDraft(dd[1], dd[2]));

    // Proposals on demand: a fresh batch drafted in a conversation of its own, so
    // the turn is watchable and the batch has a transcript explaining it.
    const pr = u.pathname.match(/^\/api\/projects\/([^/]+)\/proposals$/);
    if (pr) {
      const session = svc.askProposals(pr[1]);
      return json(res, { session, job: runner.enqueue(session.id, 'proposals') }, 202);
    }

    // Infer spec from codebase: read the real repository and draft a spec, so the
    // turn is watchable and the draft lands on the project page for approval.
    const is = u.pathname.match(/^\/api\/projects\/([^/]+)\/infer-spec$/);
    if (is) {
      const session = svc.askInferSpec(is[1]);
      return json(res, { session, job: runner.enqueue(session.id, 'infer-spec') }, 202);
    }

    const dc = u.pathname.match(/^\/api\/projects\/([^/]+)\/decisions$/);
    if (dc) return json(res, svc.store.listDecisions(dc[1], u.searchParams.get('state') || undefined));

    const dm = u.pathname.match(/^\/api\/decisions\/([^/]+)\/(approve|reject)$/);
    if (dm) return json(res, dm[2] === 'approve' ? svc.approveDecision(dm[1]) : svc.rejectDecision(dm[1]));

    // One project, with its spec revision, drafts and decision log on the same
    // payload: the project surface renders all four, and a second and third fetch
    // would render the drafts panel a round trip after the name above it.
    const pj = u.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (pj && req.method === 'GET') {
      const project = svc.project(pj[1]);
      return json(res, {
        ...project,
        revision: svc.specRevision(project),
        decisions: svc.store.listDecisions(project.id),
      });
    }

    if (u.pathname === '/api/tasks') {
      if (req.method === 'GET') {
        let tasks = svc.store.listTasks(u.searchParams.get('projectId'));
        const states = u.searchParams.get('state');
        if (states) tasks = tasks.filter((t) => states.split(',').includes(t.state));
        return json(res, tasks);
      }
      const b = await body(req);
      const t = svc.createTask(b.projectId, b.title, { parentId: b.parentId });
      return json(res, svc.prepare(t.id), 201);
    }

    // Queued work, answered with the job row. `enqueue` throws when the task
    // already has a job, which the error handler turns into a 400 that says so.
    const bg = u.pathname.match(routeBackground);
    if (bg) return json(res, runner.enqueue(bg[1], 'execute'), 202);

    // A PATCH on /plan is the plan editor, handled below, so it is excluded here.
    let m = u.pathname.match(routeTask);
    if (m && !(m[2] === 'plan' && req.method === 'PATCH')) {
      const id = m[1];
      const op = m[2];
      if (op === 'activity') {
        const limit = Math.min(Number(u.searchParams.get('limit') || 500) || 500, 2000);
        const before = Number(u.searchParams.get('before') || 0);
        return json(res, {
          task: svc.task(id),
          runs: svc.store.listRuns(id),
          events: before ? svc.store.pageTaskEvents(id, before, limit) : svc.store.tailTaskEvents(id, limit),
          total: svc.store.countTaskEvents(id),
        });
      }
      // The branch list rides on `show` rather than getting an endpoint of its own:
      // it is a fixed read of the repository, and the port form needs it on the same
      // render as the task it would port.
      if (op === 'show') {
        const task = svc.task(id);
        // `terminal` rides on the same payload for the same reason `branches` does: the
        // tab has to render its picker on the render that already names the task, and
        // whether the worktree directory is still there is a read of the filesystem
        // the client cannot do. It is answered by the same function the upgrade
        // handler below uses, so a target offered here is a target accepted there.
        // The parent row rides on the same payload for the reason `branches` does:
        // the header renders the parent's *title*, and a second fetch to turn the
        // id the task carries into that title would render the link as a uuid for
        // one round trip every time. Null when there is no link, and null when the
        // linked row has since been deleted, which the view reads as "no parent".
        return json(res, { task, runs: svc.store.listRuns(id), branches: svc.destinations(id), revision: svc.revision(task), live: svc.liveRun(id), ported: svc.ported(id), parent: task.parent_id ? svc.store.getTask(task.parent_id) || null : null, terminal: { enabled: terminalEnabled, targets: terminalTargets(task, repoOf(task)) } });
      }
      if (op === 'refine') {
        const b = await body(req);
        return json(res, await svc.refine(id, b.feedback));
      }
      // The link is set and cleared through the same route: `parentId` null or
      // absent is the clear, which is what makes an accidental reference removable.
      if (op === 'link') {
        const b = await body(req);
        return json(res, svc.linkTask(id, b.parentId ?? null));
      }
      // Blocking, like execute and for the same reason: the repair cycle it starts
      // is what the caller asked for, and the button that says so waits for it.
      if (op === 'feedback') {
        const b = await body(req);
        const text = String(b.text || '').trim();
        // Refused here as well as in the service, because a 400 with a reason is a
        // better answer to an empty box than a run that fails after the transition.
        if (!text) return json(res, { error: 'text is required' }, 400);
        return json(res, await svc.feedback(id, text));
      }
      // Read-only, so its one option rides in the query string: the dashboard asks
      // this with a GET, unlike every other op here.
      if (op === 'diff') return json(res, svc.diff(id, { to: u.searchParams.get('to') || undefined }));
      // Drafting the decision entries a completed task left behind. The review that
      // completes a task drafts these already; this is the retry for a pass that
      // failed, and it is what a task completed before the log existed is asked for.
      if (op === 'decisions') return json(res, await svc.draftDecisions(id), 201);
      // The one verb here that moves a ref. Its options come from the body, and
      // everything it declines to do it declines without writing anything.
      if (op === 'port') {
        const b = await body(req);
        return json(res, await svc.port(id, { to: b.to, dryRun: !!b.dryRun, clean: !!b.clean }));
      }
      // The three step routes run inline unless the caller asks for a job, which
      // is what keeps the dashboard's existing buttons on their blocking contract.
      // execute reads the body too: it reaches implement() through execute(), and
      // that is where an override of the dirty-baseline refusal is honoured.
      let opts = {};
      if (op === 'implement' || op === 'execute' || op === 'test' || op === 'retry' || (op === 'review' && req.method === 'POST')) {
        const b = await body(req);
        if (b.background) return json(res, runner.enqueue(id, op), 202);
        opts = { force: !!b.force };
      }
      const r =
        op === 'plan' ? await svc.plan(id)
        : op === 'approve' ? svc.approve(id)
        : op === 'execute' ? await svc.execute(id, opts)
        : op === 'implement' ? await svc.implement(id, opts)
        : op === 'test' ? await svc.runTests(id)
        : op === 'review' ? await svc.review(id)
        : op === 'repair' ? await svc.repair(id)
        : op === 'reject' ? svc.reject(id)
        : op === 'replan' ? svc.replan(id)
        : op === 'retry' ? await svc.retry(id)
        : op === 'cancel' ? svc.cancelTask(id)
        : op === 'close' ? svc.closeTask(id)
        : null;
      if (r === null) return json(res, { error: 'unknown operation' }, 400);
      return json(res, r);
    }

    const planMatch = u.pathname.match(/^\/api\/tasks\/([^/]+)\/plan$/);
    if (planMatch && req.method === 'PATCH') {
      const b = await body(req);
      // Two fields, one route, and each is written only when the body names it.
      // Testing for the key rather than the value is what keeps a request about
      // the planning model from also being an edit of the plan: `b.plan` on a body
      // that has no plan is `undefined`, which updatePlan would write as a wipe.
      let r;
      if ('plan_model' in b) r = svc.setPlanModel(planMatch[1], b.plan_model);
      if ('plan' in b) r = svc.updatePlan(planMatch[1], b.plan);
      return json(res, r ?? svc.task(planMatch[1]));
    }
    if (u.pathname.match(/^\/api\/tasks\/([^/]+)\/stream$/)) {
      return taskStream(req, res, u.pathname.split('/')[3]);
    }

    // Direct chat. A session is a conversation; a message is one turn of it.
    if (u.pathname === '/api/chat/sessions') {
      if (req.method === 'GET') return json(res, svc.store.listChatSessions(u.searchParams.get('projectId') || undefined));
      const b = await body(req);
      // `taskId` scopes the conversation to a task, which is how a question about a
      // finished one is asked with its plan and review in hand.
      return json(res, svc.createChatSession(b.projectId, b.title, b.taskId), 201);
    }

    const chat = u.pathname.match(/^\/api\/chat\/sessions\/([^/]+)(?:\/(messages|stream))?$/);
    if (chat) {
      const id = chat[1];
      if (chat[2] === 'stream') return chatStream(req, res, id);
      // The turn, queued rather than awaited, for the reason execute/background is
      // queued: an answer can take as long as a planner run, and a reply held open
      // that long is a request the browser gives up on long before it arrives.
      if (chat[2] === 'messages' && req.method === 'POST') {
        const b = await body(req);
        const text = String(b.message || '').trim();
        if (!text) return json(res, { error: 'message is required' }, 400);
        // Asked before the question is written, so a refusal leaves no trace. Two
        // checks because they cover different ground: the set catches the run this
        // process is driving, and the job row catches one another process queued.
        // Both are read synchronously before the write, so within this process the
        // answer cannot go stale between them.
        if (svc.chatBusy.has(id) || svc.store.activeJobs().some((j) => j.task_id === id)) {
          return json(res, { error: 'This chat is already answering a question' }, 409);
        }
        const message = svc.askChat(id, text);
        return json(res, { message, job: runner.enqueue(id, 'chat') }, 202);
      }
      if (!chat[2]) {
        const session = svc.chatSession(id);
        return json(res, { session, messages: svc.store.listChatMessages(id), job: svc.store.listJobs(id)[0] || null });
      }
    }

    if (u.pathname === '/api/providers') {
      if (req.method === 'GET') return json(res, { providers: svc.store.listProviders(), models: svc.store.listModels(), health: svc.providerHealthList() });
      const b = await body(req);
      return json(res, svc.addProvider(b), 201);
    }

    // The circuit-breaker state for one provider. `providerHealthList` is already
    // computed for the whole set, so there is no separate single-provider query.
    const ph = u.pathname.match(/^\/api\/providers\/([^/]+)\/health$/);
    if (ph) {
      const one = svc.providerHealthList().find((h) => h.providerId === ph[1]);
      if (!one) return json(res, { error: 'not found' }, 404);
      return json(res, one);
    }

    const pm = u.pathname.match(/^\/api\/providers\/([^/]+)$/);
    if (pm) {
      const id = pm[1];
      if (req.method === 'PATCH') return json(res, svc.updateProvider(id, await body(req)));
      if (req.method === 'DELETE') {
        // The seeded test provider is not something the user added, so refusing to
        // delete it keeps a routable fallback in place.
        if (svc.store.getProvider(id)?.kind === 'mock') return json(res, { error: 'Test provider cannot be deleted' }, 400);
        svc.store.updateProvider(id, { enabled: false });
        return json(res, svc.store.getProvider(id));
      }
    }

    const pt = u.pathname.match(/^\/api\/providers\/([^/]+)\/test$/);
    if (pt) {
      const b = await body(req);
      return json(res, await svc.testProvider(pt[1], b.modelId));
    }

    // The captured id is decoded because a model id can contain a slash: the client
    // percent-encodes it to keep it one segment, and `URL.pathname` hands the escape
    // back unchanged rather than decoding it, so the lookup would miss on `%2F`.
    const mm = u.pathname.match(/^\/api\/models\/([^/]+)$/);
    if (mm && req.method === 'PATCH') return json(res, svc.updateModel(decodeURIComponent(mm[1]), await body(req)));

    if (u.pathname === '/api/routing') {
      if (req.method === 'GET') return json(res, svc.getRouting());
      const b = await body(req);
      return json(res, svc.saveRouting(b));
    }

    if (u.pathname === '/api/jobs') return json(res, svc.store.listJobs(u.searchParams.get('taskId') || undefined));

    if (u.pathname === '/api/usage') return json(res, svc.usage(u.searchParams.get('period') || '7d'));
    if (u.pathname === '/api/runs') return json(res, svc.store.listRuns(u.searchParams.get('taskId')));
    if (u.pathname.match(routeRun)) return json(res, svc.store.listEvents(u.pathname.split('/')[3], Number(u.searchParams.get('after') || 0)));

    if (u.pathname === '/api/doctor') return json(res, await svc.doctor());

    if (u.pathname === '/api/automations') {
      if (req.method === 'GET') return json(res, svc.store.listAutomations());
      const b = await body(req);
      return json(res, svc.store.addAutomation({ id: svc.store.id(), name: b.name, trigger: b.trigger, action: b.action, enabled: b.enabled !== false, createdAt: new Date().toISOString() }), 201);
    }

    const am = u.pathname.match(/^\/api\/automations\/([^/]+)$/);
    if (am && req.method === 'PATCH') return json(res, svc.store.updateAutomation(am[1], await body(req)));

    if (u.pathname.startsWith('/api/webhooks/')) {
      const trigger = u.pathname.split('/').pop();
      const b = await body(req);
      const matches = svc.store.listAutomations().filter((a) => a.enabled && a.trigger === trigger);
      const created = [];
      for (const a of matches) {
        if (b.projectId && b.title) created.push(svc.prepare(svc.createTask(b.projectId, b.title).id));
      }
      return json(res, { trigger, matched: matches.length, created });
    }

    return json(res, { error: 'not found' }, 404);
  } catch (e) {
    // Every route reports its own failure the same way, so the UIs need one path.
    return json(res, { error: e.message, stack: process.env.NODE_ENV === 'development' ? e.stack : undefined }, 400);
  }
});

// The interactive terminal. A WebSocket rather than a route, because the traffic is
// bidirectional and long-lived: keystrokes one way, PTY output the other, and the
// existing streams are server-sent events, which have no way back.
//
// `noServer` rather than a second `listen`: one process, one port, one shutdown path.
// A second listener would need its own origin policy and its own place in the signal
// handlers, and there is nothing here that wants a different port from the dashboard.
const routeTerminal = /^\/api\/tasks\/([^/]+)\/terminal$/;
const wss = new WebSocketServer({ noServer: true });

// So this route narrows relative to the rest of the server rather than inheriting the
// posture: localhost or nothing, and only when the terminal is enabled at all. A phone
// that has paired and holds a valid token still gets a 403 here - reaching the API is
// not the same permission as opening a shell on the machine, and the phone is exactly
// the client that must not have the second one. `fromLocalhost` and the reasoning
// behind it are at the top of this file, next to the token gate that shares them.

// A refusal is an HTTP response rather than a WebSocket close: the handshake has not
// happened, so there is no frame to close with. The reason goes in the body because a
// browser cannot read it either way, and `curl -i` against the same URL is how anyone
// finds out why their terminal will not open.
function refuseUpgrade(socket, status, why) {
  const text = `${why}\n`;
  socket.write(
    `HTTP/1.1 ${status}\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\ncontent-length: ${Buffer.byteLength(text)}\r\n\r\n${text}`,
  );
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  let u;
  try {
    u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return socket.destroy();
  }
  const m = u.pathname.match(routeTerminal);
  // Anything else - another upgrade path, a probe - is not this server's to answer.
  if (!m) return socket.destroy();

  if (!terminalEnabled) return refuseUpgrade(socket, '403 Forbidden', 'The terminal is disabled (AI_CODE_DISABLE_TERMINAL is set).');
  if (!fromLocalhost(req)) return refuseUpgrade(socket, '403 Forbidden', 'The terminal is only available from localhost.');

  const target = u.searchParams.get('target');
  if (!TERMINAL_TARGETS.includes(target)) return refuseUpgrade(socket, '400 Bad Request', `target must be one of: ${TERMINAL_TARGETS.join(', ')}`);

  // The task and the checkout it belongs to. The project is read under the same catch
  // as the task: a task whose project cannot be resolved has nowhere to open a shell,
  // which is the same answer as a task that is not there.
  let task;
  let repo;
  try {
    task = svc.task(m[1]);
    repo = repoOf(task);
  } catch {
    return refuseUpgrade(socket, '404 Not Found', 'No such task.');
  }
  const spec = terminalTargets(task, repo).find((t) => t.id === target);
  if (!spec.available) return refuseUpgrade(socket, '409 Conflict', spec.reason);

  wss.handleUpgrade(req, socket, head, (ws) => {
    let session;
    try {
      // 80x24 until the client measures its own box, which it does on open and sends
      // as soon as it has. The gap is under a frame.
      session = terminals.open({ taskId: task.id, target, cwd: spec.dir });
    } catch (e) {
      // 1011 is "the server could not do it" - here, no free session slot. Truncated
      // because a close reason is capped at 123 bytes.
      return ws.close(1011, String(e.message).slice(0, 120));
    }
    terminals.attach(session, ws);
  });
});

// The agents this process spawns are detached, so they lead their own process
// groups. Without this, Ctrl-C kills the server and leaves every agent it started
// running with nothing watching it and no way to stop it.
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  runner.shutdown();
  // The shells are children of this process in the ordinary way, but they are also
  // holding sessions a reconnecting tab would come back to; killing them is what
  // makes "the server is gone" true for the terminal too.
  terminals.killAll();
  server.close();
  // The aborts are asynchronous. A stuck agent does not get to hold the terminal,
  // and the timer is unref'd so a clean exit does not wait on it.
  const t = setTimeout(() => process.exit(0), 5000);
  t.unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// `host` rather than every interface. The default is loopback, and the one exception
// that is worth reaching from elsewhere - a phone - goes through `tailscale serve`,
// which proxies to loopback and terminates TLS in front of it. The address is printed
// as a bare `localhost` regardless of the bind, because that is the URL that works for
// every client on this machine whichever address the socket is actually on.
//
// The token goes on the second line, and every start rather than only the first: it is
// what pairs a phone, and a secret shown once and then lost is a secret the user has to
// go digging in the database for. Nothing parses these lines but a person - except the
// port test, which reads the first one, and that one is unchanged.
server.listen(port, host, () => {
  const bound = server.address().port;
  // The requested port is not always the bound port: PORT=0 asks the kernel for a free
  // one, and every agent run is handed PORT=0 (see AGENT_PORT in src/agents.mjs) so a
  // smoke-test server can never collide with the dashboard that spawned the agent. A log
  // that echoed the request back would print `localhost:0` and send the reader hunting.
  console.log(`AI Code Mission Control: http://localhost:${bound}`);
  console.log(`API token: ${token}`);
  if (loopbackBind) console.log(`Phone access: tailscale serve https / http://127.0.0.1:${bound}`);
});
