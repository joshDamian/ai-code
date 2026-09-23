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
  createTask: (projectId, title) => request('/api/tasks', { method: 'POST', body: { projectId, title } }),
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
  taskRefine: (id, feedback) => request(`/api/tasks/${id}/refine`, { method: 'POST', body: { feedback } }),
  taskCancel: (id) => request(`/api/tasks/${id}/cancel`, { method: 'POST' }),
  taskClose: (id) => request(`/api/tasks/${id}/close`, { method: 'POST' }),
  // `to` is a query parameter because this is a read: which branch the port would
  // land on, answered without materializing anything.
  taskDiff: (id, to) => request(`/api/tasks/${id}/diff${to ? `?to=${encodeURIComponent(to)}` : ''}`),
  taskPort: (id, opts = {}) => request(`/api/tasks/${id}/port`, { method: 'POST', body: opts }),
  updatePlan: (id, plan) => request(`/api/tasks/${id}/plan`, { method: 'PATCH', body: { plan } }),

  providers: () => request('/api/providers'),
  updateProvider: (id, body) => request(`/api/providers/${id}`, { method: 'PATCH', body }),
  testProvider: (id, modelId) => request(`/api/providers/${id}/test`, { method: 'POST', body: { modelId } }),
  updateModel: (id, body) => request(`/api/models/${id}`, { method: 'PATCH', body }),

  routing: () => request('/api/routing'),
  saveRouting: (policies) => request('/api/routing', { method: 'PUT', body: policies }),

  runs: (taskId) => request(`/api/runs${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`),
  runEvents: (id) => request(`/api/runs/${id}/events`),

  doctor: () => request('/api/doctor'),

  automations: () => request('/api/automations'),
  updateAutomation: (id, body) => request(`/api/automations/${id}`, { method: 'PATCH', body }),
};

export function taskStreamUrl(id) {
  return `/api/tasks/${id}/stream`;
}
