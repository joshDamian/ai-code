// Thin fetch wrapper. Every call goes through `request`, which normalizes
// JSON bodies, parses JSON responses, and turns non-2xx responses into
// thrown Errors carrying the server's {error} message.

import { authHeaders, withToken, reportUnauthorized } from './auth.mjs';

// Whether the server is there, reported as an event on every transition.
//
// Every call in the app goes through `request`, so the answer is already known here -
// and the app needs it: a dashboard loaded from a service-worker cache outlives the
// process that served it, and without this it renders one failed request per view with
// nothing to say about why. An event rather than a return value, because a dozen calls
// are in flight at once and all of them are answered by the same screen.
//
// On transitions only: the overview poll runs every three seconds and a browser that
// re-rendered the shell on each one would never settle.
let last = '';
function reportConnectivity(up, supervisor = false) {
  const key = `${up}:${supervisor}`;
  if (key === last) return;
  last = key;
  window.dispatchEvent(new CustomEvent('ai-code:connectivity', { detail: { up, supervisor } }));
}

async function request(path, opts = {}) {
  const init = { ...opts };
  // Empty on desktop, where the server exempts loopback and no token is needed.
  init.headers = { ...authHeaders(), ...(init.headers || {}) };
  if (init.body !== undefined && typeof init.body !== 'string') {
    init.body = JSON.stringify(init.body);
    init.headers = { 'content-type': 'application/json', ...init.headers };
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    reportConnectivity(false);
    throw new Error(`Network error: ${e.message}`);
  }

  // The supervisor holds the port while the server is down, and it answers 404 to
  // everything under /api - a 404 that is not "no such route" but "no server". The
  // header it puts on every response is the only way to tell the two apart, and
  // reading it before the status is what keeps the stopped page from being read as a
  // server that is up and simply missing a route.
  if (res.headers.get('x-ai-code-supervisor')) reportConnectivity(false, true);
  else reportConnectivity(true, false);

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = text;
    }
  }

  if (!res.ok) {
    // A 401 is not a failure of this call, it is the absence of a token - and every
    // caller would report it the same unhelpful way. The app listens for this and
    // shows the pairing screen instead.
    if (res.status === 401) reportUnauthorized();
    const msg = (data && typeof data === 'object' && data.error) || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  overview: () => request('/api/overview'),
  usage: (period = '7d') => request(`/api/usage?period=${encodeURIComponent(period)}`),

  projects: () => request('/api/projects'),
  createProject: (name, path) => request('/api/projects', { method: 'POST', body: { name, path } }),
  // One project with its spec, its waiting drafts and its decision log. The panel
  // renders all four, so they arrive together rather than a round trip apart.
  project: (id) => request(`/api/projects/${id}`),

  // Intake: an idea note becomes a project. The drafting turn is a chat turn, so
  // the reply names the session to open - the conversation is where the draft is
  // watched, and the project it belongs to is where it is approved.
  startIntake: (idea, name) => request('/api/intake', { method: 'POST', body: { idea, name } }),

  // The spec: what the project is for. A POST proposes a change and it waits; the
  // two verbs below are the only writes that move it.
  projectSpec: (id) => request(`/api/projects/${id}/spec`),
  proposeSpec: (id, spec) => request(`/api/projects/${id}/spec`, { method: 'POST', body: { spec } }),
  approveSpec: (id, path) => request(`/api/projects/${id}/spec/approve`, { method: 'POST', body: { path } }),
  rejectSpec: (id) => request(`/api/projects/${id}/spec/reject`, { method: 'POST' }),

  drafts: (id) => request(`/api/projects/${id}/drafts`),
  approveDraft: (id, draftId) => request(`/api/projects/${id}/drafts/${draftId}/approve`, { method: 'POST' }),
  dropDraft: (id, draftId) => request(`/api/projects/${id}/drafts/${draftId}`, { method: 'DELETE' }),
  // Drafts a fresh batch against the stored spec and the open task list. The reply
  // names the conversation the pass answers in.
  proposeTasks: (id) => request(`/api/projects/${id}/proposals`, { method: 'POST' }),
  // Infers a spec from the existing codebase. The reply names the conversation it
  // answers in, and the draft lands on the project page.
  inferSpec: (id) => request(`/api/projects/${id}/infer-spec`, { method: 'POST' }),

  decisions: (id, state) => request(`/api/projects/${id}/decisions${state ? `?state=${encodeURIComponent(state)}` : ''}`),
  approveDecision: (id) => request(`/api/decisions/${id}/approve`, { method: 'POST' }),
  rejectDecision: (id) => request(`/api/decisions/${id}/reject`, { method: 'POST' }),
  // The retry for a decision pass that failed, and how a task completed before the
  // log existed is asked for its entries.
  draftDecisions: (id) => request(`/api/tasks/${id}/decisions`, { method: 'POST' }),

  tasks: (params = {}) => {
    const qs = new URLSearchParams();
    if (params.state) qs.set('state', params.state);
    if (params.projectId) qs.set('projectId', params.projectId);
    const s = qs.toString();
    return request(`/api/tasks${s ? `?${s}` : ''}`);
  },
  // `parentId` is optional: a task created without one is a task with no parent,
  // which is what every task was before the field existed.
  createTask: (projectId, title, parentId) => request('/api/tasks', { method: 'POST', body: { projectId, title, parentId } }),
  taskShow: (id) => request(`/api/tasks/${id}/show`),
  // Without `before` this returns the newest window; with it, the window ending
  // just before that event id. Callers that render the result must bound it.
  taskActivity: (id, opts = {}) => {
    const q = new URLSearchParams();
    if (opts.before) q.set('before', String(opts.before));
    if (opts.limit) q.set('limit', String(opts.limit));
    const s = q.toString();
    return request(`/api/tasks/${id}/activity${s ? `?${s}` : ''}`);
  },
  taskPlan: (id) => request(`/api/tasks/${id}/plan`, { method: 'POST' }),
  taskApprove: (id) => request(`/api/tasks/${id}/approve`, { method: 'POST' }),
  taskExecute: (id) => request(`/api/tasks/${id}/execute`, { method: 'POST' }),
  taskReview: (id) => request(`/api/tasks/${id}/review`, { method: 'POST' }),
  taskRepair: (id) => request(`/api/tasks/${id}/repair`, { method: 'POST' }),
  taskReject: (id) => request(`/api/tasks/${id}/reject`, { method: 'POST' }),
  taskReplan: (id) => request(`/api/tasks/${id}/replan`, { method: 'POST' }),
  taskRetry: (id) => request(`/api/tasks/${id}/retry`, { method: 'POST' }),
  taskRefine: (id, feedback) => request(`/api/tasks/${id}/refine`, { method: 'POST', body: { feedback } }),
  // A task's parent, set or cleared. `null` is the clear, so an accidental link is
  // removable with the same call that made it.
  taskLink: (id, parentId) => request(`/api/tasks/${id}/link`, { method: 'POST', body: { parentId } }),
  // Re-opens a COMPLETE task with a human's instruction. The call is blocking: the
  // repair, its tests and the verification review all run before it answers.
  taskFeedback: (id, text) => request(`/api/tasks/${id}/feedback`, { method: 'POST', body: { text } }),
  // The decision gate. `discuss` answers a comment and leaves the task where it is;
  // `resolve` is the instruction that starts the repair, and it blocks for the whole
  // of that cycle the way feedback does.
  taskDiscuss: (id, text) => request(`/api/tasks/${id}/discuss`, { method: 'POST', body: { text } }),
  taskResolve: (id, { option = null, text = '' } = {}) => request(`/api/tasks/${id}/resolve`, { method: 'POST', body: { option, text } }),
  taskCancel: (id) => request(`/api/tasks/${id}/cancel`, { method: 'POST' }),
  taskClose: (id) => request(`/api/tasks/${id}/close`, { method: 'POST' }),
  // `to` is a query parameter because this is a read: which branch the port would
  // land on, answered without materializing anything.
  taskDiff: (id, to) => request(`/api/tasks/${id}/diff${to ? `?to=${encodeURIComponent(to)}` : ''}`),
  taskPort: (id, opts = {}) => request(`/api/tasks/${id}/port`, { method: 'POST', body: opts }),
  updatePlan: (id, plan) => request(`/api/tasks/${id}/plan`, { method: 'PATCH', body: { plan } }),
  // The per-task planning-model preference. `null` clears it back to automatic.
  taskSetPlanModel: (id, modelId) => request(`/api/tasks/${id}/plan`, { method: 'PATCH', body: { plan_model: modelId } }),

  providers: () => request('/api/providers'),
  updateProvider: (id, body) => request(`/api/providers/${id}`, { method: 'PATCH', body }),
  testProvider: (id, modelId) => request(`/api/providers/${id}/test`, { method: 'POST', body: { modelId } }),
  // Model ids are namespaced with whatever the provider calls the model, and for
  // OpenRouter that includes a slash (`openrouter:anthropic/claude-opus-5`). Encoded,
  // it survives as the one path segment the route matches; unencoded, the server sees
  // a segment it has no route for and answers 404.
  updateModel: (id, body) => request(`/api/models/${encodeURIComponent(id)}`, { method: 'PATCH', body }),

  routing: () => request('/api/routing'),
  saveRouting: (policies) => request('/api/routing', { method: 'PUT', body: policies }),

  runs: (taskId) => request(`/api/runs${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`),
  runEvents: (id) => request(`/api/runs/${id}/events`),

  doctor: () => request('/api/doctor'),

  // The server's own control surface. `shutdown` answers before it stops - a 202 and
  // then the process goes - so nothing here waits on the server's death; the
  // connectivity event above is what reports it.
  serverStatus: () => request('/api/server/status'),
  serverShutdown: () => request('/api/server/shutdown', { method: 'POST' }),
  // The supervisor, when one is holding the port. With no supervisor these are 404s
  // from the server, which callers read as "there is nothing to start it with".
  supervisorStatus: () => request('/api/supervisor/status'),
  supervisorStart: () => request('/api/supervisor/start', { method: 'POST' }),

  automations: () => request('/api/automations'),
  updateAutomation: (id, body) => request(`/api/automations/${id}`, { method: 'PATCH', body }),

  chatSessions: (projectId) => request(`/api/chat/sessions${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  // `taskId` scopes the conversation to a task, so the agent answering it is handed
  // that task's plan and review. Omitted, this is the project-wide chat it has
  // always been.
  createChatSession: (projectId, title, taskId) => request('/api/chat/sessions', { method: 'POST', body: { projectId, title, taskId } }),
  chatSession: (id) => request(`/api/chat/sessions/${id}`),
  sendChatMessage: (sessionId, message) => request(`/api/chat/sessions/${sessionId}/messages`, { method: 'POST', body: { message } }),

  // Supervised sessions. `message` is one turn, and the reply is the run's job
  // rather than its result - the turn is read back through the stream, for the same
  // reason a chat turn is.
  sessions: (projectId) => request(`/api/sessions${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  createSession: (projectId, name, { providerId = null, modelId = null, mode } = {}) =>
    request('/api/sessions', { method: 'POST', body: { projectId, name, providerId, modelId, ...(mode ? { mode } : {}) } }),
  sessionSpend: () => request('/api/session-spend'),
  session: (id) => request(`/api/sessions/${id}`),
  updateSession: (id, body) => request(`/api/sessions/${id}`, { method: 'PATCH', body }),
  archiveSession: (id) => request(`/api/sessions/${id}/archive`, { method: 'POST' }),
  stopSession: (id) => request(`/api/sessions/${id}/cancel`, { method: 'POST' }),
  resumeSession: (id) => request(`/api/sessions/${id}/resume`, { method: 'POST' }),
  dismissSessionNudge: (id) => request(`/api/sessions/${id}/nudge`, { method: 'POST' }),
  // `attachments` are `{name, type, data}` with `data` a base64 data URL, inlined in
  // the one request so a message and its files arrive - or are refused - together.
  sendSessionMessage: (id, message, attachments = []) =>
    request(`/api/sessions/${id}/messages`, { method: 'POST', body: attachments.length ? { message, attachments } : { message } }),
  // `kind` is `attachments` for what the person sent, `outputs` for what the agent shared back.
  sessionAttachmentUrl: (id, runId, name, kind = 'attachments') =>
    `/api/sessions/${encodeURIComponent(id)}/${kind}/${encodeURIComponent(runId)}/${encodeURIComponent(name)}`,
  draftSessionTask: (id) => request(`/api/sessions/${id}/draft-task`, { method: 'POST' }),
  // `allow` is the only action that grants; the server reads every other word as a
  // denial, so this is a verb and not a boolean.
  // Every prompt waiting on the machine, for the app-wide approval card.
  pendingPermissions: () => request('/api/permissions'),
  answerSessionPermission: (sessionId, reqId, action) =>
    request(`/api/sessions/${sessionId}/permissions/${reqId}`, { method: 'POST', body: { action } }),

  // Web Push. `pushKey` answers 503 when the server has no web-push installed, which
  // the notifier treats as "no background push on this install" and nothing more.
  pushKey: () => request('/api/push/key'),
  pushSubscribe: (subscription) => request('/api/push/subscribe', { method: 'POST', body: subscription }),
  pushUnsubscribe: (endpoint) => request('/api/push/unsubscribe', { method: 'POST', body: { endpoint } }),
};

// The three URLs below carry the token in the query string, because EventSource and
// the WebSocket constructor both have no way to set a header. It is the same secret
// the `Authorization` header carries, and the server reads it in exactly these cases.

export function taskStreamUrl(id) {
  return withToken(`/api/tasks/${id}/stream`);
}

export function chatStreamUrl(id) {
  return withToken(`/api/chat/sessions/${id}/stream`);
}

export function sessionStreamUrl(id) {
  return withToken(`/api/sessions/${id}/stream`);
}

// The app-wide notification stream: run completions, for the in-page notifier.
export function notificationsUrl() {
  return withToken('/api/notifications');
}

// The one URL here that is not an http path: the terminal is a WebSocket, because
// keystrokes go up it as well as output coming down. Absolute rather than relative
// because the WebSocket constructor has no notion of a base - and the scheme is
// derived from the page's, so a dashboard served over TLS upgrades to wss rather
// than being refused as mixed content.
export function terminalSocketUrl(taskId, target) {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return withToken(`${scheme}//${location.host}/api/tasks/${taskId}/terminal?target=${encodeURIComponent(target)}`);
}
