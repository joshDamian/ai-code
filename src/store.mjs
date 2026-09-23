import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { HEALTH_DEFAULTS, COUNTED_CODES, afterFailure, afterSuccess, blankHealth, effectiveHealth, policyFor } from './health.mjs';

// How often a process running an agent refreshes its lease, and how old a
// heartbeat has to be before the lease counts as abandoned. The margin is
// deliberately wide: a heartbeat is skipped whenever the event loop is busy
// serialising a large tool result, and reaping a live run is worse than
// leaving a dead one marked as running for a few extra seconds.
const HEARTBEAT_MS = 2000;
const LEASE_STALE_MS = 15000;

export class Store {
  constructor(root = process.cwd()) {
    this.root = root;
    this.dir = path.join(root, '.ai-code');
    fs.mkdirSync(this.dir, { recursive: true });
    this.db = new DatabaseSync(path.join(this.dir, 'ai-code.db'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,language TEXT,framework TEXT,commands TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,state TEXT NOT NULL,plan TEXT,context TEXT,review TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,worktree TEXT,branch TEXT,base_commit TEXT);
      CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,enabled INTEGER NOT NULL,config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,name TEXT NOT NULL,capabilities TEXT NOT NULL,speed REAL,cost REAL,quality REAL,context_length INTEGER,input_cost_per_mtok REAL,output_cost_per_mtok REAL,cache_read_cost_per_mtok REAL,cache_write_cost_per_mtok REAL,pricing_source TEXT,pricing_updated_at TEXT,billing_mode TEXT,enabled INTEGER DEFAULT 1);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,task_id TEXT,role TEXT,provider_id TEXT,model_id TEXT,status TEXT,started_at TEXT,ended_at TEXT,error TEXT,fallback_from TEXT,tokens INTEGER DEFAULT 0,cost REAL DEFAULT 0,duration_ms INTEGER DEFAULT 0,session_id TEXT,input_tokens INTEGER DEFAULT 0,output_tokens INTEGER DEFAULT 0,cache_read_tokens INTEGER DEFAULT 0,cache_write_tokens INTEGER DEFAULT 0,cost_basis TEXT);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT,type TEXT,data TEXT,created_at TEXT);
      CREATE TABLE IF NOT EXISTS automations(id TEXT PRIMARY KEY,name TEXT,trigger TEXT,action TEXT,enabled INTEGER,created_at TEXT);
      -- task_id is nullable: a provider connectivity test runs under no task, and
      -- giving it a lease too keeps the reaper from interrupting it mid-flight.
      CREATE TABLE IF NOT EXISTS run_leases(run_id TEXT PRIMARY KEY,task_id TEXT,host TEXT NOT NULL,pid INTEGER NOT NULL,heartbeat_at TEXT NOT NULL,cancel_requested INTEGER DEFAULT 0);
      -- Circuit-breaker state per provider. Kept out of providers.config because a
      -- config edit and a failure write would otherwise clobber each other. The
      -- failure *window* is not stored here: it is counted from runs, which is
      -- already the record of every attempt.
      CREATE TABLE IF NOT EXISTS provider_health(provider_id TEXT PRIMARY KEY,state TEXT NOT NULL DEFAULT 'HEALTHY',reason TEXT,consecutive_successes INTEGER NOT NULL DEFAULT 0,cooldown_until TEXT,opened_at TEXT,last_error TEXT,last_failure_at TEXT,last_success_at TEXT);
      -- One row per background job. The partial unique index is what stops two
      -- executes of the same task from queueing at once; it is partial because
      -- finished jobs stay as history and thousands of them share a task id.
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL,started_at TEXT,ended_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active ON jobs(task_id) WHERE state IN ('queued','running');
    `);
    for (const [table, columns] of Object.entries({
      tasks: [
        ['description', 'TEXT'],
        // A cancel has to survive the gap between two steps of one task. The lease
        // covers a run in flight; this covers the moment between runs, and the
        // test command, which runs under no lease at all.
        ['cancel_requested', 'INTEGER DEFAULT 0'],
        // What the tree looked like when the plan was written: the HEAD it was
        // reasoned against, the files that were dirty then, and the files the
        // planner saw. Execution refuses when the last two still overlap, because
        // the implementer runs in a worktree built from HEAD.
        ['plan_base', 'TEXT'],
        // The revision before the current one, and when the current one landed.
        // Two columns on the task rather than a plan_revisions table, because the only
        // question ever asked is "what changed since the revision I was just reading",
        // which is exactly one predecessor - and a table would be a second place that
        // can disagree with the `plan` column it is meant to describe. It becomes the
        // right shape the day someone wants to browse a history.
        ['plan_prev', 'TEXT'],
        ['plan_at', 'TEXT'],
      ],
      models: [
        ['provider_model_id', 'TEXT'],
        ['invocation_model_id', 'TEXT'],
        ['display_name', 'TEXT'],
        ['input_cost_per_mtok', 'REAL'],
        ['output_cost_per_mtok', 'REAL'],
        ['cache_read_cost_per_mtok', 'REAL'],
        ['cache_write_cost_per_mtok', 'REAL'],
        ['peak_input_cost_per_mtok', 'REAL'],
        ['peak_output_cost_per_mtok', 'REAL'],
        ['peak_cache_read_cost_per_mtok', 'REAL'],
        ['peak_cache_write_cost_per_mtok', 'REAL'],
        ['pricing_source', 'TEXT'],
        ['pricing_updated_at', 'TEXT'],
        ['billing_mode', 'TEXT'],
        ['enabled', 'INTEGER DEFAULT 1'],
        // Structured capabilities. NULL means "unknown", which routing treats as
        // permissive, so rows written before these columns existed keep routing
        // exactly as they did.
        ['reasoning', 'TEXT'],
        ['tool_use', 'INTEGER'],
        ['vision', 'INTEGER'],
        ['streaming', 'INTEGER'],
      ],
      runs: [
        ['input_tokens', 'INTEGER DEFAULT 0'],
        ['output_tokens', 'INTEGER DEFAULT 0'],
        ['cache_read_tokens', 'INTEGER DEFAULT 0'],
        ['cache_write_tokens', 'INTEGER DEFAULT 0'],
        ['cost_basis', 'TEXT'],
        ['context_tokens', 'INTEGER DEFAULT 0'],
        ['relevant_files', 'INTEGER DEFAULT 0'],
        ['context_budget', 'INTEGER DEFAULT 0'],
      ],
    })) {
      for (const [column, type] of columns) this.ensureColumn(table, column, type);
    }
    if (!this.listProviders().length) this.seed();
    this.migrateLegacyModels();
    this.reapStaleRuns();
  }

  ensureColumn(table, column, type) {
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch {
      // Column already exists. ALTER TABLE has no IF NOT EXISTS.
    }
  }

  migrateLegacyModels() {
    const map = {
      'claude-sonnet': ['anthropic-claude-code', 'anthropic:claude-sonnet-5', 'claude-sonnet-5', 'claude-sonnet-5'],
      'claude-opus': ['anthropic-claude-code', 'anthropic:claude-opus-5', 'claude-opus-5', 'claude-opus-5'],
      'deepseek-deepseek-flash[1m]': ['deepseek-claude-code', 'deepseek:deepseek-flash', 'deepseek-flash', 'deepseek-flash'],
      'deepseek-deepseek-flash': ['deepseek-claude-code', 'deepseek:deepseek-flash', 'deepseek-flash', 'deepseek-flash'],
    };
    for (const [oldId, [provider, id, providerModel, invocation]] of Object.entries(map)) {
      const existing = this.db.prepare('SELECT * FROM models WHERE id=?').get(oldId);
      if (!existing) continue;
      if (this.db.prepare('SELECT id FROM models WHERE id=?').get(id)) {
        this.db.prepare('DELETE FROM models WHERE id=?').run(oldId);
        continue;
      }
      this.db
        .prepare('UPDATE models SET id=?,provider_id=?,name=?,display_name=?,provider_model_id=?,invocation_model_id=? WHERE id=?')
        .run(id, provider, providerModel, providerModel, providerModel, invocation, oldId);
    }
  }

  // A run is only dead if nothing holds a fresh lease for it. Reaping
  // unconditionally would clobber live agents the moment any other process
  // opened the database, which the CLI does on every single invocation.
  reapStaleRuns() {
    const cutoff = new Date(Date.now() - LEASE_STALE_MS).toISOString();
    this.db.prepare('DELETE FROM run_leases WHERE heartbeat_at < ?').run(cutoff);
    this.db
      .prepare(
        `UPDATE runs SET status='interrupted',ended_at=?,error='Process interrupted'
         WHERE status='running' AND id NOT IN (SELECT run_id FROM run_leases)`
      )
      .run(new Date().toISOString());
  }

  id() {
    return crypto.randomUUID();
  }

  seed() {
    this.addProvider({ id: 'mock', name: 'Mock (tests only)', kind: 'mock', enabled: true, config: { routable: false } });
    this.addModel({
      id: 'mock-strong',
      providerId: 'mock',
      name: 'Mock Strong',
      capabilities: ['planning', 'coding', 'review', 'repair'],
      speed: 7,
      cost: 0,
      quality: 10,
      contextLength: 100000,
      billingMode: 'test',
      pricingSource: 'AI Code test provider',
    });
  }

  // -- leases ---------------------------------------------------------------
  // A lease says "this process is currently driving this run". It is what makes
  // cancellation work across processes and what stops one process from reaping
  // another process's live agents.

  heartbeat(runId, taskId) {
    this.db
      .prepare(
        `INSERT INTO run_leases(run_id,task_id,host,pid,heartbeat_at,cancel_requested)
         VALUES(?,?,?,?,?,0)
         ON CONFLICT(run_id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at`
      )
      .run(runId, taskId, os.hostname(), process.pid, new Date().toISOString());
  }

  releaseLease(runId) {
    this.db.prepare('DELETE FROM run_leases WHERE run_id=?').run(runId);
  }

  liveRunIds() {
    const cutoff = new Date(Date.now() - LEASE_STALE_MS).toISOString();
    return this.db.prepare('SELECT run_id FROM run_leases WHERE heartbeat_at >= ?').all(cutoff).map((r) => r.run_id);
  }

  requestCancel(taskId) {
    this.db.prepare('UPDATE run_leases SET cancel_requested=1 WHERE task_id=?').run(taskId);
    return this.db.prepare('SELECT count(*) c FROM run_leases WHERE task_id=? AND cancel_requested=1').get(taskId).c;
  }

  cancelRequested(runId) {
    const r = this.db.prepare('SELECT cancel_requested FROM run_leases WHERE run_id=?').get(runId);
    return !!r?.cancel_requested;
  }

  // -- projects -------------------------------------------------------------

  addProject(p) {
    this.db.prepare('INSERT OR REPLACE INTO projects VALUES(?,?,?,?,?,?,?)').run(
      p.id, p.name, p.path, p.createdAt, p.language, p.framework, JSON.stringify(p.commands || {})
    );
    return this.getProject(p.id);
  }

  getProject(id) {
    const r = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    return r && this.mapProject(r);
  }

  getProjectByPath(p) {
    const r = this.db.prepare('SELECT * FROM projects WHERE path=?').get(p);
    return r && this.mapProject(r);
  }

  listProjects() {
    return this.db.prepare('SELECT * FROM projects ORDER BY name').all().map((r) => this.mapProject(r));
  }

  mapProject(r) {
    return { ...r, commands: JSON.parse(r.commands) };
  }

  // -- tasks ----------------------------------------------------------------

  addTask(t) {
    this.db
      .prepare(
        'INSERT INTO tasks(id,project_id,title,description,state,plan,context,review,created_at,updated_at,worktree,branch,base_commit) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(t.id, t.projectId, t.title, t.description ?? null, t.state, t.plan ?? null, t.context ?? null, t.review ?? null, t.createdAt, t.updatedAt, null, null, null);
    return this.getTask(t.id);
  }

  getTask(id) {
    return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  }

  listTasks(pid, state) {
    const where = [];
    const params = [];
    if (pid) { where.push('project_id=?'); params.push(pid); }
    if (state) { where.push('state=?'); params.push(state); }
    const q = `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`;
    return this.db.prepare(q).all(...params);
  }

  // The SET list is positional and the argument list beside it is hand-ordered to match,
  // with no type to catch a slip: `plan`, `plan_prev`, `context` and `review` are all
  // TEXT, so inserting into the middle of either list writes a plan into `context` with
  // no error and no symptom until a screen renders nonsense. Append to the end of both,
  // adjacent, and never reorder - a new column goes on the end of the SET list and the
  // end of the .run() arguments, in that order.
  updateTask(id, patch) {
    const task = this.getTask(id);
    const n = { ...task, ...patch, updated_at: new Date().toISOString() };
    this.db
      .prepare('UPDATE tasks SET state=?,plan=?,context=?,review=?,updated_at=?,worktree=?,branch=?,base_commit=?,description=?,plan_base=?,plan_prev=?,plan_at=? WHERE id=?')
      .run(n.state, n.plan ?? null, n.context ?? null, n.review ?? null, n.updated_at, n.worktree ?? null, n.branch ?? null, n.base_commit ?? null, n.description ?? null, n.plan_base ?? null, n.plan_prev ?? null, n.plan_at ?? null, id);
    return this.getTask(id);
  }

  // -- providers ------------------------------------------------------------

  addProvider(p) {
    this.db
      .prepare('INSERT OR REPLACE INTO providers VALUES(?,?,?,?,?)')
      .run(p.id, p.name, p.kind, p.enabled ? 1 : 0, JSON.stringify(p.config || {}));
    return this.getProvider(p.id);
  }

  getProvider(id) {
    const r = this.db.prepare('SELECT * FROM providers WHERE id=?').get(id);
    return r && { ...r, enabled: !!r.enabled, config: JSON.parse(r.config) };
  }

  listProviders() {
    return this.db
      .prepare('SELECT * FROM providers ORDER BY name')
      .all()
      .map((r) => ({ ...r, enabled: !!r.enabled, config: JSON.parse(r.config) }));
  }

  updateProvider(id, patch) {
    const x = this.getProvider(id);
    if (!x) throw Error('Provider not found');
    const n = { ...x, ...patch };
    this.db
      .prepare('UPDATE providers SET name=?,kind=?,enabled=?,config=? WHERE id=?')
      .run(n.name, n.kind, n.enabled ? 1 : 0, JSON.stringify(n.config || {}), id);
    return this.getProvider(id);
  }

  // -- models ---------------------------------------------------------------

  addModel(m) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO models(id,provider_id,name,capabilities,speed,cost,quality,context_length,
           provider_model_id,invocation_model_id,display_name,input_cost_per_mtok,output_cost_per_mtok,
           cache_read_cost_per_mtok,cache_write_cost_per_mtok,peak_input_cost_per_mtok,peak_output_cost_per_mtok,
           peak_cache_read_cost_per_mtok,peak_cache_write_cost_per_mtok,pricing_source,pricing_updated_at,
           billing_mode,enabled,reasoning,tool_use,vision,streaming)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        m.id,
        m.providerId,
        m.name,
        JSON.stringify(m.capabilities ?? m.roles ?? []),
        m.speed ?? 5,
        m.cost ?? 0,
        m.quality ?? 5,
        m.contextLength ?? null,
        m.providerModelId ?? m.provider_model_id ?? m.name,
        m.invocationModelId ?? m.invocation_model_id ?? m.name,
        m.displayName ?? m.display_name ?? m.name,
        m.inputCostPerMTok ?? null,
        m.outputCostPerMTok ?? null,
        m.cacheReadCostPerMTok ?? null,
        m.cacheWriteCostPerMTok ?? null,
        m.peakInputCostPerMTok ?? null,
        m.peakOutputCostPerMTok ?? null,
        m.peakCacheReadCostPerMTok ?? null,
        m.peakCacheWriteCostPerMTok ?? null,
        m.pricingSource ?? null,
        m.pricingUpdatedAt ?? now,
        m.billingMode ?? 'unknown',
        m.enabled === false ? 0 : 1,
        m.reasoning ?? null,
        m.toolUse === undefined || m.toolUse === null ? null : m.toolUse ? 1 : 0,
        m.vision === undefined || m.vision === null ? null : m.vision ? 1 : 0,
        m.streaming === undefined || m.streaming === null ? null : m.streaming ? 1 : 0
      );
  }

  updateModel(id, patch) {
    const m = this.getModel(id);
    if (!m) throw Error('Model not found');
    const n = { ...m, ...patch };
    this.addModel({ ...n, id, providerId: m.provider_id, capabilities: n.capabilities || m.capabilities });
    return this.getModel(id);
  }

  getModel(id) {
    const r = this.db.prepare('SELECT * FROM models WHERE id=?').get(id);
    return r && this.mapModel(r);
  }

  listModels(pid) {
    const q = pid
      ? 'SELECT * FROM models WHERE provider_id=? ORDER BY name'
      : 'SELECT * FROM models ORDER BY provider_id,name';
    return this.db.prepare(q).all(...(pid ? [pid] : [])).map((r) => this.mapModel(r));
  }

  mapModel(r) {
    const roles = JSON.parse(r.capabilities);
    // Nullable booleans: null means the row predates the column, and routing
    // treats that as permissive rather than as false.
    const tri = (v) => (v === null || v === undefined ? null : !!v);
    return {
      ...r,
      enabled: !!r.enabled,
      capabilities: roles,
      roles,
      providerModelId: r.provider_model_id || r.name,
      invocationModelId: r.invocation_model_id || r.name,
      displayName: r.display_name || r.name,
      // The routing code reads camelCase throughout, so the column aliases have to
      // be complete: a missing one is not a crash, it is a check that silently
      // never fires.
      contextLength: r.context_length,
      inputCostPerMTok: r.input_cost_per_mtok,
      outputCostPerMTok: r.output_cost_per_mtok,
      cacheReadCostPerMTok: r.cache_read_cost_per_mtok,
      cacheWriteCostPerMTok: r.cache_write_cost_per_mtok,
      peakInputCostPerMTok: r.peak_input_cost_per_mtok,
      peakOutputCostPerMTok: r.peak_output_cost_per_mtok,
      peakCacheReadCostPerMTok: r.peak_cache_read_cost_per_mtok,
      peakCacheWriteCostPerMTok: r.peak_cache_write_cost_per_mtok,
      pricingSource: r.pricing_source,
      pricingUpdatedAt: r.pricing_updated_at,
      billingMode: r.billing_mode,
      reasoning: r.reasoning ?? null,
      toolUse: tri(r.tool_use),
      vision: tri(r.vision),
      streaming: tri(r.streaming),
    };
  }

  // -- runs -----------------------------------------------------------------

  addRun(r) {
    this.db
      .prepare(
        `INSERT INTO runs(id,task_id,role,provider_id,model_id,status,started_at,ended_at,error,fallback_from,
           tokens,cost,duration_ms,session_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,
           cost_basis,context_tokens,relevant_files,context_budget)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        r.id, r.taskId ?? null, r.role, r.providerId, r.modelId, r.status, r.startedAt,
        null, null, r.fallbackFrom ?? null,
        0, 0, 0, null, 0, 0, 0, 0,
        null,
        r.contextTokens ?? 0, r.relevantFiles ?? 0, r.contextBudget ?? 0
      );
    return r;
  }

  updateRun(id, patch) {
    // A run that succeeded has no error. reapStaleRuns writes 'Process
    // interrupted' when a run outlives its lease, and a run that then finishes
    // anyway would keep that stale text through the `{...r, ...patch}` merge -
    // leaving one row claiming succeeded and interrupted at once. Clearing it is
    // the whole fix: the merge strategy is fine, success just has to say so.
    const p = patch.status === 'succeeded' && !('error' in patch) ? { ...patch, error: null } : patch;
    const r = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    const n = { ...r, ...p };
    this.db
      .prepare(
        `UPDATE runs SET status=?,ended_at=?,error=?,fallback_from=?,tokens=?,cost=?,duration_ms=?,session_id=?,
           input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_write_tokens=?,cost_basis=?,
           context_tokens=?,relevant_files=?,context_budget=? WHERE id=?`
      )
      .run(
        n.status, n.ended_at ?? null, n.error ?? null, n.fallback_from ?? null, n.tokens ?? 0, n.cost ?? 0,
        n.duration_ms ?? 0, n.session_id ?? null, n.input_tokens ?? 0, n.output_tokens ?? 0,
        n.cache_read_tokens ?? 0, n.cache_write_tokens ?? 0, n.cost_basis ?? null,
        n.context_tokens ?? 0, n.relevant_files ?? 0, n.context_budget ?? 0,
        id
      );
    return n;
  }

  listRuns(tid) {
    const q = tid ? 'SELECT * FROM runs WHERE task_id=? ORDER BY started_at' : 'SELECT * FROM runs ORDER BY started_at DESC';
    return this.db.prepare(q).all(...(tid ? [tid] : []));
  }

  listRunsSince(since) {
    const q = since ? 'SELECT * FROM runs WHERE started_at>=? ORDER BY started_at' : 'SELECT * FROM runs ORDER BY started_at';
    return this.db.prepare(q).all(...(since ? [since] : []));
  }

  // Runs currently held by a live lease, for concurrency accounting. Keyed on the
  // lease rather than on a status column, and read from the database rather than
  // from memory, so a second process driving the same provider is counted too.
  // The cutoff matters: a lease whose owner died would otherwise hold a provider
  // slot forever.
  countRunningByProvider() {
    const cutoff = new Date(Date.now() - LEASE_STALE_MS).toISOString();
    return this.db
      .prepare(
        `SELECT r.provider_id pid,count(*) c FROM runs r
         JOIN run_leases l ON l.run_id=r.id
         WHERE l.heartbeat_at>=?
         GROUP BY r.provider_id`
      )
      .all(cutoff);
  }

  // Does this task have a run in flight anywhere, as told by the leases rather
  // than by a status column? Used by the event stream to decide whether the task
  // is still moving, and cheap enough to ask on every tick.
  taskHasLiveRun(taskId) {
    const cutoff = new Date(Date.now() - LEASE_STALE_MS).toISOString();
    const r = this.db
      .prepare('SELECT count(*) c FROM runs r JOIN run_leases l ON l.run_id=r.id WHERE r.task_id=? AND l.heartbeat_at>=?')
      .get(taskId, cutoff);
    return r.c > 0;
  }

  // Tasks left in PLANNING with a plan that only ever reached the events table:
  // the process died between its planner run succeeding and plan() writing that
  // result onto the task. The run row is the evidence, so the plan can be
  // recovered rather than paid for again.
  //
  // One row per task - the newest succeeded planner run - because an older
  // attempt's plan must never overwrite a newer one. Only runs that finished a
  // while ago, for the same reason reapStaleRuns waits: a success written a
  // second ago belongs to a live process that is about to write the plan itself,
  // and recovering it here would move the task out from under that process.
  //
  // The same shape is what the user's own Reject and Replan leave behind, since
  // both clear the plan and return the task to PLANNING. Handing a user back the
  // plan they just refused is worse than recovering nothing, so the two are told
  // apart by when the task row was last written. An abandoned plan's task was last
  // written when planning started - before its run ended - and reject() or
  // replan() necessarily writes it after. That ordering is the whole discriminator.
  // A succeeded run with no ended_at is not recovered for the same reason: there is
  // nothing to order against. runRole always stamps ended_at on success, so that
  // row is a corruption rather than a case to serve.
  orphanedPlans() {
    const cutoff = new Date(Date.now() - LEASE_STALE_MS).toISOString();
    const rows = this.db
      .prepare(
        `SELECT t.id AS task_id, r.id AS run_id
           FROM tasks t
           JOIN runs r ON r.task_id=t.id AND r.role='planner' AND r.status='succeeded'
          WHERE t.state='PLANNING' AND t.plan IS NULL
            AND r.ended_at IS NOT NULL AND r.ended_at < ? AND t.updated_at < r.ended_at
          ORDER BY r.ended_at DESC`
      )
      .all(cutoff);
    const newest = new Map();
    for (const row of rows) if (!newest.has(row.task_id)) newest.set(row.task_id, row);
    return [...newest.values()];
  }

  // -- jobs -----------------------------------------------------------------

  addJob(j) {
    try {
      this.db.prepare('INSERT INTO jobs(id,task_id,kind,state,created_at) VALUES(?,?,?,?,?)').run(j.id, j.taskId, j.kind, j.state, j.createdAt);
    } catch {
      // The only constraint that can fail here is jobs_one_active, and it failing
      // means the caller tried to queue a second job for a task that already has
      // one. Say that, rather than leaking a SQLITE_CONSTRAINT at the user.
      throw new Error('This task already has a job queued or running');
    }
    return this.getJob(j.id);
  }

  getJob(id) {
    return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) || null;
  }

  updateJob(id, patch) {
    const j = this.getJob(id);
    if (!j) return null;
    const n = { ...j, ...patch };
    this.db
      .prepare('UPDATE jobs SET state=?,error=?,started_at=?,ended_at=? WHERE id=?')
      .run(n.state, n.error ?? null, n.started_at ?? null, n.ended_at ?? null, id);
    return this.getJob(id);
  }

  // Newest first, so `task status` shows the current attempt before its history.
  listJobs(taskId) {
    const q = taskId ? 'SELECT * FROM jobs WHERE task_id=? ORDER BY created_at DESC' : 'SELECT * FROM jobs ORDER BY created_at DESC';
    return this.db.prepare(q).all(...(taskId ? [taskId] : []));
  }

  activeJobs() {
    return this.db.prepare("SELECT * FROM jobs WHERE state IN ('queued','running') ORDER BY created_at").all();
  }

  // -- tasks: cancellation intent -------------------------------------------

  // Set on the task rather than only on the leases, so a cancel that lands
  // between two steps - or during the test command, which holds no lease - is
  // still honoured when the next agent starts.
  setTaskCancel(taskId, on) {
    this.db.prepare('UPDATE tasks SET cancel_requested=? WHERE id=?').run(on ? 1 : 0, taskId);
  }

  taskCancelRequested(taskId) {
    const r = this.db.prepare('SELECT cancel_requested FROM tasks WHERE id=?').get(taskId);
    return !!r?.cancel_requested;
  }

  // -- provider health ------------------------------------------------------
  // The stored row is a cache of a decision. effectiveHealth() resolves the
  // cooldown on read, so a cooldown that lapsed while nothing was running is
  // honoured without any timer and without two processes disagreeing.

  getProviderHealthRow(providerId) {
    return this.db.prepare('SELECT * FROM provider_health WHERE provider_id=?').get(providerId) || null;
  }

  listProviderHealthRows() {
    return this.db.prepare('SELECT * FROM provider_health').all();
  }

  // Failures in the window that are the provider's fault, counted from the runs
  // table. role<>'provider-test' keeps the "Test connection" button from ever
  // tripping the breaker it is trying to inspect.
  countRecentFailures(providerId, sinceIso, codes = COUNTED_CODES) {
    const clause = codes.map(() => 'error LIKE ?').join(' OR ');
    return this.db
      .prepare(
        `SELECT count(*) c FROM runs
          WHERE provider_id=? AND status='failed' AND ended_at>=? AND role<>'provider-test'
            AND (${clause})`
      )
      .get(providerId, sinceIso, ...codes.map((c) => `${c} %`)).c;
  }

  // The same count for every provider at once, so listing health is one query
  // rather than one per provider.
  countRecentFailuresByProvider(sinceIso, codes = COUNTED_CODES) {
    const clause = codes.map(() => 'error LIKE ?').join(' OR ');
    const rows = this.db
      .prepare(
        `SELECT provider_id, count(*) c FROM runs
          WHERE status='failed' AND ended_at>=? AND role<>'provider-test'
            AND (${clause})
          GROUP BY provider_id`
      )
      .all(sinceIso, ...codes.map((c) => `${c} %`));
    return new Map(rows.map((r) => [r.provider_id, r.c]));
  }

  // What routing should believe about every provider right now.
  providerHealthMap(now = Date.now(), thresholds) {
    const t = thresholds || HEALTH_DEFAULTS;
    const out = new Map();
    for (const row of this.listProviderHealthRows()) out.set(row.provider_id, effectiveHealth(row, now, t));
    return out;
  }

  // Records a failure against a provider. The failing run must already be in the
  // `runs` table with status 'failed' - runRole writes it before calling this -
  // because it is that row the window is counted from.
  recordProviderFailure(providerId, code, { now = Date.now(), thresholds } = {}) {
    // The request was wrong, not the provider. Writing nothing keeps the health
    // table from learning about failures it has no opinion on.
    if (policyFor(code).health === 'none') return null;
    const t = thresholds || HEALTH_DEFAULTS;
    const row = this.getProviderHealthRow(providerId);
    const failures = this.countRecentFailures(providerId, new Date(now - t.windowMs).toISOString());
    // Decide from the *effective* state, so a cooldown that has already lapsed is
    // written down as DEGRADED rather than lingering as OPEN in the row.
    const from = { ...(row || blankHealth(providerId)), state: effectiveHealth(row, now, t).state };
    return this.writeProviderHealth(afterFailure(from, code, failures, now, t));
  }

  recordProviderSuccess(providerId, { now = Date.now(), thresholds } = {}) {
    const t = thresholds || HEALTH_DEFAULTS;
    const row = this.getProviderHealthRow(providerId);
    const from = { ...(row || blankHealth(providerId)), state: effectiveHealth(row, now, t).state };
    return this.writeProviderHealth(afterSuccess(from, now, t));
  }

  writeProviderHealth(h) {
    this.db
      .prepare(
        `INSERT INTO provider_health(provider_id,state,reason,consecutive_successes,cooldown_until,opened_at,last_error,last_failure_at,last_success_at)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(provider_id) DO UPDATE SET
           state=excluded.state,reason=excluded.reason,
           consecutive_successes=excluded.consecutive_successes,
           cooldown_until=excluded.cooldown_until,opened_at=excluded.opened_at,
           last_error=excluded.last_error,last_failure_at=excluded.last_failure_at,
           last_success_at=excluded.last_success_at`
      )
      .run(
        h.provider_id, h.state, h.reason ?? null, h.consecutive_successes ?? 0,
        h.cooldown_until ?? null, h.opened_at ?? null, h.last_error ?? null,
        h.last_failure_at ?? null, h.last_success_at ?? null
      );
    return h;
  }

  // -- events ---------------------------------------------------------------

  addEvent(e) {
    this.db
      .prepare('INSERT INTO events(run_id,type,data,created_at) VALUES(?,?,?,?)')
      .run(e.runId, e.type, JSON.stringify(e.data ?? null), new Date().toISOString());
  }

  listEvents(id, afterId = 0) {
    return this.db
      .prepare('SELECT * FROM events WHERE run_id=? AND id>? ORDER BY id')
      .all(id, afterId)
      .map((x) => ({ ...x, data: JSON.parse(x.data) }));
  }

  listTaskEvents(taskId, afterId = 0) {
    return this.db
      .prepare('SELECT e.* FROM events e JOIN runs r ON r.id=e.run_id WHERE r.task_id=? AND e.id>? ORDER BY e.id')
      .all(taskId, afterId)
      .map((x) => ({ ...x, data: JSON.parse(x.data) }));
  }

  countTaskEvents(taskId) {
    return this.db
      .prepare('SELECT count(*) c FROM events e JOIN runs r ON r.id=e.run_id WHERE r.task_id=?')
      .get(taskId).c;
  }

  tailTaskEvents(taskId, limit = 500) {
    return this.db
      .prepare(
        `SELECT * FROM (SELECT e.* FROM events e JOIN runs r ON r.id=e.run_id WHERE r.task_id=? ORDER BY e.id DESC LIMIT ?) ORDER BY id`
      )
      .all(taskId, limit)
      .map((x) => ({ ...x, data: JSON.parse(x.data) }));
  }

  pageTaskEvents(taskId, before, limit = 500) {
    return this.db
      .prepare(
        `SELECT * FROM (SELECT e.* FROM events e JOIN runs r ON r.id=e.run_id WHERE r.task_id=? AND e.id<? ORDER BY e.id DESC LIMIT ?) ORDER BY id`
      )
      .all(taskId, before, limit)
      .map((x) => ({ ...x, data: JSON.parse(x.data) }));
  }

  // -- automations ----------------------------------------------------------

  addAutomation(a) {
    this.db
      .prepare('INSERT OR REPLACE INTO automations VALUES(?,?,?,?,?,?)')
      .run(a.id, a.name, a.trigger, a.action, a.enabled ? 1 : 0, a.createdAt);
    return a;
  }

  updateAutomation(id, patch) {
    const a = this.db.prepare('SELECT * FROM automations WHERE id=?').get(id);
    if (!a) throw Error('Automation not found');
    const n = { ...a, ...patch };
    this.db
      .prepare('UPDATE automations SET name=?,trigger=?,action=?,enabled=? WHERE id=?')
      .run(n.name, n.trigger, n.enabled ? 1 : 0, id);
    return n;
  }

  listAutomations() {
    return this.db
      .prepare('SELECT * FROM automations ORDER BY created_at DESC')
      .all()
      .map((x) => ({ ...x, enabled: !!x.enabled }));
  }
}

export { HEARTBEAT_MS, LEASE_STALE_MS };
