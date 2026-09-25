# Token efficiency: what the ledger says and the conventions it implies

`src/service.mjs` records every run's cost, tokens and outcome. This document reads
that record, states where the money went, and names the conventions the measurements
led to. Everything in §1 was measured against the live database on 2026-09-25 — 290
runs, 35 tasks, $18.14, 171.5M tokens generated against 6.7M sent — and the database
is still growing, so the figures are a snapshot and the shapes are the subject.
Reproduce with `node scripts/analyze-usage.mjs`.

The question is not "spend less". It is which spends bought nothing, because the
three shapes that dominate are fixed by different changes: a failed run is a budget
or a provider, a fallback is a provider that was down, a repair is a plan that did
not hold.

## 1. Where the money went

**Fallback chains — $3.27 (18.0% of cost), plus $1.23 the attempts they replaced.**
53 of 263 priced runs were a later attempt in a chain. Each is work attempted twice
because a provider failed, and the failed half is not in the figure above: `fallback_from`
names a provider, not a run, so the cost of what a fallback covered for has to be
recovered positionally. Together the two halves are $4.50, a quarter of all spend.
This is the single largest avoidable shape, and it is not fixed by a code change —
it is fixed by a provider that answers, which the circuit breaker already tries to
enforce.

**Failed runs — $1.34 (7.4% of cost) across 91 runs.** 34.6% of priced runs failed.
The money is smaller than the count because the cheapest failures are the ones caught
earliest: 14 AUTH_FAILURE runs cost nothing at all, and the largest code is
USAGE_LIMIT (12 runs, $0.63) — a provider refusing work it was never going to do.
Budgets and the breaker are the existing answer and no change was made for this.

**One repair spiral — $1.34 (7.4% of cost).** 31 repair runs cost $0.57 in total, which
reads as cheap until the runs are grouped the way the ceiling counts them: by task
*and plan revision*. One revision — task `820e5d05`, "Review the entire UI and fix
spacing issues" — carries 15 repairs, and every plan revision besides it carries four
or fewer. That one revision spent $1.34, half of all repair spend in the database and
7.4% of everything.

The spiral's shape is the point: the repairs are not what cost. The ten repairs past the
fifth cost $0.15 between them; the five reviews that followed them cost $1.19.
**The loop's cost is the review multiplier.** Each non-converging cycle buys one
cheap edit and one expensive judgement, and no per-run budget can see the cycle,
because every run in it is individually inside its own.

**Context is not the problem it looks like.** 6.7M tokens were sent against 171.5M
generated — 3.7% of the total by sum. An earlier reading of the same data put context
at 55% by averaging each run's ratio, which weights a 200-token planning run the same
as a 400k-token implementation. Traffic-weighted, the sent side is small, and the
`context.budget` of 50,000 is governing a slice that is already modest.

**Cache hit rates, by provider:** anthropic-claude-code 88.3%, deepseek-claude-code
95.0%, openrouter 57.7%. The first two are near the ceiling of what prefix caching can
do; the third is where the remaining headroom is, and D3 below moves in that direction
for every provider at once.

## 2. What was already bounded

Per-run budgets (`timeout`, `stall`, `maxToolCalls`, `maxRunCost`) stop a run that is
spending without progressing. The circuit breaker stops routing to a provider that is
failing. `windowBudget` sizes the prompt to the model's window with an output reserve.
All three were in place before this work and none of them changed.

None of them can see a cycle. `820e5d05` is the proof: no run in it failed a budget,
no provider was down, and the task spent $4.03 across 15 repairs and 13 reviews without
ever leaving the repair loop.

## 3. Conventions applied

### 3.1 Order the prompt by volatility — stable-prefix caching

Anthropic's prompt cache and DeepSeek's context cache both match on a *prefix* of the
request: bytes that are identical to a recent request are billed at the cache rate, and
the first byte that differs invalidates everything after it. A prompt assembled as a
JSON object therefore has its cache behaviour set by its key order, and an order chosen
for readability rather than for volatility (task first, project context later) invalidates
the cache on every run — the task id is the first byte of the prompt.

`buildTaskContext` now returns its sections least-volatile first: `project`, `tree`,
`architecture`, `conventions`, `spec`, then `task`, `files`, `review`, `previous`,
`parent`, `manifest`. The project row and its three standing documents are the same
string for every run against a project; `task` changes per task; `files`, `review`,
`previous` and `parent` change per attempt. V8 keeps string keys in insertion order,
so what the code writes is what the provider is sent.

Sources: [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
(a 1024-token minimum for the cached prefix — shorter prefixes are not cached at all,
which bounds this change's effect on small prompts),
[DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache).

### 3.2 Bound the loop at runtime, then hand off — never discard work

Two conventions, and both are about where the bound lives:

**The bound is enforced by the runtime, not asked for in a prompt.** Claude Code
subagents declare `maxTurns` in their frontmatter; Anthropic's advisor tool uses a
`MAX_TURNS` constant. A prompt that says "stop after five attempts" is a suggestion the
loop is free to ignore, and a loop that ignores it is exactly the one that needed
bounding. `repair.maxRepairs` is enforced in `Service.repair` before any agent starts,
in the same class as the `maxToolCalls` and `maxRunCost` budgets already there.

**On tripping, stop acting and escalate — do not discard.** The circuit-breaker
convention for agents is: stop starting new actions, return the partial results, write
a structured termination event, and escalate to a human gate. Applied here: the
pre-check stops the spend, the worktree and branch are left untouched as the checkpoint,
the refusal writes one provider-less run row into the ledger as the auditable event,
and the task lands in `FAILED` — where the two verbs that can act on it already live, and
where the message names all three exits in the order worth trying.

Replan is recommended because a ceiling reached is evidence about the plan: the findings
have now survived five attempts to answer them, and the sixth attempt at the same text
is the loop. The failing review is carried into the planner prompt, because it is the one
input a new planner can act on and the one the old plan could not answer. See
`repairLimitError` in `src/service.mjs` and "The repair ceiling and the way out" in
`docs/PHASES.md`.

Sources: [Anthropic advisor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool)
(`MAX_TURNS`), [circuit breakers for agents](https://raw.githubusercontent.com/agentpatterns-ai/website/refs/heads/main/observability/circuit-breakers.md),
[Claude Code loops](https://claude.com/blog/getting-started-with-loops).

### 3.3 Measure spend per outcome, not per token — spend telemetry

A total cost tells you what you spent, not whether it bought anything. `usage()` now
carries four waste totals alongside the existing ones:

| Key | Question it answers |
|---|---|
| `failed_cost` | spend on runs that failed — money that bought nothing |
| `fallback_cost` | spend on later attempts in a chain — the price of a provider that was down |
| `repair_runs` | how much of the period was rework |
| `repair_cost` | and what the rework cost |

They are separate figures rather than one "waste" number because they have different
fixes, and they sum over `priced` — the same provider filter that keeps the test command
out of a model spend report — so a refusal row cannot appear as spend. Per-provider and
per-role rows carry `failed_cost` too, because "which provider's failures cost me" is a
question about one row and a total over all of them cannot answer it. The convention is
to judge cost per *completed task*, which is the only denominator that punishes a cheap
loop that never converges.

### 3.4 Take the free wins before the tradeoffs

Cache ordering (§3.1) and the loop bound (§3.2) cost nothing in output quality: the
same prompt, in a better order, and a stop that fires only on a cycle that was already
failing. Model downgrades, smaller context and shorter timeouts all trade quality or
completion for money, and none of them was needed to move the numbers below — the
database's avoidable spend was concentrated in one loop, not spread across every run.
The first move on a cost problem is to find where the waste is concentrated, not to
lower a ceiling everywhere.

## 4. What the ceiling would have saved, measured

Applying `maxRepairs: 5` to the recorded history, per task and plan revision: one
revision trips it, 10 repairs never run and the 5 reviews behind them are never bought.

**$1.34 not spent — 7.4% of all cost in the database, from one loop.** The recurring
value is the shape: the same ceiling applies to every future cycle, and each one now
parks at a decision point instead of spending until someone notices.

## 5. Tunables

| Tunable | Where | Value | Evidence |
|---|---|---|---|
| `repair.maxRepairs` | policy defaults / routing.json | 5 | all revisions ≤4 repairs except one at 15; counted per plan revision; `COMPLETE` does not reset it |
| `planner.maxRunCost` | policy defaults | 1 | planner spend is $0.42 over 3 runs on the spiral task; a planner that exceeds $1 is exploring without converging |
| `reviewer.maxRunCost` | policy defaults | 1 | top reviewer run $0.67 |
| `implementer.maxRunCost` | policy defaults | 5 | largest single implementer run in the database is $0.16 |
| `context.budget` | context defaults | 50000 | §1: the sent side is 3.7% of tokens and the ranker is the smaller half of cost |
| `health.openAfter` / `cooldownMs` | health defaults | 3 / 2min | §1: fallback chains are the largest avoidable shape |

Non-positive or absent means no ceiling, for every budget above.

## 6. Deliberately not changed

- **The fallback chain.** $3.27 plus $1.23 is the largest avoidable figure, and it is
  the one with no code fix: the chain exists precisely because a provider may fail, and
  removing it would make a provider outage a task outage. The breaker and the budgets
  are the existing answer.
- **Chat.** $1.57 of the database's spend is interactive chat, which is a person asking
  questions and reading answers — a different cost model from workflow runs with a
  different denominator, and a budget on it would be a budget on reading.
- **Context size.** §1 and §3.4: no change is justified by the measurements.
- **Total re-read behaviour.** Modest, and bounded by the per-file cap and the
  already-implemented selection logic in `src/context.mjs`.
