# AI Code Architecture

AI Code is the workflow/control plane. Agent runtimes and model providers are replaceable workers.

## Core invariants
- Harness owns state transitions.
- Planner cannot implement; planning uses Claude Code plan permission plus a Git dirty-state guard.
- Only explicit approval permits execution.
- Implementations occur in task-specific Git worktrees.
- Provider failure is a routable run failure, not a workflow failure, when a capable fallback exists.
- A provider that is failing is dropped from routing by a circuit breaker, not by a workflow change: OPEN providers are not candidates, DEGRADED ones score lower, and a success is what heals them.
- A task's steps are a chain and never run in parallel. Concurrency is between tasks, and it is bounded by the provider's own capacity.
- Cancellation is cross-process. A run holds a lease that is refreshed while it is alive, and any process may set the cancel flag on it; the owning process notices within one heartbeat.
- CLI and Mission Control use the same Service layer.
- Project context bootstrap is deterministic and does not require an LLM. `context init` is the whole of it. `context enrich` is opt-in, additive, and writes only the two generated documents.
- Provider secrets are not stored in SQLite.

## Workflow states
`PLANNING -> AWAITING_APPROVAL -> APPROVED -> IMPLEMENTING -> TESTING -> REVIEWING -> COMPLETE`, with `REPAIRING` beside `REVIEWING` and `FAILED` reachable from either.

Two states wait on a person, and the questions differ. `AWAITING_APPROVAL` holds a plan nobody has approved. `AWAITING_DECISION` holds a review that needs a choice.

The reviewer returns PASS, FAIL or DECIDE. PASS completes the task. FAIL enters `REPAIRING`. DECIDE enters `AWAITING_DECISION` and stores the question, the options and the recommendation in `tasks.decision`. Every allowed move is listed in `transitions` in `src/service.mjs`, and a move that is not listed is refused.

While a decision waits, `discussReview` runs the reviewer again with the question and everything said about it. The task stays in `AWAITING_DECISION` and the repair budget is not spent. `resolveReview` takes an option, an instruction or both, writes them to `tasks.feedback`, and enters `REPAIRING`. That is the repair chain a FAIL uses, so the choice reaches the implementer through the feedback the repair prompt already carries.

A verification that answers DECIDE returns the task to `AWAITING_DECISION` with a fresh question. `REPAIRING` returns to `REVIEWING`, and the repair budget bounds the loop: a task that spends it lands in `FAILED`.

## Runtime layers
CLI / HTTP UI -> Service -> Workflow + Context + Git + Agent Router -> Claude Code adapter -> provider environment -> Anthropic or DeepSeek.

The background queue sits beside the Service in the server process, not under it: a CLI process that exits cannot host the work it asked for, so `--background` hands the job to a running server over HTTP. The queue asks the Service which providers are free, which is what keeps a dispatched job from being unroutable the moment it starts.

Every CLI invocation opens the store, so the store cannot treat "a run I did not start" as a run that died. Liveness is the lease, and only a run with no fresh lease is reaped.

DeepSeek uses the official Anthropic-compatible endpoint through Claude Code's provider environment. See the official DeepSeek integration docs.
