// @ts-check
// The client's view of the server: JSON calls, and one WebSocket that keeps a shared
// store current. Views read the store with useStore() and call `api` to change things;
// what changed comes back down the socket, so a write is never applied twice.
import { useEffect, useState, useRef, recall, remember } from './lib.mjs';
import { showToast } from './components/toast.mjs';

/** @typedef {import('../src/contract.d.mts').Project} Project */
/** @typedef {import('../src/contract.d.mts').Task} Task */
/** @typedef {import('../src/contract.d.mts').Session} Session */
/** @typedef {import('../src/contract.d.mts').Approval} Approval */
/** @typedef {import('../src/contract.d.mts').SessionEvent} SessionEvent */
/** @typedef {import('../src/contract.d.mts').ServerMessage} ServerMessage */

/** @param {string} path @param {{method?:string, body?:unknown}} [o] */
async function request(path, o = {}) {
  /** @type {RequestInit} */
  const init = { method: o.method || 'GET', credentials: 'same-origin', headers: {} };
  if (o.body !== undefined) {
    init.body = JSON.stringify(o.body);
    init.headers = { 'content-type': 'application/json' };
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw new Error(`Network error: ${/** @type {Error} */ (e).message}`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (res.status === 401) set({ unauthorized: true });
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

const get = (/** @type {string} */ p) => request(p);
const post = (/** @type {string} */ p, /** @type {unknown} */ body = {}) => request(p, { method: 'POST', body });
const patch = (/** @type {string} */ p, /** @type {unknown} */ body) => request(p, { method: 'PATCH', body });
const del = (/** @type {string} */ p) => request(p, { method: 'DELETE' });
const enc = encodeURIComponent;

// -- the outbox ----------------------------------------------------------------------------
//
// A message typed on a phone that has lost the line - a lift, a tunnel, a sleeping
// laptop - is not worth an error. It is kept here, in this browser, and sent the moment
// the socket comes back; the composer clears as though it had gone, because from the
// person's side it has. Kept out of the message list itself: it is not the server's, and
// nothing that did not reach the server should be shown as the session's history.

const OUTBOX_KEY = 'bench:outbox';
/** @type {{key:string, sessionId:string, text:string, images:any[], uploads:any[], at:number}[]} */
let outbox = recall(OUTBOX_KEY, []);
/** @param {string} [sessionId] how many are queued for one session, or all of them */
export const outboxCount = (sessionId) => (sessionId ? outbox.filter((m) => m.sessionId === sessionId).length : outbox.length);

/** @param {string} sessionId @param {string} text @param {any[]} images @param {any[]} uploads */
function queue(sessionId, text, images, uploads) {
  outbox = [...outbox, { key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), sessionId, text, images, uploads }];
  remember(OUTBOX_KEY, outbox);
  window.dispatchEvent(new Event('bench:outbox'));
}

/** True for the failure that means "no line", as opposed to the server's "no". @param {any} e */
const offline = (e) => /^Network error/.test(/** @type {Error} */ (e)?.message || '');

/**
 * Sends a message, or keeps it if the line is down. Resolves to the server's answer, or
 * to `{queued: true}` when it was kept, so a caller can say so without treating it as a
 * failure. A refusal that is not the network (a session deleted on another device) is
 * raised as usual: it will not succeed later either.
 * @param {string} sessionId @param {string} text
 * @param {{media_type:string, data:string}[]} [images] @param {{file:string, type?:string}[]} [uploads]
 */
async function sendMessage(sessionId, text, images = [], uploads = []) {
  try {
    return await post(`/api/sessions/${enc(sessionId)}/messages`, { text, images, uploads });
  } catch (e) {
    if (!offline(e)) throw e;
    queue(sessionId, text, images, uploads);
    return { queued: true };
  }
}

let flushing = false;
/** Sends everything queued, oldest first, and stops at the first sign the line is still down. */
export async function flushOutbox() {
  if (flushing || !outbox.length) return;
  flushing = true;
  let sent = 0;
  try {
    for (const m of [...outbox]) {
      try {
        await post(`/api/sessions/${enc(m.sessionId)}/messages`, { text: m.text, images: m.images, uploads: m.uploads });
      } catch (e) {
        if (offline(e)) return; // still no line: keep the rest for the next try
        // The server refused it - the session is gone, most likely - and it will refuse
        // it again, so it is dropped rather than retried at every reconnect.
      }
      outbox = outbox.filter((x) => x.key !== m.key);
      remember(OUTBOX_KEY, outbox);
      sent++;
    }
  } finally {
    flushing = false;
    if (sent) {
      window.dispatchEvent(new Event('bench:outbox'));
      showToast(`Sent ${sent} queued message${sent === 1 ? '' : 's'}`, 'success');
    }
  }
}

export const api = {
  state: () => get('/api/state'),
  addProject: (/** @type {{path:string, name?:string, init?:boolean}} */ b) => post('/api/projects', b),
  cloneProject: (/** @type {{repo:string, dir?:string, name?:string}} */ b) => post('/api/projects/clone', b),
  createProject: (/** @type {{name:string, dir?:string}} */ b) => post('/api/projects/create', b),
  githubRepos: () => get('/api/github/repos'),
  mkdir: (/** @type {string} */ parent, /** @type {string} */ name) => post('/api/fs/mkdir', { parent, name }),
  renameProject: (/** @type {string} */ id, /** @type {string} */ name) => patch(`/api/projects/${id}`, { name }),
  setProjectCheck: (/** @type {string} */ id, /** @type {string} */ check) => patch(`/api/projects/${id}`, { check_command: check }),
  removeProject: (/** @type {string} */ id) => del(`/api/projects/${id}`),
  git: (/** @type {string} */ id) => get(`/api/projects/${id}/git`),
  checkoutDiff: (/** @type {string} */ id) => get(`/api/projects/${id}/diff`),
  fetch: (/** @type {string} */ id) => post(`/api/projects/${id}/fetch`),
  pull: (/** @type {string} */ id) => post(`/api/projects/${id}/pull`),
  push: (/** @type {string} */ id) => post(`/api/projects/${id}/push`),
  checkout: (/** @type {string} */ id, /** @type {{branch:string, create?:boolean, from?:string, stash?:boolean}} */ b) => post(`/api/projects/${id}/checkout`, b),
  commit: (/** @type {string} */ id, /** @type {string} */ message) => post(`/api/projects/${id}/commit`, { message }),
  browse: (/** @type {string|undefined} */ path) => get(`/api/fs${path ? `?path=${enc(path)}` : ''}`),

  createTask: (/** @type {any} */ b) => post('/api/tasks', b),
  task: (/** @type {string} */ id) => get(`/api/tasks/${id}`),
  renameTask: (/** @type {string} */ id, /** @type {string} */ title) => patch(`/api/tasks/${id}`, { title }),
  setTaskBar: (/** @type {string} */ id, /** @type {{done?:string|null, check?:string|null}} */ b) => patch(`/api/tasks/${id}`, b),
  checkTask: (/** @type {string} */ id) => post(`/api/tasks/${id}/check`),
  taskGit: (/** @type {string} */ id) => get(`/api/tasks/${id}/git`),
  taskDiff: (/** @type {string} */ id) => get(`/api/tasks/${id}/diff`),
  commitTask: (/** @type {string} */ id, /** @type {string} */ message) => post(`/api/tasks/${id}/commit`, { message }),
  updateTask: (/** @type {string} */ id) => post(`/api/tasks/${id}/update`),
  abortMerge: (/** @type {string} */ id) => post(`/api/tasks/${id}/abort-merge`),
  mergeTask: (/** @type {string} */ id, /** @type {{strategy?:string, message?:string, cleanup?:boolean}} */ b) => post(`/api/tasks/${id}/merge`, b),
  pushTask: (/** @type {string} */ id) => post(`/api/tasks/${id}/push`),
  pullRequest: (/** @type {string} */ id, /** @type {{title?:string, body?:string}} */ b) => post(`/api/tasks/${id}/pr`, b),
  closeTask: (/** @type {string} */ id, /** @type {{deleteBranch?:boolean}} */ b) => post(`/api/tasks/${id}/close`, b),
  reopenTask: (/** @type {string} */ id) => post(`/api/tasks/${id}/reopen`),

  createSession: (/** @type {any} */ b) => post('/api/sessions', b),
  session: (/** @type {string} */ id) => get(`/api/sessions/${id}`),
  sessionCommands: (/** @type {string} */ id) => get(`/api/sessions/${id}/commands`),
  events: (/** @type {string} */ id, /** @type {number} */ before) => get(`/api/sessions/${id}/events?before=${before}`),
  send: sendMessage,
  upload,
  fileStat: (/** @type {string} */ id, /** @type {string[]} */ paths) => post(`/api/sessions/${enc(id)}/files/stat`, { paths }),
  interrupt: (/** @type {string} */ id) => post(`/api/sessions/${id}/interrupt`),
  updateSession: (/** @type {string} */ id, /** @type {any} */ b) => patch(`/api/sessions/${id}`, b),
  archiveSession: (/** @type {string} */ id, archived = true) => post(`/api/sessions/${id}/archive`, { archived }),
  deleteSession: (/** @type {string} */ id) => del(`/api/sessions/${id}`),
  answer: (/** @type {string} */ id, /** @type {import('../src/contract.d.mts').ApprovalAnswer} */ a) => post(`/api/approvals/${id}`, a),

  providers: () => get('/api/providers'),
  updateProvider: (/** @type {string} */ id, /** @type {any} */ b) => patch(`/api/providers/${id}`, b),
  updateModel: (/** @type {string} */ id, /** @type {any} */ b) => patch(`/api/models/${enc(id)}`, b),
  testProvider: (/** @type {string} */ id, /** @type {string|null} */ modelId) => post(`/api/providers/${id}/test`, { modelId }),
  setDefaults: (/** @type {any} */ b) => request('/api/defaults', { method: 'PUT', body: b }),
  usage: () => get('/api/usage'),
  doctor: () => get('/api/doctor'),
  devices: () => get('/api/devices'),
  revokeDevice: (/** @type {string} */ id) => del(`/api/devices/${id}`),
  pairing: () => post('/api/pairing'),
  pair: (/** @type {string} */ code, /** @type {string} */ name) => post('/api/pair', { code, name }),
  pushKey: () => get('/api/push/key'),
  pushSubscribe: (/** @type {any} */ sub) => post('/api/push/subscribe', sub),
  pushUnsubscribe: (/** @type {string} */ endpoint) => post('/api/push/unsubscribe', { endpoint }),
  pushChoices: (/** @type {string} */ endpoint, /** @type {any} */ choices) => post('/api/push/choices', { endpoint, choices }),
  status: () => get('/api/server/status'),
  restart: () => post('/api/server/restart'),
  /** @returns {Promise<import('../src/contract.d.mts').Metrics>} */
  metrics: () => get('/api/metrics'),
};

/**
 * Sends one file to a session's attachments as its raw bytes, so a large file (an APK, an
 * archive) is never held in memory as base64. Resolves to what send() names it by.
 * @param {string} sessionId @param {File} file
 * @param {{onProgress?: (fraction: number) => void, signal?: AbortSignal}} [o]
 * @returns {Promise<{file:string, name:string, size:number, type:string}>}
 */
function upload(sessionId, file, o = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const q = new URLSearchParams({ name: file.name || 'file', type: file.type || '' });
    xhr.open('POST', `/api/sessions/${enc(sessionId)}/uploads?${q}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && o.onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status === 401) set({ unauthorized: true });
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error((data && data.error) || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error(`Network error uploading ${file.name}`));
    xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { aborted: true }));
    o.signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}

/** @param {URLSearchParams | Record<string,string>} q */
export function terminalUrl(q) {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/api/terminal?${new URLSearchParams(q)}`;
}

// -- the store ----------------------------------------------------------------------------

/**
 * The shell is drawn from this. On a cold open it is filled in from what was on screen
 * last time (below), so a phone over a tailnet shows the projects and their sessions at
 * once rather than the word "Connecting" for a second or two; refresh() replaces all of
 * it with the server's own answer, so nothing stale survives the first round trip.
 * @typedef {{
 *   ready: boolean, unauthorized: boolean, connected: boolean, error: string|null,
 *   projects: Project[], tasks: Task[], sessions: Session[], approvals: Approval[],
 *   providers: any[], defaults: {providerId:string, modelId:string|null, mode:string, effort:string|null, projectsDir:string},
 *   me: {local:boolean, device:{id:string,name:string}|null} | null, push: string|null,
 *   gitTick: Record<string, number>
 * }} State
 */

// What to draw before the server answers. Only the lists; the connection state, the push
// key and the git ticks are facts about now, and are never taken from a stale snapshot.
const CACHE_KEY = 'bench:cache';
const cached = /** @type {Partial<State>|null} */ (recall(CACHE_KEY, null));

/** @type {State} */
let state = {
  ready: !!cached,
  unauthorized: false,
  connected: false,
  error: null,
  projects: cached?.projects || [],
  tasks: cached?.tasks || [],
  sessions: cached?.sessions || [],
  approvals: cached?.approvals || [],
  providers: cached?.providers || [],
  defaults: cached?.defaults || { providerId: '', modelId: null, mode: 'default', effort: null, projectsDir: '' },
  me: cached?.me || null,
  push: null,
  gitTick: {},
};
/** @type {Set<() => void>} */
const listeners = new Set();

/** @param {Partial<State>} patch */
function set(patch) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const getState = () => state;

/**
 * The part of the store a component reads. It re-renders when that part changes.
 * @template T @param {(s: State) => T} select @returns {T}
 */
export function useStore(select) {
  const [, force] = useState(0);
  const sel = useRef(select);
  sel.current = select;
  const last = useRef(select(state));
  last.current = select(state);
  useEffect(() => {
    const check = () => {
      const next = sel.current(state);
      if (next !== last.current) {
        last.current = next;
        force((n) => n + 1);
      }
    };
    listeners.add(check);
    return () => {
      listeners.delete(check);
    };
  }, []);
  return last.current;
}

/** @template {{id:string}} T @param {T[]} list @param {T} item */
const upsert = (list, item) => {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [item, ...list];
  const next = list.slice();
  next[i] = item;
  return next;
};

/** @param {string} projectId */
export const bumpGit = (projectId) => set({ gitTick: { ...state.gitTick, [projectId]: (state.gitTick[projectId] || 0) + 1 } });

export async function refresh() {
  try {
    const s = await api.state();
    set({ ready: true, unauthorized: false, error: null, projects: s.projects, tasks: s.tasks, sessions: s.sessions, approvals: s.approvals, providers: s.providers, defaults: s.defaults, me: s.me, push: s.push });
    // The snapshot the next cold open draws from. Written after every successful refresh,
    // which is the one moment the client is known to be holding the server's own truth.
    remember(CACHE_KEY, { projects: s.projects, tasks: s.tasks, sessions: s.sessions, approvals: s.approvals, providers: s.providers, defaults: s.defaults, me: s.me });
  } catch (e) {
    const err = /** @type {any} */ (e);
    set({ ready: true, error: err.status === 401 ? null : err.message, unauthorized: err.status === 401 });
  }
}

// Messages for one session: transcript events and streaming text. A session pane
// subscribes while it is open, and the server only sends what is watched.
/** @type {Map<string, Set<(m: ServerMessage) => void>>} */
const watchers = new Map();
/** @type {WebSocket|null} */
let socket = null;

function sendWatch() {
  if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'watch', ids: [...watchers.keys()] }));
}

/** @param {string} sessionId @param {(m: ServerMessage) => void} fn */
export function watchSession(sessionId, fn) {
  let set = watchers.get(sessionId);
  if (!set) watchers.set(sessionId, (set = new Set()));
  set.add(fn);
  sendWatch();
  return () => {
    set.delete(fn);
    if (!set.size) watchers.delete(sessionId);
    sendWatch();
  };
}

/** Asks the service worker to take down a notification it is showing, by tag. @param {string} tag */
export function closeNotification(tag) {
  navigator.serviceWorker?.ready
    .then((r) => r.active?.postMessage({ type: 'close-notification', tag }))
    .catch(() => {
      /* no worker, no notification */
    });
}

/** @param {ServerMessage} m */
function onMessage(m) {
  if (m.type === 'hello') set({ sessions: m.sessions, approvals: m.approvals });
  else if (m.type === 'session') set({ sessions: upsert(state.sessions, m.session) });
  else if (m.type === 'session-removed') set({ sessions: state.sessions.filter((s) => s.id !== m.id) });
  else if (m.type === 'task') set({ tasks: upsert(state.tasks, m.task) });
  else if (m.type === 'approval') set({ approvals: [...state.approvals.filter((a) => a.id !== m.approval.id), m.approval] });
  else if (m.type === 'approval-done') {
    set({ approvals: state.approvals.filter((a) => a.id !== m.id) });
    // Answered somewhere - here, another window, the shade - so a banner still sitting
    // on the lock screen for it is stale and comes down.
    closeNotification(`approval-${m.id}`);
  }
  else if (m.type === 'git') bumpGit(m.project_id);
  else if (m.type === 'event') for (const fn of watchers.get(m.event.session_id) || []) fn(m);
  else if (m.type === 'delta' || m.type === 'suggestion' || m.type === 'commands') for (const fn of watchers.get(m.session_id) || []) fn(m);
}

let retry = 0;
/** @type {ReturnType<typeof setTimeout>|undefined} */
let timer;
/** @type {ReturnType<typeof setTimeout>|undefined} */
let probe;

export function connect() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${scheme}//${location.host}/api/ws`);
  socket = ws;
  ws.onopen = () => {
    if (socket !== ws) return;
    retry = 0;
    set({ connected: true });
    sendWatch();
    // Whatever happened while disconnected is read fresh, and open panes reload.
    refresh();
    flushOutbox();
    window.dispatchEvent(new Event('bench:reconnected'));
  };
  ws.onmessage = (e) => {
    if (socket !== ws) return;
    // Anything heard means the line is alive.
    clearTimeout(probe);
    probe = undefined;
    try {
      onMessage(JSON.parse(e.data));
    } catch {
      /* a frame this cannot read is skipped */
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    clearTimeout(probe);
    probe = undefined;
    set({ connected: false });
    if (state.unauthorized) return;
    retry = Math.min(retry + 1, 4);
    timer = setTimeout(connect, 500 * 2 ** retry);
  };
}

/**
 * Drops the current socket and opens a new one now. A socket on a dead line can sit in
 * "closing" for a minute before the browser gives up on it, so it is not waited for.
 */
function replace() {
  const old = socket;
  socket = null;
  clearTimeout(timer);
  clearTimeout(probe);
  probe = undefined;
  if (old) {
    old.onopen = old.onmessage = old.onclose = null;
    try {
      old.close();
    } catch {
      /* already gone */
    }
  }
  set({ connected: false });
  retry = 0;
  connect();
}

/** Reconnects now rather than at the next backoff, when the server is known to be back. */
export function reconnectNow() {
  if (socket && socket.readyState <= 1) return;
  clearTimeout(timer);
  retry = 0;
  connect();
}

/**
 * Asks the server for a pong. A socket that looks open but has died silently (a phone
 * that slept, a network that changed, a proxy that dropped it) never answers, and is
 * replaced, rather than leaving the page showing a state that has stopped updating.
 * @param {number} wait ms to wait for any reply
 */
function checkAlive(wait) {
  if (!socket || socket.readyState === 3) return reconnectNow();
  if (socket.readyState !== 1) return; // still connecting
  if (probe) return;
  try {
    socket.send(JSON.stringify({ type: 'ping' }));
  } catch {
    return replace();
  }
  probe = setTimeout(() => {
    probe = undefined;
    replace();
  }, wait);
}

setInterval(() => checkAlive(10000), 20000);
// On coming back to the page, find out at once rather than at the next round.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkAlive(4000);
});
// Coming back is the other moment worth a try: a socket that never dropped (a laptop that
// slept) does not fire onopen again, and the queued message would otherwise wait for one.
window.addEventListener('online', () => {
  checkAlive(4000);
  flushOutbox();
});
window.addEventListener('pageshow', (e) => {
  if (/** @type {PageTransitionEvent} */ (e).persisted) replace();
});
