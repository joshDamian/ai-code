# AI Code — Tier 3: Platform

Depends on: Tier 2 complete (smart context, health-aware routing, parallel execution).

Tier 3 turns AI Code from a single-machine tool into an extensible platform: automation that drives tasks without human initiation, providers added without code changes, and observability that answers "why was this slow/expensive."

---

## Current State

- **Automation**: table exists in SQLite, webhook endpoint creates tasks. No execution engine — nothing reads or acts on automation definitions.
- **Providers**: hardcoded `add-claude` and `add-deepseek` commands bake model catalogs into cli.mjs. No way to add a custom provider without modifying source.
- **Observability**: per-run token/cost/duration stored. Dashboard shows aggregate counts. No time-series, no charts, no per-model comparison, no context efficiency metrics.

---

## Milestone 1 — Automation Engine (I)

### 1a. Trigger system

Automation definitions already store `trigger` and `action` fields. Build the execution layer.

Trigger types:
```
webhook:<name>        — HTTP POST to /api/webhooks/<name> (already partially implemented)
schedule:<cron>       — cron expression, evaluated by a built-in scheduler
watch:<glob>          — file system watcher on the project directory
git:push              — triggered on push to watched branch
git:pr                — triggered on PR creation (via webhook)
manual                — triggered by user via CLI/TUI/dashboard
```

### 1b. Action system

Actions are compositions of existing workflow operations:

```
create-task           — create task with template title
plan                  — create + plan
plan-and-wait         — create + plan + pause for approval
full                  — create + plan + approve + execute (fully autonomous)
```

Action config:
```json
{
  "action": "full",
  "projectId": "...",
  "titleTemplate": "{{trigger.type}}: {{trigger.data.title}}",
  "autoApprove": true,
  "routing": { "implementer": { "preferred": ["deepseek:deepseek-flash"] } }
}
```

Per-automation routing overrides let you say "Dependabot alerts should use the cheapest model."

### 1c. Scheduler

```
src/scheduler.mjs  — evaluates cron triggers, runs in-process alongside the server
```

- Parses cron expressions (use `cron-parser` package or a small inline implementation)
- Checks every 60 seconds which automations are due
- Creates tasks via the same service methods as CLI/API
- Records automation runs: automation_id, triggered_at, task_id, status

### 1d. File watcher

```
src/watcher.mjs  — fs.watch on project directories for watch:<glob> triggers
```

- Debounce: 5s after last change before triggering
- Ignore: .ai-code/, node_modules/, .git/, build artifacts
- Match: glob pattern against changed file paths
- Only active when server is running

### 1e. Automation management

CLI:
```
ai-code automation list
ai-code automation add <name> <trigger> <action> [--project <id>] [--config <json>]
ai-code automation enable <id>
ai-code automation disable <id>
ai-code automation run <id>          — manual trigger
ai-code automation history <id>      — show past runs
```

API:
```
POST   /api/automations/:id/run      — manual trigger
GET    /api/automations/:id/history   — past automation runs
PATCH  /api/automations/:id           — update config (already exists)
```

TUI + dashboard: automation list with enable/disable, manual run button, run history.

### 1f. Safety guardrails

- `autoApprove: false` by default — automation creates and plans, human approves
- Daily task creation limit per automation (default: 10)
- Cost ceiling per automation per day (default: $5)
- Automation runs are tagged so they're distinguishable from manual tasks in the UI
- Kill switch: `ai-code automation pause-all` stops all automated task creation

---

## Milestone 2 — Custom Providers (J)

### 2a. Generic provider registration

Replace hardcoded `add-claude` / `add-deepseek` with a generic flow:

```
ai-code provider add \
  --name "OpenAI" \
  --kind openai-compatible \
  --base-url https://api.openai.com/v1 \
  --api-key-env OPENAI_API_KEY \
  --models "gpt-4o:reasoning=strong,speed=fast,context=128000,cost-in=2.5,cost-out=10"
```

### 2b. Provider kinds

```
claude-code          — existing: spawns claude CLI (Anthropic subscription)
deepseek             — existing: spawns claude CLI with DeepSeek env vars
openai-compatible    — new: direct API calls to any OpenAI-compatible endpoint
anthropic-api        — new: direct Anthropic API calls (not via claude CLI)
ollama               — new: local Ollama instance
custom               — new: user-defined command that speaks a simple protocol
```

### 2c. Direct API adapter

```
src/agents-api.mjs  — direct HTTP agent adapter (no claude CLI dependency)
```

For `openai-compatible` and `anthropic-api` providers:
- Makes HTTP requests directly to the provider's API
- Streams responses as SSE events
- Translates tool-use into AI Code's event format
- Handles auth (Bearer token from env var)

This is critical for removing the Claude Code CLI as a hard dependency. The roadmap explicitly states: "A system that requires one provider to work directly violates the product's purpose."

Protocol:
```
Request:  system prompt + user message + tools
Response: AsyncIterable<AgentEvent> (same as runAgent yields today)
```

Tool execution: the direct API adapter needs a tool executor for file read/write/bash. This is a contained sandbox — reads and writes scoped to the worktree only.

### 2d. Tool executor for direct API agents

```
src/tools.mjs  — sandboxed tool executor for non-CLI agents
```

Tools available to direct API agents:
```
read_file(path)              — read file within worktree
write_file(path, content)    — write file within worktree
edit_file(path, old, new)    — edit file within worktree
bash(command)                — run command within worktree (cwd locked)
list_files(glob)             — list files matching pattern
search(query)                — grep within worktree
```

Sandboxing:
- All paths resolved relative to worktree root
- Path traversal blocked (no ../ beyond root)
- Bash commands run with cwd set to worktree
- No network access from bash (optional, configurable)

### 2e. Model discovery

For providers with list-models endpoints:

```
ai-code provider discover <id>   — queries the provider's model list API
```

- OpenAI: `GET /v1/models`
- Anthropic: known model list (no discovery API)
- Ollama: `GET /api/tags`
- Presents discovered models, user selects which to register
- Sets default capabilities based on known model names (GPT-4o → strong reasoning, etc.)

### 2f. Provider management UI

Dashboard and TUI:
- Add provider form with kind selector, base URL, env var, model entry
- Test connection for all provider kinds
- Model discovery button
- Import/export provider config as JSON

---

## Milestone 3 — Observability Dashboard (K)

### 3a. Time-series storage

Add a lightweight aggregation layer — don't query raw runs for charts:

```
CREATE TABLE daily_stats (
  date TEXT,
  provider_id TEXT,
  model_id TEXT,
  role TEXT,
  runs INTEGER,
  succeeded INTEGER,
  failed INTEGER,
  tokens INTEGER,
  cost REAL,
  avg_duration_ms REAL,
  context_tokens INTEGER,
  PRIMARY KEY (date, provider_id, model_id, role)
)
```

Populated by a `rollup()` method that runs at startup and after each run completes. Cheap queries for charts.

### 3b. Usage API

```
GET /api/usage/daily?from=2026-09-01&to=2026-09-21     — daily cost/tokens
GET /api/usage/by-provider?period=7d                     — breakdown by provider
GET /api/usage/by-role?period=7d                         — breakdown by role
GET /api/usage/by-model?period=7d                        — breakdown by model
GET /api/usage/top-runs?period=7d&limit=10               — most expensive runs
GET /api/usage/context-efficiency?period=7d              — context tokens vs output tokens
```

### 3c. Dashboard charts

Technology: lightweight inline SVG charts (no charting library dependency). Or Chart.js from CDN if more complex charts are needed.

Charts:
- **Cost over time**: stacked area chart by provider, daily granularity
- **Tokens over time**: stacked area chart by role (planner/implementer/reviewer/repair)
- **Provider comparison**: horizontal bar chart — avg cost per run, avg duration, success rate
- **Model comparison**: same as provider but by model
- **Fallback frequency**: line chart — fallbacks per day, broken down by trigger (rate limit, timeout, etc.)
- **Context efficiency**: scatter plot — context tokens vs output tokens per run. Identifies bloated context.
- **Top expensive runs**: table with task title, model, tokens, cost, duration

### 3d. TUI observability

The TUI gets a simpler view (no charts — terminal limitations):
- Summary stats: total cost (24h/7d/30d), total tokens, success rate
- By-provider table: runs, cost, avg duration, failure rate
- By-model table: same
- Top 5 expensive runs
- Fallback count + last fallback details

### 3e. Alerting (lightweight)

Not a full alerting system — just thresholds that surface in the UI:

```json
{
  "alerts": {
    "dailyCostCeiling": 10.00,
    "runCostCeiling": 2.00,
    "failureRateThreshold": 0.3,
    "fallbackRateThreshold": 0.5
  }
}
```

- When a threshold is crossed, show a warning banner in dashboard/TUI
- Log to stderr in CLI output
- Per-automation cost ceiling (from Milestone 1f) ties into this

---

## Build Order

```
Phase A — Automation Engine
  1. Trigger evaluation framework
  2. Action system (create-task, plan, full)
  3. Cron scheduler
  4. File watcher
  5. Automation management CLI + API
  6. Safety guardrails (limits, kill switch)
  7. TUI + dashboard automation UI

Phase B — Custom Providers
  8. Generic provider registration CLI + API
  9. OpenAI-compatible API adapter
  10. Anthropic direct API adapter
  11. Ollama adapter
  12. Sandboxed tool executor for direct API agents
  13. Model discovery
  14. Provider management UI in TUI + dashboard
  15. Custom command provider (user-defined executable)

Phase C — Observability
  16. daily_stats table + rollup
  17. Usage aggregation API endpoints
  18. Dashboard charts (cost, tokens, provider comparison)
  19. Context efficiency tracking + chart
  20. TUI observability view
  21. Alerting thresholds + UI warnings

Phase D — Integration
  22. Automation cost tracking (ties automation to observability)
  23. Provider health history charts (ties Tier 2 health to observability)
  24. End-to-end test: webhook → automation → task → execute → review → complete
```

### Estimated Scope

- Automation engine: ~400 lines (scheduler.mjs, watcher.mjs, automation runner, CLI)
- Custom providers: ~600 lines (agents-api.mjs, tools.mjs, provider registration, discovery)
- Observability: ~400 lines (daily_stats, usage API, charts, TUI view)
- Total: ~1400 lines, ~8-10 new files

---

## Definition of Done for Tier 3

From the roadmap:

> I should be able to open AI Code, select a project, describe a software task, have AI Code gather the right context, have one model produce a plan, review and approve that plan, have another agent implement it in an isolated worktree, run tests, have an independent reviewer inspect the result, automatically repair failures, and complete the task — **without caring which underlying model/provider/agent performed each step.**

After Tier 3:

- Automation can trigger this entire flow without human initiation (except approval, if configured)
- Any OpenAI-compatible, Anthropic, or Ollama provider can fill any role
- The observability dashboard answers: why was this slow, why did it cost $3, which provider is fastest, how often are fallbacks happening
- Cost ceilings and alerting prevent runaway spending
- The system works with zero Anthropic availability if an alternative provider is configured
