// Thin fetch wrapper around the AI Code REST API (src/server.mjs).
// Every method returns a Promise that resolves with parsed JSON, or throws
// an Error with a human-readable message on failure. Screens are expected
// to wrap calls in try/catch and surface `err.message` in the UI.

async function request(baseUrl, path, options = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      headers: { 'content-type': 'application/json' },
      ...options,
    });
  } catch (err) {
    throw new Error(`Cannot reach server at ${baseUrl}: ${err.message}`);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const message = (data && typeof data === 'object' && data.error) || res.statusText || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data;
}

// Parses one `text/event-stream` frame. Fields are `name: value` lines; the
// server sends `event` (which frame this is) and `data` (the payload), and
// comments (`:`-prefixed) are skipped as the spec requires.
function parseFrame(raw) {
  let name = 'message';
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') name = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return null;
  try {
    return { name, payload: JSON.parse(data.join('\n')) };
  } catch {
    return null;
  }
}

// Subscribes to `GET /api/tasks/:id/stream`. The server pushes `event` frames
// carrying serialised run events and `state` frames carrying `{ task }` every
// 500ms, then ends the stream once the task is COMPLETE or FAILED.
//
// This uses fetch with a stream reader rather than the global EventSource,
// which is still experimental on this Node version and offers no clean way to
// cancel a subscription. Returns a handle whose `close()` aborts the request;
// callers must close it on unmount or the reader outlives the component.
export function streamTask(baseUrl, taskId, { onEvent, onState, onError, onEnd } = {}) {
  const controller = new AbortController();
  let closed = false;

  const consume = async () => {
    let res;
    try {
      res = await fetch(`${baseUrl}/api/tasks/${taskId}/stream`, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      });
    } catch (err) {
      if (!closed) onError?.(`Cannot reach server at ${baseUrl}: ${err.message}`);
      return;
    }
    if (!res.ok || !res.body) {
      if (!closed) onError?.(`Stream for task ${taskId} failed: HTTP ${res.status}`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Frames are separated by a blank line; a chunk may cut one in half,
        // so keep the tail in the buffer until the next read completes it.
        for (;;) {
          const sep = /\r?\n\r?\n/.exec(buffer);
          if (!sep) break;
          const raw = buffer.slice(0, sep.index);
          buffer = buffer.slice(sep.index + sep[0].length);
          const frame = parseFrame(raw);
          if (!frame) continue;
          if (frame.name === 'event') onEvent?.(frame.payload);
          else if (frame.name === 'state') onState?.(frame.payload);
          else if (frame.name === 'error') onError?.(frame.payload?.error || 'stream error');
        }
      }
    } catch (err) {
      // close() aborts the request, which rejects the pending read; that is
      // the normal teardown path, not a failure to report.
      if (!closed) onError?.(err.message);
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Already errored or released; nothing left to cancel.
      }
      if (!closed) onEnd?.();
    }
  };

  consume();

  return {
    close() {
      closed = true;
      controller.abort();
    },
  };
}

export function createApi(baseUrl) {
  const get = (path) => request(baseUrl, path);
  const post = (path, body) => request(baseUrl, path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined });
  const patch = (path, body) => request(baseUrl, path, { method: 'PATCH', body: JSON.stringify(body ?? {}) });
  const put = (path, body) => request(baseUrl, path, { method: 'PUT', body: JSON.stringify(body ?? {}) });

  return {
    baseUrl,
    overview: () => get('/api/overview'),

    projects: () => get('/api/projects'),

    tasks: ({ state, projectId } = {}) => {
      const q = new URLSearchParams();
      if (state) q.set('state', state);
      if (projectId) q.set('projectId', projectId);
      const qs = q.toString();
      return get(`/api/tasks${qs ? `?${qs}` : ''}`);
    },
    taskShow: (id) => get(`/api/tasks/${id}/show`),
    taskActivity: (id) => get(`/api/tasks/${id}/activity`),
    createTask: (projectId, title) => post('/api/tasks', { projectId, title }),
    plan: (id) => post(`/api/tasks/${id}/plan`),
    approve: (id) => post(`/api/tasks/${id}/approve`),
    execute: (id) => post(`/api/tasks/${id}/execute`),
    review: (id) => post(`/api/tasks/${id}/review`),
    repair: (id) => post(`/api/tasks/${id}/repair`),
    reject: (id) => post(`/api/tasks/${id}/reject`),
    replan: (id) => post(`/api/tasks/${id}/replan`),
    refine: (id, feedback) => post(`/api/tasks/${id}/refine`, { feedback }),
    cancel: (id) => post(`/api/tasks/${id}/cancel`),
    close: (id) => post(`/api/tasks/${id}/close`),
    updatePlan: (id, plan) => patch(`/api/tasks/${id}/plan`, { plan }),
    // The per-task planning-model preference. `null` clears it back to automatic.
    setPlanModel: (id, modelId) => patch(`/api/tasks/${id}/plan`, { plan_model: modelId }),

    providers: () => get('/api/providers'),
    updateProvider: (id, body) => patch(`/api/providers/${id}`, body),
    testProvider: (id, modelId) => post(`/api/providers/${id}/test`, { modelId }),

    routing: () => get('/api/routing'),
    saveRouting: (body) => put('/api/routing', body),

    runs: (taskId) => get(`/api/runs${taskId ? `?taskId=${taskId}` : ''}`),

    usage: (period = '7d') => get(`/api/usage?period=${encodeURIComponent(period)}`),

    streamTask: (id, handlers) => streamTask(baseUrl, id, handlers),

    doctor: () => get('/api/doctor'),
  };
}
