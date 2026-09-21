# AI Code Architecture

AI Code is the workflow/control plane. Agent runtimes and model providers are replaceable workers.

## Core invariants
- Harness owns state transitions.
- Planner cannot implement; planning uses Claude Code plan permission plus a Git dirty-state guard.
- Only explicit approval permits execution.
- Implementations occur in task-specific Git worktrees.
- Provider failure is a routable run failure, not a workflow failure, when a capable fallback exists.
- CLI and Mission Control use the same Service layer.
- Project context bootstrap is deterministic and does not require an LLM.
- Provider secrets are not stored in SQLite.

## Runtime layers
CLI / HTTP UI -> Service -> Workflow + Context + Git + Agent Router -> Claude Code adapter -> provider environment -> Anthropic or DeepSeek.

DeepSeek uses the official Anthropic-compatible endpoint through Claude Code's provider environment. See the official DeepSeek integration docs.
