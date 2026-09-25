# Phase 1–12 release acceptance map

1. **Context** — deterministic project inspection and durable `.ai-code/context` files.
2. **Git** — isolated task worktrees, base commit and branch tracking.
3. **Agents** — real Claude Code adapter, DeepSeek Anthropic-compatible adapter, plus mock only for automated tests.
4. **Planning** — Claude Code plan mode, source-write guard, explicit approval gate.
5. **Execution** — approved-plan implementation, tests, persisted run events, live Mission Control event stream.
6. **Providers** — provider registry, model registry, enable/disable, routability, connection tests, model controls and published pricing metadata.
7. **Fallback** — failed provider/model is excluded and the router selects the next capable configured provider/model.
8. **Review/repair** — independent reviewer and repair loop.
9. **Mission Control** — functional Overview, Projects, Tasks, Providers, Routing, Runs, Usage and Settings.
10. **Observability** — provider/model/role history, duration, usage, cost basis, fallback history and event timeline.
11. **Multi-project** — persistent project registry and per-project task/worktree state.
12. **Automation foundation** — persistent automation definitions and webhook-ready API; deliberately not presented as a scheduler.

## Post-completion feedback

`COMPLETE` is no longer terminal. It has exactly one outgoing edge, `REPAIRING`: a human sends feedback on a completed task, the text is stored and prepended to the reviewer's findings, and the repair/review cycle runs again until a review passes. The hint is cleared on the way out, so a later failure of the ordinary kind repairs against the reviewer's findings alone. Nothing else leaves `COMPLETE`, and `CANCELLED` remains terminal.

A completed task can also be named as another task's parent. The link is a single reference, one task to one task; the planner for the child reads a capped summary of the parent's description and review, and drops it first when the prompt is over budget. A question about a task is the existing project chat scoped to that task, which hands the agent that task's plan and review.

## The repair ceiling and the way out

Repair is bounded, and the bound is a plan revision's budget rather than a run's. `repair.maxRepairs` (routing.json; 5 by default, non-positive means no ceiling) is the number of repair runs one plan revision may spend, counted from the ledger so it survives a restart and a second process. A cancelled repair does not count: it was stopped before it could act, and a ceiling a user can reach by cancelling punishes the wrong party. Nothing else about repair changed — each run is still inside its own `timeout`, `maxToolCalls` and `maxRunCost`, which is exactly why a ceiling was needed. Per-run budgets cannot see a cycle, and task `820e5d05` ran fourteen repairs and six reviews for $2.88 without any single run failing a budget.

A repair attempted with the budget already spent does not run. The task transitions to `FAILED` — the state both of its exits are already attached to — and the ledger gets one provider-less row whose error is the refusal, so the reason is readable from the same list as every other run and costs nothing on the usage report. `retry` is gated on the same count before it clears the review, so a ceiling hit through Retry is refused before the test command is paid for. Reviewer and repair failures that route to `REPAIRING` are unchanged, but the number of times they can do so is now finite.

Three exits, in the order the message gives them. **Replan** is recommended: the failing review survives the replan and is handed to the planner, because findings that have outlived five repairs are the one input a new plan can act on, and a new plan revision resets the counter. **Raise `repair.maxRepairs` and Retry** is deliberate: the count persists across it, so it needs raising above what was already spent, and the task stays `FAILED` until the retry is accepted. **Close** needs no code — it discards the worktree, which is the only exit that loses work. `COMPLETE` does not refund the count: feedback rounds are part of the same plan revision's budget, and a task with a fresh plan starts a fresh one.

## Release acceptance

A release is not considered complete if any of these are merely decorative: provider/model selection, routing policy, task tabs, run activity, usage/cost visibility, or settings/diagnostics. Mock agents are never eligible for automatic production routing.
