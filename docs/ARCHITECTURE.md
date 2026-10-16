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
  - Approval. The read-only tools carry `readOnlyHint` and `Runtime#ask` allows them without asking. `log` asks unless the session is in Accept edits or a more permissive mode. The rest reach the normal approval card, titled in words: "Bench: create task — <title>", "Bench: run check — <command>".
  - Not tools, on purpose: merging or closing a task, changing any task's done means or check, deleting anything. A session must not lower its own bar or land its own work; the server's instructions say so. A task made by `create_task` records the session that made it (`tasks.created_by_session`) and cannot call `create_task` itself: one level, never a chain.
  - To add a tool, add it to `benchTools()`; if it only reads, add its name to `READ_ONLY`.
- **Settings.** Sessions load `project` and `local` settings, never `user`: a user `settings.json` `env` block would override the provider's `ANTHROPIC_BASE_URL`. The user's `~/.claude/CLAUDE.md` is appended to the system prompt instead. A session in a worktree is pointed at the checkout's auto-memory directory.
- **The person's own skills.** Skills come from the loaded setting sources, so `~/.claude/skills` would arrive only with `user` - and with the settings that must not load. They are handed over on their own instead, as a second plugin beside the pack: `<data>/person-skills/`, a manifest and a `skills/` linked to the person's folder. Nothing is copied, and the folder is read again for each session, so a skill added later is there for the next one. A session sees them as `person:<skill>`, next to the pack's `bench:<skill>`.

## Tasks and git

A task records its `base_branch` and `base_commit`, a branch `bench/<slug>-<id>`, and a worktree beside the checkout. The worktree is cut from the base ref, so the checkout never switches.

- **Changes** are the worktree, untracked files included, against the merge base with the base branch. They are read through a temporary index, so the person's own staging is untouched.
- **Merge** commits any uncommitted work, checks for conflicts with `git merge-tree`, then lands the branch. If the base is checked out, git merges in that checkout and refuses to overwrite local changes there. If it is not, the commit is written with `commit-tree` and only the ref moves. Squash lands one commit.
- **Update from base** merges the base into the worktree. Conflicts stay there for a session to resolve.
- **Close** removes the worktree and archives the sessions. **Reopen** recreates the worktree while the branch exists.

## Access

Loopback requests from this machine's own browser need nothing. A request that carries `X-Forwarded-For` or a Tailscale header is not loopback, whatever its Host says. Every other request needs a paired device's token: an HttpOnly, SameSite=Strict cookie set when a one-time pairing code is redeemed. Writes must be JSON. WebSockets must come from the same origin. Tokens and pairing codes are stored only as hashes.

## Lifecycle

`bench service install` writes a launchd agent (macOS) or a systemd user unit (Linux) that restarts the server whenever it exits, and sets `BENCH_SERVICE` in its environment. `POST /api/server/restart` exits the process only when that variable is set; otherwise it answers 409, since a restart nothing completes is a stop. Live sessions die with the process and resume from Claude Code's transcript on their next message.

## Data

The database is `$BENCH_ROOT/.bench/bench.db`. A v1 (pipeline) database is upgraded in place on first start:

1. The file is snapshotted with `VACUUM INTO`.
2. The pipeline tables are renamed `legacy_*`.
3. Tasks whose worktrees still exist are imported as active tasks.

A task's decision log is `task_log` (task id, session id, decision, evidence, time), written only by the `log` tool.
