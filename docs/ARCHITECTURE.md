# Architecture

One Node process owns everything: the SQLite database, the Claude sessions, the git operations and the terminals. Browsers are thin clients that read JSON and listen on one WebSocket.

```
browser ── HTTP /api/* ──┐
        ── WS /api/ws ───┤  server.mjs ── service.mjs ─┬─ runtime.mjs ── Agent SDK ── claude
        ── WS /api/terminal ┘                          ├─ git.mjs ───── git, gh
                                                       └─ store.mjs ─── SQLite
```

| File | Owns |
|---|---|
| `src/contract.d.mts` | Every shape that crosses the wire. Server and client both reference it. |
| `src/store.mjs` | The schema, the v1 migration, and every query. |
| `src/runtime.mjs` | One Agent SDK `query()` per live session, approvals, streaming. |
| `src/tools.mjs` | The `bench` MCP server each session gets: tools on its own task and project. |
| `src/loop.mjs` | Loop until done: the failing check fed back to a session between turns. |
| `src/service.mjs` | Projects, tasks, sessions and git actions: the operations the server and CLI expose. |
| `src/git.mjs` | Git as child processes: status, branches, worktrees, diffs, landing. |
| `src/providers.mjs` | Provider environments and model catalogs. |
| `src/server.mjs` | Routes, auth and pairing, the event hub, terminals, push. |
| `src/terminal.mjs` | PTYs that outlive the socket that opened them. |
| `web/` | Preact + htm with no build step. `api.mjs` is the client and the store. |

## Sessions

A session is a row plus, while in use, an open Agent SDK `query()` fed by an async input stream. A message is pushed into that stream, so a follow-up typed mid-turn is queued by Claude Code itself. Interrupts, mode changes and model changes reach the running process.

- **Approvals.** `canUseTool` holds the tool call as a pending approval, broadcasts it, and resolves when a person answers. `AskUserQuestion` is answered with the chosen labels. `ExitPlanMode` is answered with the mode to continue in.
- **Transcript.** Assistant messages, tool results, results and errors are stored in `session_events`. Streaming text deltas are broadcast only to clients watching that session, and are not stored.
- **Lifecycle.** A query idle for 30 minutes is closed. The next message resumes it from Claude Code's own transcript (`resume: claude_session_id`). A provider or effort change also closes it, because the environment is fixed at spawn.
- **The `bench` MCP server.** Every session's `query()` gets `mcpServers: { bench }`, an in-process server (`createSdkMcpServer`) built by `benchServer(svc, sessionId)` in `src/tools.mjs`. It runs inside the Bench process: no port, no login, nothing exposed. One instance per session, so each tool knows the calling session and, through it, its task and project; ids from anywhere else in the project are accepted as a unique prefix of 4+ characters, and nothing outside the project is reachable. The Service hands the factory to the Runtime, so `runtime.mjs` never imports the Service. Results are plain text; anything another session, a check or a log entry wrote is fenced between `<<<` and `>>>` and labelled as data, not instructions.
  - Its own task: `task_status` (title, branch → base, done means, check and its last result with the end of its output, files and lines changed, commits ahead and behind, the task's other sessions, the last 10 log entries; outside a task, the project and "not in a task"), `task_diff` (against the base, optionally one path, cut at ~30k characters), `run_check` (forced, recorded on the task and as a `check` transcript entry, as a stop is), `update_from_base` (merges the base in and reports conflicts; the calling session itself does not count as "a session is working").
  - A trail and the person: `log` writes `decision` and `evidence` to the `task_log` table, adds a `log` entry to the transcript ("Logged: …"), and shows on the task's Log tab, newest first. `notify` pushes to the person's devices through the server's web-push path (`svc.notifier`), opening the session when tapped; at most one per session per minute, and the tool says when it was throttled.
  - The project: `list_tasks` (active unless `all`), `get_task`, `create_task` (the person's defaults, as the new-task form; check defaults to the project's), `list_sessions`, `session_status` (status, model, cost, the end of its last reply), `list_models` (enabled providers, whether their keys are set, their models).
  - A second opinion: `request_review` starts a fresh session in Plan mode on the first ready provider of another model family (else the caller's own, with a note), waits for it, and records its reply in the task log as a `review` entry. Given `screenshots` (PNG, JPEG or WebP, checked by their bytes), it is a design review: the images go with the reviewer's first message and it judges the rendered UI against a design rubric instead of the diff, and against the project's `Design-brief.md` and the pack's `patterns/` when there is a brief; the entry reads "Design review by …". The `design-review` skill shoots the pages for it, `design-tokens` sets up the token source `design-check` enforces, and `design-brief` writes the brief - each view's job, one primary action, hierarchy, states, and layout at both widths - from the pattern library in `pack/patterns/` before any component is written.
  - Approval. The read-only tools carry `readOnlyHint` and `Runtime#ask` allows them without asking. `log` asks unless the session is in Accept edits or a more permissive mode. The rest reach the normal approval card, titled in words: "Bench: create task — <title>", "Bench: run check — <command>".
  - Not tools, on purpose: merging or closing a task, changing any task's done means or check, turning a loop on or stopping it, deleting anything. A session must not lower its own bar, land its own work, or put itself into an unattended loop; the server's instructions say so. A task made by `create_task` records the session that made it (`tasks.created_by_session`) and cannot call `create_task` itself: one level, never a chain. Likewise a session started by `start_session` or `request_review` (`sessions.started_by_session`) cannot call `start_session` or `create_task`. `request_review` is the one exception: a task's session may call it however it was started, because the review only reads (Plan mode) and the reviewer is a dead end - its own `started_by_session` keeps it from starting anything, and its `purpose` of `review` keeps it from asking for a review of its own.
  - To add a tool, add it to `benchTools()`; if it only reads, add its name to `READ_ONLY`.
- **Settings.** Sessions load `project` and `local` settings, never `user`: a user `settings.json` `env` block would override the provider's `ANTHROPIC_BASE_URL`. The user's `~/.claude/CLAUDE.md` is appended to the system prompt instead. A session in a worktree is pointed at the checkout's auto-memory directory.
- **The person's own skills.** Skills come from the loaded setting sources, so `~/.claude/skills` would arrive only with `user` - and with the settings that must not load. They are handed over on their own instead, as a second plugin beside the pack: `<data>/person-skills/`, a manifest and a `skills/` linked to the person's folder. Nothing is copied, and the folder is read again for each session, so a skill added later is there for the next one. A session sees them as `person:<skill>`, next to the pack's `bench:<skill>`.

## Tasks and git

A task records its `base_branch` and `base_commit`, a branch `bench/<slug>-<id>`, and a worktree beside the checkout. The worktree is cut from the base ref, so the checkout never switches.

- **Changes** are the worktree, untracked files included, against the merge base with the base branch. They are read through a temporary index, so the person's own staging is untouched.
- **Merge** commits any uncommitted work, checks for conflicts with `git merge-tree`, then lands the branch. If the base is checked out, git merges in that checkout and refuses to overwrite local changes there. If it is not, the commit is written with `commit-tree` and only the ref moves. Squash lands one commit.
- **Update from base** merges the base into the worktree. Conflicts stay there for a session to resolve.
- **Close** removes the worktree and archives the sessions. **Reopen** recreates the worktree while the branch exists.

## Loop until done

A task can be marked to loop: the overnight contract, where Bench feeds a failing check back to the session between turns instead of waiting for the person. `Task.loop` is nullable and holds `{max_attempts, max_minutes, attempts, state, reason, started_at, ended_at, session_id}`; it is set and edited only by a person, through `bench task loop <id> [--max-attempts N] [--max-minutes M]` / `--off` or the task page. It needs a check - without one there is no termination condition, and turning it on is refused (400). `src/loop.mjs` holds it: the Service makes one `Loop`, and it listens for the runtime's `turn-done`, which fires when a session has finished every message it was given and is idle again.

- **The check decides.** Passed ends the loop (`done`); failed sends the session a fresh message with the end of its output - "The check still fails: `<command>` failed (exit N) … Keep going." - counted as one attempt. This is the across-messages form of the Stop hook in `runtime.mjs`, which does the same inside one message.
- **Caps are mandatory.** `max_attempts` (default 10, at most 100) and `max_minutes` (default 2 hours, at most 24). Either one reached with the check still failing ends the loop without another turn.
- **The way out.** At a cap the loop is `gave-up`, and the session is asked once more, read-only, to write up why it is stuck: it is put in Plan mode (`setMode`, as a review's is) and `send(..., {writeUp: true})` sets `Live.writeUp`, so the Stop hook leaves the failing check alone for that turn. The write-up is recorded in the task log when the turn ends.
- **Auditable.** Every attempt is a `loop` line in the session's transcript and a `loop` entry in the task log, with the check's result; the ending is logged with its reason and evidence.
- **It ends cleanly** for a person turning it off (`stopped`; the task's field goes back to null and the log keeps the trail), a closed or merged task, an archived or deleted session, a session that errored (`error`), a task with no session left to feed, a check that could not run, or a send that failed.
- **Never while waiting.** A session waiting on the person is theirs until they answer - a message now would sit behind the approval - so the loop waits and takes over from the turn-end after it.
- **One session.** The loop binds to the task's newest non-review session at the first turn-end (`session_id`), and one turned on with no session to feed stops at once rather than sit there looping in name only: nothing else would ever run the check or reach a cap. `started_at` identifies a loop, so a turn already deciding an old loop can never write it back over a person's change; the loop's own writes are laid over the caps as they stand, so retuning one mid-flight keeps the progress it has.

## Access

Loopback requests from this machine's own browser need nothing. A request that carries `X-Forwarded-For` or a Tailscale header is not loopback, whatever its Host says. Every other request needs a paired device's token: an HttpOnly, SameSite=Strict cookie set when a one-time pairing code is redeemed. Writes must be JSON. WebSockets must come from the same origin. Tokens and pairing codes are stored only as hashes.

## Lifecycle

`bench service install` writes a launchd agent (macOS) or a systemd user unit (Linux) that restarts the server whenever it exits, and sets `BENCH_SERVICE` in its environment. `POST /api/server/restart` exits the process only when that variable is set; otherwise it answers 409, since a restart nothing completes is a stop. Live sessions die with the process and resume from Claude Code's transcript on their next message.

## Data

The database is `$BENCH_ROOT/.bench/bench.db`. A v1 (pipeline) database is upgraded in place on first start:

1. The file is snapshotted with `VACUUM INTO`.
2. The pipeline tables are renamed `legacy_*`.
3. Tasks whose worktrees still exist are imported as active tasks.

A task's decision log is `task_log` (task id, session id, decision, evidence, time), written by the `log` tool, by a review's findings, and by a loop's attempts and endings (`kind` is `decision`, `review` or `loop`).
