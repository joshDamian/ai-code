import path from 'node:path';
import fs from 'node:fs';
import { relevantFiles } from './context.mjs';

// A labelled retrieval benchmark for the context ranker, mined from the database
// rather than annotated by hand.
//
// Every tool call an agent made is already in `events`, so the files a planner
// actually opened are recoverable for free, and the ranking that was offered to
// it is reproducible by re-running `relevantFiles` on the same task. That gives
// a project-specific gold set with no labelling work, which is the only thing
// that makes a change to the scorer provable rather than asserted.
//
// Four decisions this module pins down, because each one changes the number and
// the design note does not settle any of them:
//
//  1. Gold is a *read*, not a search. Grep and Glob name a directory or a search
//     root far more often than they name an answer - `tests` shows up in this
//     repository's own gold set as a Glob argument - so only Read and
//     NotebookRead count.
//
//  2. The unit is one planner *run*, not one task. A task that was planned four
//     times has four attempts at the same question, and pooling them into one
//     gold set makes the answer larger than the window and the number
//     meaningless. One run is one ranking against one gold set.
//
//  3. Paths are normalised across three shapes that all occur in the same
//     database: project-relative, absolute in the project, and absolute inside a
//     per-task worktree. The third names the same file as the first, and
//     counting it twice both inflates the gold set and invents misses.
//
//  4. A run whose gold set is larger than the window cannot score above
//     `k / |gold|` however good the ranking is. Those runs are reported and kept
//     out of the recall mean rather than averaged in as if the shortfall were the
//     ranker's.

export const EVAL_DEFAULTS = { k: 15 };

const READ_FILE_TOOLS = /^(Read|NotebookRead)$/;

// `.ai-code-worktrees-<project>/<task-uuid>/src/x.mjs` is `src/x.mjs`.
const WORKTREE = /\.ai-code-worktrees-[^/]+\/[0-9a-f-]{36}\/(.+)$/;

// One tool path, as the project-relative path it denotes, or null when it
// denotes no file in this project: the repository root itself (a Grep on `.`),
// or a path outside the tree.
export function normalisePath(p, root) {
  const raw = String(p);
  const inWorktree = raw.match(WORKTREE);
  if (inWorktree) return path.normalize(inWorktree[1]);
  const rel = path.relative(root, path.resolve(root, raw));
  if (!rel || rel.startsWith('..')) return null;
  return path.normalize(rel);
}

// The files an agent opened with a reading tool, from one run's events.
export function goldFromEvents(events, root) {
  const out = new Set();
  for (const e of events) {
    const content = e?.data?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== 'tool_use' || !READ_FILE_TOOLS.test(String(b.name))) continue;
      const p = b.input?.file_path || b.input?.notebook_path || b.input?.path;
      if (!p) continue;
      const rel = normalisePath(p, root);
      if (rel) out.add(rel);
    }
  }
  return out;
}

// Binary gain at the first occurrence of each gold file inside the window. A
// gold file ranked below `k` is not counted at all, which is the definition the
// published numbers use.
export function scoreCase(ranked, gold, k = EVAL_DEFAULTS.k) {
  const answers = new Set(gold);
  const positions = [];
  ranked.slice(0, k).forEach((p, i) => {
    if (answers.has(p)) positions.push(i);
  });
  const hits = positions.length;
  const mrr = hits ? 1 / (positions[0] + 1) : 0;
  // Binary gain, so DCG is a sum of 1/log2(rank+1) over the hits and the ideal
  // arrangement is the hits packed into the front of the window.
  let dcg = 0;
  for (const i of positions) dcg += 1 / Math.log2(i + 2);
  let idcg = 0;
  for (let i = 0; i < Math.min(answers.size, k); i++) idcg += 1 / Math.log2(i + 2);
  return {
    hits,
    gold: answers.size,
    k,
    // Null rather than zero when there is nothing to recall: a run with an empty
    // gold set is not a perfect ranking, it is no measurement at all.
    recall: answers.size ? hits / answers.size : null,
    mrr,
    ndcg: idcg ? dcg / idcg : 0,
    capped: answers.size > k,
  };
}

// Every planner run in one project, with the gold set that run's own events
// produced. Gold is filtered to files that still exist: a benchmark that scored
// the ranker against a path deleted six months ago would measure the repository,
// not the ranking.
export function plannerCases(store, project, options = {}) {
  const root = options.root || project.path || store.root;
  const roles = options.roles || ['planner'];
  const cases = [];
  for (const task of store.listTasks(project.id)) {
    const runs = store.listRuns(task.id).filter((r) => roles.includes(r.role));
    if (!runs.length) continue;
    // Read the task's events once and group them, rather than once per run.
    const byRun = new Map();
    for (const e of store.listTaskEvents(task.id)) {
      if (!byRun.has(e.run_id)) byRun.set(e.run_id, []);
      byRun.get(e.run_id).push(e);
    }
    for (const run of runs) {
      const gold = goldFromEvents(byRun.get(run.id) || [], root);
      const present = [...gold].filter((f) => fs.existsSync(path.join(root, f)) && !isDirectory(path.join(root, f)));
      const gone = [...gold].filter((f) => !present.includes(f));
      cases.push({
        runId: run.id,
        taskId: task.id,
        title: task.title,
        description: task.description || '',
        startedAt: run.started_at,
        gold: present,
        // Named rather than dropped: a gold file that no longer exists is a
        // different fact from one the ranker failed to find.
        gone,
      });
    }
  }
  return cases;
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Re-ranks every case with the current scorer and reports what it scored. The
// tree is the one on disk now, not the one the run saw: this measures the
// ranker in front of you, which is what a change has to be judged against.
export function evaluate(project, cases, options = {}) {
  const k = options.k ?? EVAL_DEFAULTS.k;
  const root = options.cwd || project.path;
  const rows = [];
  for (const c of cases) {
    const picked = relevantFiles(
      project,
      { title: c.title, description: c.description, plan: null },
      { cwd: root, limit: k, config: options.config }
    );
    // The ranker is allowed to return the file list the planner's prompt would
    // carry, which is never smaller than the window; the metric is the ranking.
    rows.push({ case: c, ranked: picked.paths, ...scoreCase(picked.paths, c.gold, k) });
  }
  return { k, rows, summary: summarise(rows, k) };
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function summarise(rows, k = EVAL_DEFAULTS.k) {
  const scored = rows.filter((r) => r.gold > 0);
  const capped = scored.filter((r) => r.capped);
  const uncapped = scored.filter((r) => !r.capped);
  const distribution = {};
  for (const r of scored) distribution[r.gold] = (distribution[r.gold] || 0) + 1;
  const hits = (rs) => rs.reduce((a, r) => a + r.hits, 0);
  const golds = (rs) => rs.reduce((a, r) => a + r.gold, 0);
  return {
    k,
    runs: scored.length,
    // Runs with no gold at all: the planner opened nothing recoverable from its
    // events, which is what a run that died early looks like.
    empty: rows.length - scored.length,
    capped: capped.length,
    goldTotal: golds(scored),
    goldDistribution: distribution,
    // Two recalls, and they are not the same number.
    //
    // Macro is the mean of per-run recalls, so a run that read one file moves it
    // as much as a run that read twenty-seven. Micro pools the answers and is the
    // one that describes the corpus. Quoting either alone is how a benchmark
    // misleads; both are reported over the runs where `k / |gold|` was not the
    // binding constraint.
    recallMacro: mean(uncapped.map((r) => r.recall)),
    recallMicro: golds(uncapped) ? hits(uncapped) / golds(uncapped) : null,
    recallRuns: uncapped.length,
    // The part of recall the ranker is responsible for: answers the planner read
    // that the ranking never offered. A gold file that was offered *and* read is
    // partly a fact about the prompt - a planner reads what it is handed - so
    // this is the honest lower bound on what the ranking missed.
    unoffered: uncapped.reduce((a, r) => a + (r.gold - r.hits), 0),
    // Answers that named a file this repository no longer has. Kept out of the
    // gold sets and counted here, because scoring the ranker against a path that
    // was deleted months ago measures the repository rather than the ranking.
    gone: rows.reduce((a, r) => a + (r.case?.gone?.length ?? 0), 0),
    // MRR and nDCG are not capped by a large answer set, so they take every run.
    // nDCG's ideal packs the hits into the front of the window, which is
    // reachable even when the answers outnumber the slots.
    mrr: mean(scored.map((r) => r.mrr)),
    ndcg: mean(scored.map((r) => r.ndcg)),
  };
}

