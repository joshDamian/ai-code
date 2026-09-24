// Thin fetch wrapper. Every call goes through `request`, which normalizes
// JSON bodies, parses JSON responses, and turns non-2xx responses into
// thrown Errors carrying the server's {error} message.

async function request(path, opts = {}) {
  const init = { ...opts };
  if (init.body !== undefined && typeof init.body !== 'string') {
    init.body = JSON.stringify(init.body);
    init.headers = { 'content-type': 'application/json', ...(init.headers || {}) };
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw new Error(`Network error: ${e.message}`);
  }

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
    const msg = (data && typeof data === 'object' && data.error) || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

export const api = {
  overview: () => request('/api/overview'),
  usage: (period = '7d') => request(`/api/usage?period=${encodeURIComponent(period)}`),

  projects: () => request('/api/projects'),
  createProject: (name, path) => request('/api/projects', { method: 'POST', body: { name, path } }),

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

  automations: () => request('/api/automations'),
  updateAutomation: (id, body) => request(`/api/automations/${id}`, { method: 'PATCH', body }),

  chatSessions: (projectId) => request(`/api/chat/sessions${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  // `taskId` scopes the conversation to a task, so the agent answering it is handed
  // that task's plan and review. Omitted, this is the project-wide chat it has
  // always been.
  createChatSession: (projectId, title, taskId) => request('/api/chat/sessions', { method: 'POST', body: { projectId, title, taskId } }),
  chatSession: (id) => request(`/api/chat/sessions/${id}`),
  sendChatMessage: (sessionId, message) => request(`/api/chat/sessions/${sessionId}/messages`, { method: 'POST', body: { message } }),
};

export function taskStreamUrl(id) {
  return `/api/tasks/${id}/stream`;
}

export function chatStreamUrl(id) {
  return `/api/chat/sessions/${id}/stream`;
}

// The one URL here that is not an http path: the terminal is a WebSocket, because
// keystrokes go up it as well as output coming down. Absolute rather than relative
// because the WebSocket constructor has no notion of a base - and the scheme is
// derived from the page's, so a dashboard served over TLS upgrades to wss rather
// than being refused as mixed content.
export function terminalSocketUrl(taskId, target) {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/api/tasks/${taskId}/terminal?target=${encodeURIComponent(target)}`;
}
