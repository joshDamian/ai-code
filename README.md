# AI Code

A workbench for Claude sessions, served from your own machine or a VPS and used from any browser: your Mac, a phone, a tablet.

- **Tasks.** A task is a branch cut from any base branch, in its own worktree, with Claude sessions working in it. Its work lands on that base only when you merge it.
- **Sessions in the checkout.** For quick work directly in the project's checked-out branch, with no worktree.
- **Git without a terminal.** Switch branches (with a stash prompt), fetch, pull, push and commit from the project page. A task's changes, updates from its base, conflicts, merge (or squash), push and pull request all live on the task page.
- **Claude Code itself.** Sessions run on the Claude Agent SDK, so they behave as Claude Code does: the same tools, CLAUDE.md, slash commands and permission modes (Ask before edits, Accept edits, Plan, Auto, Bypass). Approvals, questions and plans appear as cards you answer from any device. Any session also opens as `claude --resume` in a terminal.
- **Providers.** Each session picks a provider and model: your Claude login, DeepSeek, OpenRouter or Fireworks.

## Requirements

- macOS or Linux, Node.js 22.13 or later, git
- Claude Code logged in on the machine (`claude` then `/login`), or an API key for a hosted provider
- Optional: the GitHub CLI (`gh auth login`) for pull requests, and Tailscale for other devices

## Run it

```bash
npm install
./dev/ai-code serve          # http://localhost:4317
```

Add a project from the page, or with `./dev/ai-code add /path/to/repo`.

To install a snapshot as the `ai-code` command and keep the server running at login:

```bash
bin/install-ai-code --service
```

## Other devices

The server listens on loopback only. Your own browser on that machine needs no login. Every other device reaches it over your tailnet and pairs once:

```bash
ai-code share      # tailscale serve: https://<machine>.<tailnet>.ts.net
ai-code pair       # a one-time link and QR code, valid for 10 minutes
```

Or choose **Settings → Pair a device**. A paired device gets its own cookie. You can unpair it in Settings or with `ai-code revoke <id>`. Add the app to your phone's home screen, then turn on notifications in Settings to get a push when Claude needs an approval or finishes.

### On a VPS

1. Install Node 22+, git, Claude Code (`npm i -g @anthropic-ai/claude-code`, then log in) and Tailscale, then join your tailnet.
2. Clone this repository, run `npm install`, then `bin/install-ai-code --service`.
3. Run `sudo loginctl enable-linger $USER` so the user service survives logout.
4. Run `ai-code share` and `ai-code pair`, then open the link on your phone.

Under the service, **Settings → Server → Restart server** restarts it from any paired device: the server exits and the service manager starts a fresh one. Without the service the button is not offered, because nothing would start the server again.

Hosted-provider keys (`DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `FIREWORKS_API_KEY`) are read from the server's environment. `ai-code service install` copies them, with your PATH, into the service definition.

## Commands

```
ai-code serve | open | add <path> [name] | projects
ai-code share [--off] | pair | devices | revoke <id>
ai-code service install | uninstall | status
ai-code doctor
ai-code shell <provider> [claude args]
```

## Development

```bash
npm test            # node:test, with a scripted fake of the Agent SDK
npm run typecheck   # tsc over the files marked // @ts-check
AI_CODE_FAKE_SDK=1 ./dev/ai-code serve   # the interface, with no model calls
```

There is no build step. The browser loads Preact, htm and the other libraries from this server's `node_modules` through an import map. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
