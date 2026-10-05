import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Service, permissionDecision } from './service.mjs';
import { Runner } from './runner.mjs';
import { TerminalSessions, TERMINAL_TARGETS, terminalTargets } from './terminal.mjs';

// The job kinds whose conversation writes a spec for the project.
const SPEC_KINDS = new Set(['intake', 'infer-spec']);

// What a conversation drafted, so the approval panel under it shows that and nothing
// else. Drafts belong to the project and carry the id of the conversation whose pass
// wrote them. Drafts written before that id existed are matched to the conversation
// whose answer was stored within 100ms of them, since both are written by the same call.
function chatDrafting(session, jobs, messages) {
  const drafts = svc.project(session.project_id).drafts || [];
  const answers = messages.filter((m) => m.role === 'assistant').map((m) => Date.parse(m.created_at));
  const draftIds = drafts
    .filter((d) =>
      d.chat_session_id
        ? d.chat_session_id === session.id
        : answers.some((t) => Math.abs(Date.parse(d.at) - t) <= 100)
    )
    .map((d) => d.id);
  return { specPass: jobs.some((j) => SPEC_KINDS.has(j.kind)), draftIds };
}

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
// When this process started, for the status route. Read from the process rather than
// recorded on the first request, because the question it answers is "how long has the
// dashboard been up", and a server that has been idle since it booted has been up the
// whole time.
const startedAt = Date.now();

// Where the server binds. Loopback by default, which is what this process has always
// meant to do and until now did not say - `listen(port)` binds every interface, so the
// dashboard was reachable from the LAN by accident. A reachable bind is opt-in and
// costs an explicitly named token.
const host = process.env.AI_CODE_HOST || '127.0.0.1';
// Where the installer put the supervisor LaunchAgent, so the status route can say which
// port a Start button will live on. Overridable for tests, which must not read the
// developer's real launch agent.
const supervisorPlist = process.env.AI_CODE_SUPERVISOR_PLIST || path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.ai-code.supervisor.plist');
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

// A new task, set going the way its engine goes. A pipeline is prepared, and a
// comparison's pipeline attempt is planned straight away so every attempt is under
// way at once; a lone pipeline task waits on its Plan button, as it always has. A
// session task gets its worktree and conversation, and its first turn is queued.
function startTask(t) {
  if (t.engine === 'session') {
    const { task, session } = svc.startSessionTask(t.id);
    runner.enqueue(session.id, 'session');
    return task;
  }
  const prepared = svc.prepare(t.id);
  if (t.attempt_group) runner.enqueue(t.id, 'plan');
  return prepared;
}

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

const routeTask = /^\/api\/tasks\/([^/]+)\/(plan|approve|execute|implement|test|review|repair|reject|replan|retry|refine|diff|port|cancel|close|show|activity|link|feedback|discuss|resolve|decisions)$/;
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

// A supervised session's progress, in the same frame shapes: `meta` once with the
// session and its runs, `event` per agent event of the turn in flight, `state` on
// every tick with the session, the run, whether it is still working, and the
// permission being asked right now.
//
// The permission is in the state frame rather than in one of its own because it is
// state: a reload, a second tab and a reconnect all have to arrive at the same
// answer to "what is this session blocked on", and the request id is what the
// client keys its panel on. The countdown is not sent as a remaining-seconds number
// - it is derived from the request's own deadline, so a page opened late shows the
// time actually left rather than the time the frame was written.
function sessionStream(req, res, id) {
  sse(res);
  let lastEvent = 0;
  let streamed = null;
  let seeded = false;
  let ticks = 0;
  // Whether this stream has ever seen a turn running. A session with nothing in
  // flight is the resting case, and ending there would have the browser reconnect
  // once a second for as long as the page is open - the same reason the chat stream
  // waits until it has seen a question being answered.
  let sawWorking = false;
  const timer = setInterval(() => {
    try {
      const session = svc.store.getSession(id);
      if (!session) {
        clearInterval(timer);
        res.write(`event: error\ndata: ${JSON.stringify({ error: 'Session not found' })}\n\n`);
        return res.end();
      }
      const runs = svc.store.listSessionRuns(id);
      // The run in flight, or the last one if nothing is. Read from the session row
      // rather than from this process's memory, so the events a reload sees are the
      // events the process driving the run is writing.
      const runId = session.pending_run_id || runs[runs.length - 1]?.id || null;
      if (!seeded) {
        seeded = true;
        // The transcript travels in the one frame that is sent once, and again after
        // a turn settles - which is why the client re-reads the session rather than
        // assembling the answer out of event frames. What it read before a reload is
        // what it reads after one.
        res.write(`event: meta\ndata: ${JSON.stringify({ session, runs, turns: svc.sessionTurns(id) })}\n\n`);
      }
      // Event ids are global, but a cursor is only meaningful within one run's
      // events: when the run being watched changes, the cursor starts over.
      if (runId !== streamed) {
        streamed = runId;
        lastEvent = 0;
      }
      for (const e of runId ? svc.store.listEvents(runId, lastEvent) : []) {
        lastEvent = Math.max(lastEvent, e.id);
        res.write(`event: event\ndata: ${JSON.stringify(e)}\n\n`);
      }
      const job = svc.store.listJobs(id)[0] || null;
      const queued = !!job && (job.state === 'queued' || job.state === 'running');
      const working = !!session.pending_run_id && (queued || svc.store.hasLiveLease(session.pending_run_id));
      if (working) sawWorking = true;
      res.write(
        `event: state\ndata: ${JSON.stringify({ session, runId, working, job, permission: svc.permissionFor(id) })}\n\n`
      );
      if ((sawWorking && !working) || ticks++ > STREAM_MAX_TICKS) {
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

// The permission response, held open until a person answers or the deadline passes.
//
// This is the far end of the round trip the whole feature rests on: the agent's MCP
// server POSTs here and blocks, and nothing else happens in that agent until this
// function writes something. Both ways out go through the Service, so both reach
// the same `permissionDecision` - the row is the record, and what the agent is told
// is read back out of it rather than out of whatever settled it. A release that
// raced an answer therefore reports the answer, not the race.
function holdPermission(req, res, request) {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const row = svc.store.getPermissionRequest(request.id) || { ...request, status: 'denied' };
    json(res, permissionDecision(row));
  };
  const ms = (Number(svc.policies.session?.permissionTimeoutMs) || 120) * 1000;
  // Unref'd, because a pending prompt must not be what keeps the process alive when
  // somebody closes the dashboard.
  const timer = setTimeout(() => {
    svc.timeoutPermission(request.id);
    finish();
  }, ms);
  timer.unref?.();
  svc.holdPermission(request.id, finish);
  // The asker hanging up is the asker being gone: the agent process was killed, or
  // its socket dropped. A request nobody is waiting on is denied rather than left
  // pending, so the dashboard does not show a live prompt for an agent that is not
  // there - and `answerPermission` refuses if a person answered in the same instant,
  // which is the case this must not overwrite.
  req.on('close', () => {
    if (settled) return;
    try {
      svc.answerPermission(request.id, 'deny');
    } catch {
      /* already settled by the person, which is the answer that stands */
    }
    // The row is written above, but writing it does not release the waiter: only
    // `resolvePermission` and `timeoutPermission` do. Without this the Service keeps
    // a closure over a response that has already been written, one per agent that
    // went away mid-prompt, for as long as the process lives.
    svc.resolvePermission(request.id);
    finish();
  });
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
  session: 'Session',
};

// What a finished run says, composed once. Same shape as the in-page notifier, plus the
// ids a push needs to open the right screen - a notification that cannot be tapped
// through to the thing it is about is a notification the user has to go hunting after.
function runEndPayload(run, task) {
  // A reviewer that stopped on a question did not fail and did not pass it: the task
  // is waiting for a person, and a notification that says "reviewer failed" sends
  // them looking for a fault rather than for the choice they have to make. Read from
  // the task rather than from the verdict, because the state is what the workflow
  // acted on and a verification that answered DECIDE lands here the same way.
  if (task?.state === 'AWAITING_DECISION') {
    return {
      title: 'Decision needed',
      body: `${task.title || 'A task'} — the review needs your choice before it can be repaired.`,
      runId: run.id,
      taskId: task.id,
    };
  }
  const succeeded = run.status === 'succeeded';
  const role = ROLE_LABEL[run.role] || run.role || 'Run';
  return {
    title: `${role} ${succeeded ? 'completed' : 'failed'}`,
    body: `${role}${task?.title ? `: ${task.title}` : ''} — ${succeeded ? 'succeeded' : run.error || 'failed'}`,
    runId: run.id,
    taskId: task?.id || null,
  };
}

// One notification - a run-end or a permission prompt - to every subscribed browser.
// Failures here are the push service's and are not the caller's problem.
// A 404 or a 410 is the one answer that means this subscription is dead for good (the
// app was removed, or the browser rotated the endpoint), so that row is dropped;
// anything else is left in place to fail again next time.
async function pushAll(payload) {
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
  pushAll(runEndPayload(run, task)).catch(() => {});
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
  for (const r of svc.store.listSessionRuns()) if (r.status !== 'running') announcedRuns.add(r.id);
  const timer = setInterval(() => {
    try {
      // The prompts whose asker is gone. A held request has its own timer for as
      // long as this process is the one holding it; the sweep is for the rows left
      // pending by a process that is not - a server restarted while an agent was
      // blocked, an agent killed mid-prompt. Without it the dashboard draws a live
      // countdown for a question nothing is waiting on, and the auto-deny the design
      // promises never arrives. It shares this tick rather than owning one because it
      // is the same question the loop below asks: what did the last process leave.
      svc.sweepPermissions();
      for (const r of svc.store.listRuns()) {
        if (r.status === 'running' || announcedRuns.has(r.id)) continue;
        announcedRuns.add(r.id);
        publishRunEnd(r, r.task_id ? svc.store.getTask(r.task_id) : null);
      }
      for (const r of svc.store.listSessionRuns()) {
        if (r.status === 'running' || announcedRuns.has(r.id)) continue;
        announcedRuns.add(r.id);
        // Session runs have no associated task
        publishRunEnd(r, null);
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

// The port the installed supervisor holds, or null when there is none to read. The
// dashboard is visited on whatever port this server bound, and the Start button only
// exists on a port something is holding while this process is down - so a disagreement
// between the two is a Start button on a port nobody visits, which is exactly what the
// status route reports it for. Read per request rather than once at startup: a reinstall
// while the server keeps running is the state this exists to surface, and the route is
// hit rarely enough that the read costs nothing.
//
// The Label check keeps a foreign or hand-replaced file from posing as ours, and a
// binary plist fails both patterns and reads as absent. That is acceptable - a file the
// installer did not write is not one worth shelling out to plutil to interpret.
function readSupervisorPort() {
  try {
    const text = fs.readFileSync(supervisorPlist, 'utf8');
    if (!/<key>Label<\/key>\s*<string>com\.ai-code\.supervisor<\/string>/.test(text)) return null;
    return Number(/<key>PORT<\/key>\s*<string>(\d+)<\/string>/.exec(text)?.[1]) || null;
  } catch {
    return null;
  }
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

    // What this process is, for the Settings card that offers to stop it. It sits
    // inside the token gate above like every other route, so nothing here is a way
    // around pairing - and the token itself is deliberately not one of the fields,
    // because a status endpoint that hands out the secret is a pairing screen with
    // no reason to exist.
    if (u.pathname === '/api/server/status') {
      const active = svc.store.activeJobs();
      return json(res, {
        pid: process.pid,
        // The bound port rather than the requested one: PORT=0 asks the kernel for a
        // free port, and the number the dashboard is reachable on is the one that
        // matters to whoever is reading this.
        port: server.address()?.port ?? null,
        host,
        root,
        // Where a Start button would appear once this process stops, which is not
        // necessarily where this process is: a supervisor configured for another port
        // is invisible from here until the day it matters. Null when no supervisor is
        // installed, which is the honest answer rather than a guess at 4317.
        supervisorPort: readSupervisorPort(),
        startedAt,
        uptimeMs: Date.now() - startedAt,
        jobs: {
          queued: active.filter((j) => j.state === 'queued').length,
          running: active.filter((j) => j.state === 'running').length,
        },
      });
    }

    // Stop the server from a browser. This is the Ctrl-C below, reached over HTTP,
    // and it is the only route in this file that ends the process.
    //
    // Loopback or nothing: a paired phone holding a valid token is refused, for the
    // same reason it is refused a terminal - reaching the API is not the same
    // permission as stopping the machine's dashboard. The token gate above has
    // already run, so this is the narrower check on top of it.
    //
    // Known and accepted: a server the TUI started in-process is this process, so
    // stopping it from a browser exits the TUI too. The alternative - a stop that
    // silently does nothing when the TUI owns the port - is worse.
    if (u.pathname === '/api/server/shutdown') {
      if (req.method !== 'POST') return json(res, { error: 'not found' }, 404);
      if (!fromLocalhost(req)) return json(res, { error: 'The server can only be stopped from this machine.' }, 403);
      // The response goes out before the shutdown does. `shutdown` closes the socket
      // and arms a force-exit timer, and a timer that fires while this response is
      // still in the socket buffer would turn a clean stop into a dropped request.
      json(res, { stopping: true }, 202);
      setImmediate(shutdown);
      return;
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
      // Several variants is a comparison: one task per variant, each started its
      // own way. One is an ordinary task on the engine it names.
      if (Array.isArray(b.variants) && b.variants.length > 1) {
        let made;
        try {
          made = svc.createAttempts(b.projectId, b.title, b.variants, { parentId: b.parentId, planFirst: !!b.planFirst });
        } catch (e) {
          return json(res, { error: e.message }, 400);
        }
        const tasks = made.tasks.map(startTask);
        return json(res, { group: made.group, tasks }, 201);
      }
      let t;
      try {
        t = svc.createTask(b.projectId, b.title, { parentId: b.parentId, engine: b.engine || 'pipeline', modelId: b.modelId || null, planFirst: !!b.planFirst });
      } catch (e) {
        return json(res, { error: e.message }, 400);
      }
      return json(res, startTask(t), 201);
    }

    // A comparison: its attempts measured side by side, and the person's pick.
    const attemptsMatch = u.pathname.match(/^\/api\/attempts\/([^/]+)(?:\/(pick))?$/);
    if (attemptsMatch) {
      const group = attemptsMatch[1];
      try {
        if (attemptsMatch[2] === 'pick' && req.method === 'POST') {
          const b = await body(req);
          return json(res, svc.pickAttempt(group, b.taskId));
        }
        if (req.method === 'GET') return json(res, svc.attempts(group));
      } catch (e) {
        return json(res, { error: e.message }, e.code === 'NOT_FOUND' ? 404 : 409);
      }
    }

    if (u.pathname === '/api/scoreboard' && req.method === 'GET') return json(res, svc.scoreboard());

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
        // The other attempts of its comparison, for the switcher in the header.
        const siblings = task.attempt_group
          ? svc.store.listAttempts(task.attempt_group).map((x) => ({ id: x.id, label: x.attempt_label, engine: x.engine, model_id: x.model_id, state: x.state, pick: x.pick }))
          : [];
        const changes = task.engine === 'session' ? svc.taskChangeStat(task) : null;
        return json(res, { task, runs: svc.store.listRuns(id), branches: svc.destinations(id), revision: svc.revision(task), live: svc.liveRun(id), ported: svc.ported(id), parent: task.parent_id ? svc.store.getTask(task.parent_id) || null : null, siblings, changes, terminal: { enabled: terminalEnabled, targets: terminalTargets(task, repoOf(task)) } });
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
      // The two halves of the decision gate. `discuss` answers a comment and leaves
      // the task where it is, so it is blocking in the small sense: one reviewer run
      // is what the caller is waiting for. `resolve` is blocking in feedback's sense -
      // the repair, its tests and the verification review all run before it answers.
      if (op === 'discuss') {
        const b = await body(req);
        const text = String(b.text || '').trim();
        if (!text) return json(res, { error: 'text is required' }, 400);
        return json(res, await svc.discussReview(id, text));
      }
      if (op === 'resolve') {
        const b = await body(req);
        const text = String(b.text || '').trim();
        // An absent option is a resolve by instruction alone, which is allowed. A
        // malformed one is refused here rather than read as NaN by the service, where
        // the error would name an option number nobody wrote.
        const raw = b.option;
        const option = raw === undefined || raw === null || raw === '' ? null : Number(raw);
        if (option !== null && !Number.isInteger(option)) return json(res, { error: 'option must be an integer index' }, 400);
        if (option === null && !text) return json(res, { error: 'option or text is required' }, 400);
        return json(res, await svc.resolveReview(id, { option, text }));
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
        const jobs = svc.store.listJobs(id);
        const messages = svc.store.listChatMessages(id);
        return json(res, { session, messages, job: jobs[0] || null, ...chatDrafting(session, jobs, messages) });
      }
    }

    // -------------------------------------------------------------------------
    // Supervised sessions.
    //
    // A session is an agent working in the project's own checkout on freeform
    // instructions, with every write and every command held at a permission prompt.
    // Two things about these routes are not like the rest of this file.
    //
    // The first is the permission routes. `POST .../permissions` is not a normal API
    // call and its client is not the dashboard: it is the MCP server inside the
    // agent's own process, and it blocks on this response for as long as a person
    // takes to answer. So the handler deliberately does not return - it registers a
    // release with the Service, arms the deadline, and answers when whichever of
    // them finishes first. Because of that it must never be reachable from anywhere
    // but this machine: it is a loopback-only route by its own check, not merely by
    // the token gate above, since a token on a phone would otherwise be a way to
    // have an agent ask itself a question and answer it.
    //
    // The second is that the answer routes take an action word and nothing else.
    // `allow` is the only word that grants; the Service reads everything else as a
    // denial, so a misspelled verb cannot become an approval.
    // Today's spend across sessions, for the list's footer. Its own path rather than
    // a field on the list, which is an array every other caller reads as one.
    if (u.pathname === '/api/session-spend' && req.method === 'GET') return json(res, svc.sessionsSpend());
    // Every prompt waiting on the machine, for the approval card the whole app shows.
    if (u.pathname === '/api/permissions' && req.method === 'GET') return json(res, svc.pendingPermissions());

    if (u.pathname === '/api/sessions') {
      if (req.method === 'GET') return json(res, svc.sessionSummaries(u.searchParams.get('projectId') || undefined));
      const b = await body(req);
      return json(res, svc.createSession(b.projectId, b.name, { providerId: b.providerId, modelId: b.modelId, ...(b.mode ? { mode: b.mode } : {}) }), 201);
    }

    // A turn's attached file, for the transcript to show: the session, the turn and
    // the file's name. Its own pattern, because it is the one session route with two
    // segments after the verb.
    // `outputs` is the same for what the agent shared back.
    const attachment = u.pathname.match(/^\/api\/sessions\/([^/]+)\/(attachments|outputs)\/([^/]+)\/([^/]+)$/);
    if (attachment && req.method === 'GET') {
      let file;
      try {
        file = svc.sessionAttachment(attachment[1], decodeURIComponent(attachment[3]), decodeURIComponent(attachment[4]), attachment[2] === 'outputs' ? 'out' : 'in');
      } catch (e) {
        return json(res, { error: e.message }, 404);
      }
      res.writeHead(200, {
        'content-type': file.type,
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
        // Shown inline only when it is an image, a video or audio; anything else
        // downloads, so an HTML or SVG file is never rendered on this origin.
        'content-disposition': `${/^(image\/(png|jpe?g|gif|webp)|video\/(mp4|webm)|audio\/(mpeg|wav|ogg|mp4))$/.test(file.type) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      });
      return fs.createReadStream(file.path).pipe(res);
    }

    const session = u.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(messages|stream|archive|cancel|resume|permissions|draft-task|drafts|nudge|outputs)(?:\/([^/]+))?)?$/);
    if (session) {
      const id = session[1];
      const what = session[2] || null;
      const rest = session[3] || null;

      if (what === 'stream') return sessionStream(req, res, id);

      // The MCP tool's question, held open until a person answers or the deadline
      // passes. See the block comment above: this is the one route in this file that
      // is expected to still be open minutes after the request arrived.
      if (what === 'permissions' && !rest && req.method === 'POST') {
        if (!fromLocalhost(req)) return json(res, { error: 'Permissions can only be asked from this machine.' }, 403);
        const b = await body(req);
        const request = svc.addPermissionRequest({
          sessionId: id,
          runId: b.run_id || null,
          tool: b.tool,
          input: b.input ?? null,
          cwd: b.cwd ?? null,
        });
        // A conversation on auto-allow answers its routine actions here, before
        // anything is pushed or held: the row is still written, so the history shows
        // what was approved and that nobody was asked.
        if (svc.autoAnswer(request.id)) return json(res, permissionDecision(svc.store.getPermissionRequest(request.id)));
        // A prompt is the one thing in a session that stops it until a person acts,
        // so it is pushed like a finished run: a phone in a pocket hears about it
        // before the countdown denies it.
        const owner = svc.store.getSession(id);
        pushAll({
          title: 'Approval needed',
          body: `${owner?.name || 'A conversation'} wants to run ${request.tool}.`,
          url: `/#/sessions/${id}`,
          tag: `permission-${request.id}`,
        }).catch(() => {});
        return holdPermission(req, res, request);
      }

      // What is being asked right now, which is what a page reads on load before its
      // stream has delivered a state frame.
      if (what === 'permissions' && req.method === 'GET') {
        return json(res, { permission: svc.pendingPermission(id), history: svc.store.listPermissionRequests(id) });
      }

      if (what === 'permissions' && rest && req.method === 'POST') {
        const b = await body(req);
        // A request that has already left `pending` is refused rather than rewritten:
        // the countdown this route exists beside is a real deadline, and an Allow
        // clicked a second after it fired would otherwise approve an action the agent
        // has already been told was denied.
        try {
          svc.answerPermission(rest, b.action);
        } catch (e) {
          const status = e?.code === 'NOT_FOUND' ? 404 : e?.code === 'CONFLICT' ? 409 : 400;
          return json(res, { error: e.message }, status);
        }
        // Released after the row is written, so the held response builds its answer
        // from the recorded decision rather than from this request's body.
        return json(res, { permission: svc.resolvePermission(rest) });
      }

      if (what === 'messages' && req.method === 'POST') {
        const b = await body(req);
        const text = String(b.message || '').trim();
        const attachments = Array.isArray(b.attachments) ? b.attachments : [];
        if (!text && !attachments.length) return json(res, { error: 'message is required' }, 400);
        // The same two checks the chat route makes, in the same order and for the
        // same reason: the set catches the run this process is driving, the job row
        // catches one another process queued, and both are read before the write.
        if (svc.sessionBusy.has(id) || svc.store.activeJobs().some((j) => j.task_id === id)) {
          return json(res, { error: 'This session is already working on an instruction' }, 409);
        }
        let asked;
        try {
          asked = svc.askSession(id, text, attachments);
        } catch (e) {
          return json(res, { error: e.message }, 400);
        }
        return json(res, { session: asked, job: runner.enqueue(id, 'session') }, 202);
      }

      if (what === 'archive' && req.method === 'POST') {
        try {
          return json(res, svc.archiveSession(id));
        } catch (e) {
          return json(res, { error: e.message }, 409);
        }
      }

      // Stop, not cancel. A session that is working gets its run cancelled; one that
      // is idle simply stops. Both are the same column, which is what makes the
      // button work whichever state the session is in when it is pressed.
      if ((what === 'cancel' || what === 'resume') && req.method === 'POST') {
        if (what === 'cancel') return json(res, svc.stopSession(id));
        return json(res, svc.resumeSession(id));
      }

      if (what === 'nudge' && req.method === 'POST') {
        return json(res, svc.dismissNudge(id));
      }

      // The session agent's `share_file` tool. Local only, like drafts below: the
      // caller is the MCP process beside the agent, and the path it names is a path
      // on this machine.
      if (what === 'outputs' && !rest && req.method === 'POST') {
        if (!fromLocalhost(req)) return json(res, { error: 'Files can only be shared from this machine.' }, 403);
        const b = await body(req);
        try {
          return json(res, { output: svc.shareFromSession(id, { path: b.path, caption: b.caption, cwd: b.cwd }) }, 201);
        } catch (e) {
          return json(res, { error: e.message }, 400);
        }
      }

      // The session agent's `draft_task` tool. Local only, for the reason the
      // permissions route is: the caller is the MCP process beside the agent.
      if (what === 'drafts' && req.method === 'POST') {
        if (!fromLocalhost(req)) return json(res, { error: 'Drafts can only be proposed from this machine.' }, 403);
        const b = await body(req);
        try {
          return json(res, svc.draftFromSession(id, { title: b.title, description: b.description }), 201);
        } catch (e) {
          return json(res, { error: e.message }, 400);
        }
      }

      if (what === 'draft-task' && req.method === 'POST') {
        let drafted;
        try {
          drafted = svc.draftSessionTask(id);
        } catch (e) {
          return json(res, { error: e.message }, 400);
        }
        // Queued, not awaited: this is a proposals pass, and a proposals pass is a
        // planner run. The job's `task_id` is the chat session the drafts will land
        // in, which is the same binding every other drafting pass uses.
        return json(res, { session: drafted.chatSession, job: runner.enqueue(drafted.chatSession.id, 'proposals') }, 202);
      }

      if (!what) {
        if (req.method === 'GET') {
          const s = svc.sessionById(id);
          return json(res, {
            session: s,
            runs: svc.store.listSessionRuns(id),
            turns: svc.sessionTurns(id),
            // The question being asked right now, resolved with its deadline, and
            // the ones already answered - the panel and its history in one read.
            permission: svc.permissionFor(id),
            history: svc.store.listPermissionRequests(id),
            nudge: svc.nudgeFor(id),
            budget: svc.sessionBudget(id),
            changes: svc.sessionChanges(id),
            job: svc.store.listJobs(id)[0] || null,
          });
        }
        if (req.method === 'PATCH') {
          const b = await body(req);
          if ('name' in b) svc.renameSession(id, b.name);
          // The mode first and on its own: it is the one change here that can be
          // refused, and a refusal says which conversation holds the checkout.
          if ('mode' in b) {
            try {
              svc.setSessionMode(id, b.mode);
            } catch (e) {
              return json(res, { error: e.message, holder: e.holder || null }, e.code === 'CONFLICT' ? 409 : 400);
            }
          }
          // Read back rather than returned from the write, so a rename and a model
          // change in one request produce one row from one read.
          const patch = {};
          if ('providerId' in b) patch.provider_id = b.providerId ?? null;
          if ('modelId' in b) patch.model_id = b.modelId ?? null;
          if (Object.keys(patch).length) svc.store.updateSession(id, patch);
          if ('autoAllow' in b) {
            try {
              svc.setSessionAutoAllow(id, !!b.autoAllow);
            } catch (e) {
              return json(res, { error: e.message }, 400);
            }
          }
          if (b.dismissNudge) svc.dismissNudge(id);
          return json(res, svc.sessionById(id));
        }
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

    if (u.pathname === '/api/routing/preview') return json(res, svc.routingPreview(u.searchParams.get('role'), u.searchParams.get('strategy')));

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
  // Where a supervised session's permission MCP server asks its questions. Set here
  // and not before, because the port is not known until the socket is bound - and
  // set to loopback explicitly rather than to `host`, because the agent runs on this
  // machine whatever address the dashboard was told to listen on. A session started
  // before this line has no endpoint, and `claudeArgs` refuses to start it at all
  // rather than running it ungated.
  svc.permissionEndpoint = `http://127.0.0.1:${bound}`;
  // The requested port is not always the bound port: PORT=0 asks the kernel for a free
  // one, and every agent run is handed PORT=0 (see AGENT_PORT in src/agents.mjs) so a
  // smoke-test server can never collide with the dashboard that spawned the agent. A log
  // that echoed the request back would print `localhost:0` and send the reader hunting.
  console.log(`AI Code Mission Control: http://localhost:${bound}`);
  console.log(`API token: ${token}`);
  if (loopbackBind) console.log(`Phone access: tailscale serve https / http://127.0.0.1:${bound}`);
});
