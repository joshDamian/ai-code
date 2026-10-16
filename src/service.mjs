// @ts-check
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from './env.mjs';
import { Store } from './store.mjs';
import { Runtime, MODES } from './runtime.mjs';
import { providerReady } from './providers.mjs';
import { benchServer } from './tools.mjs';
import { Loop, newLoop } from './loop.mjs';
import * as g from './git.mjs';

/** @typedef {import('./contract.mjs').Task} Task */
/** @typedef {import('./contract.mjs').Session} Session */
/** @typedef {import('./contract.mjs').TaskGit} TaskGit */
/** @typedef {import('./contract.mjs').PermissionMode} PermissionMode */

// Everything the CLI and the server can do, in one place. The server adds transport;
// this adds no policy beyond git's own. Events: 'task' when a task row changes and
// 'git' when a project's repository may have moved.

const DEFAULT_PROVIDER = 'anthropic-claude-code';
// How hard the model thinks. Null leaves it to Claude Code's default for the model.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** @param {unknown} e */
function effortOf(e) {
  if (e === undefined) return undefined;
  if (e === null || e === '') return null;
  if (!EFFORTS.includes(String(e))) throw fail(`Unknown effort ${e}; use one of ${EFFORTS.join(', ')}`);
  return String(e);
}

/** @param {string} text */
function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'task';
}

/** @param {string} p */
const expandHome = (p) => p.replace(/^~(?=$|\/)/, os.homedir());

/** A folder name from a project or repository name: no separators, nothing hidden. @param {string} n */
function safeName(n) {
  const s = String(n).trim().replace(/[\/\\]+/g, '-').replace(/[^\w.\- ]+/g, '-').replace(/^[.\-\s]+/, '').slice(0, 100);
  if (!s) throw fail('That name cannot be a folder name');
  return s;
}

/** @param {string} msg @param {number} [status] */
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

export class Service extends EventEmitter {
  /** @param {string} root @param {{query?: any, idleMs?: number}} [o] */
  constructor(root = process.cwd(), o = {}) {
    super();
    this.root = root;
    this.store = new Store(root);
    // Each session's own bench MCP server: tools that act on its task and project.
    this.runtime = new Runtime(this.store, { ...o, mcp: (sessionId) => benchServer(this, sessionId) });
    /**
     * Sends a push notification to the person's devices, and says to how many. Set by
     * the server, which holds the push keys; null where there is no push (the CLI, tests).
     * @type {((payload: {title:string, body:string, url?:string, tag?:string, sessionId?:string}) => Promise<number>) | null}
     */
    this.notifier = null;
    /**
     * Loop until done: what feeds a task's failing check back to its session. It listens for
     * the runtime's turn-done, so a loop is driven by turns ending, not by a timer.
     */
    this.loop = new Loop(this);
    this.runtime.on('turn-done', ({ session }) => session && this.emit('git', session.project_id));
    this.runtime.on('task', (t) => this.emit('task', t));
    this.#importLegacy();
  }

  // -- projects ---------------------------------------------------------------------

  /** @param {string} id */
  project(id) {
    const p = this.store.getProject(id);
    if (!p) throw fail('No such project', 404);
    return p;
  }

  /**
   * Registers a directory. A directory that is not a repository is refused unless
   * `init`, which makes it one with a first commit, so a task has a HEAD to branch from.
   * @param {{name?:string, path:string, init?:boolean}} o
   */
  addProject(o) {
    const dir = path.resolve(expandHome(String(o.path || '')));
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw fail(`No such directory: ${dir}`);
    if (!g.isRepo(dir)) {
      if (!o.init) throw Object.assign(fail(`${dir} is not a git repository`), { code: 'NOT_A_REPO' });
      g.git(dir, ['init', '-q']);
    }
    const top = g.topLevel(dir);
    if (!g.revParse(top)) {
      g.git(top, ['add', '-A']);
      g.git(top, ['-c', 'user.email=bench@localhost', '-c', 'user.name=Bench', 'commit', '-q', '--allow-empty', '-m', 'Initial commit']);
    }
    const existing = this.store.projectByPath(top);
    if (existing) return existing;
    return this.store.addProject({ name: o.name?.trim() || path.basename(top), path: top });
  }

  /** Where cloned and new projects go unless a person picks somewhere else. */
  projectsDir() {
    const set = this.store.getSetting('projects_dir') || env('PROJECTS_DIR');
    return path.resolve(expandHome(set || path.join(os.homedir(), 'bench-projects')));
  }

  /**
   * Clones a repository into `dir` (the projects folder by default) and registers it.
   * @param {{repo:string, dir?:string, name?:string}} o
   */
  async cloneProject(o) {
    let spec;
    try {
      spec = g.repoSpec(o.repo);
    } catch (e) {
      throw fail(/** @type {Error} */ (e).message);
    }
    const target = path.join(o.dir ? path.resolve(expandHome(o.dir)) : this.projectsDir(), safeName(o.name || spec.name));
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw Object.assign(fail(`${target} already exists and is not empty`, 409), { code: 'EXISTS', path: target });
    try {
      await g.clone(spec, target);
    } catch (e) {
      throw fail(/** @type {Error} */ (e).message);
    }
    return this.addProject({ path: target, name: o.name });
  }

  /**
   * A new, empty project: a folder with a fresh repository and a first commit.
   * @param {{name:string, dir?:string}} o
   */
  createProject(o) {
    if (!o.name?.trim()) throw fail('Name the project');
    const target = path.join(o.dir ? path.resolve(expandHome(o.dir)) : this.projectsDir(), safeName(o.name));
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw Object.assign(fail(`${target} already exists and is not empty`, 409), { code: 'EXISTS', path: target });
    fs.mkdirSync(target, { recursive: true });
    return this.addProject({ path: target, name: o.name.trim(), init: true });
  }

  /** @returns {Promise<{ready:boolean, repos:any[]}>} */
  async githubRepos() {
    if (!(await g.ghReady())) return { ready: false, repos: [] };
    return { ready: true, repos: await g.githubRepos() };
  }

  /**
   * Unregisters a project. Its directory, worktrees and branches are left alone. Its
   * sessions are closed and their scratch folders removed with them, so nothing of the
   * project's is left behind for the sweep to find.
   * @param {string} id
   */
  removeProject(id) {
    for (const s of this.store.listSessions({ projectId: id, archived: true })) {
      this.runtime.close(s.id);
      this.runtime.dropScratch(s.id);
    }
    this.store.deleteProject(id);
  }

  /** @param {string} id */
  git(id) {
    return g.gitState(this.project(id).path);
  }

  /** @param {string} id */
  async fetch(id) {
    await g.fetchAll(this.project(id).path);
    this.emit('git', id);
    return this.git(id);
  }

  /** @param {string} id */
  async pull(id) {
    await g.pull(this.project(id).path);
    this.emit('git', id);
    return this.git(id);
  }

  /** @param {string} id */
  async push(id) {
    const p = this.project(id);
    const branch = g.currentBranch(p.path);
    if (!branch) throw fail('The checkout is not on a branch');
    await g.push(p.path, branch);
    this.emit('git', id);
    return this.git(id);
  }

  /** @param {string} id @param {{branch:string, create?:boolean, from?:string, stash?:boolean}} o */
  checkout(id, o) {
    const p = this.project(id);
    const busy = this.store.listSessions({ projectId: id }).find((s) => !s.task_id && s.status !== 'idle' && s.status !== 'error');
    if (busy) throw fail(`"${busy.title}" is working in this checkout; stop it before switching branches`, 409);
    try {
      const r = g.checkout(p.path, o.branch, o);
      this.emit('git', id);
      return r;
    } catch (e) {
      const err = /** @type {any} */ (e);
      if (err.code === 'DIRTY') throw Object.assign(fail(err.message, 409), { code: 'DIRTY', dirty: err.dirty });
      throw fail(err.message);
    }
  }

  /** @param {string} id @param {string} message */
  commit(id, message) {
    if (!message?.trim()) throw fail('A commit needs a message');
    const sha = g.commitAll(this.project(id).path, message.trim());
    if (!sha) throw fail('Nothing to commit');
    this.emit('git', id);
    return { commit: sha };
  }

  /** @param {string} id */
  checkoutDiff(id) {
    const dir = this.project(id).path;
    const head = g.revParse(dir);
    return { diff: head ? g.workingDiff(dir, head) : '' };
  }

  // -- tasks ------------------------------------------------------------------------

  /** @param {string} id */
  task(id) {
    const t = this.store.getTask(id);
    if (!t) throw fail('No such task', 404);
    return t;
  }

  /** @param {string} [projectId] */
  tasks(projectId) {
    return this.store.listTasks(projectId);
  }

  /**
   * A new branch from `baseBranch`, in its own worktree, with a session working in it.
   * The base defaults to whatever the checkout has out, and need not be checked out:
   * the worktree is cut from the ref, so the checkout is never switched.
   * @param {string} projectId
   * `done` says in words what finished looks like; `check` is the command Bench runs to
   * check it, and defaults to the project's. An empty `check` means none.
   * `createdBy` is the session that asked for the task through the bench tool.
   * `loop` turns on the unattended loop at once, for its caps and nobody else's: it is not
   * something a session can ask for through the bench tools.
   * @param {{title?:string, prompt?:string, baseBranch?:string, providerId?:string, modelId?:string|null, mode?:PermissionMode, effort?:string|null, done?:string|null, check?:string|null, createdBy?:string|null, loop?:{max_attempts?:unknown, max_minutes?:unknown}|null}} o
   */
  createTask(projectId, o) {
    const p = this.project(projectId);
    const prompt = (o.prompt || '').trim();
    const title = (o.title || '').trim() || (prompt ? prompt.split('\n')[0].slice(0, 80) : '');
    if (!title) throw fail('A task needs a title or a prompt');
    const base = o.baseBranch || g.currentBranch(p.path);
    if (!base) throw fail('The checkout is detached; pick a base branch');
    try {
      g.ensureLocalBranch(p.path, base);
    } catch (e) {
      throw fail(/** @type {Error} */ (e).message);
    }
    const baseCommit = /** @type {string} */ (g.revParse(p.path, `refs/heads/${base}`));
    const id = this.store.id();
    const branch = `bench/${slug(title)}-${id.slice(0, 6)}`;
    const worktree = path.join(g.worktreeRoot(p.path), id);
    try {
      g.createWorktree(p.path, worktree, branch, baseCommit);
    } catch (e) {
      throw fail(g.gitError(e));
    }
    const done = (o.done || '').trim() || null;
    const check = (o.check === undefined ? p.check_command : o.check)?.trim() || null;
    // A loop with no check to end it would run to its caps and stop there every time.
    const loop = o.loop ? newLoop(o.loop, check) : null;
    const task = this.store.addTask({ id, project_id: p.id, title, description: prompt || null, base_branch: base, base_commit: baseCommit, branch, worktree, done, check_command: check, created_by_session: o.createdBy || null, loop });
    this.emit('task', task);
    this.emit('git', p.id);
    const session = this.createSession({ projectId: p.id, taskId: id, title, providerId: o.providerId, modelId: o.modelId, mode: o.mode, effort: o.effort, startedBy: o.createdBy || null });
    if (prompt) this.send(session.id, prompt);
    if (loop) void this.loop.start(id);
    return { task: this.task(id), session: this.store.getSession(session.id) };
  }

  /** How the task's branch stands. @param {string} id @returns {TaskGit} */
  taskGit(id) {
    const t = this.task(id);
    const p = this.project(t.project_id);
    const repo = p.path;
    const gone = !fs.existsSync(t.worktree);
    const tip = g.revParse(repo, `refs/heads/${t.branch}`);
    const base = g.revParse(repo, `refs/heads/${t.base_branch}`);
    const st = gone ? { dirty: [], conflicted: [] } : g.status(t.worktree);
    const { ahead, behind } = tip && base ? g.compare(repo, t.branch, t.base_branch) : { ahead: 0, behind: 0 };
    const from = tip && base ? g.mergeBase(repo, tip, base) : null;
    const stat = !gone && from ? g.workingStat(t.worktree, from) : { files: 0, added: 0, removed: 0 };
    // A task with no commits of its own is not merged just because its tip is in the base.
    const merged = t.state === 'merged' || !!(tip && base && tip !== t.base_commit && ahead === 0 && !st.dirty.length);
    /** @type {TaskGit['canMerge']} */
    let canMerge = { ok: true, reason: null, conflicts: [] };
    if (t.state !== 'active') canMerge = { ok: false, reason: `The task is ${t.state}`, conflicts: [] };
    else if (!base) canMerge = { ok: false, reason: `${t.base_branch} no longer exists`, conflicts: [] };
    else if (st.conflicted.length) canMerge = { ok: false, reason: 'The worktree has unresolved conflicts', conflicts: st.conflicted };
    else if (!ahead && !st.dirty.length) canMerge = { ok: false, reason: 'Nothing to merge yet', conflicts: [] };
    else if (tip && ahead) {
      const m = g.mergeTree(repo, base, tip);
      if (!m.clean) canMerge = { ok: false, reason: `Conflicts with ${t.base_branch}`, conflicts: m.conflicts };
    }
    return { ahead, behind, dirty: st.dirty, conflicted: st.conflicted, ...stat, merged, canMerge };
  }

  /** Everything the task changed since it left its base, uncommitted work included. @param {string} id */
  taskDiff(id) {
    const t = this.task(id);
    if (!fs.existsSync(t.worktree)) return { diff: '' };
    const repo = this.project(t.project_id).path;
    const base = g.revParse(repo, `refs/heads/${t.base_branch}`);
    const from = (base && g.mergeBase(t.worktree, 'HEAD', base)) || t.base_commit;
    return { diff: g.workingDiff(t.worktree, from) };
  }

  /** A session working in the task, other than `except`. @param {string} id @param {string} [except] */
  #liveTaskWork(id, except) {
    return this.store.listSessions({ taskId: id }).find((s) => s.id !== except && (s.status === 'running' || s.status === 'waiting'));
  }

  /** @param {string} id @param {string} [message] */
  commitTask(id, message) {
    const t = this.task(id);
    const sha = g.commitAll(t.worktree, message?.trim() || t.title);
    if (!sha) throw fail('Nothing to commit');
    this.emit('git', t.project_id);
    return { commit: sha };
  }

  /**
   * Merges the base branch's new commits into the task. Conflicts stay in the worktree.
   * `except` is a session asking for it itself, which is working by definition.
   * @param {string} id @param {{except?:string}} [o]
   */
  updateFromBase(id, o = {}) {
    const t = this.task(id);
    if (this.#liveTaskWork(id, o.except)) throw fail('A session is working in this task; wait for it or stop it', 409);
    if (g.status(t.worktree).dirty.length) throw fail('Commit the task\'s changes first, so the merge cannot mix with them', 409);
    let r;
    try {
      r = g.mergeInto(t.worktree, t.base_branch);
    } catch (e) {
      throw fail(/** @type {Error} */ (e).message);
    }
    this.emit('git', t.project_id);
    return r;
  }

  /** @param {string} id */
  abortTaskMerge(id) {
    const t = this.task(id);
    g.abortMerge(t.worktree);
    this.emit('git', t.project_id);
    return { ok: true };
  }

  /**
   * Lands the task on its base branch. Uncommitted work is committed first, under the
   * task's title. `cleanup` then removes the worktree and the branch and archives the
   * task's sessions, because a merged task has nothing left to do in them.
   * @param {string} id @param {{strategy?:'merge'|'squash', message?:string, cleanup?:boolean}} [o]
   */
  mergeTask(id, o = {}) {
    const t = this.task(id);
    if (t.state !== 'active') throw fail(`The task is already ${t.state}`, 409);
    if (this.#liveTaskWork(id)) throw fail('A session is working in this task; wait for it or stop it', 409);
    const repo = this.project(t.project_id).path;
    if (fs.existsSync(t.worktree)) {
      if (g.status(t.worktree).conflicted.length) throw fail('Resolve the conflicts in the task first', 409);
      g.commitAll(t.worktree, t.title);
    }
    let landed;
    try {
      landed = g.land(repo, { branch: t.branch, target: t.base_branch, message: o.message?.trim() || (o.strategy === 'squash' ? t.title : `Merge task: ${t.title}`), strategy: o.strategy || 'merge' });
    } catch (e) {
      const err = /** @type {any} */ (e);
      throw Object.assign(fail(err.message, err.code === 'CONFLICT' ? 409 : 400), { code: err.code, conflicts: err.conflicts });
    }
    // The task is landed: there is nothing left for a loop to work towards.
    this.loop.stop(id, 'stopped', 'the task was merged');
    const updated = this.store.updateTask(id, { state: 'merged', merge_commit: landed.commit, merged_at: new Date().toISOString() });
    if (o.cleanup) this.#cleanup(updated, true);
    this.emit('task', updated);
    this.emit('git', t.project_id);
    return { task: this.task(id), ...landed };
  }

  /** @param {Task} t @param {boolean} deleteBranch */
  #cleanup(t, deleteBranch) {
    const repo = this.project(t.project_id).path;
    for (const s of this.store.listSessions({ taskId: t.id })) {
      this.runtime.close(s.id);
      this.runtime.dropScratch(s.id);
      this.runtime.emit('session', this.store.updateSession(s.id, { archived_at: new Date().toISOString() }));
    }
    try {
      g.removeWorktree(repo, t.worktree);
    } catch {
      /* already gone */
    }
    if (deleteBranch) {
      try {
        g.deleteBranch(repo, t.branch);
      } catch {
        /* already gone */
      }
    }
  }

  /** Throws the task away: its sessions archived, its worktree removed. @param {string} id @param {{deleteBranch?:boolean}} [o] */
  closeTask(id, o = {}) {
    const t = this.task(id);
    if (t.state !== 'active') throw fail(`The task is already ${t.state}`, 409);
    this.loop.stop(id, 'stopped', 'the task was closed');
    this.#cleanup(t, !!o.deleteBranch);
    const updated = this.store.updateTask(id, { state: 'closed' });
    this.emit('task', updated);
    this.emit('git', t.project_id);
    return updated;
  }

  /** A closed task whose branch survives gets its worktree back. @param {string} id */
  reopenTask(id) {
    const t = this.task(id);
    if (t.state !== 'closed') throw fail('Only a closed task can be reopened', 409);
    const repo = this.project(t.project_id).path;
    if (!g.revParse(repo, `refs/heads/${t.branch}`)) throw fail(`The branch ${t.branch} was deleted`, 409);
    if (!fs.existsSync(t.worktree)) g.git(repo, ['worktree', 'add', '-q', t.worktree, t.branch]);
    for (const s of this.store.listSessions({ taskId: id, archived: true })) this.runtime.emit('session', this.store.updateSession(s.id, { archived_at: null }));
    const updated = this.store.updateTask(id, { state: 'active' });
    this.emit('task', updated);
    return updated;
  }

  /** @param {string} id */
  async pushTask(id) {
    const t = this.task(id);
    if (fs.existsSync(t.worktree)) g.commitAll(t.worktree, t.title);
    await g.push(this.project(t.project_id).path, t.branch);
    this.emit('git', t.project_id);
    return { ok: true };
  }

  /** @param {string} id @param {{title?:string, body?:string}} [o] */
  async pullRequest(id, o = {}) {
    const t = this.task(id);
    if (!(await g.ghReady())) throw fail('The GitHub CLI is not logged in on this machine; run `gh auth login`');
    await this.pushTask(id);
    const url = await g.createPullRequest(this.project(t.project_id).path, { head: t.branch, base: t.base_branch, title: o.title?.trim() || t.title, body: o.body ?? t.description ?? '' });
    return { url };
  }

  /**
   * A new title, or a new bar for done. Changing the bar clears the last check's result,
   * which judged the old one, and closes the task's idle sessions so that each picks the
   * new bar up when it resumes.
   *
   * `loop` turns the unattended loop on, retunes a running one's caps, or - with null -
   * stops it. Like the bar, this is a person's to set: no bench tool reaches it.
   * @param {string} id
   * @param {{title?:string, done?:string|null, check?:string|null, loop?:{max_attempts?:unknown, max_minutes?:unknown}|null}} patch
   */
  editTask(id, patch) {
    const t0 = this.task(id);
    /** @type {Partial<Task>} */
    const change = {};
    if (patch.title !== undefined) {
      if (!patch.title?.trim()) throw fail('A title cannot be empty');
      change.title = patch.title.trim();
    }
    const bar = patch.done !== undefined || patch.check !== undefined;
    if (patch.done !== undefined) change.done = patch.done?.trim() || null;
    if (patch.check !== undefined) change.check_command = patch.check?.trim() || null;
    if (bar) Object.assign(change, { check_status: null, check_tree: null, check_output: null, check_at: null });
    if (patch.loop !== undefined && patch.loop !== null) {
      const check = bar ? change.check_command : t0.check_command;
      change.loop = newLoop(patch.loop, check || null, t0.loop?.state === 'looping' ? t0.loop : null);
    }
    // Off is two things: the loop ends with a reason in the log, and the task stops carrying
    // one at all. The log is where the audit trail of an overnight run stays.
    if (patch.loop === null) {
      this.loop.off(id);
      change.loop = null;
    }
    this.store.updateTask(t0.id, change);
    if (bar) for (const s of this.store.listSessions({ taskId: id })) if (!this.runtime.busy(s.id)) this.runtime.close(s.id);
    if (change.loop) void this.loop.start(id);
    // Starting a loop can already have written to the task - an attempt, or a stop because
    // there is no session to feed - so the answer is the task as it stands now.
    const now = this.task(id);
    this.emit('task', now);
    return now;
  }

  /** Runs the task's check now, whether or not anything changed. @param {string} id */
  async checkTask(id) {
    const t = this.task(id);
    if (!t.check_command) throw fail('This task has no check; add one first');
    if (t.state !== 'active') throw fail(`The task is ${t.state}`, 409);
    await this.runtime.check(id, { force: true });
    return this.task(id);
  }

  /** A task's decision log, newest first. @param {string} id */
  taskLog(id) {
    this.task(id);
    return this.store.listLog(id);
  }

  /**
   * One entry in the decision log of the task a session works in. It shows in the
   * session's transcript too, and the task is touched so its page picks it up.
   * @param {string} sessionId @param {{decision:string, evidence:string}} e
   */
  logDecision(sessionId, e) {
    const s = this.session(sessionId);
    if (!s.task_id) throw fail('This session is not in a task, so there is no decision log to write to');
    const decision = String(e.decision || '').trim();
    const evidence = String(e.evidence || '').trim();
    if (!decision || !evidence) throw fail('A log entry needs both a decision and its evidence');
    const entry = this.store.addLog({ task_id: s.task_id, session_id: s.id, decision, evidence });
    this.runtime.record(s.id, 'log', { decision, evidence, entry: entry.id });
    this.emit('task', this.store.updateTask(s.task_id, {}));
    return entry;
  }

  /**
   * A review of a task's change, in its log: who reviewed it and what it found. It shows in
   * the transcript of the session that asked for it, as a log entry does.
   * @param {string} taskId @param {{reviewer:string, by:string, findings:string, askedBy?:string|null, design?:boolean}} r
   * `reviewer` is the reviewing session, `by` its provider and model in words; `design` for a
   * review of the rendered UI rather than the diff.
   */
  recordReview(taskId, r) {
    this.task(taskId);
    const entry = this.store.addLog({ task_id: taskId, session_id: r.reviewer, kind: 'review', decision: `${r.design ? 'Design review' : 'Review'} by ${r.by}`, evidence: r.findings.trim() || '(no reply)' });
    if (r.askedBy) this.runtime.record(r.askedBy, 'log', { decision: entry.decision, evidence: entry.evidence, entry: entry.id, kind: 'review' });
    this.emit('task', this.store.updateTask(taskId, {}));
    return entry;
  }

  // -- sessions ---------------------------------------------------------------------

  /** @param {string} id */
  session(id) {
    const s = this.store.getSession(id);
    if (!s) throw fail('No such session', 404);
    return s;
  }

  /** @param {{projectId?:string, taskId?:string, archived?:boolean}} [q] */
  sessions(q) {
    return this.store.listSessions(q);
  }

  defaults() {
    return {
      projectsDir: this.projectsDir(),
      providerId: this.store.getSetting('default_provider') || DEFAULT_PROVIDER,
      modelId: this.store.getSetting('default_model') || null,
      mode: /** @type {PermissionMode} */ (this.store.getSetting('default_mode') || 'default'),
      effort: this.store.getSetting('default_effort') || null,
    };
  }

  /** @param {{providerId?:string, modelId?:string|null, mode?:string, effort?:string|null, projectsDir?:string|null}} o */
  setDefaults(o) {
    if (o.projectsDir !== undefined) this.store.setSetting('projects_dir', o.projectsDir ? path.resolve(expandHome(o.projectsDir)) : '');
    const effort = effortOf(o.effort);
    if (effort !== undefined) this.store.setSetting('default_effort', effort || '');
    if (o.providerId) this.store.setSetting('default_provider', o.providerId);
    if (o.modelId !== undefined) this.store.setSetting('default_model', o.modelId || '');
    if (o.mode && MODES.includes(/** @type {any} */ (o.mode))) this.store.setSetting('default_mode', o.mode);
    return this.defaults();
  }

  /**
   * A session in a task's worktree, or in the project's own checkout when there is no task.
   * `startedBy` is the session that started it through a bench tool; `purpose` is 'review'
   * for one request_review started. `images` go with the prompt, as a person's pasted ones do.
   * @param {{projectId:string, taskId?:string|null, title?:string, providerId?:string, modelId?:string|null, mode?:PermissionMode, effort?:string|null, prompt?:string, images?:{media_type:string, data:string}[], startedBy?:string|null, purpose?:string|null}} o
   */
  createSession(o) {
    const p = this.project(o.projectId);
    const t = o.taskId ? this.task(o.taskId) : null;
    if (t && t.project_id !== p.id) throw fail('That task belongs to another project');
    if (t && t.state !== 'active') throw fail(`The task is ${t.state}`, 409);
    const d = this.defaults();
    const providerId = o.providerId || d.providerId;
    const provider = this.store.getProvider(providerId);
    if (!provider) throw fail(`No provider ${providerId}`);
    const ready = providerReady(provider);
    if (!ready.ready) throw fail(`${provider.name}: ${ready.reason}`);
    const modelId = o.modelId !== undefined ? o.modelId : providerId === d.providerId ? d.modelId : null;
    if (modelId && this.store.getModel(modelId)?.provider_id !== providerId) throw fail('That model is not on that provider');
    const mode = o.mode || d.mode;
    if (!MODES.includes(/** @type {any} */ (mode))) throw fail(`Unknown mode ${mode}`);
    const s = this.store.addSession({
      project_id: p.id,
      task_id: t?.id || null,
      title: o.title?.trim() || (t ? 'New task session' : 'New session'),
      cwd: t ? t.worktree : p.path,
      provider_id: providerId,
      model_id: modelId || null,
      permission_mode: mode,
      effort: (o.effort === undefined ? d.effort : effortOf(o.effort)) || null,
      started_by_session: o.startedBy || null,
      purpose: o.purpose || null,
    });
    this.runtime.emit('session', s);
    if (o.prompt?.trim()) this.send(s.id, o.prompt, o.images?.length ? { images: o.images } : undefined);
    return this.session(s.id);
  }

  /** @param {string} id @param {string} text @param {{images?: {media_type:string, data:string}[], files?: {name:string, media_type?:string, data:string}[], uploads?: {file:string, type?:string}[], writeUp?:boolean}} [o] */
  send(id, text, o) {
    const s = this.session(id);
    if (s.task_id && this.task(s.task_id).state !== 'active') throw fail('The task is no longer active', 409);
    if (!fs.existsSync(s.cwd)) throw fail(`The session's directory is gone: ${s.cwd}`, 409);
    this.runtime.send(id, String(text || ''), o);
    return this.session(id);
  }

  /** @param {string} id @param {{title?:string, mode?:PermissionMode, providerId?:string, modelId?:string|null, effort?:string|null}} patch */
  async updateSession(id, patch) {
    this.session(id);
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw fail('A title cannot be empty');
      this.runtime.emit('session', this.store.updateSession(id, { title: patch.title.trim() }));
    }
    if (patch.mode) await this.runtime.setMode(id, patch.mode);
    if (patch.effort !== undefined) patch = { ...patch, effort: effortOf(patch.effort) };
    if (patch.providerId !== undefined || patch.modelId !== undefined || patch.effort !== undefined) {
      const providerId = patch.providerId || this.session(id).provider_id;
      const provider = this.store.getProvider(providerId);
      if (!provider) throw fail('No such provider');
      const ready = providerReady(provider);
      if (!ready.ready) throw fail(`${provider.name}: ${ready.reason}`);
      try {
        await this.runtime.setModel(id, { providerId, modelId: patch.modelId, effort: patch.effort });
      } catch (e) {
        throw fail(/** @type {Error} */ (e).message, 409);
      }
    }
    return this.session(id);
  }

  /** @param {string} id */
  interrupt(id) {
    this.session(id);
    return this.runtime.interrupt(id);
  }

  /** @param {string} id @param {boolean} archived */
  archiveSession(id, archived = true) {
    const s = this.session(id);
    if (archived) {
      // A loop with nowhere to send its check has nothing left to do; the log says so.
      this.loop.sessionGone(s);
      this.runtime.close(id);
      this.runtime.dropScratch(id);
    } else if (s.task_id && this.task(s.task_id).state !== 'active') throw fail('Reopen the task first', 409);
    const updated = this.store.updateSession(id, { archived_at: archived ? new Date().toISOString() : null });
    this.runtime.emit('session', updated);
    return updated;
  }

  /** @param {string} id */
  deleteSession(id) {
    this.loop.sessionGone(this.session(id), 'its session was deleted');
    this.runtime.close(id);
    fs.rmSync(this.runtime.attachmentsDir(id), { recursive: true, force: true });
    this.runtime.dropScratch(id);
    this.store.deleteSessionData(id);
    this.runtime.emit('session-removed', id);
    return { ok: true };
  }

  /** @param {string} id @param {{before?:number, limit?:number}} [o] */
  events(id, o) {
    this.session(id);
    return this.store.listEvents(id, o);
  }

  // -- providers --------------------------------------------------------------------

  providers() {
    return this.store.listProviders().map((p) => ({ ...p, ...providerReady(p), models: this.store.listModels(p.id) }));
  }

  /** @param {string} id @param {{enabled?:boolean, name?:string, config?:object}} patch */
  updateProvider(id, patch) {
    return this.store.updateProvider(id, patch);
  }

  /** @param {string} id @param {{enabled?:boolean}} patch */
  updateModel(id, patch) {
    return this.store.updateModel(id, patch);
  }

  /**
   * A one-turn session that says OK, in a scratch directory. It goes through the same
   * runtime a real session does, so a provider that passes here works there.
   * @param {string} providerId @param {string|null} [modelId]
   */
  async testProvider(providerId, modelId = null) {
    const provider = this.store.getProvider(providerId);
    if (!provider) throw fail('No such provider', 404);
    const ready = providerReady(provider);
    if (!ready.ready) return { ok: false, error: ready.reason };
    const model = modelId || this.store.listModels(providerId).find((m) => m.enabled)?.id || null;
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { cleanEnv, providerEnv, invocationId } = await import('./providers.mjs');
    const m = model ? this.store.getModel(model) || null : null;
    const started = Date.now();
    try {
      const q = query({
        prompt: 'Reply with exactly OK.',
        options: { cwd: this.store.dir, env: { ...cleanEnv(), ...providerEnv(provider, m) }, settingSources: [], maxTurns: 1, permissionMode: 'dontAsk', ...(m ? { model: invocationId(m) } : {}) },
      });
      let text = '';
      for await (const msg of q) {
        const r = /** @type {any} */ (msg);
        if (r.type === 'result') {
          if (r.is_error) return { ok: false, error: (r.errors || []).join('\n') || r.result || 'Failed', ms: Date.now() - started };
          text = r.result || '';
        }
      }
      return { ok: true, response: text.slice(0, 200), ms: Date.now() - started };
    } catch (e) {
      return { ok: false, error: /** @type {Error} */ (e).message, ms: Date.now() - started };
    }
  }

  // -- the rest ---------------------------------------------------------------------

  usage() {
    return this.store.usage();
  }

  async doctor() {
    /** @param {string} cmd @param {string[]} args */
    const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 15000 }, (err, stdout) => resolve(err ? null : String(stdout).trim().split('\n')[0])));
    const checks = [];
    for (const [name, cmd, args] of /** @type {const} */ ([['git', 'git', ['--version']], ['node', 'node', ['--version']], ['claude', 'claude', ['--version']], ['gh', 'gh', ['--version']], ['tailscale', 'tailscale', ['version']]])) {
      const v = await run(cmd, [...args]);
      checks.push({ name, ok: !!v, detail: v || 'not found', optional: name === 'gh' || name === 'tailscale' || name === 'claude' });
    }
    checks.push({ name: 'gh auth', ok: await g.ghReady(), detail: 'needed for pull requests', optional: true });
    const { terminalsAvailable } = await import('./terminal.mjs');
    checks.push({ name: 'terminal (node-pty)', ok: terminalsAvailable(), detail: terminalsAvailable() ? 'ready' : 'not built: install build-essential and python3, then re-run bin/install', optional: true });
    for (const p of this.store.listProviders()) {
      const r = providerReady(p);
      checks.push({ name: `provider: ${p.name}`, ok: r.ready, detail: r.reason || 'ready', optional: !p.enabled });
    }
    return { checks };
  }

  // Pipeline tasks whose worktree is still on disk become active tasks, so their work
  // can be merged or thrown away from here. Run once, on the first start after the
  // schema upgrade.
  #importLegacy() {
    if (this.store.getSetting('legacy_import') !== 'pending') return;
    for (const lt of this.store.legacyTasks()) {
      try {
        const p = this.store.getProject(lt.project_id);
        if (!p || !lt.worktree || !fs.existsSync(lt.worktree) || !lt.branch) continue;
        if (!g.revParse(p.path, `refs/heads/${lt.branch}`) || this.store.getTask(lt.id)) continue;
        let target = null;
        try {
          target = JSON.parse(lt.plan_base || 'null')?.target_branch || null;
        } catch {
          /* no recorded target */
        }
        target = target && g.revParse(p.path, `refs/heads/${target}`) ? target : g.currentBranch(p.path);
        if (!target) continue;
        const t = this.store.addTask({
          id: lt.id,
          project_id: p.id,
          title: lt.title,
          description: lt.description,
          base_branch: target,
          base_commit: lt.base_commit || g.mergeBase(p.path, lt.branch, target) || /** @type {string} */ (g.revParse(p.path, target)),
          branch: lt.branch,
          worktree: lt.worktree,
          created_at: lt.created_at,
        });
        // Work that already landed is history rather than a task to act on.
        if (g.isAncestor(p.path, lt.branch, target) && !g.status(lt.worktree).dirty.length) this.store.updateTask(t.id, { state: 'merged' });
      } catch {
        /* one task that cannot be read does not stop the rest */
      }
    }
    this.store.setSetting('legacy_import', 'done');
  }

  shutdown() {
    this.runtime.shutdown();
  }
}
