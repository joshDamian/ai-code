// What a run history cost and how much of it bought nothing.
//
// Reads the whole ledger rather than a usage period, because the questions this
// answers are about shape - how much of the spend went to repairs, how much to
// covering for failed providers - and a shape needs the whole history to be
// visible. `ai-code usage` is the report for "what did this week cost"; this is
// the report for "where does the money go".
//
// Read-only by construction: the connection is opened readOnly and no statement
// here writes. Safe to run against a live .ai-code database while the server is up.
//
//   node scripts/analyze-usage.mjs                  # ./.ai-code/ai-code.db
//   node scripts/analyze-usage.mjs --db /path/to/ai-code.db
//   node scripts/analyze-usage.mjs --root /path/to/project
//   node scripts/analyze-usage.mjs --top 20         # spiral rows to list

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The repair ceiling from src/policy.mjs, duplicated deliberately: this script is a
// measurement of history that mostly predates the ceiling, and the question it asks
// of that history is "how often would this have fired". Importing the live default
// would make this report change meaning the day someone edits routing.json.
const REPAIR_CEILING = 5;

function parseArgs(argv) {
  const out = { db: null, root: null, top: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i];
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--top') out.top = Number(argv[++i]) || 10;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

const money = (n) => `$${Number(n || 0).toFixed(4)}`;
const pct = (part, whole) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—');
const num = (n) => Number(n || 0).toLocaleString();

// The leading token of an error is the code the harness or the adapter raised it
// with - `COST_LIMIT planner spent $1.02...`, `RATE_LIMIT You've hit your session
// limit`. Everything a report wants to group by is that token, and the rest of the
// string is provider prose that varies run to run.
function errorCode(err) {
  const s = String(err || '').trim();
  if (!s) return '(none)';
  return s.split(/[\s:]/)[0].slice(0, 40) || '(none)';
}

function heading(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/analyze-usage.mjs [--db PATH] [--root PATH] [--top N]');
    return;
  }
  const root = path.resolve(args.root || process.cwd());
  const dbPath = path.resolve(args.db || path.join(root, '.ai-code', 'ai-code.db'));
  if (!fs.existsSync(dbPath)) {
    console.error(`No database at ${dbPath}\nPass --db, or --root for a project whose .ai-code/ai-code.db exists.`);
    process.exitCode = 1;
    return;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const runs = db.prepare('SELECT * FROM runs ORDER BY started_at').all();
  const tasks = db.prepare('SELECT id, title, state, plan_at FROM tasks').all();
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // A run still marked running is not evidence about anything: it has no cost yet,
  // no verdict, and it may be a process that died without its lease being reaped.
  // Every share below divides by the terminal rows for that reason - a denominator
  // that moves while the report is being read is how a share comes out wrong.
  const terminal = runs.filter((r) => r.status !== 'running');
  const running = runs.length - terminal.length;

  // Model spend only, matching Service.usage(): the test command is a tracked run
  // with no provider behind it, and a run with no provider spent nothing.
  const priced = terminal.filter((r) => r.provider_id);
  const cost = priced.reduce((s, r) => s + Number(r.cost || 0), 0);
  const generated = priced.reduce((s, r) => s + Number(r.tokens || 0), 0);
  const sent = priced.reduce((s, r) => s + Number(r.context_tokens || 0), 0);

  console.log(`Database: ${dbPath}`);
  console.log(`Runs: ${num(runs.length)} (${num(priced.length)} priced, ${num(running)} still running)`);
  console.log(`Tasks: ${num(tasks.length)}`);
  console.log(`Cost: ${money(cost)}   Generated: ${num(generated)}   Sent: ${num(sent)}`);

  heading('Context share');
  // By sum, not by averaging each run's ratio. The per-run average weights a
  // 200-token planning run the same as a 400k-token implementation, which is how
  // this figure first came out at 55% when the traffic-weighted answer was 3.4%:
  // the expensive runs are the ones with a large generated side, and averaging
  // ratios hides exactly that.
  console.log(`Context ${num(sent)} of ${num(sent + generated)} tokens sent+generated — ${pct(sent, sent + generated)}`);
  console.log(`Generated is ${pct(generated, sent + generated)} of the total; the budget governs the sent side only.`);

  heading('Outcomes');
  const byStatus = new Map();
  for (const r of priced) byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1);
  for (const [status, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`${status.padEnd(12)} ${String(n).padStart(6)}  ${pct(n, priced.length)}`);
  }

  const failed = priced.filter((r) => r.status === 'failed');
  const failedCost = failed.reduce((s, r) => s + Number(r.cost || 0), 0);
  console.log(`\nFailed spend ${money(failedCost)} — ${pct(failedCost, cost)} of all cost, across ${num(failed.length)} runs.`);
  const byCode = new Map();
  for (const r of failed) {
    const k = errorCode(r.error);
    const e = byCode.get(k) || { n: 0, cost: 0, tokens: 0 };
    e.n++;
    e.cost += Number(r.cost || 0);
    e.tokens += Number(r.tokens || 0);
    byCode.set(k, e);
  }
  for (const [code, e] of [...byCode.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    console.log(`  ${code.padEnd(20)} ${String(e.n).padStart(5)}  ${money(e.cost).padStart(11)}  ${pct(e.cost, failedCost)}`);
  }

  heading('Fallbacks');
  const fallbacks = priced.filter((r) => r.fallback_from);
  const fallbackCost = fallbacks.reduce((s, r) => s + Number(r.cost || 0), 0);
  console.log(`${num(fallbacks.length)} runs were a later attempt — ${pct(fallbacks.length, priced.length)} of runs, ${money(fallbackCost)} (${pct(fallbackCost, cost)} of cost).`);
  // The attempt a fallback covered for is not free and is not in the figure above.
  // `fallback_from` names the provider that failed rather than the run, so there is no
  // id to join on and the previous run on the same task and role is the only handle -
  // which is what a fallback is: the same work, one provider later.
  let covered = 0;
  let coveredCost = 0;
  const prevByKey = new Map();
  for (const r of runs) {
    const key = `${r.task_id}\u0000${r.role}`;
    const prev = prevByKey.get(key);
    if (r.fallback_from && prev) {
      covered++;
      coveredCost += Number(prev.cost || 0);
    }
    prevByKey.set(key, r);
  }
  console.log(`The ${num(covered)} attempts those replaced spent a further ${money(coveredCost)} — the two together are what a provider failure cost.`);

  heading('Repair cycles');
  const repairs = terminal.filter((r) => r.role === 'repair');
  const repairCost = repairs.reduce((s, r) => s + Number(r.cost || 0), 0);
  const reviews = terminal.filter((r) => r.role === 'reviewer');
  console.log(`${num(repairs.length)} repair runs, ${money(repairCost)} (${pct(repairCost, cost)} of cost), against ${num(reviews.length)} reviews.`);

  // Per task and per plan revision, which is how the ceiling counts. A task
  // repaired ten times under four different plans is four short cycles, not one
  // spiral, and the ledger cannot tell them apart by task id alone.
  const perTask = new Map();
  for (const r of terminal) {
    if (r.role !== 'repair' || !r.provider_id) continue;
    const t = taskById.get(r.task_id);
    const key = `${r.task_id}\u0000${(t && t.plan_at) || ''}`;
    const e = perTask.get(key) || { taskId: r.task_id, planAt: (t && t.plan_at) || null, n: 0, cost: 0, title: (t && t.title) || '' };
    e.n++;
    e.cost += Number(r.cost || 0);
    perTask.set(key, e);
  }
  const cycles = [...perTask.values()].sort((a, b) => b.cost - a.cost);
  const overCeiling = cycles.filter((c) => c.n >= REPAIR_CEILING);
  const overCost = overCeiling.reduce((s, c) => s + c.cost, 0);
  console.log(`\n${num(cycles.length)} plan revisions needed a repair. ${num(overCeiling.length)} reached ${REPAIR_CEILING} repairs (${money(overCost)}, ${pct(overCost, repairCost)} of all repair spend).`);
  console.log('Those are the revisions a ceiling of ' + REPAIR_CEILING + ' would have stopped:');
  for (const c of cycles.slice(0, args.top)) {
    const mark = c.n >= REPAIR_CEILING ? '*' : ' ';
    console.log(`${mark} ${String(c.taskId).slice(0, 8)}  ${String(c.n).padStart(3)} repairs  ${money(c.cost).padStart(11)}  ${String(c.planAt || 'no plan_at').slice(0, 19)}  ${c.title.slice(0, 48)}`);
  }
  if (cycles.length > args.top) console.log(`  ... and ${num(cycles.length - args.top)} more (--top N to list them)`);

  heading('Cache');
  // What the cache saved, by provider. cache_read is the part of the prompt the
  // provider served from its cache; input_tokens is the part it charged full price
  // for. A provider that reports neither is not at 0% - it is unmeasured, and the
  // two must not be printed the same way.
  const byProvider = new Map();
  for (const r of priced) {
    const k = r.provider_id;
    const e = byProvider.get(k) || { read: 0, input: 0, write: 0, runs: 0, cost: 0, measured: false };
    e.runs++;
    e.read += Number(r.cache_read_tokens || 0);
    e.input += Number(r.input_tokens || 0);
    e.write += Number(r.cache_write_tokens || 0);
    e.cost += Number(r.cost || 0);
    if (r.input_tokens || r.cache_read_tokens) e.measured = true;
    byProvider.set(k, e);
  }
  for (const [pid, e] of [...byProvider.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    // Against everything the provider was sent, so a provider that caches nothing
    // reads as 0% rather than as a ratio over a denominator it does not report.
    const denom = e.read + e.input + e.write;
    const hit = e.measured && denom > 0 ? pct(e.read, denom) : 'unmeasured';
    console.log(`${String(pid).padEnd(22)} ${String(e.runs).padStart(5)} runs  ${money(e.cost).padStart(11)}  cache ${String(hit).padStart(10)}`);
  }

  heading('Top runs by cost');
  for (const r of [...priced].sort((a, b) => Number(b.cost || 0) - Number(a.cost || 0)).slice(0, 10)) {
    console.log(`${String(r.task_id || '—').slice(0, 8)}  ${String(r.role).padEnd(11)} ${String(r.status).padEnd(10)} ${money(r.cost).padStart(11)}  ${num(r.tokens).padStart(9)} gen  ${String(r.model_id).slice(0, 28)}`);
  }
}

main();
