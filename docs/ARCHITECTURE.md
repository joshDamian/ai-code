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
- **Settings.** Sessions load `project` and `local` settings, never `user`: a user `settings.json` `env` block would override the provider's `ANTHROPIC_BASE_URL`. The user's `~/.claude/CLAUDE.md` is appended to the system prompt instead. A session in a worktree is pointed at the checkout's auto-memory directory.

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
