import { cancelled } from './service.mjs';

// The default number of jobs the queue will run at once, before provider limits
// narrow it further.
const DEFAULT_CONCURRENCY = 2;

// Gateways that front a single subscription or a single machine handle one agent
// at a time; a hosted API is happy with a couple. A provider that knows better
// sets `config.maxConcurrency`.
const DEFAULT_PROVIDER_CONCURRENCY = { 'claude-code': 1, deepseek: 2, openrouter: 2 };

// The background job queue.
//
// It lives in the server process, not in the CLI: `ai-code task execute --background`
// exits immediately, so it cannot host the work it asked for. A queue in a process
// that is about to exit is not a queue.
export class Runner {
  constructor(service, options = {}) {
    this.service = service;
    this.store = service.store;
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_CONCURRENCY;
    this.log = options.log ?? ((m) => process.stdout.write(`${m}\n`));
    // Jobs waiting for a slot, and the ones running now, in memory. The `jobs`
    // table is the durable mirror the UIs read; these two are the live queue.
    this.queued = [];
    this.running = new Map();
    this.stopped = false;
    this.recover();
  }

  // A job row left queued or running belongs to a server that is gone. The queue
  // is deliberately in-process, so this process is the only one that could be
  // driving them, and it has just started.
  recover() {
    for (const j of this.store.activeJobs()) {
      this.store.updateJob(j.id, { state: 'interrupted', ended_at: new Date().toISOString(), error: 'Server restarted' });
    }
  }

  // What this provider will tolerate at once.
  limitFor(provider) {
    const configured = provider.config?.maxConcurrency;
    if (Number.isFinite(configured) && configured > 0) return configured;
    return DEFAULT_PROVIDER_CONCURRENCY[provider.kind] ?? 1;
  }

  // Counted from the live leases rather than from this process's run registry: a
  // provider is busy if an agent is talking to it, and that agent need not be
  // ours. The dashboard holds a foreground run the CLI cannot see, and a second
  // server on the same database holds runs neither of them can see - so the
  // count comes from the one thing all of them write, which is the lease.
  //
  // The query is a grouped join over a table with as many rows as there are runs
  // in flight, so asking it once per provider per routing decision costs nothing.
  runningByProvider(providerId) {
    const row = this.store.countRunningByProvider().find((r) => r.pid === providerId);
    return row ? row.c : 0;
  }

  // Asked by `Service.eligible`, so a saturated provider is simply not a
  // candidate for the next run rather than a run that queues behind itself.
  atCapacity(provider) {
    return this.runningByProvider(provider.id) >= this.limitFor(provider);
  }

  // Jobs that may run at once. Bounded by the total provider capacity: starting a
  // job whose every provider is already taken would fail it for a queueing
  // reason, which reads to the user as a routing failure.
  limit() {
    const capacity = this.store
      .listProviders()
      .filter((p) => p.enabled)
      .reduce((sum, p) => sum + this.limitFor(p), 0);
    return Math.max(1, Math.min(this.maxConcurrency, capacity || this.maxConcurrency));
  }

  // Queue one step, or the whole chain under the `execute` kind. Returns the job
  // row immediately; the work happens on the next tick.
  enqueue(taskId, kind = 'execute') {
    if (this.stopped) throw new Error('The server is shutting down');
    const job = this.store.addJob({ id: this.store.id(), taskId, kind, state: 'queued', createdAt: new Date().toISOString() });
    this.queued.push(job);
    this.#pump();
    return this.store.getJob(job.id);
  }

  list(taskId) {
    return this.store.listJobs(taskId);
  }

  // Fill every free slot. Called on enqueue and again whenever a job settles.
  #pump() {
    while (!this.stopped && this.queued.length && this.running.size < this.limit()) {
      this.#dispatch(this.queued.shift());
    }
  }

  #dispatch(job) {
    this.running.set(job.id, job);
    // A background job writes nothing to the terminal. Its stderr is the
    // server's, and two concurrent spinners interleave into garbage.
    this.service.quiet = true;
    this.store.updateJob(job.id, { state: 'running', started_at: new Date().toISOString() });
    this.log(`[job ${job.kind}] ${job.task_id} started`);

    this.#step(job)
      .then(() => this.#settle(job, 'succeeded', null))
      .catch((e) => {
        const state = e?.code === 'CANCELLED' ? 'cancelled' : 'failed';
        this.#settle(job, state, e?.message || String(e));
      });
  }

  // Which service call a job kind names. Every kind is one step of the workflow,
  // so this table is also the list of things that can be run in the background.
  //
  // `chat` is the one kind whose `task_id` is not a task: it is the id of the chat
  // session, because that is what the job is bound to. The unique index on
  // (task_id, active) is what makes it the right thing to put there - one turn of
  // one conversation at a time is exactly the constraint a conversation needs, and
  // the database enforces it rather than a flag in the server.
  #step(job) {
    switch (job.kind) {
      case 'chat': return this.service.chat(job.task_id);
      case 'implement': return this.service.implement(job.task_id);
      case 'test': return this.service.runTests(job.task_id);
      case 'review': return this.service.review(job.task_id);
      case 'repair': return this.service.repair(job.task_id);
      case 'retry': return this.service.retry(job.task_id);
      default: return this.service.execute(job.task_id);
    }
  }

  #settle(job, state, error) {
    this.running.delete(job.id);
    this.service.quiet = this.running.size > 0;
    this.store.updateJob(job.id, { state, error, ended_at: new Date().toISOString() });
    this.log(`[job ${job.kind}] ${job.task_id} ${state}${error ? `: ${error.split('\n')[0]}` : ''}`);
    this.#pump();
  }

  // Stops everything this process is driving. The server calls this from its
  // signal handlers, which is the only thing standing between a Ctrl-C and a set
  // of detached agent process groups left running with nobody watching them.
  shutdown() {
    this.stopped = true;
    const now = new Date().toISOString();
    for (const job of this.queued) {
      this.store.updateJob(job.id, { state: 'cancelled', error: 'Server shutting down', ended_at: now });
    }
    this.queued.length = 0;
    this.service.abortAll(cancelled());
  }
}
