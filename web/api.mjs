// @ts-check
// The client's view of the server: JSON calls, and one WebSocket that keeps a shared
// store current. Views read the store with useStore() and call `api` to change things;
// what changed comes back down the socket, so a write is never applied twice.
import { useEffect, useState, useRef } from './lib.mjs';

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

export const api = {
  state: () => get('/api/state'),
  addProject: (/** @type {{path:string, name?:string, init?:boolean}} */ b) => post('/api/projects', b),
  renameProject: (/** @type {string} */ id, /** @type {string} */ name) => patch(`/api/projects/${id}`, { name }),
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
  events: (/** @type {string} */ id, /** @type {number} */ before) => get(`/api/sessions/${id}/events?before=${before}`),
  send: (/** @type {string} */ id, /** @type {string} */ text, /** @type {{media_type:string, data:string}[]} */ images = [], /** @type {{name:string, media_type:string, data:string}[]} */ files = []) => post(`/api/sessions/${id}/messages`, { text, images, files }),
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
  status: () => get('/api/server/status'),
  restart: () => post('/api/server/restart'),
};

/** @param {URLSearchParams | Record<string,string>} q */
export function terminalUrl(q) {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/api/terminal?${new URLSearchParams(q)}`;
}

// -- the store ----------------------------------------------------------------------------

/**
 * @typedef {{
 *   ready: boolean, unauthorized: boolean, connected: boolean, error: string|null,
 *   projects: Project[], tasks: Task[], sessions: Session[], approvals: Approval[],
 *   providers: any[], defaults: {providerId:string, modelId:string|null, mode:string},
 *   me: {local:boolean, device:{id:string,name:string}|null} | null, push: string|null,
 *   gitTick: Record<string, number>
 * }} State
 */

/** @type {State} */
let state = {
  ready: false,
  unauthorized: false,
  connected: false,
  error: null,
  projects: [],
  tasks: [],
  sessions: [],
  approvals: [],
  providers: [],
  defaults: { providerId: '', modelId: null, mode: 'default' },
  me: null,
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

/** @param {ServerMessage} m */
function onMessage(m) {
  if (m.type === 'hello') set({ sessions: m.sessions, approvals: m.approvals });
  else if (m.type === 'session') set({ sessions: upsert(state.sessions, m.session) });
  else if (m.type === 'session-removed') set({ sessions: state.sessions.filter((s) => s.id !== m.id) });
  else if (m.type === 'task') set({ tasks: upsert(state.tasks, m.task) });
  else if (m.type === 'approval') set({ approvals: [...state.approvals.filter((a) => a.id !== m.approval.id), m.approval] });
  else if (m.type === 'approval-done') set({ approvals: state.approvals.filter((a) => a.id !== m.id) });
  else if (m.type === 'git') bumpGit(m.project_id);
  else if (m.type === 'event') for (const fn of watchers.get(m.event.session_id) || []) fn(m);
  else if (m.type === 'delta') for (const fn of watchers.get(m.session_id) || []) fn(m);
}

let retry = 0;
/** @type {ReturnType<typeof setTimeout>|undefined} */
let timer;
export function connect() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${scheme}//${location.host}/api/ws`);
  socket = ws;
  ws.onopen = () => {
    retry = 0;
    set({ connected: true });
    sendWatch();
    // Whatever happened while disconnected is read fresh, and open panes reload.
    refresh();
    window.dispatchEvent(new Event('bench:reconnected'));
  };
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(e.data));
    } catch {
      /* a frame this cannot read is skipped */
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    set({ connected: false });
    if (state.unauthorized) return;
    retry = Math.min(retry + 1, 4);
    timer = setTimeout(connect, 500 * 2 ** retry);
  };
}

/** Reconnects now rather than at the next backoff, when the server is known to be back. */
export function reconnectNow() {
  if (socket && socket.readyState <= 1) return;
  clearTimeout(timer);
  retry = 0;
  connect();
}

// A phone that wakes from sleep has a socket that died silently; a ping finds out.
setInterval(() => {
  if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'ping' }));
}, 25000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') reconnectNow();
});
