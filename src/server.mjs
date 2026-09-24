import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Service } from './service.mjs';
import { Runner } from './runner.mjs';

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
const port = Number(process.env.PORT || 4317);

const json = (res, x, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
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

const routeTask = /^\/api\/tasks\/([^/]+)\/(plan|approve|execute|implement|test|review|repair|reject|replan|retry|refine|diff|port|cancel|close|show|activity)$/;
// The one route that always queues rather than blocks. Matched before routeTask,
// whose pattern has no room for the extra path segment.
const routeBackground = /^\/api\/tasks\/([^/]+)\/execute\/background$/;
const routeRun = /^\/api\/runs\/([^/]+)\/events$/;

const sse = (res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
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
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);

    // Anything outside /api is the dashboard's static bundle.
    if (!/^\/api(\/|$)/.test(u.pathname)) {
      if (SHARED_MODULES[u.pathname]) {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'access-control-allow-origin': '*' });
        return res.end(fs.readFileSync(SHARED_MODULES[u.pathname]));
      }
      const staticPath = path.join(webDir, u.pathname === '/' ? 'index.html' : u.pathname);
      const ext = path.extname(staticPath);
      // The startsWith check keeps a traversal path from escaping the web root.
      if (ext && staticPath.startsWith(webDir) && fs.existsSync(staticPath)) {
        res.writeHead(200, { 'content-type': (mimeTypes[ext] || 'application/octet-stream') + '; charset=utf-8', 'access-control-allow-origin': '*' });
        return res.end(fs.readFileSync(staticPath));
      }
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
      return json(res, svc.initProject(b.name, b.path), 201);
    }

    if (u.pathname === '/api/tasks') {
      if (req.method === 'GET') {
        let tasks = svc.store.listTasks(u.searchParams.get('projectId'));
        const states = u.searchParams.get('state');
        if (states) tasks = tasks.filter((t) => states.split(',').includes(t.state));
        return json(res, tasks);
      }
      const b = await body(req);
      const t = svc.createTask(b.projectId, b.title);
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
        return json(res, { task, runs: svc.store.listRuns(id), branches: svc.destinations(id), revision: svc.revision(task), live: svc.liveRun(id), ported: svc.ported(id) });
      }
      if (op === 'refine') {
        const b = await body(req);
        return json(res, await svc.refine(id, b.feedback));
      }
      // Read-only, so its one option rides in the query string: the dashboard asks
      // this with a GET, unlike every other op here.
      if (op === 'diff') return json(res, svc.diff(id, { to: u.searchParams.get('to') || undefined }));
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
      return json(res, svc.createChatSession(b.projectId, b.title), 201);
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

    const mm = u.pathname.match(/^\/api\/models\/([^/]+)$/);
    if (mm && req.method === 'PATCH') return json(res, svc.updateModel(mm[1], await body(req)));

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

// The agents this process spawns are detached, so they lead their own process
// groups. Without this, Ctrl-C kills the server and leaves every agent it started
// running with nothing watching it and no way to stop it.
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  runner.shutdown();
  server.close();
  // The aborts are asynchronous. A stuck agent does not get to hold the terminal,
  // and the timer is unref'd so a clean exit does not wait on it.
  const t = setTimeout(() => process.exit(0), 5000);
  t.unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// The requested port is not always the bound port: PORT=0 asks the kernel for a free
// one, and every agent run is handed PORT=0 (see AGENT_PORT in src/agents.mjs) so a
// smoke-test server can never collide with the dashboard that spawned the agent. A log
// that echoed the request back would print `localhost:0` and send the reader hunting.
server.listen(port, () => console.log(`AI Code Mission Control: http://localhost:${server.address().port}`));
