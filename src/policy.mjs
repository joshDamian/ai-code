import fs from 'node:fs';
import path from 'node:path';

// routing.json holds one object per role plus a top-level `health` block. Only
// the roles are per-role, so anything that walks the file must walk this list
// rather than Object.keys, or it will treat `health` as a fifth role.
const ROLES = ['planner', 'implementer', 'reviewer', 'repair', 'session'];

// Per-role routing policy. `strategy` decides which model Automatic picks - see
// STRATEGIES below for what each one weighs.
//
// timeout is in seconds. maxToolCalls and maxRunCost (USD) are budgets rather
// than schedules: a wall clock does not stop an agent that is busy the whole
// time, which is how a planning run once spent three and a half minutes and
// $2.21 rediscovering a codebase it had been given no files for. A planner and a
// reviewer explore and answer, so they get a tight budget; the two roles that
// actually edit and test get a wide one. Unset or non-positive means no limit.
//
// stall is the seconds of silence - no progress, no message, no result and no
// tool_progress - that count as wedged. It is the same number for every role
// because silence is a property of the provider rather than of the role. 120s is
// far above what a streaming provider produces, which is a frame every few
// milliseconds or a thinking-token notice every few hundred, and the budget is
// re-armed by every frame that carries work rather than only by the one a response
// opens with - so a finished turn whose next one never arrives is a stall and not a
// wait. Set it to 0 for a provider that batches a whole block before writing it.
//
// subagentWait is the seconds of a run's own wall clock it may spend inside
// subagent calls without being charged for them. The spawn is the agent's own
// decision, but what happens inside it is another agent's work on another
// lifetime, and the parent can neither see it nor bound it - so a planner that
// delegates was being killed for time it did not spend. It is the same number for
// every role, like stall: delegation is a property of the loop, not of the role.
// Zero or absent means no exemption. It is a cap and not a discount, so a chain
// of subagents cannot extend a run without end.
//
// It covers an agent spawn and not a Bash command. The CLI announces both with the
// same `task_started`, but a command the run is waiting on is its own tool call -
// counted against it already, and bounded by the call returning - and the repair of
// bb9ac058 ran two `npm test`s that way. Counting those would let a role that runs
// the suite open its own clock; two of them unclosed would have bought that repair
// most of a second budget.
//
// The two timeouts that had to move. The reviewer's prompt is the largest of the
// four - the task, the plan and the diff - and a reasoning model spends the front
// of the run on it: on 2026-09-23 the reviewer of task 8e900a8c spent 277s
// producing its first block against a budget of 300, and the same task's reviewer
// on a faster provider ran out at 300 mid-review, so it failed twice for the same
// reason. 900 fits a slow first block and a whole review behind it. The planner
// followed for the same reason a day later: on 2026-09-24 the planner of task
// f70c23a7 was cut at 300 mid-thought after 95s of reasoning and 127s inside three
// subagents, still streaming when it died.
//
// maxRepairs is the repair role's own ceiling and the only one here that bounds a
// task rather than a run: it is the number of repair runs one plan revision may
// spend. Every other budget stops something that is still making progress; this one
// stops a cycle that is not - repair, test, review, FAIL, repair - which no per-run
// budget can see, because each run in the cycle is individually inside its budget.
// Task 820e5d05 spent $2.88 and fourteen repair runs that way, each one re-reading
// the same findings and answering them with an edit the next review rejected.
//
// Five, because a repair cycle that has not converged after five attempts is
// evidence about the plan rather than about the code, and the exit that follows is
// a new plan. It is a repair-row key rather than a top-level one so it travels with
// the role it bounds, and it is read per attempt from the live policy, so raising it
// in routing.json is itself the way out (see repairLimitError in src/service.mjs).
// Non-positive or absent means no ceiling, like the other budgets here.
const defaults = {
  planner: { strategy: 'quality', preferred: [], fallback: [], effort: 'high', timeout: 900, stall: 120, maxToolCalls: 40, maxRunCost: 1, subagentWait: 600 },
  implementer: { strategy: 'balanced', preferred: [], fallback: [], effort: 'medium', timeout: 600, stall: 120, maxToolCalls: 200, maxRunCost: 5, subagentWait: 600 },
  reviewer: { strategy: 'quality', preferred: [], fallback: [], effort: 'high', timeout: 900, stall: 120, maxToolCalls: 40, maxRunCost: 1, subagentWait: 600 },
  repair: { strategy: 'speed', preferred: [], fallback: [], effort: 'medium', timeout: 600, stall: 120, maxToolCalls: 200, maxRunCost: 5, subagentWait: 600, maxRepairs: 5 },
  // A supervised session is budgeted where a chat deliberately is not. A chat is a
  // person asking and reading, and the person is the loop that stops it; a session
  // is an agent acting in the user's checkout, and its loop is its own. So it takes
  // the same four budgets the workflow roles take, at the size of one working
  // session rather than one task: a narrower call count than an implementer's 200,
  // because every one of those calls is a person answering a prompt, and $2 rather
  // than $5 for the same reason.
  //
  // permissionTimeoutMs is the one budget with no counterpart above. It is the
  // seconds an agent waits, blocked, for a human to answer a permission prompt
  // before the request is swept to `timeout` - which is a denial. It is short on
  // purpose: nobody is reading the prompt if two minutes have passed, and the
  // agent is holding a provider slot while it waits for an answer that is not
  // coming. dailyCap is the optional ceiling in dollars on what supervised sessions
  // together may spend in a day - the machine's, not one session's, because a cap
  // read per session would let five of them spend five times it. Absent or
  // non-positive means the per-run budget is the only bound.
  session: { strategy: 'balanced', preferred: [], fallback: [], effort: 'medium', timeout: 600, stall: 120, maxToolCalls: 100, maxRunCost: 2, subagentWait: 600, permissionTimeoutMs: 120, dailyCap: 0 },
  // Circuit-breaker thresholds. Absent means the defaults in src/health.mjs apply.
  health: {},
  // Prompt budget for the context assembler. Absent means the defaults in
  // src/context.mjs apply.
  context: {},
};

// Model ids were renamed when the registry gained provider-qualified ids. A saved
// routing.json may still hold the old spelling, so rewrite it on read.
const RENAMED = {
  'anthropic-claude-code:claude-opus': 'anthropic:claude-opus-5',
  'anthropic-claude-code:claude-sonnet': 'anthropic:claude-sonnet-5',
  'deepseek-claude-code:deepseek-deepseek-flash[1m]': 'deepseek:deepseek-flash',
  'deepseek-claude-code:deepseek-deepseek-flash': 'deepseek:deepseek-flash',
};

function normalize(p) {
  const out = { ...p };
  for (const role of ROLES) {
    // A role absent from the saved file falls back to its default rather than
    // becoming undefined.
    out[role] = { ...defaults[role], ...out[role] };
    // The raw weights the router used to read in place of the strategy. Every saved
    // file has them, and honouring them would let a stale number override the
    // strategy the page shows; the strategy is now the whole of the setting.
    for (const key of ['quality', 'speed', 'cost']) delete out[role][key];
    if (!STRATEGIES[out[role].strategy]) out[role].strategy = defaults[role].strategy;
    for (const key of ['preferred', 'fallback']) {
      out[role][key] = (out[role][key] || []).map((x) => RENAMED[x] || x);
    }
  }
  return out;
}

export function loadPolicies(root) {
  const f = path.join(root, '.ai-code', 'routing.json');
  if (!fs.existsSync(f)) {
    // First run: write the defaults out so the file is there to be edited.
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(defaults, null, 2));
    return structuredClone(defaults);
  }
  try {
    // Merged key by key per role (normalize, above): a saved role overrides the
    // defaults only where it names a key, so a role written before a budget
    // existed picks that budget up rather than silently losing it.
    return normalize({ ...defaults, ...JSON.parse(fs.readFileSync(f, 'utf8')) });
  } catch {
    // A corrupt or unreadable file falls back to defaults rather than failing the
    // command that just wanted to route something.
    return structuredClone(defaults);
  }
}

export function savePolicies(root, p) {
  const merged = normalize({ ...defaults, ...p });
  const f = path.join(root, '.ai-code', 'routing.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(merged, null, 2));
  return merged;
}

// What each strategy on the Routing page means, as weights over three measures that
// are each on a 0-1 scale (see modelFit). The strategy is the setting a person
// chooses; these numbers are how the router reads it, for the role's first pick and
// for every slot of its chain left on Automatic. Until 2026-10-05 the router read
// three raw weights stored beside the strategy and never the strategy itself, so the
// toggle on the page changed nothing.
const STRATEGIES = {
  quality: { quality: 1, speed: 0.1, cost: 0.1 },
  balanced: { quality: 0.6, speed: 0.4, cost: 0.4 },
  speed: { quality: 0.3, speed: 1, cost: 0.2 },
  cost: { quality: 0.3, speed: 0.2, cost: 1 },
};

// The share of an agent run's tokens in each billing class, measured over every
// priced run on 2026-10-05: cache reads dominate, writes (or, on a provider with no
// write premium, uncached input) are most of the rest, and output is a sliver that
// is nevertheless priced 5-50x a read.
const TOKEN_MIX = { cacheRead: 0.88, write: 0.1, output: 0.015 };

// A blended dollar rate per million tokens of agent traffic. A subscription model
// is free at the margin - the plan is paid for whether or not it is used - so it is
// priced at zero here. Its list price still prices the run in the ledger.
export function blendedRate(m) {
  if (m.billingMode === 'subscription') return 0;
  const input = m.inputCostPerMTok ?? 0;
  const read = m.cacheReadCostPerMTok ?? input;
  const write = m.cacheWriteCostPerMTok ?? input;
  return TOKEN_MIX.cacheRead * read + TOKEN_MIX.write * write + TOKEN_MIX.output * (m.outputCostPerMTok ?? 0);
}

// A blended rate at or above this scores zero on cost. It is Fable's list rate,
// the most expensive model in any catalog, so the scale does not move when a
// cheaper model is enabled or disabled.
const RATE_CEILING = 3.7;

// How well a model suits a strategy, on a fixed scale. Quality and speed are the
// registry's own 0-10 ratings. Cost is logarithmic, because the gap between $0.03
// and $0.12 a million matters to someone choosing Cost as much as the gap between
// $1 and $4 - a linear scale reads every non-Claude model as equally free.
export function modelFit(m, strategy) {
  const w = STRATEGIES[strategy] || STRATEGIES.balanced;
  const quality = (m.quality ?? 5) / 10;
  const speed = (m.speed ?? 5) / 10;
  const cost = 1 - Math.min(1, Math.log1p(blendedRate(m)) / Math.log1p(RATE_CEILING));
  return w.quality * quality + w.speed * speed + w.cost * cost;
}

export { defaults, ROLES, STRATEGIES };
