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

// A project's pending task drafts, as a list. A corrupt or half-written column must
// not throw a SyntaxError out of the middle of a page render, and a draft queue that
// cannot be read is a queue with nothing in it - which is exactly what a project that
// has never had a proposal is, so the two degrade to the same thing.
function mapDrafts(text) {
  if (!text) return [];
  try {
    const rows = JSON.parse(text);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export class Store {
  constructor(root = process.cwd()) {
    this.root = root;
    this.dir = path.join(root, '.ai-code');
    fs.mkdirSync(this.dir, { recursive: true });
    this.db = new DatabaseSync(path.join(this.dir, 'ai-code.db'));
    // More than one process writes this file - the server, a CLI command, the MCP
    // helpers a session spawns - and without a busy timeout SQLite answers a write
    // that meets another's lock with SQLITE_BUSY at once rather than waiting. Two
    // implementer runs failed outright that way on 2026-09-27, 474s and 188s in,
    // on "database is locked". Five seconds covers any write this store makes.
    this.db.exec('PRAGMA busy_timeout=5000');
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
      -- A direct conversation with the project, which is not a task: it has no
      -- state machine, no plan, no worktree and no approval gate. Its own tables
      -- rather than rows in the tasks table, because a task row is what every list
      -- product filters on and a chat has no state to filter by.
      CREATE TABLE IF NOT EXISTS chat_sessions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      -- run_id on a user message names the run that will answer it; on an
      -- assistant message it names the run that produced it. That pairing is the
      -- whole of "is this question still waiting", and it is how a stream finds
      -- the live run's events from the database rather than from one process's
      -- memory. No foreign key: a question whose run never started still has to
      -- be readable, and its own row is what says so.
      CREATE TABLE IF NOT EXISTS chat_messages(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,run_id TEXT,created_at TEXT NOT NULL);
      -- A chat turn's run row, which is not a task's run and so is not a row in
      -- the runs table. Every surface that reads runs asks a task-keyed question
      -- of it - the usage page, the runs list, a task's own history, the live-run
      -- lookup - and a row there belonging to no task is a row each of them has to
      -- know to exclude. The columns are the same set as runs, so the writer in
      -- runRole hands the same row to either table; task_id becomes
      -- chat_session_id, which is the conversation the turn belongs to.
      CREATE TABLE IF NOT EXISTS chat_runs(id TEXT PRIMARY KEY,chat_session_id TEXT NOT NULL,role TEXT,provider_id TEXT,model_id TEXT,status TEXT,started_at TEXT,ended_at TEXT,error TEXT,fallback_from TEXT,tokens INTEGER DEFAULT 0,cost REAL DEFAULT 0,duration_ms INTEGER DEFAULT 0,session_id TEXT,input_tokens INTEGER DEFAULT 0,output_tokens INTEGER DEFAULT 0,cache_read_tokens INTEGER DEFAULT 0,cache_write_tokens INTEGER DEFAULT 0,cost_basis TEXT,context_tokens INTEGER DEFAULT 0,relevant_files INTEGER DEFAULT 0,context_budget INTEGER DEFAULT 0,context_state TEXT);
      -- The decision log: what the project decided, in the words of the tasks that
      -- decided it. A row is drafted by the agent that finished a task and lands in
      -- the log only when a person approves it, which is why state is a column
      -- rather than the row's existence - a rejected draft is a decision somebody
      -- declined, and deleting it would lose the record of that. task_id is the
      -- task the entry came from, which is the one thing a decision cannot be read
      -- without: the same sentence is a different decision depending on what was
      -- built when it was written. No foreign key, for the reason chat_messages has
      -- none - the task row can be deleted and its decision still has to be readable.
      CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT,content TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,approved_at TEXT);

      -- A supervised session: a named agent acting in the user's own checkout on
      -- freeform instructions, with every write and exec gated by a live
      -- permission prompt. Not a task and not a chat - it has no state machine
      -- and no plan, and unlike a chat it may change the tree it runs in. Its own
      -- table because every list product filters on 'tasks', and a session is not
      -- a row any of them should see.
      --
      -- 'status' is idle|running|stopped|archived. 'pending_run_id' is the run the
      -- waiting instruction names, which is what makes "is this session busy" a
      -- question the database answers rather than one a process remembers.
      -- 'budget_tally' is what the session has spent in total across its runs;
      -- sessions are budgeted where read-only chat deliberately is not.
      --
      -- 'task_shaped' and 'nudge_dismissed' are the nudge's two halves: the first
      -- is written when a settled turn changed enough to be a task, the second when
      -- a person has said they are not drafting it. The card shows while the first
      -- is set and the second is not, and 'changed_paths' is what the card and the
      -- draft are built from - read at the moment the turn ended, because what the
      -- checkout looks like after a later turn is not evidence about this one.
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'idle',provider_id TEXT,model_id TEXT,budget_tally REAL NOT NULL DEFAULT 0,cancel_requested INTEGER NOT NULL DEFAULT 0,pending_run_id TEXT,task_shaped INTEGER NOT NULL DEFAULT 0,nudge_dismissed INTEGER NOT NULL DEFAULT 0,changed_paths TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);

      -- A session turn's run row, the same shape as chat_runs and for the same
      -- reason: a session run belongs to no task, and a row in 'runs' belonging
      -- to no task is a row every task-keyed surface has to know to exclude.
      --
      -- The claude resume id is named 'resume_session_id' rather than 'session_id'
      -- because in 'runs' and 'chat_runs' that column already means the resume id,
      -- and here 'session_id' is the session the turn belongs to - the parent. One
      -- name cannot be both, so the parent claims it and the resume id is spelled
      -- out. runRole hands the same patch to this writer as to the other two; the
      -- translation is here, where the column names are.
      CREATE TABLE IF NOT EXISTS session_runs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,role TEXT,provider_id TEXT,model_id TEXT,status TEXT,started_at TEXT,ended_at TEXT,error TEXT,fallback_from TEXT,tokens INTEGER DEFAULT 0,cost REAL DEFAULT 0,duration_ms INTEGER DEFAULT 0,resume_session_id TEXT,input_tokens INTEGER DEFAULT 0,output_tokens INTEGER DEFAULT 0,cache_read_tokens INTEGER DEFAULT 0,cache_write_tokens INTEGER DEFAULT 0,cost_basis TEXT,context_tokens INTEGER DEFAULT 0,relevant_files INTEGER DEFAULT 0,context_budget INTEGER DEFAULT 0,context_state TEXT);

      -- One row per gated action an agent asked for and has not been answered on.
      -- A row rather than a held request because a blocked agent must survive a
      -- page reload, a backgrounded phone and the process that was watching it:
      -- the prompted action is written here before anything waits, and every
      -- surface answers the same question by reading it back.
      --
      -- The lifecycle is pending -> allowed|denied|timeout, and 'answered_at' is
      -- the moment it left pending, whichever of the three it left by. A row left
      -- pending past the policy's permissionTimeoutMs is swept to 'timeout', which
      -- is a denial - the fail-closed answer, not an absence of one.
      -- run_id is nullable, and that is the fail-closed shape rather than a
      -- loosening of it: the asker is an HTTP client, and a request that arrives
      -- without one still has to be recorded and answered. A NOT NULL here would
      -- turn a missing field into a 500, which the MCP tool reads as a denial -
      -- denying an action because of a bug in the thing that asks about it.
      CREATE TABLE IF NOT EXISTS permission_requests(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,run_id TEXT,tool TEXT NOT NULL,input TEXT,cwd TEXT,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL,answered_at TEXT);

      -- Values that belong to the install rather than to any project: the API token
      -- a phone pairs with, and the VAPID keypair push is signed with. A table
      -- rather than a file because the database is already the one thing every
      -- process opens, and a secret in a second file beside it is a second thing
      -- that can go missing or get out of sync with the row it belongs to.
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);

      -- One row per browser that has subscribed to push. Keyed on the endpoint
      -- because that is what the push service issues and what identifies a
      -- subscription, with the two client keys the payload is encrypted to.
      -- Re-subscribing from the same browser replaces the row, which is what a
      -- rotated keypair or a refreshed token looks like from here.
      CREATE TABLE IF NOT EXISTS push_subscriptions(endpoint TEXT PRIMARY KEY,p256dh TEXT NOT NULL,auth TEXT NOT NULL,created_at TEXT NOT NULL);
    `);
    for (const [table, columns] of Object.entries({
      // The project's spec: what it is for, what it is not for, and the product
      // decisions already taken. The same revision pair a task's plan carries, for
      // the same reason - the only question ever asked is "what changed since the
      // revision I was reading" - plus the draft pair, which is what stands in for
      // the AWAITING_APPROVAL gate a task has and a project does not: a spec change
      // is written to `spec_draft` and moves to `spec` only when a person approves
      // it. `spec_at` is when the approved text landed, not when a draft was made.
      projects: [
        ['spec', 'TEXT'],
        ['spec_prev', 'TEXT'],
        ['spec_at', 'TEXT'],
        ['spec_draft', 'TEXT'],
        ['spec_draft_at', 'TEXT'],
        // The idea note a project was started from, when it was started from one.
        // NULL on every project added by path, which is most of them. It is kept on
        // the row rather than reconstructed from the intake conversation because it
        // is what becomes the repository's first commit, and a commit has to be
        // reproducible from the project rather than from a chat log.
        ['idea', 'TEXT'],
        // Task drafts awaiting a person's approval, as a JSON array of
        // `{id,title,description,source}`. A column rather than a table because a
        // draft is not a row anything else joins to: it is a queue in front of the
        // approvals, and the only two things done to it are "add a batch" and
        // "remove the one that was approved". Both are whole-array writes.
        //
        // These are the intake's first tasks and the proposals pass's batches,
        // which share this list rather than each having one: a draft is approved
        // identically wherever it came from, and `source` is what tells a reader
        // which pass drafted it.
        ['task_drafts', 'TEXT'],
      ],
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
        // The model this task's planner should use, when it is healthy and
        // available. NULL means route normally, which is what every task written
        // before this column existed gets.
        ['plan_model', 'TEXT'],
        // The task this one builds on, when a person has drawn that line. One level
        // only - the context builder reads the parent's own row and not its parent's
        // - so this is a reference rather than a tree, and a cycle costs nothing
        // beyond a summary the planner did not need.
        ['parent_id', 'TEXT'],
        // A human's instruction on a completed task, set while the repair that
        // answers it runs and cleared once it has. It is a column rather than a
        // message table because it is read in exactly one place - the repair's
        // findings - and the review after it has the same text through the same
        // argument.
        ['feedback', 'TEXT'],
        // The question a review left open, set when a DECIDE verdict stops the task
        // in AWAITING_DECISION and cleared once a repair has been approved to answer
        // it. JSON rather than columns, because the options and the discussion thread
        // are one value: a question is read with the comments about it or not at all,
        // and nothing queries an individual option.
        ['decision', 'TEXT'],
        // How a task is run, and the attempt it is when several run side by side.
        // `engine` is 'pipeline' (plan, approve, implement, test, review) or 'session'
        // (one agent in a worktree, end to end). Every task written before the column
        // existed was a pipeline. `model_id` pins one model for every role of the task,
        // which is what makes "this engine on this model" an attempt. `attempt_group`
        // is the id shared by the attempts of one comparison, `attempt_label` the
        // letter each is shown under, and `pick` what the person decided between them:
        // 'won', 'lost', or null while undecided. `session_id` is a session-engine
        // task's conversation.
        ['engine', "TEXT NOT NULL DEFAULT 'pipeline'"],
        ['model_id', 'TEXT'],
        ['plan_first', 'INTEGER NOT NULL DEFAULT 0'],
        ['attempt_group', 'TEXT'],
        ['attempt_label', 'TEXT'],
        ['pick', 'TEXT'],
        ['session_id', 'TEXT'],
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
        // §5.9's label, persisted so a degraded context is visible in `runs`
        // without reading the prompt back out of the transcript. NULL on rows
        // written before the column existed, which is exactly why the default is
        // not 'FULL': an unrecorded run did not observe a state, and saying it did
        // would invent a measurement.
        ['context_state', 'TEXT'],
      ],
      // A conversation can be scoped to a task, which is how a question about a
      // completed task is asked with that task's plan and review in hand. NULL is
      // the project-scoped chat every session written before this column was.
      chat_sessions: [
        ['task_id', 'TEXT'],
        // The work a drafting pass was opened to describe, when it was opened for
        // one. Null for every speculative pass - an intake, an ordinary proposals
        // batch - which is what lets `proposeTasks` tell "propose the next thing"
        // from "write up what already happened in the checkout" without reading the
        // question's text, where the two would look alike.
        ['focus', 'TEXT'],
        // A conversation a drafting pass opened (intake, proposals, infer-spec, Draft
        // as task) rather than one a person started. The conversations list hides
        // these by default: they are the passes' working, not questions anybody asked.
        ['system', 'INTEGER NOT NULL DEFAULT 0'],
      ],
      // What a conversation may do: 'read' answers from the repo and AI Code's
      // records, 'edit' works in the checkout behind the permission gate. Rows
      // written before the column existed come back 'read'. They were all editing
      // sessions, but an idle one holding the project's checkout would lock every
      // other conversation out of editing, and a read-only turn only asks first.
      sessions: [
        ['mode', "TEXT NOT NULL DEFAULT 'read'"],
        // The task a conversation is the agent of, and the worktree it works in.
        // Null for every conversation a person started, which work in the project's
        // own checkout.
        ['task_id', 'TEXT'],
        ['cwd', 'TEXT'],
        // Whether an editing conversation's routine actions are approved without a
        // prompt. Off for every row written before it existed, and off by default:
        // it is a person's choice for one conversation, never a default.
        ['auto_allow', 'INTEGER NOT NULL DEFAULT 0'],
      ],
      // A request the auto-allow rule answered rather than a person, so the
      // history can say which approvals nobody looked at.
      permission_requests: [['auto', 'INTEGER NOT NULL DEFAULT 0']],
    })) {
      for (const [column, type] of columns) {
        const had = this.db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
        this.ensureColumn(table, column, type);
        // The passes' conversations, marked once, on the start that adds the column.
        // Later ones are marked as they are created.
        if (!had && table === 'chat_sessions' && column === 'system') {
          this.db.exec("UPDATE chat_sessions SET system=1 WHERE title IN ('Intake','Task proposals','Infer spec') OR title LIKE 'Task from session:%'");
        }
      }
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

  getSetting(key) {
    return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null;
  }

  setSetting(key, value) {
    this.db
      .prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, String(value));
    return value;
  }

  // Called once at pairing, and again whenever the same browser re-subscribes -
  // which it does on every permission grant, because the endpoint is stable but
  // the keys under it are not guaranteed to be.
  addPushSubscription(sub) {
    this.db
      .prepare('INSERT INTO push_subscriptions(endpoint,p256dh,auth,created_at) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth')
      .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString());
    return this.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint=?').get(sub.endpoint);
  }

  deletePushSubscription(endpoint) {
    return this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint).changes;
  }

  listPushSubscriptions() {
    return this.db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at').all();
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
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE runs SET status='interrupted',ended_at=?,error='Process interrupted'
         WHERE status='running' AND id NOT IN (SELECT run_id FROM run_leases)`
      )
      .run(now);
    // The same reaping for a chat turn, which holds a lease of its own. The lease
    // going stale is what says the process running it is gone, and the row is the
    // turn's own record: left saying 'running' it reports a turn that is over as
    // one still in flight.
    this.db
      .prepare(
        `UPDATE chat_runs SET status='interrupted',ended_at=?,error='Process interrupted'
         WHERE status='running' AND id NOT IN (SELECT run_id FROM run_leases)`
      )
      .run(now);
    // And for a session turn, for the same reason and by the same test.
    this.db
      .prepare(
        `UPDATE session_runs SET status='interrupted',ended_at=?,error='Process interrupted'
         WHERE status='running' AND id NOT IN (SELECT run_id FROM run_leases)`
      )
      .run(now);
    // The session's own status is derived from its runs, so it is derived here
    // too: a session left saying 'running' with no run holding a lease is a
    // session nothing is driving, and the UI would offer a Stop button for a
    // process that is gone. The subquery rather than a second pass, so the two
    // statements cannot disagree about which rows were just interrupted.
    //
    // `pending_run_id` is cleared with it. That column is the instruction nothing
    // is answering, and the process that was going to answer it is the one that
    // just died - so left set it would make the session permanently unaskable,
    // refusing every new instruction with "already working on one". The events
    // stay, so the instruction is still in the transcript; it simply stops being
    // pending, which after the process died is the truth.
    this.db
      .prepare(
        `UPDATE sessions SET status='idle',pending_run_id=NULL,updated_at=?
         WHERE status='running' AND id NOT IN (SELECT session_id FROM session_runs WHERE status='running')`
      )
      .run(now);
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

  // Whether one run is still held. `liveRun` cannot answer this: it is keyed on a
  // task id, and a chat run has no task to be keyed on. The chat stream is the
  // caller - it watches a run by its id and needs to know when to stop.
  hasLiveLease(runId) {
    const cutoff = new Date(Date.now() - LEASE_STALE_MS).toISOString();
    return !!this.db.prepare('SELECT 1 x FROM run_leases WHERE run_id=? AND heartbeat_at>=?').get(runId, cutoff);
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

  // The column list is explicit, and the spec columns are deliberately not in it. A
  // positional `VALUES(?,?,?,?,?,?,?)` writes whatever it is handed into whatever
  // column happens to be there, so the day an eighth column was added every project
  // insert would have been one value short with no error - and `INSERT OR REPLACE`
  // would have taken the spec and its history down with the row it replaced. Named
  // columns mean a column nobody names keeps its default, which for a spec is the
  // only safe thing for a re-add to do. `idea` is named because it is written once,
  // at creation, and there is no later write that could own it.
  addProject(p) {
    this.db
      .prepare('INSERT OR REPLACE INTO projects(id,name,path,created_at,language,framework,commands,idea) VALUES(?,?,?,?,?,?,?,?)')
      .run(p.id, p.name, p.path, p.createdAt, p.language, p.framework, JSON.stringify(p.commands || {}), p.idea ?? null);
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
    return { ...r, commands: JSON.parse(r.commands), drafts: mapDrafts(r.task_drafts) };
  }

  // The columns a project row may move, and they are the ones a spec is not in:
  // `updateProjectSpec` owns those, and the two writers being separate is what keeps
  // a path edit from being able to clear a spec. The same append-only discipline as
  // updateTask - a new column goes on the end of both lists, adjacent, and neither
  // list is ever reordered.
  updateProject(id, patch) {
    const p = this.getProject(id);
    if (!p) throw new Error('Project not found');
    const n = { ...p, ...patch };
    this.db
      .prepare('UPDATE projects SET name=?,path=?,language=?,framework=?,commands=? WHERE id=?')
      .run(n.name, n.path, n.language ?? null, n.framework ?? null, JSON.stringify(n.commands || {}), id);
    return this.getProject(id);
  }

  updateProjectSpec(id, patch) {
    const p = this.getProject(id);
    if (!p) throw new Error('Project not found');
    const n = { ...p, ...patch };
    this.db
      .prepare('UPDATE projects SET spec=?,spec_prev=?,spec_at=?,spec_draft=?,spec_draft_at=? WHERE id=?')
      .run(n.spec ?? null, n.spec_prev ?? null, n.spec_at ?? null, n.spec_draft ?? null, n.spec_draft_at ?? null, id);
    return this.getProject(id);
  }

  updateProjectDrafts(id, drafts) {
    this.db.prepare('UPDATE projects SET task_drafts=? WHERE id=?').run(JSON.stringify(drafts || []), id);
    return this.getProject(id);
  }

  // -- tasks ----------------------------------------------------------------

  addTask(t) {
    this.db
      .prepare(
        'INSERT INTO tasks(id,project_id,title,description,state,plan,context,review,created_at,updated_at,worktree,branch,base_commit,parent_id,engine,model_id,plan_first,attempt_group,attempt_label) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        t.id, t.projectId, t.title, t.description ?? null, t.state, t.plan ?? null, t.context ?? null, t.review ?? null, t.createdAt, t.updatedAt, null, null, t.baseCommit ?? null, t.parentId ?? null,
        t.engine || 'pipeline', t.modelId ?? null, t.planFirst ? 1 : 0, t.attemptGroup ?? null, t.attemptLabel ?? null
      );
    return this.getTask(t.id);
  }

  getTask(id) {
    return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  }

  // The attempts of one comparison, in the order they are shown.
  listAttempts(group) {
    return this.db.prepare('SELECT * FROM tasks WHERE attempt_group=? ORDER BY attempt_label, created_at').all(group);
  }

  // Every task that was an attempt of some comparison, for the scoreboard.
  listAllAttempts() {
    return this.db.prepare('SELECT * FROM tasks WHERE attempt_group IS NOT NULL ORDER BY created_at').all();
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
      .prepare('UPDATE tasks SET state=?,plan=?,context=?,review=?,updated_at=?,worktree=?,branch=?,base_commit=?,description=?,plan_base=?,plan_prev=?,plan_at=?,plan_model=?,parent_id=?,feedback=?,decision=?,engine=?,model_id=?,plan_first=?,attempt_group=?,attempt_label=?,pick=?,session_id=? WHERE id=?')
      .run(
        n.state, n.plan ?? null, n.context ?? null, n.review ?? null, n.updated_at, n.worktree ?? null, n.branch ?? null, n.base_commit ?? null, n.description ?? null, n.plan_base ?? null, n.plan_prev ?? null, n.plan_at ?? null, n.plan_model ?? null, n.parent_id ?? null, n.feedback ?? null, n.decision ?? null,
        n.engine || 'pipeline', n.model_id ?? null, n.plan_first ? 1 : 0, n.attempt_group ?? null, n.attempt_label ?? null, n.pick ?? null, n.session_id ?? null,
        id
      );
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

  // Deleting a model is safe for history: `runs.model_id` is a plain text column
  // with no foreign key, so a run row keeps naming the model it ran on after the
  // row it named is gone.
  deleteModel(id) {
    this.db.prepare('DELETE FROM models WHERE id=?').run(id);
  }

  updateModel(id, patch) {
    const m = this.getModel(id);
    if (!m) throw Error('Model not found');
    const n = { ...m, ...patch };
    this.addModel({ ...n, id, providerId: m.provider_id, capabilities: n.capabilities || m.capabilities });
    return this.getModel(id);
  }

  // Every priced row of the three run ledgers, for a reprice. Only the columns a
  // price is computed from, plus where the row lives so it can be written back.
  pricedRunRows() {
    return ['runs', 'chat_runs', 'session_runs'].flatMap((table) =>
      this.db
        .prepare(`SELECT id,model_id,started_at,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,cost_basis FROM ${table} WHERE provider_id IS NOT NULL AND model_id IS NOT NULL`)
        .all()
        .map((r) => ({ ...r, table }))
    );
  }

  setRunCost(table, id, cost, basis) {
    if (!['runs', 'chat_runs', 'session_runs'].includes(table)) throw new Error(`Not a run table: ${table}`);
    this.db.prepare(`UPDATE ${table} SET cost=?,cost_basis=? WHERE id=?`).run(cost, basis, id);
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
           cost_basis,context_tokens,relevant_files,context_budget,context_state)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        r.id, r.taskId ?? null, r.role, r.providerId, r.modelId, r.status, r.startedAt,
        null, null, r.fallbackFrom ?? null,
        0, 0, 0, null, 0, 0, 0, 0,
        null,
        r.contextTokens ?? 0, r.relevantFiles ?? 0, r.contextBudget ?? 0, r.contextState ?? null
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
        `UPDATE runs SET provider_id=?,model_id=?,status=?,ended_at=?,error=?,fallback_from=?,tokens=?,cost=?,duration_ms=?,session_id=?,
           input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_write_tokens=?,cost_basis=?,
           context_tokens=?,relevant_files=?,context_budget=?,context_state=? WHERE id=?`
      )
      .run(
        n.provider_id ?? null, n.model_id ?? null,
        n.status, n.ended_at ?? null, n.error ?? null, n.fallback_from ?? null, n.tokens ?? 0, n.cost ?? 0,
        n.duration_ms ?? 0, n.session_id ?? null, n.input_tokens ?? 0, n.output_tokens ?? 0,
        n.cache_read_tokens ?? 0, n.cache_write_tokens ?? 0, n.cost_basis ?? null,
        n.context_tokens ?? 0, n.relevant_files ?? 0, n.context_budget ?? 0, n.context_state ?? null,
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
    // A chat turn's run is counted too. It is an agent talking to the provider
    // exactly as a task's is - which is what this limit is about, since a gateway
    // fronting one subscription cannot serve two - so counting only `runs` would
    // let a chat and an implementer both start against a provider that allows one.
    // A session turn is the same claim for the same reason: it is an agent on a
    // lease, and a session that is not counted would start against a provider that
    // is already full.
    return this.db
      .prepare(
        `SELECT provider_id pid,count(*) c FROM (
           SELECT r.provider_id AS provider_id,l.heartbeat_at AS heartbeat_at FROM runs r
             JOIN run_leases l ON l.run_id=r.id
           UNION ALL
           SELECT c.provider_id,l.heartbeat_at FROM chat_runs c
             JOIN run_leases l ON l.run_id=c.id
           UNION ALL
           SELECT s.provider_id,l.heartbeat_at FROM session_runs s
             JOIN run_leases l ON l.run_id=s.id
         ) WHERE heartbeat_at>=?
         GROUP BY provider_id`
      )
      .all(cutoff);
  }

  // The run this task has in flight, as told by the leases rather than by a status
  // column. One definition, because three surfaces used to answer this question
  // differently and disagree: the dashboard held a local boolean that died on reload
  // and could not see a second tab, and both the dashboard and the TUI scanned
  // runs.status - a column that lingers as 'running' after the process that owned it
  // is gone, which is exactly the case where "still moving" is the wrong answer.
  //
  // Newest first, so a task whose second run has started while a dead first one is
  // still marked running reports the one that is actually running.
  liveRun(taskId) {
    const cutoff = new Date(Date.now() - LEASE_STALE_MS).toISOString();
    return (
      this.db
        .prepare('SELECT r.* FROM runs r JOIN run_leases l ON l.run_id=r.id WHERE r.task_id=? AND l.heartbeat_at>=? ORDER BY r.started_at DESC')
        .get(taskId, cutoff) || null
    );
  }

  // Does this task have a run in flight anywhere? Cheap enough to ask on every tick
  // of the event stream, which is what asks it - through the same query, so the
  // frame the stream sends and the condition it stops on cannot disagree.
  taskHasLiveRun(taskId) {
    return !!this.liveRun(taskId);
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

  // Set on the task rather than only on the leases, so a cancel that lands between
  // two steps of a chain - where no run exists to hold a lease - is still honoured
  // when the next agent starts.
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
  // tables. role<>'provider-test' keeps the "Test connection" button from ever
  // tripping the breaker it is trying to inspect.
  //
  // A chat turn's failure counts here too: the breaker exists to notice a provider
  // that is refusing work, and a provider refusing chats is exactly that. The
  // union is over the two tables rather than over `runs` alone because a chat run
  // is not a task's run - see chat_runs.
  countRecentFailures(providerId, sinceIso, codes = COUNTED_CODES) {
    const clause = codes.map(() => 'error LIKE ?').join(' OR ');
    return this.db
      .prepare(
        `SELECT count(*) c FROM (${this.failureRows()})
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
        `SELECT provider_id, count(*) c FROM (${this.failureRows()})
          WHERE status='failed' AND ended_at>=? AND role<>'provider-test'
            AND (${clause})
          GROUP BY provider_id`
      )
      .all(sinceIso, ...codes.map((c) => `${c} %`));
    return new Map(rows.map((r) => [r.provider_id, r.c]));
  }

  // The columns the failure window is counted from, over the three tables that
  // record an attempt. The role is a literal in the two that are not `runs`, so
  // the halves line up - a session turn is a turn of the same conversation shape
  // as a chat's, and the breaker should count it the same way.
  failureRows() {
    return `SELECT provider_id,status,ended_at,error,role FROM runs
            UNION ALL
            SELECT provider_id,status,ended_at,error,'chat' AS role FROM chat_runs
            UNION ALL
            SELECT provider_id,status,ended_at,error,'session' AS role FROM session_runs`;
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

  // -- chat -----------------------------------------------------------------
  // A conversation is ordered by insertion, and `chat_messages.id` is a uuid, so
  // the order is the rowid. It is returned as `seq` for the same reason `events`
  // returns its autoincrement id: a stream that reconnects needs a cursor, and a
  // uuid cannot be one. The `*` is expanded first so an explicit column list
  // would shadow nothing - `seq` is the only added name.

  createChatSession({ id, projectId, title, taskId, focus, system = false }) {
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO chat_sessions(id,project_id,title,created_at,updated_at,task_id,focus,system) VALUES(?,?,?,?,?,?,?,?)').run(id, projectId, title, now, now, taskId ?? null, focus ?? null, system ? 1 : 0);
    return this.getChatSession(id);
  }

  getChatSession(id) {
    return this.db.prepare('SELECT * FROM chat_sessions WHERE id=?').get(id) || null;
  }

  listChatSessions(projectId) {
    const q = projectId
      ? 'SELECT * FROM chat_sessions WHERE project_id=? ORDER BY updated_at DESC'
      : 'SELECT * FROM chat_sessions ORDER BY updated_at DESC';
    return this.db.prepare(q).all(...(projectId ? [projectId] : []));
  }

  // The timestamp a write to a conversation lands on, which has to be strictly
  // later than the one already on the row. Timestamps are millisecond-resolution
  // and a conversation is created and first written to in the same millisecond as
  // often as not, so a plain `new Date()` there leaves `updated_at` equal to
  // `created_at` - and `listChatSessions` orders by `updated_at`, so "newest
  // reply first" would quietly be creation order for exactly the conversations
  // that are moving. One millisecond past the value already there is the smallest
  // step that keeps that order honest: this column is a position in a list, and
  // the clock is only how the first one is seeded.
  #touch(previous) {
    const now = new Date().toISOString();
    if (!previous || now > previous) return now;
    const next = Date.parse(previous) + 1;
    // A timestamp that will not parse is not a position to step past: the clock is
    // a worse answer than a tie and a better one than a RangeError out of a write.
    return Number.isNaN(next) ? now : new Date(next).toISOString();
  }

  updateChatSession(id, patch) {
    const s = this.getChatSession(id);
    if (!s) return null;
    const n = { ...s, ...patch, updated_at: this.#touch(s.updated_at) };
    this.db.prepare('UPDATE chat_sessions SET title=?,updated_at=?,task_id=? WHERE id=?').run(n.title, n.updated_at, n.task_id ?? null, id);
    return this.getChatSession(id);
  }

  getChatMessage(id) {
    return this.db.prepare('SELECT rowid AS seq,* FROM chat_messages WHERE id=?').get(id) || null;
  }

  // Writing a message is also what makes its conversation current: the session
  // list is ordered by `updated_at`, and a chat whose newest reply is an hour old
  // would otherwise sort as though nothing had been said. The row is read back for
  // its timestamp because the step is off *that* value rather than off the clock -
  // see `#touch`.
  addChatMessage(m) {
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO chat_messages(id,session_id,role,content,run_id,created_at) VALUES(?,?,?,?,?,?)').run(m.id, m.sessionId, m.role, m.content, m.runId ?? null, now);
    const s = this.getChatSession(m.sessionId);
    this.db.prepare('UPDATE chat_sessions SET updated_at=? WHERE id=?').run(this.#touch(s && s.updated_at), m.sessionId);
    return this.getChatMessage(m.id);
  }

  listChatMessages(sessionId, afterSeq = 0) {
    return this.db.prepare('SELECT rowid AS seq,* FROM chat_messages WHERE session_id=? AND rowid>? ORDER BY rowid').all(sessionId, afterSeq);
  }

  // The question a run is about to answer, or null when every question has been
  // answered. `IS` rather than `=` so the comparison is null-safe: a question
  // written without a run id is waiting on nothing, and `= NULL` would make it
  // invisible to this query rather than pending in it.
  pendingChatMessage(sessionId) {
    return (
      this.db
        .prepare(
          `SELECT rowid AS seq,* FROM chat_messages m
            WHERE m.session_id=? AND m.role='user'
              AND NOT EXISTS (SELECT 1 FROM chat_messages a WHERE a.session_id=m.session_id AND a.role='assistant' AND a.run_id IS m.run_id)
            ORDER BY m.rowid DESC LIMIT 1`
        )
        .get(sessionId) || null
    );
  }

  // Points a waiting question at a different run. A run that fails and falls back
  // hands the question over rather than answering it, and the question has to
  // follow: the column is what pairs a reply with the question it answers, so a
  // question left naming the run that died would be waiting forever for a reply
  // that is stored against a different id.
  retargetChatQuestion(sessionId, fromRunId, toRunId) {
    return this.db
      .prepare(`UPDATE chat_messages SET run_id=? WHERE session_id=? AND role='user' AND run_id=?`)
      .run(toRunId, sessionId, fromRunId).changes;
  }

  // -- chat runs ------------------------------------------------------------
  // The same writer shape as addRun/updateRun above, pointed at the chat table.
  // They are two methods rather than one that takes a table name because the two
  // rows mean different things: `runs.task_id` is the task the attempt belongs
  // to, and `chat_runs.chat_session_id` is the conversation it answers.

  addChatRun(r, chatSessionId) {
    this.db
      .prepare(
        `INSERT INTO chat_runs(id,chat_session_id,role,provider_id,model_id,status,started_at,ended_at,error,fallback_from,
           tokens,cost,duration_ms,session_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,
           cost_basis,context_tokens,relevant_files,context_budget,context_state)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        r.id, chatSessionId, r.role, r.providerId, r.modelId, r.status, r.startedAt,
        null, null, r.fallbackFrom ?? null,
        0, 0, 0, null, 0, 0, 0, 0,
        null,
        r.contextTokens ?? 0, r.relevantFiles ?? 0, r.contextBudget ?? 0, r.contextState ?? null
      );
    return r;
  }

  updateChatRun(id, patch) {
    const p = patch.status === 'succeeded' && !('error' in patch) ? { ...patch, error: null } : patch;
    const r = this.db.prepare('SELECT * FROM chat_runs WHERE id=?').get(id);
    if (!r) return null;
    const n = { ...r, ...p };
    this.db
      .prepare(
        `UPDATE chat_runs SET status=?,ended_at=?,error=?,fallback_from=?,tokens=?,cost=?,duration_ms=?,session_id=?,
           input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_write_tokens=?,cost_basis=?,
           context_tokens=?,relevant_files=?,context_budget=?,context_state=? WHERE id=?`
      )
      .run(
        n.status, n.ended_at ?? null, n.error ?? null, n.fallback_from ?? null, n.tokens ?? 0, n.cost ?? 0,
        n.duration_ms ?? 0, n.session_id ?? null, n.input_tokens ?? 0, n.output_tokens ?? 0,
        n.cache_read_tokens ?? 0, n.cache_write_tokens ?? 0, n.cost_basis ?? null,
        n.context_tokens ?? 0, n.relevant_files ?? 0, n.context_budget ?? 0, n.context_state ?? null,
        id
      );
    return n;
  }

  getChatRun(id) {
    return this.db.prepare('SELECT * FROM chat_runs WHERE id=?').get(id) || null;
  }

  listChatRuns(sessionId) {
    const q = sessionId
      ? 'SELECT * FROM chat_runs WHERE chat_session_id=? ORDER BY started_at'
      : 'SELECT * FROM chat_runs ORDER BY started_at';
    return this.db.prepare(q).all(...(sessionId ? [sessionId] : []));
  }

  // -- sessions -------------------------------------------------------------
  // A supervised session and the turns it has taken. The CRUD is the chat
  // session's, pointed at a row that carries a status, a budget and a cancel flag
  // as well - so the differences from `createChatSession` are exactly those three
  // and everything else is the same row shape.

  createSession({ id, projectId, name, providerId, modelId, mode = 'edit' }) {
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO sessions(id,project_id,name,status,provider_id,model_id,budget_tally,cancel_requested,pending_run_id,task_shaped,nudge_dismissed,changed_paths,created_at,updated_at,mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, name, 'idle', providerId ?? null, modelId ?? null, 0, 0, null, 0, 0, null, now, now, mode);
    return this.getSession(id);
  }

  getSession(id) {
    return this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) || null;
  }

  listSessions(projectId) {
    const q = projectId
      ? 'SELECT * FROM sessions WHERE project_id=? ORDER BY updated_at DESC'
      : 'SELECT * FROM sessions ORDER BY updated_at DESC';
    return this.db.prepare(q).all(...(projectId ? [projectId] : []));
  }

  // Only the columns a caller may change are read from `patch`, and `status` is
  // one of them: the reaper and the run lifecycle both write it, and a PATCH route
  // that could not name it would be a second way to change a session's state.
  updateSession(id, patch = {}) {
    const s = this.getSession(id);
    if (!s) return null;
    const n = { ...s, ...patch };
    this.db
      .prepare('UPDATE sessions SET name=?,status=?,provider_id=?,model_id=?,budget_tally=?,cancel_requested=?,pending_run_id=?,task_shaped=?,nudge_dismissed=?,changed_paths=?,mode=?,auto_allow=?,task_id=?,cwd=?,updated_at=? WHERE id=?')
      .run(
        n.name,
        n.status,
        n.provider_id ?? null,
        n.model_id ?? null,
        n.budget_tally ?? 0,
        n.cancel_requested ? 1 : 0,
        n.pending_run_id ?? null,
        n.task_shaped ? 1 : 0,
        n.nudge_dismissed ? 1 : 0,
        n.changed_paths ?? null,
        n.mode || 'read',
        n.auto_allow ? 1 : 0,
        n.task_id ?? null,
        n.cwd ?? null,
        // Touched rather than stamped, for the reason `#touch` exists: a session
        // created and first written to inside one millisecond would otherwise
        // sort by creation order in the list it is meant to be moving in.
        patch.updated_at ?? this.#touch(s.updated_at),
        id
      );
    return this.getSession(id);
  }

  // The cancel channels, mirroring the task pair. `sessions.cancel_requested` is
  // the durable one and it is a session column rather than a lease column because
  // a session's leases carry `task_id = null` - there is no task id to mark, so
  // the task-scoped `requestCancel` cannot reach them.
  setSessionCancel(sessionId, on) {
    this.db.prepare('UPDATE sessions SET cancel_requested=? WHERE id=?').run(on ? 1 : 0, sessionId);
  }

  sessionCancelRequested(sessionId) {
    const r = this.db.prepare('SELECT cancel_requested FROM sessions WHERE id=?').get(sessionId);
    return !!r?.cancel_requested;
  }

  // What supervised sessions have spent since an instant, for the daily cap. Every
  // session's, not one session's: the cap is a ceiling on what this machine spends
  // driving agents in people's checkouts, and a per-session reading of it would let
  // five sessions spend five times it. Summed from the run rows rather than from
  // `budget_tally`, because the tally is one session's lifetime and this is about
  // today - and a run still in flight has already been priced on its own row as it
  // went.
  sessionSpendSince(iso) {
    const r = this.db
      .prepare("SELECT COALESCE(SUM(cost),0) c FROM session_runs WHERE started_at >= ?")
      .get(iso);
    return r?.c || 0;
  }

  // -- session runs ---------------------------------------------------------

  addSessionRun(r, sessionId) {
    this.db
      .prepare(
        `INSERT INTO session_runs(id,session_id,role,provider_id,model_id,status,started_at,ended_at,error,fallback_from,
           tokens,cost,duration_ms,resume_session_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,
           cost_basis,context_tokens,relevant_files,context_budget,context_state)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        r.id, sessionId, r.role, r.providerId, r.modelId, r.status, r.startedAt,
        null, null, r.fallbackFrom ?? null,
        0, 0, 0, null, 0, 0, 0, 0,
        null,
        r.contextTokens ?? 0, r.relevantFiles ?? 0, r.contextBudget ?? 0, r.contextState ?? null
      );
    return r;
  }

  // runRole's patch names the claude resume id `session_id`, because that is what
  // it is called in `runs` and `chat_runs`. Here that name belongs to the parent,
  // so it is translated rather than written - a resume id landing in the parent
  // column would silently reparent the run to a session id that is not a session.
  updateSessionRun(id, patch) {
    // Copied first, because both branches below write to the patch rather than to
    // the row: one translates `session_id` out of it, and the caller's object is not
    // this function's to edit. A caller that held a patch with a resume id in it
    // would otherwise find the key gone after the first update.
    const p = { ...patch };
    // A success clears the error column unless the caller named one. Tested with
    // `in` rather than for a truthy value, so a caller that passes an explicit
    // `error: null` and one that passes nothing are the same write.
    if (p.status === 'succeeded' && !('error' in patch)) p.error = null;
    const r = this.db.prepare('SELECT * FROM session_runs WHERE id=?').get(id);
    if (!r) return null;
    if ('session_id' in p) {
      p.resume_session_id = p.session_id;
      delete p.session_id;
    }
    const n = { ...r, ...p };
    this.db
      .prepare(
        `UPDATE session_runs SET status=?,ended_at=?,error=?,fallback_from=?,tokens=?,cost=?,duration_ms=?,resume_session_id=?,
           input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_write_tokens=?,cost_basis=?,
           context_tokens=?,relevant_files=?,context_budget=?,context_state=? WHERE id=?`
      )
      .run(
        n.status, n.ended_at ?? null, n.error ?? null, n.fallback_from ?? null, n.tokens ?? 0, n.cost ?? 0,
        n.duration_ms ?? 0, n.resume_session_id ?? null, n.input_tokens ?? 0, n.output_tokens ?? 0,
        n.cache_read_tokens ?? 0, n.cache_write_tokens ?? 0, n.cost_basis ?? null,
        n.context_tokens ?? 0, n.relevant_files ?? 0, n.context_budget ?? 0, n.context_state ?? null,
        id
      );
    return n;
  }

  getSessionRun(id) {
    return this.db.prepare('SELECT * FROM session_runs WHERE id=?').get(id) || null;
  }

  listSessionRuns(sessionId) {
    const q = sessionId
      ? 'SELECT * FROM session_runs WHERE session_id=? ORDER BY started_at'
      : 'SELECT * FROM session_runs ORDER BY started_at';
    return this.db.prepare(q).all(...(sessionId ? [sessionId] : []));
  }

  // Everything that settled since a moment, for the notification watcher. A run
  // still in flight is not news, so it is not returned - the same reading
  // watchRuns takes of the runs table.
  listSessionRunsSince(since, status = null) {
    const q = status
      ? 'SELECT * FROM session_runs WHERE started_at > ? AND status = ? ORDER BY started_at'
      : 'SELECT * FROM session_runs WHERE started_at > ? ORDER BY started_at';
    return this.db.prepare(q).all(...(status ? [since, status] : [since]));
  }

  // The run this session has in flight, as told by the leases rather than by a
  // status column - the same reading `liveRun` takes of a task, and for the same
  // reason: a status lingers as 'running' after the process that owned it is gone.
  liveSessionRun(sessionId) {
    const cutoff = new Date(Date.now() - LEASE_STALE_MS).toISOString();
    return (
      this.db
        .prepare('SELECT r.* FROM session_runs r JOIN run_leases l ON l.run_id=r.id WHERE r.session_id=? AND l.heartbeat_at>=? ORDER BY r.started_at DESC')
        .get(sessionId) || null
    );
  }

  // -- permission requests --------------------------------------------------

  addPermissionRequest(p) {
    this.db
      .prepare('INSERT INTO permission_requests(id,session_id,run_id,tool,input,cwd,status,created_at,answered_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(p.id, p.sessionId, p.runId, p.tool, p.input ?? null, p.cwd ?? null, p.status || 'pending', p.createdAt, p.answeredAt ?? null);
    return this.getPermissionRequest(p.id);
  }

  getPermissionRequest(id) {
    return this.db.prepare('SELECT * FROM permission_requests WHERE id=?').get(id) || null;
  }

  // The one unanswered request a session has, or null. Newest first, because an
  // agent that has been blocked twice in a row is waiting on the later one and the
  // earlier was answered to let it get there.
  pendingPermission(sessionId) {
    return (
      this.db
        .prepare("SELECT * FROM permission_requests WHERE session_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1")
        .get(sessionId) || null
    );
  }

  // Every unanswered request on the machine, oldest first: the order they will time
  // out in, which is the order a person working through them should take.
  listPendingPermissions() {
    return this.db.prepare("SELECT * FROM permission_requests WHERE status='pending' ORDER BY created_at").all();
  }

  listPermissionRequests(sessionId) {
    return this.db.prepare('SELECT * FROM permission_requests WHERE session_id=? ORDER BY created_at').all(sessionId);
  }

  updatePermissionRequest(id, patch = {}) {
    const p = this.getPermissionRequest(id);
    if (!p) return null;
    const n = { ...p, ...patch };
    this.db
      .prepare('UPDATE permission_requests SET status=?,answered_at=?,auto=? WHERE id=?')
      .run(n.status, n.answered_at ?? null, n.auto ? 1 : 0, id);
    return this.getPermissionRequest(id);
  }

  // Every request still pending when the deadline passed, moved to `timeout`.
  // A sweep rather than a timer per row, because the request that matters is the
  // one whose process died: a timer dies with the process that armed it, and this
  // still finds the row. Returns the ids so the caller can release any waiter it
  // is still holding in memory.
  sweepTimeoutPermissions(cutoffIso) {
    const rows = this.db
      .prepare("SELECT id FROM permission_requests WHERE status='pending' AND created_at < ?")
      .all(cutoffIso);
    if (!rows.length) return [];
    const now = new Date().toISOString();
    const stmt = this.db.prepare("UPDATE permission_requests SET status='timeout',answered_at=? WHERE id=? AND status='pending'");
    for (const r of rows) stmt.run(now, r.id);
    return rows.map((r) => r.id);
  }

  // -- decision log ---------------------------------------------------------

  addDecision(d) {
    this.db
      .prepare('INSERT INTO decisions(id,project_id,task_id,content,state,created_at,approved_at) VALUES(?,?,?,?,?,?,?)')
      .run(d.id, d.projectId, d.taskId ?? null, d.content, d.state, d.createdAt, d.approvedAt ?? null);
    return this.getDecision(d.id);
  }

  getDecision(id) {
    return this.db.prepare('SELECT * FROM decisions WHERE id=?').get(id) || null;
  }

  // `state` filters to one of draft|approved|rejected; absent it, everything the
  // project has ever decided and declined. Oldest first, because a decision log is
  // read as a history - what was decided before what - rather than as a feed.
  listDecisions(projectId, state) {
    const where = [];
    const params = [];
    if (projectId) { where.push('project_id=?'); params.push(projectId); }
    if (state) { where.push('state=?'); params.push(state); }
    const q = `SELECT * FROM decisions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`;
    return this.db.prepare(q).all(...params);
  }

  // Only the two fields a person's approval moves. `content` is not among them: an
  // approved entry is the text that was approved, and an edit of it after the fact
  // would be a decision recorded in words nobody agreed to.
  updateDecision(id, patch) {
    const d = this.getDecision(id);
    if (!d) throw new Error('Decision not found');
    const n = { ...d, ...patch };
    this.db.prepare('UPDATE decisions SET state=?,approved_at=? WHERE id=?').run(n.state, n.approved_at ?? null, id);
    return this.getDecision(id);
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
