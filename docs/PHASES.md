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

## Release acceptance

A release is not considered complete if any of these are merely decorative: provider/model selection, routing policy, task tabs, run activity, usage/cost visibility, or settings/diagnostics. Mock agents are never eligible for automatic production routing.
