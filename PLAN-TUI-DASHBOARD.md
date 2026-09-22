# AI Code — Tier 1: Usable Product

## Current State

- **CLI**: bare argv dispatch, JSON.stringify output, no interactive mode
- **Dashboard**: single 35-line HTML file, string-concatenated DOM, prompt()/alert() for input, 5s polling
- **Server**: 26-line HTTP server, 15+ REST endpoints, SSE task streaming — the API layer is solid
- **Tests**: 11 passing (9 unit + 2 integration)

The backend and API are functional. The interfaces are the gap.

---

## Milestone 1 — TUI (Terminal UI)

### Technology

**Ink 5 + React** — renders React components to the terminal. Fits the ESM codebase, composes well, supports real-time updates natively. No build step needed with `tsx` or direct Node ESM.

Dependencies: `ink`, `ink-text-input`, `ink-select-input`, `ink-spinner`, `ink-table`, `react`

### Architecture

```
src/tui/
  app.mjs          — Root component, keyboard routing, screen manager
  api.mjs          — Shared fetch client for the REST API (reuses server endpoints)
  screens/
    overview.mjs   — Metric cards, active tasks, provider health
    tasks.mjs      — Task list with state filters, create inline
    task.mjs       — Task detail: plan/execute/review/activity tabs
    providers.mjs  — Provider list, model details, test connection
    routing.mjs    — Per-role routing configuration
    runs.mjs       — Run history table
    usage.mjs      — Cost/token aggregates and by-provider breakdown
  components/
    layout.mjs     — Sidebar + main pane, header/footer
    status.mjs     — State pill (colored badge per workflow state)
    table.mjs      — Sortable/filterable table
    form.mjs       — Inline form inputs (text, select, confirm)
    spinner.mjs    — Loading/progress indicator
    diff.mjs       — Diff viewer (review tab)
    stream.mjs     — Live event stream (activity tab)
    keybinds.mjs   — Keyboard shortcut legend + handler
```

### CLI Integration

New command: `ai-code tui` — launches the interactive TUI.
The TUI talks to the same REST API as the dashboard (starts the server in-process if not running).

### Screens

#### Overview
- 4 metric boxes: projects, active tasks, runs, active providers
- Active task list with state badges, one-key open
- Provider health summary with last-error/last-success

#### Tasks
- Filterable list: all / active / failed / complete
- Inline task creation (project selector + title input)
- Enter to open task detail

#### Task Detail (most complex screen)
- Tabbed: PLAN | EXECUTE | REVIEW | ACTIVITY
- **Plan tab**: rendered plan text, approve/reject/refine/edit actions
- **Execute tab**: worktree info, run list with status/cost/duration
- **Review tab**: review text with findings highlighted, repair action
- **Activity tab**: SSE-driven live event stream, human-readable event rendering (not raw JSON)
- Action bar: context-sensitive buttons per state (Approve, Execute, Review, Repair)

#### Providers
- Provider cards with enable/disable toggle
- Model list with quality/speed/enabled
- Test connection inline with result display

#### Routing
- Per-role: strategy selector, preferred model, fallback slots, effort level
- Save action

#### Runs
- Table: role, provider, model, status, tokens, cost, duration
- Sort by any column
- Filter by status/role

#### Usage
- Aggregate cost + tokens
- By-provider breakdown table

### Keyboard Navigation

```
Tab / Shift+Tab    — cycle screens
j/k or ↑/↓         — navigate lists
Enter              — open / confirm
Esc                — back / close
a                  — approve (task detail, plan tab)
r                  — reject plan (task detail, plan tab)
f                  — refine plan with feedback (task detail, plan tab)
E                  — edit plan in $EDITOR (task detail, plan tab)
e                  — execute (task detail, when approved)
n                  — new task
/                  — filter/search
q                  — quit
?                  — show keybinds
```

### Real-time Updates

- The TUI polls `/api/overview` on a 3s interval for the overview screen
- Task detail uses SSE via `/api/tasks/:id/stream` for live agent events
- Events are rendered as human-readable lines (role, action, duration) not raw JSON

---

## Milestone 2 — Dashboard Rebuild

### Technology

**Preact + HTM** — no build step, ESM from CDN, component model, 3KB runtime. HTM provides JSX-like tagged template literals that work without transpilation.

Alternative considered: vanilla JS with a proper component pattern. Rejected because the dashboard already has ~10 views with forms, modals, and live updates — a component model pays for itself immediately.

### Architecture

```
web/
  index.html         — Shell: loads app.mjs, defines CSS custom properties
  app.mjs            — Router, global state, API client
  views/
    overview.mjs     — Dashboard home
    projects.mjs     — Project list + add form
    tasks.mjs        — Task list + filters
    task-detail.mjs  — Full-page task view (not a modal)
    providers.mjs    — Provider cards + configuration
    routing.mjs      — Routing policy editor
    runs.mjs         — Run history
    usage.mjs        — Cost/token analytics
    settings.mjs     — Doctor, automations, preferences
  components/
    layout.mjs       — App shell: sidebar, header, main content area
    status-badge.mjs — Workflow state pill
    data-table.mjs   — Sortable, filterable, paginated table
    form.mjs         — Inline form elements with validation + loading states
    modal.mjs        — Proper modal with focus trap and Esc close
    diff-viewer.mjs  — Side-by-side or unified diff for review
    event-stream.mjs — Human-readable live activity feed
    chart.mjs        — Simple bar/sparkline charts for usage view
    toast.mjs        — Non-blocking success/error notifications (replaces alert())
    spinner.mjs      — Loading states for async operations
    empty-state.mjs  — Placeholder when lists are empty
    kbd.mjs          — Keyboard shortcut indicators
  lib/
    api.mjs          — fetch wrapper with error handling, loading state
    sse.mjs          — SSE client with reconnect
    state.mjs        — Simple reactive state (Preact signals or manual pub/sub)
    format.mjs       — Date, duration, token count, cost formatters
```

### Key Improvements Over Current

| Current | Rebuilt |
|---|---|
| prompt()/alert() | Inline forms with validation, toast notifications |
| String-concatenated DOM | Preact components with reactive state |
| 5s polling only | SSE for task activity, polling for overview |
| Task detail is a modal | Full-page task view with URL routing |
| Raw JSON in activity tab | Human-readable event stream |
| No loading states | Spinner/skeleton for every async operation |
| No error handling | Toast notifications, inline error messages |
| No search/filter/sort | Data tables with all three |
| No diff viewer | Unified diff view for review tab |
| No keyboard nav | Full keyboard navigation + shortcut legend |
| Hard-coded dark theme | Dark theme with CSS custom properties (light toggle later) |
| Metrics are counts only | Sparkline trends, per-model comparisons |

### Views

#### Overview
- 4 metric cards with sparkline trend (last 7 days)
- Active task list with progress indicators
- Provider health cards with last-error tooltip
- Recent runs timeline

#### Tasks
- List with state filter tabs: All | Active | Awaiting | Complete | Failed
- Search by title
- Sort by date, state
- Inline new-task form (project dropdown + title input)

#### Task Detail (full page, not modal)
- URL: `#/tasks/:id`
- Header: title, state badge, created date, project link
- Tabs: PLAN | EXECUTE | REVIEW | ACTIVITY
- **Plan tab**:
  - Rendered markdown plan (not raw pre)
  - Approve / Reject / Refine / Edit buttons
  - Refine: inline textarea for feedback → model revises the plan
  - Edit: plan text becomes editable textarea → save persists directly
  - Plan generation timestamp, model used, cost
- **Execute tab**:
  - Worktree info card (path, branch, base commit)
  - Run list with expandable details
  - Live progress when agent is running (SSE)
- **Review tab**:
  - Diff viewer: unified or side-by-side toggle
  - Review findings with severity badges
  - Repair trigger button
- **Activity tab**:
  - Live event stream via SSE
  - Events rendered as: `[role] [action] [detail]` — not raw JSON
  - Timestamp, duration, token count per event
  - Auto-scroll with "new events" indicator when scrolled up

#### Providers
- Card grid with: name, kind, status badge, model count, last test result
- Expand card to see models with pricing/capabilities
- Configure button → inline form (not modal with prompt())
- Test connection with inline result display
- Enable/disable toggle

#### Routing
- Card per role with: strategy dropdown, preferred model selector, fallback slots, effort level
- Save button with success toast
- Live preview: "With current settings, planner would select: Claude Opus 5"

#### Runs
- Full data table: role, provider, model, status, tokens, cost, duration, fallback indicator
- Sort by any column
- Filter by status, role, provider
- Click to expand: full error message, event count, session ID

#### Usage
- Period selector: 24h / 7d / 30d / all
- Cost chart by provider over time
- Token chart by role
- Top-5 most expensive runs
- By-provider breakdown table

#### Settings
- Doctor results with pass/fail indicators (not raw JSON)
- Automation list with enable/disable
- Dashboard preferences (refresh interval — actually wired)

### Keyboard Shortcuts

```
g o    — go to overview
g t    — go to tasks
g p    — go to providers
g r    — go to runs
n      — new task (from tasks view)
/      — focus search
Esc    — close modal / clear search
?      — show shortcut legend
```

---

## Milestone 3 — Shared Improvements (Backend)

These backend changes support both TUI and dashboard:

### 3a. Human-readable event formatting

Add `formatEvent(event)` to service or a new `format.mjs`:
- `started` → "Planner started (Claude Opus 5 via Anthropic)"
- `message` → extract text content, truncate to first line
- `completed` → "Planner completed in 45s, 12,400 tokens"
- `result` → "Implementation complete"
- Tool use events → "Reading src/service.mjs" / "Edited src/agents.mjs"

Used by both TUI and dashboard activity views.

### 3b. Failure recovery transitions

- FAILED → PLANNING (re-plan)
- AWAITING_APPROVAL → PLANNING (reject plan)
- Add API endpoints: `POST /api/tasks/:id/replan`, `POST /api/tasks/:id/reject`

### 3c. Task filtering API

- `GET /api/tasks?state=IMPLEMENTING&projectId=...`
- Support multiple states: `?state=IMPLEMENTING,TESTING,REVIEWING`

### 3d. Usage aggregation API

- `GET /api/usage?period=7d` — returns pre-aggregated cost/token data by provider and by day
- Avoids client-side aggregation of potentially large run lists

### 3e. Plan feedback loop

Two complementary features — interactive refinement and manual editing.

**Refinement (model-assisted):**

- New endpoint: `POST /api/tasks/:id/refine` with `{ feedback: "..." }`
- Valid when state is `AWAITING_APPROVAL`
- Re-runs the planner with: original task + current plan + user feedback
- Stays in `AWAITING_APPROVAL` after refinement (doesn't reset to PLANNING)
- Cheaper than a full re-plan — the agent has the previous plan as starting context
- Refinement runs are recorded normally (role: planner, tagged as refinement)

Service method:
```
refine(id, feedback)
  — validate state is AWAITING_APPROVAL
  — run planner with prompt: "Revise this plan based on feedback: <feedback>\n\nCurrent plan:\n<plan>"
  — store updated plan, stay in AWAITING_APPROVAL
```

**Manual editing:**

- New endpoint: `PATCH /api/tasks/:id/plan` with `{ plan: "..." }`
- Valid when state is `AWAITING_APPROVAL`
- Directly overwrites `task.plan` with user-provided text
- No model invocation — instant
- The implementation agent works from whatever's in the plan field, regardless of how it got there

Both features surface in TUI and dashboard:

TUI (task detail, plan tab):
- `f` — refine: opens text input for feedback, sends to refine endpoint
- `E` — edit: opens plan text in $EDITOR, saves result via PATCH

Dashboard (task detail, plan tab):
- "Refine" button → inline textarea for feedback + submit
- "Edit" button → plan text becomes an editable textarea, save button persists via PATCH
- Both available alongside Approve/Reject when state is AWAITING_APPROVAL

---

## Milestone 4 — Agent Lifecycle

The agent adapter is currently fire-and-forget. No cancel, no resume, no timeout, no scoped permissions for non-planners.

### 4a. Cancel running agents

```
src/agents.mjs   — runProcess() returns a handle with cancel()
src/service.mjs  — cancelRun(runId) kills the child process, marks run 'cancelled'
src/server.mjs   — POST /api/tasks/:id/cancel
```

- `runProcess` stores the `child` reference on the generator, exposed via a `cancel()` method
- `cancelRun` sends SIGTERM, waits 5s, then SIGKILL if still alive
- Run status transitions: `running → cancelled`
- Task state: stays in current state (not FAILED) — user can retry or re-execute
- Both TUI and dashboard get a Cancel button when a task has a running agent

### 4b. Resume interrupted implementations

```
src/service.mjs  — store session_id on successful runs, pass --resume on retry
src/agents.mjs   — runClaude() accepts resumeSession, already has the arg push
```

- When a run succeeds, `session_id` is already stored (line 19 of service.mjs)
- On implementer/repair retry after failure, check if the previous run has a `session_id`
- If yes, pass it as `resumeSession` to avoid re-doing completed work
- Only for implementer and repair roles — planner and reviewer should always start fresh

### 4c. Timeout enforcement

```
src/service.mjs  — per-role timeout from routing policy
src/policy.mjs   — add timeout field to defaults
```

Default timeouts:
```json
{
  "planner":      { "timeout": 300 },
  "implementer":  { "timeout": 600 },
  "reviewer":     { "timeout": 300 },
  "repair":       { "timeout": 600 }
}
```

- `runRole` starts a timer after agent launch
- On timeout: cancel the agent, mark run as `failed` with error `TIMEOUT`
- Timeout triggers fallback to next provider (existing retry logic)

### 4d. Scoped permissions for non-planner roles

Current: `--dangerously-skip-permissions` for implementer, reviewer, repair.

Replace with scoped permission modes:

| Role | Permission mode | Disallowed tools |
|---|---|---|
| planner | `plan` | Edit, Write, Bash |
| implementer | `bypassPermissions` | — (needs full access within worktree) |
| reviewer | `plan` | Edit, Write |
| repair | `bypassPermissions` | — (needs full access within worktree) |

- Implementer and repair keep `bypassPermissions` — they need to edit files and run commands
- Reviewer gets `plan` mode like the planner — should not modify files
- Add Git dirty-state check after reviewer runs (same guard as planner)

### 4e. Failure recovery transitions

New state transitions:
```
FAILED → PLANNING           (re-plan: reset task, try again)
AWAITING_APPROVAL → PLANNING (reject: user doesn't like the plan)
```

New API endpoints:
```
POST /api/tasks/:id/replan   — transitions FAILED → PLANNING, clears plan/review
POST /api/tasks/:id/reject   — transitions AWAITING_APPROVAL → PLANNING, clears plan
```

Service methods:
```
replan(id)  — validate state is FAILED, clear plan/review/worktree, transition to PLANNING
reject(id)  — validate state is AWAITING_APPROVAL, clear plan, transition to PLANNING
```

Both TUI and dashboard expose these as actions on the task detail view.

---

## Build Order

```
Phase A — Foundation (do first)
  1. Set up TUI project structure + Ink dependency
  2. Set up dashboard file structure + Preact/HTM from CDN
  3. Implement shared API client for both
  4. Build formatEvent() in backend

Phase B — TUI core (parallel with Phase C)
  5. Layout component (sidebar + main)
  6. Overview screen
  7. Task list + task detail screens
  8. Provider + routing screens
  9. Runs + usage screens
  10. Keyboard navigation + keybind legend
  11. SSE integration for live task activity

Phase C — Dashboard core (parallel with Phase B)
  12. App shell: router, layout, CSS system
  13. Toast + spinner + empty-state components
  14. Overview view
  15. Task list + task detail (full page, not modal)
  16. Diff viewer component
  17. Provider + routing views with inline forms
  18. Runs + usage views with data tables
  19. Keyboard shortcuts
  20. SSE integration for live task activity

Phase D — Agent Lifecycle
  21. Cancel: runProcess handle, cancelRun() in service, API endpoint
  22. Resume: pass session_id on implementer/repair retry
  23. Timeout: per-role timeout in policy, timer in runRole
  24. Scoped permissions: reviewer gets plan mode, dirty-state guard
  25. Failure recovery: replan/reject transitions, API endpoints, UI in both TUI + dashboard

Phase E — Plan Feedback Loop
  26. refine() service method + API endpoint
  27. PATCH plan endpoint for manual editing
  28. TUI: f (refine) and E (edit in $EDITOR) keybinds on plan tab
  29. Dashboard: Refine button with feedback textarea, Edit button with inline editor

Phase F — Polish
  30. Usage charts in dashboard
  31. Task filtering + search
  32. Settings view (doctor, automations, preferences)
  33. Mobile responsive pass on dashboard
  34. All action buttons wired in both TUI and dashboard
```

### Estimated Scope

- TUI: ~15 files, ~800-1200 lines
- Dashboard: ~20 files, ~1500-2000 lines
- Backend additions (formatting, filtering, usage API): ~3 files, ~150 lines
- Agent lifecycle (cancel, resume, timeout, permissions, recovery): ~200 lines across agents.mjs, service.mjs, policy.mjs, server.mjs
- Total: ~40 files, ~2800-3800 lines

---

## Decisions Made

- **TUI framework**: Ink 5 (React for terminal). Composes well, handles real-time updates natively.
- **Dashboard framework**: Preact + HTM from CDN. No build step. 3KB runtime.
- **Task detail**: full page in dashboard (URL-routable), tabbed screen in TUI. Not a modal.
- **Input**: inline forms everywhere. Zero prompt()/alert() calls.
- **Live updates**: SSE for task activity, short-poll for overview. Both interfaces.
- **Diff viewer**: unified diff in dashboard review tab. Plain text in TUI.
- **Event rendering**: human-readable format, not raw JSON. Shared formatter.

## Open Questions

- Do we want the TUI to be the *default* CLI experience (replacing the current bare commands), or a separate `ai-code tui` command?
- Should the dashboard support light theme from day one, or dark-only initially?
- Do we need authentication on the dashboard server, or is localhost-only acceptable for now?
