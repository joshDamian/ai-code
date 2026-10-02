#!/usr/bin/env node
// The MCP server that lets a chat read AI Code itself: projects, tasks, runs,
// sessions, spend. A chat already reads the project's files; this is the other
// half of "what is going on here", which lives in the database and not the tree.
//
// Read-only by construction. Every tool is a GET against a route the dashboard
// already reads, so the agent sees what a person would see and nothing the server
// does not already hand out. The tools trim what they return: several routes answer
// with far more than a model can use - an activity page of 500 events, a provider's
// whole config - and the cost of that is paid on every turn that follows.
//
// The stdio protocol is the one src/permission-mcp.mjs speaks, for the same reason:
// no runtime dependencies, and four methods. The calls go to 127.0.0.1, which the
// server's token gate admits without a token, so no secret is handed to this process.
import { fileURLToPath } from 'node:url';

const ENDPOINT = process.env.AI_CODE_ENDPOINT || '';

// The largest answer a tool hands back, in characters. A cut answer says so and
// says how to narrow it, because an agent reading a silently truncated list will
// report its last row as the last one there is.
const MAX_CHARS = 40000;
const SPEC_CHARS = 8000;
const DIFF_CHARS = 30000;
const EVENT_CHARS = 2000;

const pick = (o, keys) => (o ? Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])) : o);
const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}\n[cut at ${n} of ${s.length} characters]` : s);

const TASK_FIELDS = ['id', 'project_id', 'parent_id', 'title', 'state', 'branch', 'created_at', 'updated_at'];
const RUN_FIELDS = ['id', 'task_id', 'role', 'provider_id', 'model_id', 'status', 'error', 'cost', 'tokens', 'started_at', 'ended_at', 'duration_ms'];
const JOB_FIELDS = ['id', 'task_id', 'kind', 'state', 'error', 'created_at', 'started_at', 'ended_at'];

// The text of one event, as the service's `extractText` reads it, so a run's final
// answer here is the one the dashboard shows.
function eventText(data) {
  if (typeof data === 'string') return data;
  const c = data?.message?.content ?? data?.content ?? data?.result?.content;
  if (Array.isArray(c)) return c.filter((x) => x?.type === 'text').map((x) => x.text).join('\n');
  if (typeof c === 'string') return c;
  if (typeof data?.result === 'string') return data.result;
  return '';
}

// A name or an id, resolved against a list. Ids are exact; a name is matched
// case-insensitively, whole first and then as a prefix of an id, so the agent can
// pass "Novara" or the eight characters the dashboard shows. More than one match is
// an error that names them, rather than a guess.
function resolve(list, ref, label, nameKey) {
  const want = String(ref || '').trim();
  if (!want) throw new Error(`A ${label} is required.`);
  const exact = list.find((x) => x.id === want);
  if (exact) return exact;
  const lower = want.toLowerCase();
  let hits = list.filter((x) => String(x[nameKey] || '').toLowerCase() === lower);
  if (!hits.length) hits = list.filter((x) => x.id.startsWith(want));
  if (!hits.length) hits = list.filter((x) => String(x[nameKey] || '').toLowerCase().includes(lower));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`No ${label} matches "${want}".`);
  throw new Error(`"${want}" matches ${hits.length} ${label}s: ${hits.slice(0, 10).map((x) => `${x[nameKey]} (${x.id})`).join(', ')}. Pass the id.`);
}

const sinceMs = (since) => {
  if (!since) return null;
  const rel = /^(\d+)\s*([hd])$/.exec(since);
  if (rel) return Date.now() - Number(rel[1]) * (rel[2] === 'h' ? 3600000 : 86400000);
  const t = Date.parse(since);
  if (Number.isNaN(t)) throw new Error(`Unreadable "since": ${since}. Use 24h, 7d, or an ISO date.`);
  return t;
};

const limitOf = (n, dflt, max = 500) => Math.min(Math.max(Number(n) || dflt, 1), max);

const ref = (label) => ({ type: 'string', description: `The ${label}'s id, the start of its id, or its name.` });

// Each tool: its schema for tools/list, and a handler given the parsed arguments and
// `get`, which fetches one route and returns its JSON. Handlers never write.
export const TOOLS = {
  list_projects: {
    description: 'List the AI Code projects: id, name, path, and how many drafted tasks wait for approval.',
    properties: {},
    async run(_, get) {
      return (await get('/api/projects')).map((p) => ({ ...pick(p, ['id', 'name', 'path', 'language', 'framework']), drafts_waiting: (p.drafts || []).length }));
    },
  },
  get_project: {
    description: "One project: its spec, any spec draft waiting for approval, the drafted tasks waiting, and its recorded decisions.",
    properties: { project: ref('project'), decisions_state: { type: 'string', description: 'Only decisions in this state, e.g. pending or approved.' } },
    required: ['project'],
    async run(a, get) {
      const p = resolve(await get('/api/projects'), a.project, 'project', 'name');
      const full = await get(`/api/projects/${p.id}`);
      const decisions = a.decisions_state ? await get(`/api/projects/${p.id}/decisions?state=${encodeURIComponent(a.decisions_state)}`) : full.decisions;
      return {
        ...pick(full, ['id', 'name', 'path', 'language', 'framework', 'created_at']),
        spec: clip(full.spec || null, SPEC_CHARS),
        spec_draft: clip(full.spec_draft || null, SPEC_CHARS),
        drafts: (full.drafts || []).map((d) => pick(d, ['id', 'title', 'description', 'source', 'at'])),
        decisions,
      };
    },
  },
  list_tasks: {
    description: 'List tasks, newest activity first. Filter by project, state (comma-separated, e.g. FAILED,REVIEWING), or words in the title.',
    properties: {
      project: ref('project'),
      state: { type: 'string', description: 'One state or several, comma-separated.' },
      query: { type: 'string', description: 'Words that must all appear in the title, case-insensitive.' },
      limit: { type: 'number', description: 'At most this many. Default 50.' },
    },
    async run(a, get) {
      const params = new URLSearchParams();
      if (a.project) params.set('projectId', resolve(await get('/api/projects'), a.project, 'project', 'name').id);
      if (a.state) params.set('state', String(a.state).toUpperCase());
      let tasks = await get(`/api/tasks?${params}`);
      if (a.query) {
        const words = String(a.query).toLowerCase().split(/\s+/).filter(Boolean);
        tasks = tasks.filter((t) => words.every((w) => t.title.toLowerCase().includes(w)));
      }
      tasks.sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at)));
      const limit = limitOf(a.limit, 50);
      return { total: tasks.length, tasks: tasks.slice(0, limit).map((t) => pick(t, TASK_FIELDS)) };
    },
  },
  get_task: {
    description: 'One task in full: description, plan, review, state, its runs, the run in progress, and its parent.',
    properties: { task: ref('task') },
    required: ['task'],
    async run(a, get) {
      const t = resolve(await get('/api/tasks'), a.task, 'task', 'title');
      const shown = await get(`/api/tasks/${t.id}/show`);
      return {
        task: { ...pick(shown.task, [...TASK_FIELDS, 'description', 'plan', 'review', 'feedback', 'decision']) },
        runs: (shown.runs || []).map((r) => pick(r, RUN_FIELDS)),
        live: shown.live || null,
        parent: shown.parent ? pick(shown.parent, ['id', 'title', 'state']) : null,
      };
    },
  },
  task_activity: {
    description: "A task's most recent events across all its runs, oldest first. Page back with `before` (an event id).",
    properties: { task: ref('task'), limit: { type: 'number', description: 'Default 50, at most 500.' }, before: { type: 'number', description: 'Only events older than this event id.' } },
    required: ['task'],
    async run(a, get) {
      const t = resolve(await get('/api/tasks'), a.task, 'task', 'title');
      const params = new URLSearchParams({ limit: String(limitOf(a.limit, 50)) });
      if (a.before) params.set('before', String(a.before));
      const page = await get(`/api/tasks/${t.id}/activity?${params}`);
      return {
        total: page.total,
        events: (page.events || []).map((e) => ({ id: e.id, run_id: e.run_id, type: e.type, at: e.created_at, text: clip(eventText(e.data), EVENT_CHARS) || undefined })),
      };
    },
  },
  task_diff: {
    description: "The change a task made on its branch, as a unified diff.",
    properties: { task: ref('task') },
    required: ['task'],
    async run(a, get) {
      const t = resolve(await get('/api/tasks'), a.task, 'task', 'title');
      const d = await get(`/api/tasks/${t.id}/diff`);
      return typeof d === 'string' ? clip(d, DIFF_CHARS) : { ...d, diff: clip(d.diff, DIFF_CHARS) };
    },
  },
  list_runs: {
    description: 'List agent runs on tasks, newest first. Filter by task, status (e.g. failed), and how recent (24h, 7d, or an ISO date). Use it for "what failed this week".',
    properties: {
      task: ref('task'),
      status: { type: 'string', description: 'e.g. failed, succeeded, running, cancelled.' },
      since: { type: 'string', description: '24h, 7d, or an ISO date.' },
      limit: { type: 'number', description: 'Default 50.' },
    },
    async run(a, get) {
      const taskId = a.task ? resolve(await get('/api/tasks'), a.task, 'task', 'title').id : null;
      let runs = await get(taskId ? `/api/runs?taskId=${taskId}` : '/api/runs');
      if (a.status) runs = runs.filter((r) => r.status === String(a.status).toLowerCase());
      const since = sinceMs(a.since);
      if (since) runs = runs.filter((r) => Date.parse(r.started_at) >= since);
      runs.sort((x, y) => String(y.started_at).localeCompare(String(x.started_at)));
      return { total: runs.length, runs: runs.slice(0, limitOf(a.limit, 50)).map((r) => pick(r, RUN_FIELDS)) };
    },
  },
  run_events: {
    description: "One run's events. kind=final returns only its last answer, kind=errors only the failures, kind=all everything (paged with `after`).",
    properties: {
      run: { type: 'string', description: 'The run id.' },
      kind: { type: 'string', enum: ['final', 'errors', 'all'], description: 'Default final.' },
      after: { type: 'number', description: 'Only events after this event id.' },
    },
    required: ['run'],
    async run(a, get) {
      const events = await get(`/api/runs/${encodeURIComponent(a.run)}/events?after=${Number(a.after) || 0}`);
      const kind = a.kind || 'final';
      if (kind === 'final') {
        const ended = events.filter((e) => e.type === 'result').pop();
        let text = ended ? eventText(ended.data).trim() : '';
        for (let i = events.length - 1; !text && i >= 0; i--) text = eventText(events[i].data).trim();
        return { run: a.run, final: clip(text, MAX_CHARS / 2) || null };
      }
      const keep = kind === 'errors' ? events.filter((e) => e.type === 'error' || e.data?.is_error || e.data?.subtype?.startsWith?.('error')) : events;
      return keep.map((e) => ({ id: e.id, type: e.type, at: e.created_at, text: clip(eventText(e.data), EVENT_CHARS) || undefined, ...(e.type === 'error' ? { data: e.data } : {}) }));
    },
  },
  usage: {
    description: 'Model spend over a period, by provider, role, and day.',
    properties: { period: { type: 'string', enum: ['24h', '7d', '30d', 'all'], description: 'Default 7d.' } },
    async run(a, get) {
      return get(`/api/usage?period=${encodeURIComponent(a.period || '7d')}`);
    },
  },
  list_sessions: {
    description: 'List supervised sessions: name, status, spend, turns, and what each is doing or waiting on.',
    properties: { project: ref('project') },
    async run(a, get) {
      const pid = a.project ? resolve(await get('/api/projects'), a.project, 'project', 'name').id : '';
      return (await get(`/api/sessions${pid ? `?projectId=${pid}` : ''}`)).map((s) => pick(s, ['id', 'project_id', 'name', 'status', 'budget_tally', 'turn_count', 'pending', 'activity', 'preview', 'created_at', 'updated_at']));
    },
  },
  get_session: {
    description: 'One supervised session: each turn (instruction, answer, steps), the permission requests and how they were answered, its budget, and the files it changed.',
    properties: { session: ref('session') },
    required: ['session'],
    async run(a, get) {
      const s = resolve(await get('/api/sessions'), a.session, 'session', 'name');
      const full = await get(`/api/sessions/${s.id}`);
      return {
        session: pick(full.session, ['id', 'project_id', 'name', 'status', 'budget_tally', 'changed_paths', 'created_at']),
        turns: (full.turns || []).map((t) => ({ ...t, answer: clip(t.answer, EVENT_CHARS * 2) })),
        permissions: (full.history || []).map((r) => pick(r, ['tool', 'status', 'created_at', 'answered_at'])),
        budget: full.budget,
        changes: full.changes,
      };
    },
  },
  list_jobs: {
    description: 'Background jobs: what is queued or running right now, or the job history of one task.',
    properties: { task: ref('task'), active_only: { type: 'boolean', description: 'Default true: only queued and running jobs.' } },
    async run(a, get) {
      const taskId = a.task ? resolve(await get('/api/tasks'), a.task, 'task', 'title').id : null;
      let jobs = await get(taskId ? `/api/jobs?taskId=${taskId}` : '/api/jobs');
      if (a.active_only !== false) jobs = jobs.filter((j) => j.state === 'queued' || j.state === 'running');
      return jobs.map((j) => pick(j, JOB_FIELDS));
    },
  },
  providers_status: {
    description: 'The model providers: whether each is enabled and healthy, its models, and the routing that picks a model per role.',
    properties: {},
    async run(_, get) {
      const [p, routing] = await Promise.all([get('/api/providers'), get('/api/routing')]);
      return {
        // `config` is left out: it names credentials and endpoints, and nothing the
        // agent is asked needs it.
        providers: p.providers.map((x) => pick(x, ['id', 'name', 'kind', 'enabled'])),
        models: p.models.map((m) => pick(m, ['id', 'provider_id', 'name', 'display_name', 'enabled', 'input_cost_per_mtok', 'output_cost_per_mtok', 'billing_mode'])),
        health: p.health,
        routing,
      };
    },
  },
  check_setup: {
    description: 'Whether git, node, and claude are installed, and which provider credentials are present.',
    properties: {},
    async run(_, get) {
      return get('/api/doctor');
    },
  },
};

export const TOOL_NAMES = Object.keys(TOOLS);

// One tool call, answered as the text a model reads. An error is a result the agent
// can read and act on ("no project matches X"), not a protocol failure.
export async function callTool(name, args, get) {
  const tool = TOOLS[name];
  if (!tool) return { isError: true, text: `Unknown tool: ${name}` };
  try {
    const out = await tool.run(args || {}, get);
    const text = typeof out === 'string' ? out : JSON.stringify(out, null, 1);
    return { isError: false, text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[cut at ${MAX_CHARS} of ${text.length} characters - narrow the call with a filter or a smaller limit]` : text };
  } catch (e) {
    return { isError: true, text: e.message };
  }
}

// `get` for a real server: GET only, so a handler cannot write even by mistake.
export function httpGet(endpoint) {
  return async (route) => {
    const res = await fetch(`${endpoint}${route}`, { signal: AbortSignal.timeout(30000) });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || `${route} answered ${res.status}`);
    return body;
  };
}

function serve() {
  const note = (msg) => process.stderr.write(`[app-mcp] ${msg}\n`);
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const get = httpGet(ENDPOINT);
  async function handle({ id, method, params }) {
    if (id === undefined || id === null) return;
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ai-code-app', version: '1.0.0' } } });
    }
    if (method === 'tools/list') {
      const tools = Object.entries(TOOLS).map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: { type: 'object', properties: t.properties, ...(t.required ? { required: t.required } : {}) },
        annotations: { readOnlyHint: true },
      }));
      return send({ jsonrpc: '2.0', id, result: { tools } });
    }
    if (method === 'tools/call') {
      if (!ENDPOINT) return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'No AI Code server endpoint was given to this tool.' }], isError: true } });
      const out = await callTool(params?.name, params?.arguments, get);
      if (out.isError) note(`${params?.name}: ${out.text}`);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out.text }], isError: out.isError } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
  }
  let buf = '';
  process.stdin.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        note(`unparseable frame: ${line.slice(0, 200)}`);
        continue;
      }
      handle(msg).catch((e) => note(`handler failed: ${e.message}`));
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  note(ENDPOINT ? `reading ${ENDPOINT}` : 'no endpoint in the environment; every call will fail');
}

// Imported by the tests for TOOLS and callTool; spawned by claude to serve.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) serve();
