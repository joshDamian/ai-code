import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from './store.mjs';
import { inspect, writeContext, readDependencies, relevantFiles, buildTaskContext, contextConfig } from './context.mjs';
import {
  ensureGit, status, createWorktree, diffAgainst, statusPaths, untracked, dirtyPaths, head, changedBetween, protectAiCode,
  currentBranch, revParse, isAncestor, mergeBase, findCommit, branches, checkedOut, mergeTree, commitTree, setBranch, commitAll, removeWorktree, commitDiff,
  landingCommit, commitRef,
} from './git.mjs';
import { runAgent, classify } from './agents.mjs';
import { loadPolicies, savePolicies } from './policy.mjs';
import { isTransient, healthThresholds, effectiveHealth } from './health.mjs';

const exec = promisify(execFile);

// The workflow state machine. A transition not listed here is rejected.
const transitions = {
  CREATED: ['CONTEXT_READY'],
  CONTEXT_READY: ['PLANNING'],
  PLANNING: ['AWAITING_APPROVAL', 'FAILED'],
  AWAITING_APPROVAL: ['APPROVED', 'PLANNING'],
  APPROVED: ['IMPLEMENTING'],
  IMPLEMENTING: ['TESTING', 'FAILED', 'APPROVED'],
  TESTING: ['REVIEWING', 'FAILED'],
  REVIEWING: ['COMPLETE', 'REPAIRING', 'FAILED'],
  REPAIRING: ['TESTING', 'FAILED', 'REVIEWING'],
  COMPLETE: [],
  FAILED: ['PLANNING'],
};

// Which capability a role requires a model to declare.
const capability = { planner: 'planning', implementer: 'coding', reviewer: 'review', repair: 'repair' };

// The tools whose input names something the planner read. A file it opened is a
// file whose uncommitted changes the plan may quietly rest on; a path it recorded
// from Grep or Glob is a directory as often as a file, so it is matched as a
// prefix below.
const READ_TOOLS = /^(Read|NotebookRead|Grep|Glob)$/;

// What a planning run looked at: the files it opened with a tool, plus the ones
// the context builder inlined into its prompt. Both were read by the planner, so
// both can carry an uncommitted change the plan silently depends on. A file the
// planner only reasoned about from the tree listing is not caught this way, which
// is why this is the narrowing term of the check rather than the whole of it.
export function readPaths(events, contextFiles, root) {
  const out = new Set();
  for (const p of [...contextFiles, ...toolPaths(events)]) {
    // Read reports an absolute path, and Grep reports both forms inside a single
    // run. The dirty set is repo-relative, so an unnormalised absolute path
    // matches nothing and the whole tool-derived half of this goes inert - which
    // is exactly what it did until a real run was replayed against it.
    const rel = path.relative(root, path.resolve(root, p));
    if (rel && !rel.startsWith('..')) out.add(rel);
  }
  return out;
}

function toolPaths(events) {
  const out = [];
  for (const e of events) {
    const content = e?.data?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== 'tool_use' || !READ_TOOLS.test(String(b.name))) continue;
      const p = b.input?.file_path || b.input?.notebook_path || b.input?.path;
      if (p) out.push(String(p));
    }
  }
  return out;
}

// The files the planner's prompt was assembled from, persisted by prepare() with
// the planner role before the plan existed.
function contextPaths(task) {
  try {
    return (JSON.parse(task.context || '{}').files || []).map((f) => f.path).filter(Boolean);
  } catch {
    return [];
  }
}

// A path recorded from a Grep or Glob is a directory as often as a file, so it
// matches everything beneath it.
export function touches(seen, file) {
  // Iterable rather than array: this is handed the Set readPaths() builds and the
  // array the baseline was serialised into, and they mean the same thing.
  //
  // Matched in both directions, because either side can be a directory. A Grep
  // records one, and so does git: an untracked directory is listed as a single
  // collapsed entry rather than one line per file, so `web/views/` is dirty while
  // what the planner read is `web/views/task-detail.mjs` inside it.
  for (const s of seen) {
    const a = s.replace(/\/$/, '');
    const b = file.replace(/\/$/, '');
    if (a === b || b.startsWith(a + '/') || a.startsWith(b + '/')) return true;
  }
  return false;
}

// A corrupt or half-written column must not throw a SyntaxError out of the middle
// of implement(). A baseline that cannot be read is a baseline that is not there.
function planBase(task) {
  try {
    return task.plan_base ? JSON.parse(task.plan_base) : null;
  } catch {
    return null;
  }
}

// What the tree looked like when the plan was written, so execution has something
// to compare against. The dirty set is recorded as much for the message as for the
// check: it is what tells a file that was already dirty when the planner read it
// from one that changed after the plan was written.
//
// `target_branch` is where a port means to land, and it is deliberately not called
// `branch`: the task row already has a `branch` column holding the worktree's own
// ai-code/<id>, and a UI reading the wrong one would offer the task's own branch as
// its destination. It is null under a detached HEAD, which is a real answer.
function recordPlanBase(store, root, task, runId, dirty) {
  return JSON.stringify({
    head: head(root),
    dirty,
    seen: [...readPaths(store.listEvents(runId), contextPaths(task), root)],
    target_branch: currentBranch(root),
  });
}

// What a task's worktree changed, measured from where it was cut rather than from
// the index. `git diff` alone compares the worktree to the index, so a task whose
// work has been materialized onto its branch reads as empty - and an empty diff
// handed to a reviewer is a PASS on nothing at all. Against the base it is the same
// string before and after a commit. The porcelain tail is kept because it is the
// only thing that names an untracked file, since no diff carries one's contents.
function worktreeDiff(dir, task) {
  // base_commit is the recorded cut point. merge-base is the fallback for when it
  // no longer resolves, and HEAD is the last resort - uncommitted work only, which
  // is what the index-relative read this replaces used to give.
  const base = task.base_commit && revParse(dir, task.base_commit)
    ? task.base_commit
    : mergeBase(dir, 'HEAD', task.branch) || 'HEAD';
  return diffAgainst(dir, base) + '\n' + statusPaths(dir).join('\n');
}

// What a person still has to run for the work to reach the destination, derived from
// the assessment rather than written out at each surface. Porting stops short of the
// merge whenever the destination is checked out, and it reports that honestly in one
// field instead of leaving the command to be found in a payload dump - the way a port
// that had committed, cleaned up and merged nothing came to read as finished.
//
// Ordered the way the steps have to happen: publish the work, clear the destination,
// then the merge itself.
function nextSteps(t, branch, target, a) {
  if (a.alreadyPorted) return [];
  // Nothing on the branch and nothing in the worktree. Every step below carries a change
  // somewhere, so with no change there is no step - and a `git merge` printed for a branch
  // sitting at its own fork point is an instruction to run a command that does nothing.
  if (!a.committed && !a.pending) return [];
  const steps = [];
  // Nothing is on the branch yet, so nothing can be merged anywhere. This is the step
  // that makes the rest possible.
  if (a.pending) {
    steps.push({ text: `Commit the worktree onto ${branch} and land it on ${target}:`, command: `ai-code task port ${t.id} --to ${target}` });
  }
  // git refuses a merge that would overwrite uncommitted work rather than overwriting
  // it, so this is a step before the merge and not a warning about it.
  if (a.blockedBy.length) {
    const shown = a.blockedBy.slice(0, 3).join(', ');
    steps.push({
      text: `Commit or stash the ${a.blockedBy.length} uncommitted file(s) at the destination that this would overwrite (${shown}${a.blockedBy.length > 3 ? ', ...' : ''}).`,
      command: null,
    });
  }
  // The destination is checked out in some working tree, so the port leaves its ref
  // where it is - moving it would rewrite the tree of whoever is working in it.
  if (a.checkedOut) {
    steps.push({ text: `${target} is checked out, so its ref is left alone. Run this in that checkout:`, command: a.fastForward ? `git merge --ff-only ${branch}` : `git merge ${branch}` });
  }
  return steps;
}

// The one thing a person opening this screen needs before any of the detail: which of a
// small number of states the work is in. Derived here rather than in the tab because the
// CLI answers the same question from the same assessment, and a surface that decided this
// for itself is a surface that can disagree about whether the work has landed.
//
// The order below is the precedence, and each position is a decision:
// "landed" first, because when the work is already in the destination that is the whole
// answer and every other reading of the assessment is a distraction. Then uncommitted
// work, because a prediction drawn from the branch tip does not contain it - a conflict
// reported against a branch that has not yet been committed to is re-run against the
// commit materialize makes, and leading with it would name a conflict that may not exist.
// Emptiness before the rest, since neither conflicts nor dirt at the destination can
// matter to a change that does not exist.
function portState(a) {
  if (a.alreadyPorted) {
    return {
      key: 'landed',
      tone: 'good',
      badge: 'Landed',
      headline: `${a.target} already contains this work`,
      detail: `The task's commit is an ancestor of ${a.target}, so there is nothing left to land and nothing left to run. The branch stays as the record of the change.`,
    };
  }
  if (a.pending) {
    return {
      key: 'pending',
      tone: 'neutral',
      badge: 'Not on the branch',
      headline: 'The change is uncommitted in the worktree',
      detail: `Committing is how the work becomes something that can be merged, so a port does that first${a.committed ? `, alongside the commit ${a.branch} already holds` : ''}.`,
    };
  }
  if (!a.committed) {
    return {
      key: 'empty',
      tone: 'neutral',
      badge: 'Nothing to port',
      headline: 'There is no change here to land',
      detail: 'The worktree holds nothing the branch lacks, and the branch holds no commit for this task.',
    };
  }
  if (a.conflicts.length) {
    return {
      key: 'conflicted',
      tone: 'bad',
      badge: 'Conflict',
      headline: `${a.conflicts.length} file${a.conflicts.length === 1 ? '' : 's'} conflict with ${a.target}`,
      detail: 'A port stops here and moves nothing. Git compares the two sides in the object store, so this is a prediction rather than a half-finished merge: the branch still holds the work, and the merge is yours to make.',
    };
  }
  if (a.blockedBy.length) {
    return {
      key: 'blocked',
      tone: 'warn',
      badge: 'Blocked',
      headline: `${a.target} is uncommitted where this change lands`,
      detail: `Git refuses a merge that would overwrite uncommitted work. ${a.blockedBy.length} file${a.blockedBy.length === 1 ? '' : 's'} at the destination overlap this change, and committing or stashing them there is what unblocks it.`,
    };
  }
  return {
    key: 'ready',
    tone: 'good',
    badge: 'Ready',
    headline: a.fastForward ? `Lands on ${a.target} as a fast-forward` : `Lands on ${a.target} as a merge commit`,
    detail: a.checkedOut
      ? `${a.target} is checked out somewhere, so a port will not move its ref underneath whoever is working in it. It prints the command instead.`
      : `${a.target} is checked out nowhere, so a port moves its ref for you.`,
  };
}

// The paths a commit of the worktree would add, with their sizes. A port publishes
// these, and neither the diff nor the reviewer's PASS has ever covered their
// contents - no diff carries an untracked file's body - so they are reported by
// name and size rather than silently folded in.
function untrackedFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return untracked(dir).map((name) => {
    let bytes = null;
    try {
      bytes = fs.statSync(path.join(dir, name)).size;
    } catch {
      // Vanished between the listing and the stat. Naming it is still better than
      // dropping it: the caller is being told what would be published.
    }
    return { path: name, bytes };
  });
}

// The reasoning tier each role needs. A NULL `reasoning` means the row predates
// the column, and an unknown capability is never a reason to refuse a model - only
// a stated one that falls short of the floor.
const reasoningFloor = {
  planner: ['strong', 'frontier'],
  implementer: ['basic', 'moderate', 'strong', 'frontier'],
  reviewer: ['moderate', 'strong', 'frontier'],
  repair: ['basic', 'moderate', 'strong', 'frontier'],
};

// A model that cannot call tools cannot edit files or run commands, which is the
// whole of the implementer and repair jobs. Only these two roles need the gate;
// a planner or reviewer is deliberately denied tools.
const TOOL_ROLES = new Set(['implementer', 'repair']);

// How often a running role redraws its spinner, refreshes its lease, and checks
// for a cancel requested by another process. One interval does all three, so the
// cancellation latency is never worse than the progress redraw. Overridable via
// the tickMs option so tests can exercise cross-process cancel without waiting.
const TICK_MS = 2000;

// Every path that stops a run - the cancel API, the timeout, and the cross-process
// cancel poll - must throw this exact shape, because the catch in runRole branches
// on e.code === 'CANCELLED' to tell "the user stopped this" from "this failed".
export function cancelled() {
  const err = new Error('Cancelled by user');
  err.code = 'CANCELLED';
  return err;
}

// The codes the harness raises when a run crosses a budget it was given. Neither
// is the provider's fault and neither is worth a fallback: the next provider would
// run the same agent into the same wall at the same cost.
const BUDGET_CODES = new Set(['TOOL_CALL_LIMIT', 'COST_LIMIT']);

// The planner prompt. Demanding an implementation plan and offering no other
// valid answer is what made a planning run spiral: when the code already
// satisfies the task there is nothing to plan, so the agent re-reads the
// codebase hunting for work that is not there until a budget stops it. Naming
// the way out is the fix - no state machine change, no heuristic on the plan
// text. The task still lands in AWAITING_APPROVAL, where "no changes are
// needed" is a plan the user can read and approve or reject for themselves.
// The instruction about file-writing tools is not redundant with the one about
// source files. The planner runs under `--permission-mode plan`, whose system
// prompt asks for the plan to be saved to a plans file, and "do not create files"
// reads as a rule about the repository - which is not where it was trying to
// write. It spent a turn on a Write that could only fail and another searching for
// a tool to replace it, on every planning run, until the prompt named the tool.
//
// Naming the tool in the prompt is the only lever. The plan-file instruction
// cannot be switched off: `--plan-mode-instructions` replaces the workflow phases
// below plan mode's preamble, and the sentence that causes this sits in the
// preamble that is always kept, so it survives any custom workflow. Dropping the
// permission mode instead would cost the read-only layer itself, which is the one
// that also covers tools --disallowedTools does not name. The plansDirectory
// setting only relocates a file the planner has no tool to write.
// The reviewer is denied Edit and Write and runs under plan mode too, so it faces
// the same plan-file instruction and needs the same answer. Named and exported
// rather than left inline for the reason PLANNER_PROMPT is: the clause is worth
// having a test pin, and a prompt buried in a call site is not inspectable.
export const reviewerPrompt = (diff) =>
  `Review this implementation independently. Return a clear verdict: PASS or FAIL. If FAIL, list concrete findings mapped to the approved plan and test evidence. Do not modify files. No tool that writes a file exists in this session, so the verdict is the text of your reply.\n\nDIFF:\n${diff}`;

export const PLANNER_PROMPT =
  'Produce ONLY a concrete implementation plan. Do not modify source files, create files, run mutating commands, commit, or execute implementation. No tool that writes a file exists in this session - not to the repository, not to a scratch directory, not to a plans folder - and searching for one wastes a turn. The plan is the text of your reply. Identify exact files, intended changes, tests, and verification commands. The harness will reject source changes. If the task is already fully implemented in the current codebase, say so instead of planning work: name the files that already satisfy each requirement and say why no further changes are needed. Do not invent work that does not exist.';

// One assistant message can carry several tool calls at once, so the content
// blocks are counted rather than the messages that contain them.
function countToolCalls(event) {
  const content = event.data?.message?.content;
  const blocks = Array.isArray(content) ? content.filter((c) => c?.type === 'tool_use').length : 0;
  return blocks + (event.type === 'tool_use' ? 1 : 0);
}

// A budget that is absent, unparseable or zero means no limit, so a routing.json
// written before the field existed behaves exactly as it did.
function budgetOf(value) {
  return Number.isFinite(value) && value > 0 ? value : Infinity;
}

// A task title is the first line of its description, truncated at a sentence or a
// word boundary so it stays readable in a list.
function generateTitle(text) {
  if (!text) return 'Untitled';
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= 80) return t;
  const end = t.search(/[.!?]\s/);
  if (end > 0 && end <= 80) return t.slice(0, end + 1);
  const cut = t.lastIndexOf(' ', 80);
  return (cut > 20 ? t.slice(0, cut) : t.slice(0, 80)) + '…';
}

export class Service {
  constructor(root = process.cwd(), options = {}) {
    this.root = root;
    this.options = options;
    this.store = new Store(root);
    this.policies = loadPolicies(root);
    // run id -> { controller, taskId, role, providerId }, for runs this process
    // owns. Used to abort them instantly on cancel, and to count what a provider
    // is already doing. Runs owned by another process are signalled through the
    // lease table instead, since this map cannot see them.
    this.active = new Map();
    // Set by the Runner while it has a job in flight. A background job shares the
    // server's stderr, so it redraws no spinner and prints no progress.
    this.quiet = false;
    // Assigned by the server once a Runner exists. Null everywhere else, which is
    // what makes `eligible()` behave exactly as it did before the queue existed.
    this.runner = null;
    // Opening a store is also the only repair opportunity there is: the process
    // that abandoned a run is gone, and this is what picks up after it. Every
    // command does this, which is what makes the recovery reachable at all - and
    // is why the store's own reap is lease-aware rather than unconditional.
    this.recoverPlans();
  }

  // -- task lifecycle -------------------------------------------------------

  transition(id, to) {
    const t = this.task(id);
    if (!transitions[t.state]?.includes(to)) throw new Error(`Invalid transition ${t.state} -> ${to}`);
    // Every transition into a state a *user* starts work from clears an earlier
    // cancel, so a task cancelled yesterday is not cancelled again the moment it
    // is retried. The transitions the harness makes on its own - TESTING,
    // REVIEWING, REPAIRING - deliberately do not, or a cancel issued while the
    // test command was running would be swallowed by the step that follows it.
    if (to === 'APPROVED' || to === 'PLANNING' || to === 'IMPLEMENTING') this.store.setTaskCancel(id, false);
    return this.store.updateTask(id, { state: to });
  }

  project(id) {
    const p = this.store.getProject(id);
    if (!p) throw new Error('Project not found');
    return p;
  }

  task(id) {
    const t = this.store.getTask(id);
    if (!t) throw new Error('Task not found');
    return t;
  }

  initProject(name, root) {
    root = fs.realpathSync(root);
    ensureGit(root);
    protectAiCode(root);
    const existing = this.store.getProjectByPath(root);
    if (existing) return existing;
    const x = inspect(root);
    return this.store.addProject({
      id: this.store.id(),
      name,
      path: root,
      createdAt: new Date().toISOString(),
      language: x.language,
      framework: x.framework,
      commands: x.commands,
    });
  }

  contextInit(projectId) {
    return writeContext(this.project(projectId));
  }

  createTask(projectId, text) {
    this.project(projectId);
    const now = new Date().toISOString();
    return this.store.addTask({
      id: this.store.id(),
      projectId,
      title: generateTitle(text),
      description: text,
      state: 'CREATED',
      createdAt: now,
      updatedAt: now,
    });
  }

  prepare(id) {
    this.transition(id, 'CONTEXT_READY');
    // What the planner will be given, recorded now so the task view can show it
    // before anything runs. A manifest rather than the context itself: paths and
    // token counts are what make the decision reviewable, and the file bodies
    // would be a snapshot that goes stale the moment the branch moves.
    const project = this.project(this.task(id).project_id);
    const built = buildTaskContext(project, this.task(id), { role: 'planner', config: contextConfig(this.policies.context) });
    this.store.updateTask(id, { context: JSON.stringify(built.manifest) });
    return this.transition(id, 'PLANNING');
  }

  // The prompt budget for this install, merged over the defaults.
  contextConfig() {
    return contextConfig(this.policies.context);
  }

  // -- planning -------------------------------------------------------------

  async plan(id) {
    const t = this.task(id);
    if (t.state !== 'PLANNING') throw new Error('Task must be in PLANNING');
    const p = this.project(t.project_id);
    // The planner must not touch the repo, so its effect on the working tree is
    // measured around the run and any change is treated as a violation. What it
    // changed is the difference between the tree before the run and the tree after
    // it. Asking instead whether any dirty file exists at all - which is what this
    // used to `||` into the condition - fails on any repository that already had
    // work in progress when the task was planned. That is the normal state of a
    // repository under active development, and it is how a planner that correctly
    // reported "no work needed" got its run marked FAILED and its plan thrown away.
    const before = new Set(dirtyPaths(p.path));
    let result;
    try {
      result = await this.runRole(t, 'planner', PLANNER_PROMPT, p.path);
    } catch (e) {
      // A budget failure is a property of the task rather than of the weather:
      // planning it again unchanged would spiral identically. FAILED is the state
      // that says the task needs re-scoping, and the only one replan() accepts.
      if (BUDGET_CODES.has(e.code)) this.store.updateTask(id, { state: 'FAILED' });
      throw e;
    }
    const written = dirtyPaths(p.path).filter((f) => !before.has(f));
    if (written.length) {
      this.store.updateTask(id, { state: 'FAILED' });
      // The paths, because "planner changed repository state" with no file named
      // sends the reader to the run log to find out what it is being accused of.
      throw new Error(`PLANNING_VIOLATION: planner changed repository state (${written.join(', ')})`);
    }
    // The baseline execution is gated on, recorded while it is still true. `before`
    // is the dirty set as the planner found it; the read set comes from the run
    // that just finished and from the manifest prepare() persisted, so neither
    // costs a second look at the tree or a second run.
    this.store.updateTask(id, {
      plan: this.planFromRun(result.runId),
      plan_base: recordPlanBase(this.store, p.path, t, result.runId, [...before]),
    });
    return this.transition(id, 'AWAITING_APPROVAL');
  }

  // What a run finished by saying - the plan, or the reviewer's verdict. Claude
  // Code's final `result` frame carries exactly that, and the same text also
  // arrives as the last assistant message, so reading the frame alone is what
  // keeps the answer from being written down twice.
  //
  // Joining every text block, which is what this used to do, is not the same
  // thing. A planner that spawns Explore subagents has their reports echoed into
  // the same stream: one 5,669-character plan came back as 34,949 characters,
  // 84% of it subagent research, running commentary, and the plan a second time.
  finalText(runId) {
    const events = this.store.listEvents(runId);
    const ended = events.filter((e) => e.type === 'result').pop();
    const closing = ended ? this.extractText(ended.data).trim() : '';
    if (closing) return closing;
    // No result frame: the mock provider emits none, and neither does a run that
    // died mid-stream. The last thing it said is still nearer its answer than
    // everything it said on the way there.
    for (let i = events.length - 1; i >= 0; i--) {
      const text = this.extractText(events[i].data).trim();
      if (text) return text;
    }
    return '';
  }

  // The plan a finished planner run left behind. plan() and the startup recovery
  // both come through here, so a plan that was written normally and one that was
  // recovered cannot disagree about what a run that said nothing means.
  planFromRun(runId) {
    return this.finalText(runId) || 'No textual plan returned. Inspect the run events before approving.';
  }

  // A process that dies between its planner run succeeding and plan() writing the
  // result leaves the task in PLANNING with a plan that exists only as events.
  // The run row is the evidence, so the plan is recovered rather than replanned -
  // which would spend the same budget to reach the same place.
  //
  // A task the user rejected or replanned has the same shape, which is why the
  // query rather than this loop decides what qualifies: orphanedPlans() excludes
  // those, so a plan that was refused is not handed back on the next open.
  recoverPlans() {
    const recovered = [];
    for (const { task_id, run_id } of this.store.orphanedPlans()) {
      try {
        // The plan first, then the transition. A crash between the two leaves the
        // task in PLANNING, which the next open recovers again; the other order
        // leaves an empty plan in front of a user, with nothing left to notice it.
        //
        // A recovered plan gets a baseline like any other, because the process that
        // wrote it never got to record one and a plan with no baseline is a plan
        // nothing checks. The read set comes from the run's own events; the dirty
        // set is taken as the tree is now, which is the conservative reading and
        // the only one available - the tree it was written against is gone.
        const task = this.task(task_id);
        const project = this.project(task.project_id);
        this.store.updateTask(task_id, {
          plan: this.planFromRun(run_id),
          plan_base: recordPlanBase(this.store, project.path, task, run_id, dirtyPaths(project.path)),
        });
        this.transition(task_id, 'AWAITING_APPROVAL');
        recovered.push({ taskId: task_id, runId: run_id });
      } catch {
        // The state moved under us - most likely the owning process finished and
        // wrote its own plan - so there is nothing here to recover.
      }
    }
    if (recovered.length && !this.options.silent) {
      for (const r of recovered) {
        process.stderr.write(`  recovered plan for task ${r.taskId.slice(0, 8)} from run ${r.runId.slice(0, 8)}\n`);
      }
    }
    return recovered;
  }

  approve(id) {
    return this.transition(id, 'APPROVED');
  }

  reject(id) {
    const t = this.task(id);
    if (t.state !== 'AWAITING_APPROVAL') throw new Error('Can only reject when AWAITING_APPROVAL');
    this.store.updateTask(id, { plan: null });
    return this.transition(id, 'PLANNING');
  }

  replan(id) {
    const t = this.task(id);
    if (t.state !== 'FAILED') throw new Error('Can only replan when FAILED');
    // plan_base goes with the plan it describes: between here and the next plan()
    // the task would otherwise carry a baseline for a plan that no longer exists.
    this.store.updateTask(id, { plan: null, review: null, worktree: null, branch: null, base_commit: null, plan_base: null });
    return this.transition(id, 'PLANNING');
  }

  async refine(id, feedback) {
    const t = this.task(id);
    if (t.state !== 'AWAITING_APPROVAL') throw new Error('Can only refine when AWAITING_APPROVAL');
    const p = this.project(t.project_id);
    // Recorded before the run for the same reason plan() records its own before
    // its run: this is what the tree looked like to the planner.
    const before = dirtyPaths(p.path);
    const result = await this.runRole(
      t,
      'planner',
      `Revise this plan based on feedback. Keep what works, change what the user asked for.\n\nFEEDBACK:\n${feedback}\n\nCURRENT PLAN:\n${t.plan || '(no plan)'}`,
      p.path
    );
    // A revised plan is a different plan, read against the tree as it is now, so
    // it gets its own baseline. Left at the previous one, the dashboard's Refine
    // button would quietly re-gate the new plan against the old plan's files.
    this.store.updateTask(id, {
      plan: this.finalText(result.runId) || t.plan,
      plan_base: recordPlanBase(this.store, p.path, t, result.runId, before),
    });
    return this.task(id);
  }

  updatePlan(id, plan) {
    const t = this.task(id);
    if (t.state !== 'AWAITING_APPROVAL') throw new Error('Can only edit plan when AWAITING_APPROVAL');
    this.store.updateTask(id, { plan });
    return this.task(id);
  }

  // -- execution ------------------------------------------------------------

  // The whole chain, blocking. Kept exactly as it was - the CLI foreground path,
  // the dashboard's Start Execution button and the test suite all depend on it -
  // but built from the same three steps the background queue calls one at a time.
  async execute(id, opts) {
    await this.implement(id, opts);
    await this.runTests(id);
    return this.review(id);
  }

  // Worktree, implementer, and the transition into TESTING. The first half of
  // execute(), split out so a dashboard can run one step without committing to
  // the rest, and so the queue has something to enqueue.
  async implement(id, opts = {}) {
    const t = this.task(id);
    if (t.state !== 'APPROVED') throw new Error('Explicit approval required before execution');
    const p = this.project(t.project_id);
    // The planner reads the live tree, dirt included; this worktree is built from
    // HEAD. A plan written against uncommitted changes therefore describes code
    // the implementer will never see, and the change that comes back is against
    // stale sources - which is how a task whose reviewer ran a 12-test suite got
    // approved in a repository whose suite was 82.
    //
    // The read set is the whole of the narrowing: it is what separates the handful
    // of files a plan rests on from the twenty-odd unrelated entries a working
    // repository carries. Whether a file was dirty when the planner looked is not
    // part of the test - a file that was clean then and is dirty now has the same
    // HEAD-only worktree underneath it - but it is recorded, because it is what
    // tells the reader which of the two situations they are in.
    //
    // It refuses rather than repairs, and changes nothing: the task stays APPROVED,
    // so committing the files and retrying is the whole remedy, and the gate opens
    // on its own once they are.
    const baseline = planBase(t);
    if (baseline && !opts.force) {
      const blocked = dirtyPaths(p.path).filter((f) => touches(baseline.seen, f));
      if (blocked.length) {
        const later = baseline.dirty ? blocked.filter((f) => !baseline.dirty.includes(f)) : [];
        throw Object.assign(
          new Error(
            `PLAN_BASE_DIRTY: ${blocked.length} file(s) this plan depends on have uncommitted changes (${blocked.join(', ')}). ` +
              `The implementer runs in a worktree built from HEAD (${String(baseline.head).slice(0, 12)}), which contains none of them. ` +
              (later.length ? `${later.length} of them changed after the plan was written. ` : '') +
              `Commit them first, or re-run with --force.`
          ),
          { code: 'PLAN_BASE_DIRTY' }
        );
      }
    }
    const wt = createWorktree(p.path, t.id);
    this.store.updateTask(id, { worktree: wt.dir, branch: wt.branch, base_commit: wt.base });
    this.transition(id, 'IMPLEMENTING');
    try {
      await this.runRole(t, 'implementer', 'Implement the approved plan in this worktree. Do not change files outside the worktree. Do not alter AI Code task metadata.', wt.dir);
    } catch (e) {
      if (e.code === 'CANCELLED') {
        // A cancelled run is not a failed task: revert so it can be executed again.
        this.transition(id, 'APPROVED');
        throw e;
      }
      this.store.updateTask(id, { state: 'FAILED' });
      throw e;
    }
    // The exact version of the check the gate can only approximate. The gate
    // reasons about what the planner saw; this asks what the implementer actually
    // wrote, and finds the files that were already dirty when it planned. Without
    // it the rewrite is invisible - the diff and the review are both computed
    // inside the worktree, where the uncommitted version never existed.
    //
    // Unless those files were committed in between, which is the remedy the gate
    // asks for: then their uncommitted content is in HEAD, the implementer saw it,
    // and reporting a conflict would be reporting the fix as the problem.
    if (baseline) {
      const moved = new Set(changedBetween(p.path, baseline.head, wt.base));
      const rewritten = dirtyPaths(wt.dir).filter((f) => !moved.has(f) && touches(baseline.dirty || [], f));
      if (rewritten.length) this.store.updateTask(id, { plan_base: JSON.stringify({ ...baseline, conflicts: rewritten }) });
    }
    this.transition(id, 'TESTING');
    return this.task(id);
  }

  // The test command and the transition into REVIEWING. `test` below is the raw
  // command runner and takes the worktree; this is the workflow step around it.
  async runTests(id) {
    const t = this.task(id);
    if (t.state !== 'TESTING') throw new Error('Task must be in TESTING');
    try {
      await this.test(t, t.worktree);
    } catch (e) {
      this.store.updateTask(id, { state: 'FAILED' });
      throw e;
    }
    this.transition(id, 'REVIEWING');
    return this.task(id);
  }

  async test(t, cwd) {
    const cmd = this.project(t.project_id).commands.test;
    if (!cmd) return { skipped: true };
    try {
      await exec(cmd, { cwd, shell: true, maxBuffer: 10 * 1024 * 1024 });
      return { passed: true };
    } catch (e) {
      throw new Error(`TEST_FAILED: ${e.stderr || e.stdout || e.message}`);
    }
  }

  async review(id) {
    const t = this.task(id);
    if (t.state !== 'REVIEWING') throw new Error('Task must be in REVIEWING');
    const d = worktreeDiff(t.worktree, t);
    const before = status(t.worktree);
    try {
      const r = await this.runRole(t, 'reviewer', reviewerPrompt(d), t.worktree);
      const after = status(t.worktree);
      if (before !== after) this.store.updateTask(id, { review: 'REVIEW_VIOLATION: reviewer changed worktree state' });
      // The verdict is the reviewer's closing message, not its whole transcript:
      // matching the word FAIL against the exploration that led to the verdict is
      // how a reviewer that reasoned about a failure it then ruled out gets read
      // as having failed the task.
      const text = this.finalText(r.runId);
      // A verdict counts as FAIL when the word appears anywhere but is never the
      // start of a line - so "PASS" as a standalone verdict is not read as FAIL.
      // The verdict need not be the bare word: "the implementation fails to meet
      // item 3" is as much a FAIL as "FAIL", and a reviewer writing prose is the
      // ordinary case rather than the exception.
      const fail = /\bfail(?:s|ed|ing|ures?)?\b/i.test(text) && !/^\s*PASS\b/im.test(text);
      if (fail) {
        this.store.updateTask(id, { review: text });
        return this.transition(id, 'REPAIRING');
      }
      this.store.updateTask(id, { review: text || 'PASS' });
      return this.transition(id, 'COMPLETE');
    } catch (e) {
      if (e.code === 'CANCELLED') throw e;
      // A reviewer that crashed is itself a finding: hand the task to repair with
      // the error as the review body rather than failing the whole task.
      this.store.updateTask(id, { review: String(e) });
      return this.transition(id, 'REPAIRING');
    }
  }

  async repair(id) {
    const t = this.task(id);
    if (t.state !== 'REPAIRING') throw new Error('Task must be in REPAIRING');
    try {
      await this.runRole(t, 'repair', `Repair the review findings in the worktree. Re-run relevant tests after fixing. Review findings:\n${t.review || 'Review failed.'}`, t.worktree);
    } catch (e) {
      if (e.code === 'CANCELLED') this.transition(id, 'REVIEWING');
      throw e;
    }
    this.transition(id, 'TESTING');
    await this.test(this.task(id), t.worktree);
    this.transition(id, 'REVIEWING');
    return this.review(id);
  }

  // -- porting --------------------------------------------------------------

  // Publishes the worktree onto its own branch. Until this runs a task's whole
  // result is uncommitted edits in a directory: nothing can diff it by ref, merge
  // it, revert it, or remove the directory without losing it.
  //
  // Deliberately not called by the workflow. FAILED is written directly in four
  // places rather than through transition(), so a commit at the terminal transition
  // would have to be written from all of them, and a port is the only thing that
  // needs one.
  //
  // Idempotent, and an empty result is supported rather than an error: the planner
  // is explicitly told to say "already fully implemented" instead of inventing work,
  // and `git commit` on an empty index exits non-zero, which git() does not catch.
  materialize(id) {
    const t = this.task(id);
    const branch = t.branch || `ai-code/${t.id}`;
    if (!t.worktree || !fs.existsSync(t.worktree)) {
      // The worktree is gone, and that is a state rather than a failure: `--clean`
      // removes the directory once the work is on the branch, and the commit outlives
      // it. So the question is not whether the directory is there but whether the
      // branch holds a commit for this task, because that is what a merge can move.
      // Nothing published is reported as nothing to publish; anything else is what
      // the caller lands, and refusing here is what once left a ported task looking
      // unportable while its work sat on a branch.
      const published = findCommit(this.project(t.project_id).path, branch, `AI Code task ${t.id}`);
      return { branch, commit: published, empty: !published, gone: true, files: [] };
    }
    const files = dirtyPaths(t.worktree);
    if (!files.length) {
      // Nothing to publish, whether because nothing was ever written or because an
      // earlier materialize already published it. Either way there is nothing to do
      // now, and the commit is the branch's tip - the base in the first case, the
      // earlier port's commit in the second.
      return { branch, commit: head(t.worktree), empty: true, gone: false, files: [] };
    }
    return { branch, commit: commitAll(t.worktree, `${t.title}\n\nAI Code task ${t.id}`), empty: false, gone: false, files };
  }

  // The branch a port means to land on: named, else the one the plan was written
  // against, else the one checked out now. The recorded one is the better default
  // when it exists, and replan() nulls plan_base along with the plan it described -
  // so a task that failed and was replanned has only the live answer, which is the
  // right one at the moment it is asked for.
  portTarget(task, opts = {}) {
    if (opts.to) return opts.to;
    const recorded = planBase(task)?.target_branch;
    if (recorded) return recorded;
    const live = currentBranch(this.project(task.project_id).path);
    if (live) return live;
    throw new Error('No target branch: pass --to <branch>, or run this from a branch (HEAD is detached)');
  }

  // The branches a port could name as its destination. Local heads only, and the
  // task branches are excluded: every task has one, and offering `ai-code/<id>` as
  // somewhere to merge `ai-code/<id>` is a footgun rather than an option.
  destinations(id) {
    const t = this.task(id);
    return branches(this.project(t.project_id).path).filter((b) => !b.startsWith('ai-code/'));
  }

  // Everything a human needs to decide, and nothing that writes a ref or a file.
  // This is the whole of --dry-run, so it must not throw on a repository that has
  // moved underneath the plan: an unresolvable base degrades to "unknown" rather
  // than an exception out of the one step whose job is to say what would happen.
  //
  // It does let git write objects - `merge-tree --write-tree` is the only way to
  // ask whether a merge would conflict - but they are unreachable, gc collects
  // them, and nothing a later command can observe changes.
  assess(t, p, branch, target) {
    const targetTip = revParse(p.path, target);
    if (!targetTip) throw new Error(`Unknown branch: ${target}`);
    const taskTip = revParse(p.path, branch);
    const base = taskTip ? mergeBase(p.path, branch, target) : null;
    const merge = taskTip ? mergeTree(p.path, targetTip, taskTip) : null;
    const baseline = planBase(t);
    const baseResolves = !!(baseline && revParse(p.path, baseline.head));
    // What the change touches, from both states: uncommitted work is in the
    // worktree and committed work is in the range, and only one of the two is
    // populated at any moment.
    const touched = new Set();
    const live = t.worktree && fs.existsSync(t.worktree);
    const dirty = live ? dirtyPaths(t.worktree) : [];
    for (const f of dirty) touched.add(f);
    if (base && taskTip) for (const f of changedBetween(p.path, base, taskTip)) touched.add(f);
    // The commit this task published, if it ever did. Reading it off ancestry does
    // not work, and both ways it fails are the interesting cases. A task that was
    // never materialized sits at its own fork point, so `targetTip` contains the
    // branch tip and the test reports "already ported" for work stranded uncommitted
    // in a worktree - the exact case this feature exists for. And once the work is in
    // the target, the branch tip and the fork point are again the same commit, so it
    // would report the same thing for a port that never happened. The commit's own
    // message is the record, and materialize is the only thing that writes one.
    const published = findCommit(p.path, branch, `AI Code task ${t.id}`);
    const a = {
      // What was assessed: the pair a port would move between. Named here because the
      // verdict is written from it, and a state that says "undefined already contains
      // this work" is what a verdict interpolating a field it was not given looks like.
      branch,
      target,
      targetTip,
      taskTip,
      base,
      committed: !!published,
      // The commit itself, so a surface can name it rather than only reporting that one
      // exists. Read in one place because the way this is found is the subtle part.
      commit: published,
      // Work sitting in the worktree that the branch does not have. A port is what
      // publishes it, and a prediction drawn from the branch tip does not contain it.
      pending: dirty.length > 0,
      // Ancestry, not `base_commit === targetTip`. The equality holds for the
      // common case and lies in the one that matters: a worktree reused after a
      // replan sits on an older commit than the base_commit rewritten underneath
      // it, and moving the target's ref on that answer silently rewinds the branch.
      fastForward: !!(taskTip && isAncestor(p.path, targetTip, taskTip)),
      alreadyPorted: !!(published && isAncestor(p.path, published, targetTip)),
      // `git branch -f` refuses to move a branch checked out in any worktree, so
      // the port has to know this before it tries rather than after it fails.
      checkedOut: checkedOut(p.path).includes(target),
      // Whether the plan's own premise still holds where this is going. Null is
      // "cannot tell", which is not the same as "no" and is not a reason to refuse.
      premisesMoved: baseResolves
        ? changedBetween(p.path, baseline.head, targetTip).filter((f) => touches(baseline.seen || [], f))
        : null,
      clean: merge ? merge.clean : null,
      conflicts: merge ? merge.conflicts : [],
      // The merged TREE, not a commit: commit-tree is held back for port() so that
      // a dry run adds nothing to the object store beyond what the prediction needs.
      mergedTree: merge && merge.clean ? merge.tree : null,
      // Dirt at the destination in files this would touch. git refuses such a merge
      // rather than overwriting it, and that is worth knowing before reading the
      // diff rather than after.
      blockedBy: dirtyPaths(p.path).filter((f) => touches([...touched], f)),
    };
    // Derived last, because it reads every field above, and carried on the assessment
    // so that both the read-only diff and the port itself answer with it.
    a.next = nextSteps(t, branch, target, a);
    a.state = portState(a);
    // The two commits worth being able to name, each answering a different question. The
    // task's own commit is the work - what to read to see what this task did - and it
    // exists from the moment a port publishes it, landed or not. The commit it landed as
    // only exists once the destination has it, and for a merge it is a different commit
    // from the work, which is exactly why both are carried.
    a.taskCommit = commitRef(p.path, published);
    a.landedAs = a.alreadyPorted ? commitRef(p.path, landingCommit(p.path, published, targetTip)) : null;
    return a;
  }

  // Read-only. The change a port would carry and what the destination would make of
  // it. `files` is the porcelain list; `untracked` is the names and sizes a commit
  // would publish that no diff can show.
  diff(id, opts = {}) {
    const t = this.task(id);
    const p = this.project(t.project_id);
    const branch = t.branch || `ai-code/${t.id}`;
    const target = this.portTarget(t, opts);
    const live = !!(t.worktree && fs.existsSync(t.worktree));
    const a = this.assess(t, p, branch, target);
    // Uncommitted work when there is any, and the commit the branch holds otherwise. The
    // worktree's existence is not the test, and taking it for one showed an empty pane for
    // a worktree that had already been committed - which reads as the work having been
    // lost when it is only waiting on the branch.
    const fromWorktree = live && dirtyPaths(t.worktree).length > 0;
    return {
      task: t.id,
      branch,
      target,
      // Whether the directory is still there, so a surface can say where the work is
      // held rather than leaving it to be inferred from an empty diff.
      worktree: live,
      // What the port carries: the porcelain list while there is uncommitted work, and
      // the commit's own files otherwise. Not the base..tip range - a landed branch is
      // its own merge base, so that range is empty exactly when the work is in place.
      files: fromWorktree ? statusPaths(t.worktree) : a.commit ? changedBetween(p.path, `${a.commit}^`, a.commit) : [],
      untracked: untrackedFiles(t.worktree),
      diff: fromWorktree ? worktreeDiff(t.worktree, t) : a.commit ? commitDiff(p.path, a.commit) : '',
      // Which of the two the change above was read from, so a surface can label what it
      // is showing instead of presenting committed work as something still pending.
      from: fromWorktree ? 'worktree' : a.commit ? 'commit' : 'none',
      ...a,
    };
  }

  // Ports a task's work onto a branch. Foreground only, and deliberately not a job:
  // a job carries no options, so a named target would need a column on `jobs` and a
  // step in the runner, and a merge is a decision rather than a long agent run.
  //
  // Nothing lands on a ref it was not asked to touch. A branch that is checked out
  // anywhere is left alone and the command to merge it is printed instead, because
  // moving it would change the tree of whoever is working in it.
  async port(id, opts = {}) {
    const t = this.task(id);
    const p = this.project(t.project_id);
    // A port is not a job, so jobs_one_active does not cover it, and this process's
    // `active` map cannot see a run the dashboard server owns. Committing a worktree
    // out from under a live implementer would publish half a tree and move the
    // branch beneath the agent still writing it.
    if (this.store.taskHasLiveRun(id) || this.store.activeJobs().some((j) => j.task_id === id)) {
      throw new Error('This task has a run or job in flight; wait for it to finish before porting');
    }
    const branch = t.branch || `ai-code/${t.id}`;
    const target = this.portTarget(t, opts);

    if (opts.dryRun) {
      // The prediction is drawn from the branch tip, so uncommitted work is not in
      // it yet. `pending` is what says so, and it is the difference between a
      // prediction and a promise.
      return { dryRun: true, target, branch, ...this.assess(t, p, branch, target) };
    }

    const put = this.materialize(id);
    const a = this.assess(t, p, branch, target);

    // Nothing to port: no commit was ever published for this task and the worktree has
    // nothing the branch lacks. `put.gone` separates the two ways that happens, and it
    // is the difference worth saying out loud - a worktree that was removed with the
    // work already on the branch is not the same as one removed with nothing in it.
    if (put.empty && !a.committed) {
      return {
        task: id, target, branch, commit: null, empty: true, published: false, next: [],
        note: put.gone
          ? `Nothing to port: the worktree is gone and ${branch} holds no commit for this task.`
          : 'Nothing to port: the worktree matches the branch.',
      };
    }

    // Already where it is going. Landing it again would put a merge commit on the
    // target whose tree is the target's own - a commit that changes nothing, with two
    // parents, saying the work has just arrived when it arrived earlier.
    if (a.alreadyPorted) {
      return {
        task: id, target, branch, commit: a.taskTip, landed: null, command: null, cleaned: null,
        empty: false, published: true, next: [], alreadyPorted: true,
        note: `${target} already contains this work. Nothing was moved.`,
      };
    }

    if (!a.clean) {
      throw Object.assign(
        new Error(
          // The destination is what did not move. The task branch did and must have:
          // the commit is what makes the work addressable enough to merge by hand,
          // which is the remedy this message is about to recommend.
          `CONFLICT: ${a.conflicts.length} file(s) differ between ${branch} and ${target} (${a.conflicts.join(', ')}). ` +
            `${target} was not moved. The work is committed on ${branch} - merge it by hand, or port it to a branch that has not moved.`
        ),
        { code: 'CONFLICT', conflicts: a.conflicts }
      );
    }

    let landed = null;
    let command = null;
    if (a.checkedOut) {
      command = a.fastForward ? `git merge --ff-only ${branch}` : `git merge ${branch}`;
    } else if (a.fastForward) {
      setBranch(p.path, target, a.taskTip);
      landed = a.taskTip;
    } else {
      landed = commitTree(p.path, a.mergedTree, [a.targetTip, a.taskTip], `Merge AI Code task ${id} into ${target}`);
      setBranch(p.path, target, landed);
    }

    let cleaned = null;
    // Only when it is still there: the task row keeps the path after a clean, and
    // removing a directory git has already forgotten is an error rather than a no-op.
    if (opts.clean && t.worktree && fs.existsSync(t.worktree)) {
      removeWorktree(p.path, t.worktree);
      cleaned = t.worktree;
    }

    return {
      task: id,
      target,
      branch,
      commit: a.taskTip,
      landed,
      command,
      cleaned,
      empty: false,
      published: true,
      // What a person still has to run. Non-empty exactly when the port stopped short
      // of the destination, which is the case that has to be impossible to miss.
      next: a.next,
      fastForward: a.fastForward,
      alreadyPorted: a.alreadyPorted,
      premisesMoved: a.premisesMoved,
      conflicts: [],
      untracked: untrackedFiles(t.worktree),
      files: put.files,
      // Said plainly rather than implied, because the one thing this has not done is
      // run the tests where the change is going. A fresh worktree at the merge would
      // have none of the destination's ignored files, so the run would fail on
      // node_modules rather than on the change; the destination tree is the only
      // place the check is real, and it belongs to whoever runs the command above.
      note: 'The tests were green in the worktree. Re-run them in the destination after merging.',
    };
  }

  // -- cancellation ---------------------------------------------------------

  cancelTask(id) {
    this.task(id);
    // Durable first. This row is the only channel to a run owned by another
    // process, and that process notices within one tick. Aborting a controller we
    // own below is just the fast path on top of it.
    this.store.requestCancel(id);
    // Also on the task itself: a cancel that lands while no agent is mid-run -
    // between two steps, or during the test command - has no lease to mark, and
    // would otherwise be forgotten by the time the next agent starts.
    this.store.setTaskCancel(id, true);
    const live = [...this.active.entries()].filter(([, v]) => v.taskId === id);
    for (const [, v] of live) v.controller.abort(cancelled());
    if (!live.length) {
      // Nothing here owns the run. Writing the rows directly covers a run whose
      // process died without cleaning up; a live owner writes the same values a
      // tick from now, which is harmless.
      for (const r of this.store.listRuns(id).filter((r) => r.status === 'running')) {
        this.store.updateRun(r.id, { status: 'cancelled', ended_at: new Date().toISOString(), error: 'Cancelled by user' });
      }
    }
    // Read before a cross-process owner has written its state back, so this is the
    // pre-cancel snapshot. Callers reload; nothing depends on the returned state.
    return this.task(id);
  }

  // -- routing --------------------------------------------------------------

  // The circuit-breaker thresholds come from routing.json's top-level `health`
  // block, merged over the defaults so a partial override never leaves a hole.
  healthThresholds() {
    return healthThresholds(this.policies.health);
  }

  // One query for every provider, resolved against a single `now` so two providers
  // in the same selection cannot be judged against clocks a millisecond apart.
  healthNow(now = Date.now()) {
    return this.store.providerHealthMap(now, this.healthThresholds());
  }

  // Health writes always carry the configured thresholds. The store's own default
  // would silently disagree with a `health` block in routing.json, so nothing
  // above the store calls it without them.
  recordFailure(providerId, code) {
    return this.store.recordProviderFailure(providerId, code, { thresholds: this.healthThresholds() });
  }

  recordSuccess(providerId) {
    return this.store.recordProviderSuccess(providerId, { thresholds: this.healthThresholds() });
  }

  // The health of every provider in the shape the APIs and both UIs want. The
  // failure count is read from the runs window rather than stored, so it is
  // correct after a restart and after another process recorded the failure.
  providerHealthList(now = Date.now()) {
    const t = this.healthThresholds();
    const stored = new Map(this.store.listProviderHealthRows().map((r) => [r.provider_id, r]));
    const counts = this.store.countRecentFailuresByProvider(new Date(now - t.windowMs).toISOString());
    return this.store.listProviders().map((p) => {
      const row = stored.get(p.id) || null;
      const h = effectiveHealth(row, now, t);
      return {
        providerId: p.id,
        state: h.state,
        eligible: h.eligible,
        penalty: h.penalty,
        reason: h.reason ?? null,
        failures: counts.get(p.id) || 0,
        cooldownRemainingMs: h.cooldownRemainingMs,
        lastError: row?.last_error ?? null,
        lastFailureAt: row?.last_failure_at ?? null,
        lastSuccessAt: row?.last_success_at ?? null,
      };
    });
  }

  // Every route this role could take, best first. A pure query: no fallback, no
  // last resort. `select` is what turns an empty list into a decision.
  eligible(role, excluded = [], { ignoreHealth = false } = {}) {
    const cap = capability[role];
    const policy = this.policies[role] || {};
    // Preferred entries outrank fallbacks, and either may be written as a bare
    // model id or as provider:model. The first position found wins.
    const pref = [...(policy.preferred || []), ...(policy.fallback || [])];
    const health = ignoreHealth ? new Map() : this.healthNow();
    const rows = [];
    for (const p of this.store.listProviders()) {
      const routable = p.config?.routable !== false && p.kind !== 'mock';
      if (!p.enabled || !routable || excluded.includes(p.id)) continue;
      // An OPEN circuit is the one hard filter in routing. A DEGRADED provider is
      // still eligible; its penalty is applied to the score below.
      const h = health.get(p.id);
      if (h && !h.eligible) continue;
      // A provider already at its concurrency limit is not a candidate, so the
      // next run routes elsewhere instead of queueing behind the one in flight.
      // `runner` is null outside the server, and the check then never fires.
      if (this.runner?.atCapacity(p)) continue;
      for (const m of this.store.listModels(p.id)) {
        if (!m.enabled || !m.capabilities.includes(cap)) continue;
        // `excluded` accepts model ids as well as provider ids, so a model that is
        // the wrong shape for this particular prompt can be skipped without
        // discarding the rest of its provider's line-up.
        if (excluded.includes(m.id)) continue;
        if (m.reasoning && !reasoningFloor[role].includes(m.reasoning)) continue;
        if (TOOL_ROLES.has(role) && m.toolUse === false) continue;
        const byModel = pref.indexOf(m.id);
        const prefIndex = byModel >= 0 ? byModel : pref.indexOf(`${p.id}:${m.id}`);
        const providerIndex = pref.indexOf(p.id);
        const preference = prefIndex >= 0 ? 100000 - prefIndex * 1000 : providerIndex >= 0 ? 50000 - providerIndex * 1000 : 0;
        // Cost is a rough per-token expectation: output is billed once, input is
        // weighted at a quarter to stand in for the usual prompt/output ratio.
        const expected = (m.outputCostPerMTok ?? 0) + (m.inputCostPerMTok ?? 0) * 0.25;
        const base = preference + m.quality * (policy.quality ?? 1) + m.speed * (policy.speed ?? 0.3) - expected * (policy.cost ?? 0.1);
        // The penalty is multiplicative so it scales with a model's own score
        // rather than flattening the ranking to a constant subtraction.
        const score = base * (1 - (h?.penalty || 0));
        rows.push({ p, m, score, health: h?.state || 'HEALTHY' });
      }
    }
    rows.sort((a, b) => b.score - a.score);
    return rows;
  }

  select(role, excluded = []) {
    const rows = this.eligible(role, excluded);
    if (rows[0]) return rows[0];
    // Every provider is in an OPEN circuit. Retrying the best of them beats
    // failing with "no available model", which tells the user nothing: the run
    // records the real error, and the attempt is what re-opens a window on it.
    const forced = this.eligible(role, excluded, { ignoreHealth: true })[0];
    if (forced) return { ...forced, healthForced: true };
    // Mock providers are excluded from routing above (a real install must never
    // route to them by accident), so they are only reachable as a last resort,
    // and only when the caller opted in.
    if (this.options.allowMock) {
      for (const p of this.store.listProviders()) {
        if (p.kind !== 'mock' || !p.enabled || excluded.includes(p.id)) continue;
        for (const m of this.store.listModels(p.id)) {
          if (m.enabled && !excluded.includes(m.id) && m.capabilities.includes(capability[role])) return { p, m, score: 0 };
        }
      }
    }
    throw new Error(`No available model capable of ${role}`);
  }

  // -- run helpers ----------------------------------------------------------

  // Claim or refresh this run's lease. Shared state, and it may be called from an
  // interval callback, so it must never throw: a missed heartbeat only makes the
  // run look stale to other processes, which is far better than killing it.
  #beat(runId, taskId) {
    try {
      this.store.heartbeat(runId, taskId);
    } catch {
      /* reaped once the previous heartbeat goes stale */
    }
  }

  // Stops a run that has crossed a budget. The controller is aborted first, which
  // is what kills the detached agent process group, and the error is then thrown
  // out of the event loop so the attempt ends there rather than draining a stream
  // that is no longer worth paying for.
  #stopRun(controller, code, message) {
    const err = Object.assign(new Error(message), { code });
    controller.abort(err);
    return err;
  }

  // Refresh the lease and honour a cancel requested by another process. The tick
  // that redraws the spinner calls this, so cancellation latency equals the
  // redraw interval without needing a second timer.
  #pollLease(runId, taskId, controller) {
    this.#beat(runId, taskId);
    try {
      // Two channels. The lease covers a run already in flight; the task flag
      // covers the gap between two steps of the same task, and the test command,
      // which holds no lease and so cannot be signalled any other way.
      if (this.store.cancelRequested(runId) || (taskId && this.store.taskCancelRequested(taskId))) controller.abort(cancelled());
    } catch {
      /* treat an unreadable flag as "not cancelled" and check again next tick */
    }
  }

  // Stops every agent this process is driving. Called by the server's signal
  // handlers, through the Runner: aborting the controller is what triggers the
  // group kill in src/agents.mjs, so this is how a Ctrl-C reaches the detached
  // process groups instead of orphaning them.
  abortAll(reason = cancelled()) {
    for (const v of this.active.values()) v.controller.abort(reason);
  }

  // The provider may report usage in any of several shapes, or not at all.
  usageFrom(data) {
    const u = data?.usage || data?.result?.usage || data?.message?.usage || data?.metadata?.usage;
    if (!u) return null;
    return {
      inputTokens: Number(u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? 0),
      outputTokens: Number(u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? 0),
      cacheReadTokens: Number(u.cache_read_input_tokens ?? u.cache_read_tokens ?? 0),
      cacheWriteTokens: Number(u.cache_creation_input_tokens ?? u.cache_write_tokens ?? 0),
    };
  }

  extractText(data) {
    if (typeof data === 'string') return data;
    const c = data?.message?.content ?? data?.content ?? data?.result?.content;
    if (Array.isArray(c)) return c.filter((x) => x?.type === 'text').map((x) => x.text).join('\n');
    if (typeof c === 'string') return c;
    if (typeof data?.result === 'string') return data.result;
    return '';
  }

  price(model, usage, startedAt) {
    const input = usage.inputTokens || 0;
    const output = usage.outputTokens || 0;
    const cacheRead = usage.cacheReadTokens || 0;
    const cacheWrite = usage.cacheWriteTokens || 0;
    let i = model.inputCostPerMTok || 0;
    let o = model.outputCostPerMTok || 0;
    let cr = model.cacheReadCostPerMTok || 0;
    let cw = model.cacheWriteCostPerMTok || 0;
    let basis = model.billingMode === 'api' ? 'published-api-rate' : 'list-price-equivalent';
    // Off-peak pricing is a published-rate concept, and only a model that carries
    // peak rates has it. Keyed on the rates themselves rather than on the
    // provider's id: an id is the user's to rename, and renaming it must not
    // silently reprice every run.
    // Peak is UTC weekday 01:00-04:00 and 06:00-10:00; everything else is off-peak.
    if (model.billingMode === 'api' && model.peakInputCostPerMTok != null) {
      const h = new Date(startedAt).getUTCHours();
      const day = new Date(startedAt).getUTCDay();
      const peak = day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
      if (peak) {
        i = model.peakInputCostPerMTok ?? i;
        o = model.peakOutputCostPerMTok ?? o;
        cr = model.peakCacheReadCostPerMTok ?? cr;
        cw = model.peakCacheWriteCostPerMTok ?? cw;
        basis = 'published-api-rate-peak';
      } else {
        basis = 'published-api-rate-off-peak';
      }
    }
    const cost = (input * i + output * o + cacheRead * cr + cacheWrite * cw) / 1e6;
    return { cost, input, output, cacheRead, cacheWrite, basis };
  }

  // Runs one agent role, walking the fallback chain until one attempt succeeds.
  // Every attempt is its own run row and its own lease, so a failure is recorded
  // rather than retried invisibly.
  async runRole(task, role, prompt, cwd, excluded = []) {
    let last;
    let previous = null;
    let resumeSession = this.resumeCandidate(task, role);
    // A background job is silent: the Runner logs one line per job instead, and
    // two runs sharing the server's stderr would interleave their spinners.
    const quiet = this.options.silent || this.quiet;
    const log = quiet ? () => {} : (m) => process.stderr.write(`  [${role}] ${m}\n`);

    for (let attempt = 0; attempt < 8; attempt++) {
      let p, m, healthForced;
      try {
        ({ p, m, healthForced } = this.select(role, excluded));
      } catch (selErr) {
        // Nothing left to route to. A real failure from an earlier attempt says
        // far more than "no model available", so prefer it.
        throw last || selErr;
      }
      const policy = this.policies[role] || {};
      const timeoutMs = (policy.timeout || 600) * 1000;
      // The budgets are per attempt, like the timeout: a fallback starts a fresh
      // agent with a fresh context, and a budget failure does not fall back at all.
      const maxToolCalls = budgetOf(policy.maxToolCalls);
      const maxRunCost = budgetOf(policy.maxRunCost);
      log(`${m.displayName || m.name} via ${p.name}${previous ? ' (fallback)' : ''}${healthForced ? ' (all providers unhealthy; retrying anyway)' : ''}`);

      const run = this.store.addRun({
        id: this.store.id(),
        taskId: task.id,
        role,
        providerId: p.id,
        modelId: m.id,
        status: 'running',
        startedAt: new Date().toISOString(),
        fallbackFrom: previous,
      });
      const started = Date.now();
      let sessionId = null;
      let approxTokens = 0;
      let toolCalls = 0;
      let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

      const controller = new AbortController();
      // providerId is carried so the concurrency gate can count what a provider is
      // already doing without a second query.
      this.active.set(run.id, { controller, taskId: task.id, role, providerId: p.id });
      // Claim the lease before anything can take time, so other processes can see
      // this run immediately rather than only after the first tick.
      this.#beat(run.id, task.id);

      try {
        // Assembled against `cwd`, the tree the agent actually runs in - the
        // worktree for implementer, reviewer and repair, and the project root for
        // the planner. Reading the project root for a worktree run would hand the
        // agent a file list that does not match its own checkout.
        const context = buildTaskContext(this.project(task.project_id), task, { role, cwd, store: this.store, config: this.contextConfig() });
        const taskText = task.description || task.title;
        const full = `You are the ${role} agent in AI Code. The harness owns workflow state. Never claim a state transition occurred unless the harness performs it.\n\nTASK:\n${taskText}\n\nAPPROVED PLAN:\n${task.plan || '(planning stage)'}\n\nPROJECT CONTEXT:\n${JSON.stringify(context)}\n\nINSTRUCTIONS:\n${prompt}`;

        // The context-length check lives here rather than in select(), because
        // this is the first point at which the real size is known: a pre-filter
        // would have to guess at a number measured a few lines later, before any
        // process is spawned. The 85% headroom is for the model's own output.
        const needTokens = Math.ceil(full.length / 4);
        if (m.contextLength && needTokens > m.contextLength * 0.85) {
          throw Object.assign(new Error(`${needTokens} tokens exceeds ${m.contextLength} for ${m.displayName || m.name}`), { code: 'CONTEXT_TOO_LARGE' });
        }
        // What this attempt actually cost before the model said a word. Recorded
        // even when the run then fails, because the number is what the next
        // attempt's context check has to reason about.
        this.store.updateRun(run.id, {
          context_tokens: needTokens,
          relevant_files: context.manifest.files.length,
          context_budget: context.manifest.budget,
        });

        let dots = 0;
        const tick = setInterval(() => {
          dots++;
          // The spinner shares the tick with the lease work but respects silence:
          // concurrent runs write to one shared stderr and interleave into garbage.
          if (!quiet) process.stderr.write(`\r  [${role}] working${'·'.repeat(dots % 4).padEnd(3)} ${Math.round((Date.now() - started) / 1000)}s`);
          this.#pollLease(run.id, task.id, controller);
        }, this.options.tickMs ?? TICK_MS);

        const timeoutId = setTimeout(() => {
          const err = new Error(`${role} timed out after ${policy.timeout || 600}s`);
          err.code = 'TIMEOUT';
          controller.abort(err);
        }, timeoutMs);

        try {
          for await (const e of runAgent(p, m, {
            role,
            task,
            project: context.project,
            context,
            worktree: cwd,
            prompt: full,
            effort: policy.effort || p.config?.effort || undefined,
            signal: controller.signal,
            resumeSession,
          })) {
            this.store.addEvent({ runId: run.id, type: e.type, data: e.data });
            const u = this.usageFrom(e.data);
            if (u) usage = { ...usage, ...u };
            const txt = this.extractText(e.data);
            approxTokens += Math.ceil(txt.length / 4);
            if (e.type === 'completed' && e.data?.sessionId) sessionId = e.data.sessionId;
            // Checked as the stream arrives rather than when it ends: the point of
            // a budget is to stop the run that is spiralling, and a run that has to
            // finish before it can be measured is not stopped at all.
            toolCalls += countToolCalls(e);
            if (toolCalls > maxToolCalls) {
              throw this.#stopRun(controller, 'TOOL_CALL_LIMIT', `${role} made ${toolCalls} tool calls, over its budget of ${maxToolCalls}`);
            }
            const spent = this.price(m, usage, new Date(started).toISOString()).cost;
            if (spent > maxRunCost) {
              throw this.#stopRun(controller, 'COST_LIMIT', `${role} spent $${spent.toFixed(2)}, over its ceiling of $${maxRunCost}`);
            }
          }
        } finally {
          clearTimeout(timeoutId);
          clearInterval(tick);
          if (!quiet) process.stderr.write('\r\x1b[K');
        }

        // Prefer the provider's own usage numbers; fall back to the estimate when
        // it reported none at all.
        const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens || approxTokens;
        const priced = this.price(m, usage, new Date(run.started_at || run.startedAt || new Date()).toISOString());
        this.store.updateRun(run.id, {
          status: 'succeeded',
          ended_at: new Date().toISOString(),
          tokens: total,
          cost: priced.cost,
          duration_ms: Date.now() - started,
          session_id: sessionId,
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_read_tokens: usage.cacheReadTokens,
          cache_write_tokens: usage.cacheWriteTokens,
          cost_basis: priced.basis,
        });
        log(`done in ${Math.round((Date.now() - started) / 1000)}s, ${total} tokens`);
        // Nothing used to be written on success, so a DEGRADED provider had no way
        // back to HEALTHY.
        try {
          this.recordSuccess(p.id);
        } catch {
          /* the run succeeded; a health write that fails must not undo that */
        }
        return { provider: p, model: m, runId: run.id, sessionId, usage, cost: priced.cost };
      } catch (e) {
        last = e;
        log(`failed: ${e.code || ''} ${e.message.split('\n')[0]}`);
        const code = e.code || classify(e.message);

        if (code === 'CANCELLED') {
          // A cancel is not a provider fault, so the provider is not penalised and
          // no fallback is attempted. The caller decides what the task state becomes.
          this.store.updateRun(run.id, {
            status: 'cancelled',
            ended_at: new Date().toISOString(),
            error: 'Cancelled by user',
            duration_ms: Date.now() - started,
            session_id: e.sessionId ?? null,
          });
          // The cancel has been delivered, so it is spent. Leaving the flag set
          // would abort the next agent the moment it started.
          this.store.setTaskCancel(task.id, false);
          throw e;
        }

        this.store.updateRun(run.id, {
          status: 'failed',
          ended_at: new Date().toISOString(),
          error: `${code} ${e.message}`,
          duration_ms: Date.now() - started,
          session_id: e.sessionId ?? null,
        });
        // Health lives in its own table rather than in provider config, so this
        // write cannot race a config edit on the same provider.
        try {
          this.recordFailure(p.id, code);
        } catch {
          /* a health write that fails must not replace the real failure */
        }
        // A budget failure ends the run here. The fallback chain exists to route
        // around a provider that is not working, and this one worked exactly as
        // asked - handing the same agent to the next provider would spend the same
        // budget to reach the same place.
        if (BUDGET_CODES.has(code)) throw e;
        // Only a transient failure is worth resuming a session for; anything else
        // means the session itself is in a bad state.
        resumeSession = isTransient(code) ? e.sessionId || resumeSession : null;
        // A prompt that was too large for this model says nothing about the model's
        // siblings, so only the model itself is excluded. Every other failure is
        // the provider's, and taking the whole provider out is the point.
        excluded = [...excluded, code === 'CONTEXT_TOO_LARGE' ? m.id : p.id];
        previous = p.id;
        if (attempt < 7) continue;
        throw e;
      } finally {
        this.active.delete(run.id);
        try {
          this.store.releaseLease(run.id);
        } catch {
          /* a stranded lease is reaped once it goes stale */
        }
      }
    }
    throw last;
  }

  // Whether a failure code is worth walking the fallback chain for. The policy
  // table in src/health.mjs is the single place that decides this.
  transient(code) {
    return isTransient(code);
  }

  // Only the roles that keep a conversation across a retry resume one, and only
  // when the previous failure was transient.
  resumeCandidate(task, role) {
    if (role !== 'implementer' && role !== 'repair') return null;
    const prior = this.store.listRuns(task.id).filter((r) => r.role === role && r.session_id && r.status !== 'running').pop();
    if (!prior) return null;
    return this.transient(String(prior.error || '').split(/\s+/)[0]) ? prior.session_id : null;
  }

  // -- provider connectivity and diagnostics --------------------------------

  async testProvider(id, modelId) {
    const p = this.store.getProvider(id);
    if (!p) throw new Error('Provider not found');
    const models = this.store.listModels(id);
    const m = modelId ? this.store.getModel(modelId) : models.find((x) => x.enabled) || models[0];
    if (!m) throw new Error('Provider has no models');
    const run = this.store.addRun({ id: this.store.id(), taskId: null, role: 'provider-test', providerId: p.id, modelId: m.id, status: 'running', startedAt: new Date().toISOString() });
    // A connectivity test is a run like any other and gets a lease, so another CLI
    // command opening the store mid-test cannot mark it interrupted. It carries no
    // task id, so it is never cancellable and the lease is never refreshed - a test
    // that outlives the staleness window has to fend for itself.
    this.#beat(run.id, null);
    const started = Date.now();
    try {
      let text = '';
      for await (const e of runAgent(p, m, {
        role: 'provider-test',
        task: { id: 'provider-test', title: 'Provider connectivity test', project_id: null, plan: null },
        project: { path: process.cwd() },
        context: {},
        worktree: process.cwd(),
        prompt: 'Reply with exactly OK. Do not use tools and do not modify files.',
        effort: p.config?.effort || 'medium',
      })) {
        this.store.addEvent({ runId: run.id, type: e.type, data: e.data });
        const tx = this.extractText(e.data);
        if (tx) text += tx;
      }
      this.store.updateRun(run.id, { status: 'succeeded', ended_at: new Date().toISOString(), duration_ms: Date.now() - started });
      return { ok: true, provider: p.name, model: m.name, response: text.slice(-1000), runId: run.id };
    } catch (e) {
      this.store.updateRun(run.id, { status: 'failed', ended_at: new Date().toISOString(), error: `${e.code || ''} ${e.message}`, duration_ms: Date.now() - started });
      return { ok: false, provider: p.name, model: m.name, error: e.message, code: e.code || classify(e.message), runId: run.id };
    } finally {
      try {
        this.store.releaseLease(run.id);
      } catch {
        /* reaped once stale */
      }
    }
  }

  // Generates the two documents the context assembler reads. Deliberately separate
  // from `context init`: that command is deterministic and LLM-free, and this one
  // is opt-in, additive, and rewrites only the two generated files.
  async contextEnrich(projectId) {
    const project = this.project(projectId);
    const run = this.store.addRun({ id: this.store.id(), taskId: null, role: 'context-enrich', providerId: 'pending', modelId: 'pending', status: 'running', startedAt: new Date().toISOString() });
    this.#beat(run.id, null);
    const started = Date.now();
    try {
      // The planner role: writing an architecture summary is the same job as
      // planning, and it wants the same kind of model.
      const { p, m } = this.select('planner');
      const info = inspect(project.path);
      const deps = readDependencies(project.path);
      const sources = relevantFiles(project, { title: `overview of ${project.name}`, description: '' }, { cwd: project.path, limit: 25 });
      const prompt = [
        'Write two documents that will be given to other agents as background.',
        'Reply with exactly two fenced blocks and nothing else:',
        '```architecture.md',
        '<how this project is structured, its main modules, and how data flows>',
        '```',
        '```conventions.md',
        '<the coding conventions a contributor must follow: naming, layout, tests, error handling>',
        '```',
        'Base every statement on the files below. Do not speculate about files you were not shown.',
        '',
        `FILE TREE (${info.files.length} files):`,
        info.files.slice(0, 400).join('\n'),
        '',
        `DEPENDENCIES: ${deps.map((d) => `${d.name}@${d.version || '*'}`).join(', ') || 'none declared'}`,
        '',
        'KEY FILES:',
        ...sources.contents.map((f) => `--- ${f.path}\n${f.text}`),
      ].join('\n');

      let text = '';
      for await (const e of runAgent(p, m, {
        role: 'planner',
        task: { id: 'context-enrich', title: `Context for ${project.name}`, project_id: project.id, plan: null },
        project: { path: project.path },
        worktree: project.path,
        prompt,
        effort: 'high',
      })) {
        this.store.addEvent({ runId: run.id, type: e.type, data: e.data });
        const tx = this.extractText(e.data);
        if (tx) text += tx;
      }

      const dir = path.join(project.path, '.ai-code', 'context');
      fs.mkdirSync(dir, { recursive: true });
      const written = [];
      for (const name of ['architecture', 'conventions']) {
        // Fenced-block extraction; a model that ignores the format leaves the
        // existing document untouched rather than replacing it with prose.
        const m2 = text.match(new RegExp('```' + name + '\\.md\\s*\\n([\\s\\S]*?)```'));
        if (!m2) continue;
        fs.writeFileSync(path.join(dir, `${name}.md`), `${m2[1].trim()}\n`);
        written.push(`${name}.md`);
      }

      this.store.updateRun(run.id, { status: 'succeeded', ended_at: new Date().toISOString(), duration_ms: Date.now() - started });
      return { ok: true, provider: p.name, model: m.name, project: project.name, written, runId: run.id };
    } catch (e) {
      this.store.updateRun(run.id, { status: 'failed', ended_at: new Date().toISOString(), error: `${e.code || ''} ${e.message}`, duration_ms: Date.now() - started });
      throw e;
    } finally {
      try {
        this.store.releaseLease(run.id);
      } catch {
        /* reaped once stale */
      }
    }
  }

  async doctor() {
    const checks = [];
    for (const cmd of ['git', 'node']) {
      try {
        const { stdout } = await exec(cmd, ['--version']);
        checks.push({ name: cmd, ok: true, version: stdout.trim() });
      } catch {
        checks.push({ name: cmd, ok: false });
      }
    }
    try {
      const { stdout } = await exec('claude', ['--version']);
      checks.push({ name: 'claude', ok: true, version: stdout.trim() });
    } catch {
      checks.push({ name: 'claude', ok: false, requiredForRealAgents: true });
    }
    for (const p of this.store.listProviders().filter((x) => x.kind === 'deepseek')) {
      const keyEnv = p.config.apiKeyEnv || 'DEEPSEEK_API_KEY';
      checks.push({ name: p.name, ok: !!process.env[keyEnv], credential: keyEnv });
    }
    return { checks };
  }

  // -- usage ----------------------------------------------------------------

  usage(period = '7d') {
    const spans = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
    if (period !== 'all' && !spans[period]) period = '7d';
    const ms = spans[period];
    const since = ms ? new Date(Date.now() - ms).toISOString() : null;
    const runs = this.store.listRunsSince(since);
    const names = new Map(this.store.listProviders().map((p) => [p.id, p.name]));

    // `tokens` is what the models generated; `context_tokens` is what was sent to
    // them. They are different questions - the second is what the budget governs.
    const totals = { runs: runs.length, tokens: 0, context_tokens: 0, cost: 0, succeeded: 0, failed: 0, fallbacks: 0 };
    const byProvider = new Map();
    const byRole = new Map();
    const byDay = new Map();
    // day -> provider_id -> { runs, cost }. Kept separate from byDay because the
    // provider breakdown needs the per-provider split, not just the total.
    const byProviderDay = new Map();

    for (const r of runs) {
      const tokens = Number(r.tokens || 0);
      const cost = Number(r.cost || 0);
      totals.tokens += tokens;
      totals.context_tokens += Number(r.context_tokens || 0);
      totals.cost += cost;
      if (r.status === 'succeeded') totals.succeeded++;
      if (r.status === 'failed') totals.failed++;
      if (r.fallback_from) totals.fallbacks++;

      const pk = r.provider_id || 'unknown';
      const pv = byProvider.get(pk) || { provider_id: pk, provider: names.get(pk) || pk, runs: 0, tokens: 0, cost: 0, failed: 0 };
      pv.runs++;
      pv.tokens += tokens;
      pv.cost += cost;
      if (r.status === 'failed') pv.failed++;
      byProvider.set(pk, pv);

      const rk = r.role || 'unknown';
      const rv = byRole.get(rk) || { role: rk, runs: 0, tokens: 0, context_tokens: 0, cost: 0 };
      rv.runs++;
      rv.tokens += tokens;
      rv.context_tokens += Number(r.context_tokens || 0);
      rv.cost += cost;
      byRole.set(rk, rv);

      const day = String(r.started_at || '').slice(0, 10);
      if (!day) continue;
      const dv = byDay.get(day) || { day, runs: 0, tokens: 0, cost: 0 };
      dv.runs++;
      dv.tokens += tokens;
      dv.cost += cost;
      byDay.set(day, dv);

      const pd = byProviderDay.get(day) || new Map();
      const pe = pd.get(pk) || { runs: 0, cost: 0 };
      pe.runs++;
      pe.cost += cost;
      pd.set(pk, pe);
      byProviderDay.set(day, pd);
    }

    const byCost = (a, b) => b.cost - a.cost;
    const byDayKey = (a, b) => (a[0] < b[0] ? -1 : 1);
    return {
      period,
      since,
      totals,
      by_provider: [...byProvider.values()].sort(byCost),
      by_role: [...byRole.values()].sort(byCost),
      by_day: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
      by_provider_day: [...byProviderDay.entries()].sort(byDayKey).map(([day, m]) => ({
        day,
        providers: m.size,
        runs: [...m.values()].reduce((s, x) => s + x.runs, 0),
        cost: [...m.values()].reduce((s, x) => s + x.cost, 0),
      })),
      cost_by_provider: [...byProviderDay.entries()]
        .sort(byDayKey)
        .flatMap(([day, m]) => [...m.entries()].map(([pk, v]) => ({ day, provider_id: pk, provider: names.get(pk) || pk, cost: v.cost, runs: v.runs }))),
      top_runs: [...runs].sort(byCost).slice(0, 5),
    };
  }

  // -- configuration passthrough --------------------------------------------

  getRouting() {
    return this.policies;
  }

  saveRouting(p) {
    this.policies = savePolicies(this.root, p);
    return this.policies;
  }

  addProvider(p) {
    return this.store.addProvider(p);
  }

  addModel(m) {
    this.store.addModel(m);
    return this.store.getModel(m.id);
  }

  updateProvider(id, p) {
    return this.store.updateProvider(id, p);
  }

  updateModel(id, p) {
    return this.store.updateModel(id, p);
  }
}
