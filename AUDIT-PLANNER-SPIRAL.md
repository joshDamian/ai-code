# Audit: Planner Spiral on Task d25abe5b

## What happened

Task: "Improve the Mission Control task detail view so PLAN, EXECUTE, REVIEW and ACTIVITY tabs display the corresponding task information instead of behaving as static navigation."

The tabs already work. The planner couldn't tell, because the files implementing them weren't in context. It spent 3.5 minutes and $2.21 reading every file in the project, spawning 3 Explore subagents, re-reading `store.mjs` 4 times and `server.mjs` 3 times, before the DeepSeek balance ran out.

Evidence: run `e3a44f4e-a75d-4594-bab7-c08382128910`, 306 events, session `4bce6f6c-0aca-4e99-b885-57d10553acd6`.

## Root causes

### 1. Stale file list in context

`buildContext()` in `src/context.mjs` returns a file list stored in the project record at `context init` time. Files created after that — all of `web/views/`, `web/components/`, `src/tui/`, `src/format.mjs`, `web/api.mjs`, `web/app.mjs`, `web/lib.mjs` — are invisible to the planner prompt.

The planner receives a list of ~20 files that doesn't include the files relevant to its task, so it spends its entire budget discovering the codebase from scratch.

### 2. No tool-call or cost cap on planning runs

The planner role has a 300s wall-clock timeout (`src/policy.mjs` line 3). That didn't help — the agent stayed busy the entire time. There is no limit on how many tool calls it can make or how much it can spend.

### 3. Planner has no exit path for "task already done"

The final thinking block (event 22662, 09:50:11 UTC) shows the planner correctly concluded:

> "the exploration found both UIs already render real data per tab. This is puzzling."

It then spent 1,300 words of reasoning trying to explain why the task might still have a gap — maybe a bug, maybe stale state, maybe the commit differs from the working tree — and decided to re-read `task-detail.mjs` "one more time" to verify. That read hit the 402 and killed the run.

The planner prompt says "Produce ONLY a concrete implementation plan." It has no instruction for what to do when the code already satisfies the task. The agent couldn't produce a no-op plan, so it kept looking for work that wasn't there.

### 4. Sonnet produced a plan but the task never received it

The Anthropic fallback run (`f5841b50`, Claude Sonnet 5) **succeeded**. Status `succeeded`, 1.79M tokens, $0.21, session `5a3b94fa`, 175 events including the full plan text at event 22843 and the `completed` event at 22845.

But `task.plan` is `null` and the task is stuck in `PLANNING`.

Timeline:
- **09:50:13** — Sonnet run starts as fallback from DeepSeek
- **09:54:39** — Sonnet outputs the full plan (event 22843)
- **09:54:40** — `runRole` writes `status='succeeded'` to the run row (line 757 of service.mjs)
- The process dies before `plan()` can execute lines 219–223 (extract text from events, write to task, transition to AWAITING_APPROVAL)
- **10:31:56** — A new process opens the store; the task gets a timestamp update but stays in PLANNING with no plan

The `error: 'Process interrupted'` on the succeeded run is the fingerprint: `reapStaleRuns` wrote it while the agent was still running (the lease expired during Sonnet's 4.5-minute run with rate limiting). When `runRole` later wrote `succeeded`, `updateRun`'s `{...row, ...patch}` merge kept the `error` field from the interrupted state because the success patch doesn't clear it.

**Root cause:** `runRole` committing the run as `succeeded` and `plan()` writing the plan text to the task are not atomic. A crash between the two loses the plan even though the events exist in the database.

---

## ~~Fix 1: Live file list in buildContext~~ — RESOLVED

Already fixed by Tier 2. `buildTaskContext()` in `src/context.mjs` calls `inspect(root).files` which does a live `walk()` of the working tree at call time. The stale project-record file list is no longer used for prompt assembly. `service.mjs` calls `buildTaskContext` at lines 161 and 638.

The spiral predated the Tier 2 wiring — the Sept 22 run still used the old `buildContext`.

## ~~Fix 2: Planner prompt must allow "already done"~~ — IMPLEMENTED

**File:** `src/service.mjs`

The planner prompt (inside `plan()`, line ~161) says:

> "Produce ONLY a concrete implementation plan."

This leaves no valid output when the task is already satisfied by the current code. The agent loops trying to find work because it can't produce what the prompt demands.

**Steps:**

1. Amend the planner system prompt in `service.mjs` `plan()` to include an explicit exit:

   Add after the existing instructions:
   ```
   If the task is already fully implemented in the current codebase, say so. State which files satisfy each requirement and why no further changes are needed. Do not invent work that does not exist.
   ```

2. In `plan()`, after extracting the plan text from events, check whether the planner reported the task as already done. A simple heuristic: if the plan text contains a phrase like "already implemented" or "no changes needed" and the planner made no file modifications, transition the task to `COMPLETE` (or a new `ALREADY_DONE` terminal state) instead of `AWAITING_APPROVAL`.

   Alternatively, keep the `AWAITING_APPROVAL` transition — the user can read "already done" in the plan tab and decide whether to approve (skip to review) or reject.

The simpler option is (2b): keep AWAITING_APPROVAL, let the user decide. No state machine changes, no heuristic detection. The prompt change alone fixes the spiral.

**Verification:**
- Create a task whose description matches work already done (e.g. the same task title from this incident).
- Run `plan`. The planner should produce a short response stating the task is satisfied, not a 300-event exploration.

## Fix 3: Tool-call budget per role

**Files:** `src/policy.mjs`, `src/service.mjs`

Add a `maxToolCalls` field to the per-role policy defaults. The harness already counts events in `runRole` — add a check that aborts the run when the tool-call count exceeds the budget.

Steps:

1. **`src/policy.mjs`** — Add `maxToolCalls` to each role's defaults:
   ```
   planner:      maxToolCalls: 40
   implementer:  maxToolCalls: 200
   reviewer:     maxToolCalls: 40
   repair:       maxToolCalls: 200
   ```

2. **`src/service.mjs`, inside `runRole`** — In the `for await` loop over agent events, count events where the type indicates a tool call. When the count exceeds `policy.maxToolCalls`, abort via the existing `controller.abort()` with a new error code `TOOL_CALL_LIMIT`.

   Tool-call detection: an event is a tool call when `e.data?.message?.content` contains an item with `type === 'tool_use'`, or when `e.type === 'tool_use'`. Count each tool-use content block, not each event (one event can carry multiple parallel tool calls).

3. **`src/agents.mjs`, `classify()`** — Add `TOOL_CALL_LIMIT` recognition so it doesn't get bucketed as `AGENT_FAILURE`. It should not penalise the provider (the provider worked fine — the agent misbehaved). Treat it like `CONTEXT_TOO_LARGE`: don't count toward the circuit breaker.

4. **`src/service.mjs`, `runRole` retry logic** — `TOOL_CALL_LIMIT` should not trigger a fallback to a different provider. The same agent on a different provider would spiral the same way. Instead, fail the run and let the task land in FAILED so the user can adjust the task description or increase the budget.

**Verification:**
- Add a test using the mock provider that emits tool-use events. Set `maxToolCalls: 3` in the policy override, confirm the run is aborted after 3 tool calls with error code `TOOL_CALL_LIMIT`.
- Confirm existing tests still pass (they use the mock provider which emits no tool-use events, so the cap is never hit).

## Fix 4 (optional): Per-run cost ceiling

**Files:** `src/policy.mjs`, `src/service.mjs`

Add a `maxRunCost` field to the per-role policy defaults (e.g. planner: $1.00). In `runRole`, after updating `usage` from each event, call `this.price()` and abort if the running cost exceeds the ceiling.

This is a safety net for cases where tool-call count is low but token spend is high (e.g. few calls with massive context windows, or subagent spawning). Lower priority than Fix 3 because Fix 3 catches the observed failure mode.

## Fix 5: Activity tab renders raw JSON instead of human-readable events

**Files:** `web/components/event-stream.mjs`, `web/lib.mjs`

The dashboard's `EventStream` component has a local `describe()` function that falls through to `JSON.stringify(e.data)` for most events. The result is a wall of raw JSON in the activity tab.

A proper `formatEvent()` already exists in `src/format.mjs`. The TUI imports and uses it (`src/tui/screens/task.mjs` line 11, line 442). The dashboard ignores it.

Steps:

1. **`web/lib.mjs`** — Re-export `formatEvent` from `../src/format.mjs` so the web layer can import it without a deep relative path. The web layer already imports `html`, `useState`, etc. from `lib.mjs`.

   ```js
   export { formatEvent, formatDuration, formatTokens, formatCost, formatState } from '../src/format.mjs';
   ```

2. **`web/components/event-stream.mjs`** — Replace the local `describe()` function with `formatEvent` from `../lib.mjs`.

   Current `describe()` (lines 29–41) does:
   - `e.message` → string coercion
   - `typeof e.data === 'string'` → pass through
   - object data → `JSON.stringify(e.data)`

   `formatEvent(e, extractText)` does:
   - `started` → `"planner started (model-name)"`
   - `completed` → `"completed [session-prefix]"`
   - `result` → first line of extracted text
   - `message` → first line of text, or tool name + command/path, or `"message"`
   - `event` → tool name or subtype

   The second argument `extractText` is a function that pulls text content from a claude stream-json message object. The TUI passes `this.svc.extractText` — the same method used in `service.mjs`. For the web component, define a local helper:

   ```js
   function extractText(data) {
     if (typeof data === 'string') return data;
     const msg = data?.message || data;
     const content = msg?.content || [];
     if (!Array.isArray(content)) return '';
     return content
       .filter(c => c.type === 'text')
       .map(c => c.text || '')
       .join('\n');
   }
   ```

   Then in the event row template, replace `${describe(e)}` with `${formatEvent(e, extractText)}`.

3. **Delete the local `describe()` function** from `event-stream.mjs`. It is fully replaced.

**Verification:**
- Start the dashboard (`ai-code dashboard`), open a task with run history, click the ACTIVITY tab.
- Events should render as readable lines like `"planner started (deepseek-v4-pro)"`, `"tool: Read — src/server.mjs"`, `"completed [4bce6f6c]"` — not raw JSON blobs.
- Compare with the TUI activity view for the same task — they should show equivalent text.

---

## Tier 2 Audit: PLAN-SMART-ROUTING.md vs Implementation

All tests pass (48 unit + 5 integration = 53 total).

### Milestone 1 — Context Engine: COMPLETE

| Plan item | Status | Location |
|---|---|---|
| 1a. `relevantFiles()` heuristic | Done | `src/context.mjs:258` — tokenizes task title/description/plan, scores files by name match, git recency, entry-point/config bonus, test siblings |
| 1a. File content inclusion with token budget | Done | `src/context.mjs:277–282` — reads top N files, caps per-file at `fileChars` (12K), total at `budget` (50K) |
| 1b. `dependencies.json` extraction | Done | `src/context.mjs:127–188` — parses package.json, pyproject.toml, go.mod, Cargo.toml |
| 1b. `architecture.md` + `conventions.md` | Done | `src/context.mjs:287–291` reads them; `src/service.mjs:846` generates via `contextEnrich` |
| 1b. `context enrich` command | Done | CLI: `ai-code context enrich <project-id>`, service method at `src/service.mjs:846` |
| 1c. `buildTaskContext()` replaces `buildContext` | Done | `src/context.mjs:312–384`, called from `service.mjs:161` (plan) and `service.mjs:638` (runRole) |
| 1c. Assembly order (architecture → files → plan → review → previous run) | Done | `src/context.mjs:321–324` |
| 1c. Token budget enforcement with trimming | Done | `src/context.mjs:342–358` — trims files, then conventions, then architecture, then tree |
| 1d. Context efficiency tracking on run rows | Done | `store.mjs` columns `context_tokens`, `relevant_files`, `context_budget`; written at `service.mjs:654–656` |
| Tests | 3 tests | `relevantFiles` ranking, budget enforcement, context usage recording |

### Milestone 2 — Provider Health: COMPLETE

| Plan item | Status | Location |
|---|---|---|
| 2a. Circuit breaker (HEALTHY / DEGRADED / OPEN) | Done | `src/health.mjs` — pure-function state machine, no clock dependency |
| 2a. Transition logic (degrade/open/cooldown/heal thresholds) | Done | `health.mjs:104–133` (afterFailure), `health.mjs:136–150` (afterSuccess) |
| 2a. Configurable thresholds | Done | `healthThresholds()` merges `routing.json` health block over defaults |
| 2b. Health-aware scoring (penalty multiplier) | Done | `service.mjs:465` — `base * (1 - penalty)` |
| 2b. OPEN circuit excluded from routing | Done | `service.mjs:442` |
| 2b. Last-resort override when all providers OPEN | Done | `service.mjs:479` — `ignoreHealth: true` fallback |
| 2c. Provider health API | Done | `GET /api/providers/:id/health` at `server.mjs:236` |
| 2c. Health display in TUI | Done | `src/tui/screens/providers.mjs:107` — `HealthBadge` component |
| 2c. Health display in dashboard | Done | `web/views/providers.mjs:93` — `HealthDot` component at `web/components/health-dot.mjs` |
| 2d. New failure codes (PROVIDER_DOWN, MODEL_UNAVAILABLE, CONTEXT_TOO_LARGE) | Done | `agents.mjs:16–20` |
| 2d. Per-code response policy (health impact, transience, resume) | Done | `health.mjs:33–46` — FAILURE_POLICY table |
| Tests | 10 tests | Circuit open/degrade/heal, auth immediate-open, rate-limit soft hold, cooldown lapse, last-resort routing, configurable thresholds |

**Deviation from plan (documented):** Health state stored in a dedicated `provider_health` table instead of inside provider config. Failure counts read from the `runs` table instead of a stored timestamp list. Both are improvements over the plan.

### Milestone 3 — Model Capabilities: COMPLETE

| Plan item | Status | Location |
|---|---|---|
| 3a. Capability schema (reasoning, toolUse, vision, streaming) | Done | `store.mjs:71–74` columns, `store.mjs:371–374` hydration |
| 3b. Reasoning floor per role | Done | `service.mjs:34–42` — `reasoningFloor` map, checked at `service.mjs:453` |
| 3b. toolUse required for implementer/repair | Done | `service.mjs:44,454` — `TOOL_ROLES` set |
| 3b. Context-length check | Done | `service.mjs:642–648` — after context assembly, throws `CONTEXT_TOO_LARGE` if tokens > 85% of model's context_length |
| 3c. Model catalog updates | Done | `cli.mjs` add-claude/add-deepseek set reasoning, toolUse, contextLength per model |
| 3d. Migration (backward compatible) | Done | `store.mjs:71–74` — columns added via `ALTER TABLE` migration; null means permissive |
| Tests | 3 tests | Basic-reasoning excluded from planner, toolUse=false excluded from implementer, null flags keep old behavior |

**Deviation from plan (documented):** Kept the flat `capabilities` array alongside the new columns rather than replacing it with an object. The array is used by `.includes()` in routing; the new columns gate independently.

### Milestone 4 — Parallel Execution: COMPLETE

| Plan item | Status | Location |
|---|---|---|
| 4a. Independent step endpoints (implement/test/review) | Done | `server.mjs:199–201` — each accepts `{background: true}` |
| 4a. Background execution via `/api/tasks/:id/execute/background` | Done | `server.mjs:43,175` |
| 4b. Background job runner | Done | `src/runner.mjs` — queue with configurable concurrency, recovery on restart, graceful shutdown |
| 4b. Job persistence | Done | `store.mjs` jobs table, `store.mjs` activeJobs/addJob/updateJob/listJobs |
| 4c. CLI `--background` flag | Done | `cli.mjs:114` — delegates to dashboard server via HTTP |
| 4c. `task active` command | Done | `cli.mjs:23,108` |
| 4d. Concurrency-safe provider selection | Done | `runner.mjs:55–63` — `atCapacity` checked in `service.mjs:446` via lease count |
| 4d. `maxConcurrency` per provider | Done | `runner.mjs:41–44` — configured or default per kind (claude-code: 1, deepseek: 2) |
| Tests | 4 tests | Queue concurrency limit, duplicate-job rejection, dead-server recovery, --background with/without server |

**Deviation from plan (documented):** Concurrency counted from `run_leases` table (cross-process safe) rather than in-memory `service.active` map. A `cancel_requested` flag added to tasks to catch cancels between steps.

### Gaps found

None of the following are regressions — the plan didn't call for them — but they're worth flagging.

1. **`speed_tier` column was skipped.** The plan mentioned it; the implementation notes say no gate consumes it and the numeric `speed` already exists. Correct — no action needed.

2. **No test for `context enrich` itself.** The command calls the planner model, so it can't run in the mock test suite. The context *assembly* is tested; the *generation* is not. Acceptable — it's an LLM call with no interesting control flow.

3. **The `CONTEXT_TOO_LARGE` exclusion targets the model, not the provider** (`service.mjs:766`). The plan said "don't penalise provider; reduce context and retry." The implementation excludes the model and retries with the next model (which may have a larger context window). It does not reduce context. If all models have the same context length, the task fails. This is a reasonable choice for now but diverges from the plan's "reduce context and retry" intent.

## ~~Fix 6: Crash-safe plan extraction + startup recovery~~ — IMPLEMENTED

**Files:** `src/service.mjs`, `src/store.mjs`

Two bugs surface when the process dies between `runRole` completing and `plan()` writing the result to the task.

### 6a. Recovery on startup

When the store opens, after `reapStaleRuns()`, scan for tasks stuck in `PLANNING` that have a succeeded planner run whose plan was never extracted.

**`src/store.mjs`** — add `recoverOrphanedPlans()`:

```sql
SELECT t.id AS task_id, r.id AS run_id
FROM tasks t
JOIN runs r ON r.task_id = t.id AND r.role = 'planner' AND r.status = 'succeeded'
WHERE t.state = 'PLANNING' AND t.plan IS NULL
ORDER BY r.ended_at DESC
```

For each match, re-extract the plan text from `listEvents(run_id)` using `extractText`, write it to the task, and transition to `AWAITING_APPROVAL`. Log each recovery.

Call this from the `Store` constructor (after `reapStaleRuns`) or from `Service` init. The service already has `extractText`, so the recovery logic probably belongs in `Service.recover()` or a new `Service.recoverPlans()` called at construction time.

### 6b. `updateRun` must clear `error` on success

**`src/store.mjs`, `updateRun()` (line 398)**

The `{...r, ...patch}` merge means a `succeeded` patch without an explicit `error: null` keeps whatever `error` was written by `reapStaleRuns`. The result: a run that says `succeeded` and `error: 'Process interrupted'` simultaneously.

Fix: when `patch.status === 'succeeded'` and `patch.error` is undefined, set `patch.error = null` before merging. This is the narrowest fix — it doesn't change the merge strategy, just ensures success clears the error.

```js
updateRun(id, patch) {
  if (patch.status === 'succeeded' && !('error' in patch)) patch.error = null;
  const r = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
  const n = { ...r, ...patch };
  // ... existing SQL ...
}
```

### Verification

1. **Recovery test:** Insert a task in `PLANNING` state with `plan: null`. Insert a succeeded planner run with events containing plan text. Call `recoverOrphanedPlans()`. Assert the task now has `plan` set and `state === 'AWAITING_APPROVAL'`.

2. **Error-clear test:** Write a run with `error: 'Process interrupted'`, then call `updateRun(id, { status: 'succeeded' })`. Assert `error` is `null` on the result.

3. **Manual verification for task d25abe5b:** After deploying, restart the server. The recovery should pick up the Sonnet run's plan from events and surface it on the task.

---

## Not in scope

- Tier 2 context engine — already implemented and audited above.

---

## Implemented

Fixes 2, 3, 4, 5 and 6 are in. `node --test tests/test.mjs tests/server.mjs` →
73 tests, 73 pass. Four of them were written after the fixes: two for the plan
extraction and two for the planning check, both below.

| Fix | Where |
|---|---|
| 2 — planner prompt | `PLANNER_PROMPT` in `src/service.mjs`, asserted in `tests/test.mjs` |
| 3 — tool-call budget | `src/policy.mjs` defaults, `src/service.mjs` (`countToolCalls`, the check in `runRole`'s event loop, the no-fallback branch in its catch) |
| 4 — cost ceiling | Same three places; `COST_LIMIT` alongside `TOOL_CALL_LIMIT` |
| 5 — readable events | `web/components/event-stream.mjs`, `web/lib.mjs`, `src/server.mjs`, `web/index.html` |
| 6 — crash-safe plan recovery | `Store.orphanedPlans()` and `Store.updateRun()` in `src/store.mjs`; `Service.planFromRun()` and `Service.recoverPlans()` in `src/service.mjs` |

Budgets: planner and reviewer 40 tool calls / $1, implementer and repair 200 /
$5. Both are per attempt, like `timeout`, and a non-positive or absent value
means no limit, so a `routing.json` written before the field existed behaves
exactly as it did.

### Deviations from the steps above

**No `classify()` pattern was added.** Step 3 asks for `TOOL_CALL_LIMIT`
recognition in `src/agents.mjs` so it is not bucketed as `AGENT_FAILURE`. It is
not bucketed, but not because of a pattern: the harness constructs the error and
sets `err.code` itself, and `runRole`'s catch reads `e.code || classify(...)`, so
the text classifier is never consulted for it. The pattern would be a regex
matching a string nothing produces. The requirement behind step 3 — no provider
penalty, nothing counted toward the breaker — is met by a `FAILURE_POLICY` entry
with `health: 'none'`, the same treatment `CONTEXT_TOO_LARGE` gets.

**Fix 5 needed a route the steps did not anticipate.** Step 1 re-exports
`../src/format.mjs` from `web/lib.mjs`, which cannot work: the dashboard's static
handler serves `web/` and refuses any path that escapes it, so the import 404s in
the browser. `src/server.mjs` now publishes that one file at `/shared/format.mjs`
through an allowlist, and `web/index.html` maps the bare specifier
`ai-code/format` to it — the same mechanism already used for `preact` and `htm`.
An allowlist rather than a mount of `src/`, since nothing else in there is
browser-safe. `tests/server.mjs` fetches the route, because a blank activity tab
is not something the unit suite would otherwise notice.

**Fix 4 was marked optional and was implemented anyway.** It is the same abort
path as Fix 3 and the observed run was stopped by money, not by tool calls.

**Fix 6 took a grace window the steps did not ask for.** The query in 6a recovers
any `PLANNING` task with a succeeded planner run and no plan. That includes the
milliseconds between `runRole` writing `succeeded` and `plan()` writing the task,
and a second process opening the store in that window would move the task to
`AWAITING_APPROVAL` under the first one — whose own `transition(id,
'AWAITING_APPROVAL')` would then throw `Invalid transition AWAITING_APPROVAL ->
AWAITING_APPROVAL` into a live run. Adding the fix straight from the steps would
have opened a fresh instance of the race it exists to close. The recovery
therefore skips a run that finished less than `LEASE_STALE_MS` ago, which is the
margin `reapStaleRuns` already waits before calling a run abandoned and for the
same reason: a crash is only visible after the grace, and the cost of waiting is
a few seconds in `PLANNING` rather than a task moved out from under its owner.

**The plan extraction was moved rather than duplicated.** 6a says to re-extract
with `extractText`, which `plan()` does a few lines above where the plan is
written. Both now go through `Service.planFromRun(runId)`, so an interrupted plan
and a recovered one cannot drift on what a planner run that emitted no text
means. That indirection is also what made the next finding cheap to fix —
`planFromRun` became a one-line wrapper over `finalText`, and the same correction
reached `refine()` and `review()` without a second copy of the logic.

**Recovery is called from `Service`, not `Store`.** The store owns the query; the
service owns the extraction and the transition, because the state machine is the
service's. It runs at the end of the `Service` constructor, which every CLI
command constructs, so an abandoned plan is picked up by whatever opens the store
next rather than only by the server.

**The mock provider grew two knobs.** `config.toolCalls` emits that many
`tool_use` blocks in the shape a claude assistant message carries them, and
`config.usage` emits a usage payload. Without them neither budget is reachable
in the test suite, since no mock emits either.

### Two decisions worth knowing about

`plan()` marks the task `FAILED` when a budget is what failed the run, and leaves
it in `PLANNING` for any other failure. A budget failure is a property of the
task — planning it again unchanged spirals identically — and `FAILED` is both the
state that says so and the only one `replan()` accepts. An ordinary provider
failure stays in `PLANNING`, where a retry is usually the right move.

`BUDGET_CODES` ends the run without walking the fallback chain. The chain exists
to route around a provider that is not working; here the provider worked exactly
as asked, and the next one would spend the same budget to reach the same place.

### Fix 6 verified against the real record

`d25abe5b` is the only orphaned task in this repository's own database, so it is
what the steps' manual verification named. `orphanedPlans()` finds it through the
`f5841b50` Sonnet run, the recovery rebuilds the plan from that run's 175 events,
and the task moves to `AWAITING_APPROVAL`. Run against a copy of the database
first, so the live row was not touched by the check itself. What it rebuilt the
first time was 34,949 characters — see the next section for why, and for the
5,669 it rebuilds now.

The negative check is worth stating, because a recovery test that passes for the
wrong reason is the failure mode here: with `recoverPlans()` un-called and the
`error`-clearing line removed, exactly the three tests written for Fix 6 fail and
nothing else does.

### The extraction joined every text block

Recovering the above is what made a second defect visible, and it is a defect of
`plan()`, not of the recovery. The joined plan decomposed as:

| piece | chars |
|---|---|
| Explore subagent report — task-detail view | 8,975 |
| Explore subagent report — task data model and API | 12,711 |
| the plan (`## Context` / `## Approach` / `## Files and changes` / `## Verification`) | 5,669 |
| the same plan again, byte-identical, from the `result` frame | 5,669 |
| 9 narration blocks | 1,913 |

A 5,669-character plan delivered as 34,949 characters, 16% of it the plan and that
plan written down twice. Claude Code echoes a subagent's report into the stream as
assistant text, so joining every text block collects the research as readily as the
answer — and this was never specific to the recovery: every `plan()`, `refine()`
and `review()` had done it since before this report existed.

`Service.finalText(runId)` now reads the run's closing message instead: the `result`
frame's text, which is also what arrives as the final assistant message, so reading
the frame alone also drops the duplicate. The fallback when there is no frame — the
mock provider emits none, and neither does a run killed mid-stream — is the last
thing the run said rather than everything it said. All three call sites go through
it. `planFromRun` is now `finalText(runId)`, with the placeholder for a run that
emitted no text at all.

The reviewer's call site is where this mattered most, and it is the reason the fix
reaches past planning: the joined text fed both the stored review body *and*
`/\bFAIL\b/i`, so a reviewer that reasoned about a failure it then ruled out was
one stray line from being read as having failed the task. The verdict is now the
reviewer's closing message.

Verified on `f5841b50`: 34,949 characters to 5,669, `## Approach` once, opening on
`## Context`. The stored plan on `d25abe5b` was re-extracted to match, so the two
reports it used to carry are now only in the run's events, where they always were.

### The planning check read "dirty" as "the planner dirtied it"

Found by running the tool rather than by reading it, and it is what Fix 2 was
tested against. Task `e394c13c` asked for an `ai-code provider health` command.
DeepSeek failed on a missing key, Sonnet took the fallback, and it answered
correctly — the command already exists in `src/cli.mjs` — and stopped. Then:

```
AI Code: PLANNING_VIOLATION: planner changed repository state
```

The planner had not changed anything. Its one write attempt, to
`~/.claude/plans/`, was refused by the harness's own plan-mode restrictions and
appears in the run log as `Error: No such tool available: Write`. The task went to
`FAILED`, the plan was never written, and a correct answer was thrown away.

The check was:

```js
if (before !== after || changedFiles(p.path).some((x) => !x.includes('.ai-code')))
```

The first half does the job: `before` and `after` are the working tree captured
around the run. The second half compares nothing to anything — it asks whether the
repository currently has any dirty file at all, which is true of every repository
with work in progress, whatever the planner did. This repository had 28 dirty
entries when the task was planned, none of them under `.ai-code`, so the condition
was unconditionally true. Planning could not succeed here, or in any other
repository mid-change, and the failure mode was to report a violation and discard
a correct run.

`plan()` now compares the two trees as sets and fails only on a path that was not
dirty before the run, which is what `review()` already did for the reviewer
(`before !== after`, with no second clause). The error names the offending paths,
because `planner changed repository state` alone sends the reader into the run log
to find out what it is being accused of.

Two tests, one per direction, since the bug is a check that fired when it should
not and the tempting wrong fix is a check that never fires. `touchedFiles()`
filters `.ai-code` on both sides rather than relying on `protectAiCode` having put
it in `.git/info/exclude` — the store's database is written during every run, and a
tree measurement that can be confused by the harness's own bookkeeping is not one
to hang a task's fate on.

The negative check: with the old clause restored, exactly one test fails —
`uncommitted work already in the tree is not a planning violation` — and the other
73 pass, including the one asserting a genuine write is still caught.

Noted, not fixed: `git status --porcelain` collapses an untracked directory to one
entry, so a new file written inside an already-untracked directory does not change
the measurement. `web/views/` and `src/tui/` are both untracked here, so a planner
writing into either would go unnoticed. `-uall` would close it at the cost of
listing every file under `node_modules`, which is also untracked in this
repository, so it is a performance decision rather than a one-word fix.
