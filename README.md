# AI Code

AI Code is a local-first software-engineering control plane: context → plan → approve → implement → test → review → repair.

## Requirements
- macOS/Linux
- Node.js 22.5+
- Git
- Claude Code installed and authenticated for real agent runs
- DeepSeek API key for DeepSeek-backed Claude Code runs

Claude Code supports non-interactive `-p` execution and JSON/stream-json output; AI Code uses that interface. DeepSeek officially documents using Claude Code through its Anthropic-compatible endpoint.

## Immediately after extraction

```bash
cd ai-code
./dev/ai-code doctor
./dev/ai-code --help
```

Install the stable local command:

```bash
./bin/install-ai-code
ai-code doctor
```

The development command always uses the checked-out source. The installed `ai-code` command is the promoted stable version.

## Register a project

From the AI Code checkout:

```bash
./dev/ai-code init "My Project" /absolute/path/to/project
```

Or after installation:

```bash
ai-code init "My Project" /absolute/path/to/project
```

## Project context

Registering a project writes the deterministic half of its context — `architecture.md`, `conventions.md`, `commands.json`, and a `dependencies.json` parsed from the project's manifests. No model is involved, and nothing here changes unless you change it:

```bash
ai-code context init <project-id>
```

The two prose documents start as skeletons. Filling them in with a model is a separate, opt-in step that overwrites only those two files:

```bash
ai-code context enrich <project-id>
```

At run time the agent gets the project context plus the files most relevant to the task, ranked from the task text, entry points, test adjacency, config files and recent Git history. Assembly is capped by a token budget and a file cap, both under a `context` key in `routing.json`; when it overflows, the lowest-ranked file contents go first, then the generated docs, then the file tree. Each run records what it was given — `context_tokens`, `relevant_files`, `context_budget` — which the Usage view totals.

## Add real providers

Anthropic / Claude Code:

```bash
ai-code provider add-claude
```

DeepSeek through Claude Code:

```bash
export DEEPSEEK_API_KEY="..."
ai-code provider add-deepseek
```

Test a real provider connection (this invokes Claude Code and may consume model/API usage):

```bash
ai-code provider test anthropic-claude-code
ai-code provider test deepseek-claude-code
```

DeepSeek's official Claude Code integration currently uses `https://api.deepseek.com/anthropic` and `deepseek-flash[1m]`; AI Code configures those in the child process only and does not mutate your shell environment.

### Provider health

Each provider carries a circuit-breaker state. A failing provider is dropped from routing rather than retried forever, and a success is what brings it back.

```bash
ai-code provider health            # every provider
ai-code provider health deepseek-claude-code
```

```json
{
  "providerId": "deepseek-claude-code",
  "state": "DEGRADED",
  "eligible": true,
  "penalty": 0.3,
  "reason": "1 failure in the window",
  "failures": 1,
  "cooldownRemainingMs": 0,
  "lastError": "RATE_LIMIT: 429 Too Many Requests"
}
```

`OPEN` means no run will route to that provider until the cooldown expires or the credentials are fixed. Thresholds live under a `health` key in `routing.json`; the same state is shown as a badge on the provider cards in both UIs.

## Run a task

```bash
ai-code task create <project-id> "Add a health check endpoint"
ai-code task plan <task-id>
ai-code task approve <task-id>
ai-code task execute <task-id>
ai-code task show <task-id>
```

Watch a task and list what is in flight:

```bash
ai-code task status <task-id>   # the task, its jobs, and its runs
ai-code task active             # every job the server has queued or running
```

The dashboard:

```bash
ai-code dashboard
```

### Recovering an interrupted plan

A process that dies between its planner run succeeding and the plan being written to the task leaves that task in `Planning` with a plan that exists only in the run's events. Opening the store repairs it, and every command opens the store — the plan is rebuilt from the run's events and put in front of you for approval rather than being paid for again. The one run that finished in the last few seconds is left alone, because its owner is still about to write that same plan itself.

### Committing before execution

The planner reads the project's working tree, uncommitted work included. The implementer works in a worktree cut from `HEAD`, which does not contain that work. A plan written against uncommitted changes therefore describes code the implementer will never see, and the change that comes back is built against stale sources.

So `task execute` refuses while a file the plan depends on is dirty, naming the files to commit:

```
AI Code: PLAN_BASE_DIRTY: 3 file(s) this plan depends on have uncommitted changes
(src/agents.mjs, src/service.mjs, tests/test.mjs). The implementer runs in a worktree
built from HEAD (efe2a89), which contains none of them. Commit them first, or re-run
with --force.
```

What a plan depends on is what the planner actually read — the files it opened with a tool, plus the ones the harness inlined into its prompt. That distinction is what keeps the gate proportionate: a repository under active development is normally dirty, and a task that has nothing to do with those files still runs.

The refusal changes nothing. The task stays `APPROVED`, so committing the files and retrying is the whole remedy, and the gate opens on its own once they are clean. `--force` overrides it for the case where you have looked at the overlap and decided it does not matter; it cannot be combined with `--background`, because a queued job carries no options.

After the implementer runs, the worktree is compared against what was dirty when the plan was written. A file it rewrote that had uncommitted work — and that was not committed since — is recorded as a plan conflict on the task, because the diff and the review are both computed inside the worktree, where the uncommitted version never existed.

### Background execution

`task execute` blocks until the whole workflow finishes. `--background` hands it to a running dashboard server and returns at once:

```bash
ai-code task execute <task-id> --background
```

The server owns the queue, so this needs one running. With no server on the port it exits non-zero and says so, rather than quietly starting a second one:

```
no dashboard server on :4317; start one with `ai-code dashboard`, or drop --background
```

`task implement`, `task test`, `task review` and `task repair` take `--background` too. A task may have only one job queued or running at a time.

The queue runs at most two jobs at once by default, narrowed further by how many runs the enabled providers will tolerate together — one for a Claude Code provider, two for a hosted API, overridable per provider with `config.maxConcurrency`. A provider at its own limit is simply not a candidate for the next run, so a job is never dispatched into a state where nothing can serve it.

The count comes from the run leases, not from the server's memory, so a run started in another process counts too: a foreground run from the dashboard holds its provider slot against a background job, and a job holds it against the next CLI start.

Background jobs are recorded in the `jobs` table and survive a restart as `interrupted`: the queue itself is in-process, so a job row left queued or running belongs to a server that is gone.

`Ctrl-C` on the dashboard stops the queue, aborts every run in flight, and waits briefly for the detached agent processes to exit before closing. Without that the agents outlive the server with nothing watching them.

### Per-role budgets

Every role has a wall-clock timeout and two spend budgets, all set per role in `.ai-code/routing.json`:

| Role | `timeout` | `maxToolCalls` | `maxRunCost` |
|---|---|---|---|
| planner | 300s | 40 | $1.00 |
| implementer | 600s | 200 | $5.00 |
| reviewer | 300s | 40 | $1.00 |
| repair | 600s | 200 | $5.00 |

A wall clock does not stop an agent that stays busy the whole time, which is how a planning run once spent three and a half minutes and $2.21 re-reading a codebase. The two spend budgets are checked as each event arrives, and the run is aborted the moment it crosses either. The provider is not penalised — it answered every call correctly — and no fallback is attempted, because the next provider would spend the same budget to reach the same place. A planning run that hits a budget leaves its task `FAILED`, ready to replan with a narrower description or a larger budget.

Set either budget to a non-positive value to remove the limit.

### Porting the work onto a branch

A task's work lives in a worktree cut from `HEAD`, and nothing commits there. When the task finishes, `ai-code/<id>` still points at the base commit and the change exists only as uncommitted edits in a directory — nothing you can merge, review or safely delete. Porting is the other half.

See what changed and where it would go:

```bash
ai-code task diff <task-id>
ai-code task diff <task-id> --to <branch>
```

The default destination is the branch the plan was written against, falling back to the branch checked out now. `--to` overrides it. The answer says whether the port would be a fast-forward, whether the work is already in the destination, which files conflict, and which files at the destination are dirty in a way that would block the merge.

Land it:

```bash
ai-code task port <task-id>                  # onto the default branch
ai-code task port <task-id> --to feat/thing  # onto a named one
ai-code task port <task-id> --dry-run        # report only, writes nothing
ai-code task port <task-id> --clean          # remove the worktree after landing
```

Porting is three steps. It commits the worktree onto `ai-code/<id>`, untracked files included — which is what makes the work addressable, and it does not change what a reviewer is handed, because the diff is read against a ref rather than against the index. It predicts the merge with `git merge-tree`, which resolves it in the object store: no scratch worktree, no index, nothing left on disk and nothing to collide with on a retry. Then it lands it.

Landing never moves a ref you own without being asked. If the destination is checked out anywhere, the port leaves it alone and prints the command to run — `git merge --ff-only ai-code/<id>` when the merge is a fast-forward, `git merge ai-code/<id>` when it is not. If it is checked out nowhere, the ref moves: to the work itself when that is a fast-forward, otherwise to a merge commit.

That command is the part that is easy to lose, so it is not left to the reader. Both surfaces report what a port would leave you to do before you run one — `next` on `task diff` and `task port` — and the PORT tab renders it as Next steps above the buttons. A port that stopped short says so instead of reporting the success of the steps it did take.

Once the worktree is gone, the branch is the artifact and porting it again reports the same command rather than failing on a missing directory. The tab shows the change off the commit, so a finished port still reads as the work it was. Nothing is lost by `--clean`; only the directory is.

A conflict stops the port and names the files. No agent is asked to resolve it — a merge is where mechanical stops and judgement starts. The destination is not moved, and the work stays committed on the task branch, which is what you merge by hand.

### Reading the PORT tab

The tab leads with a verdict rather than with the controls, because the work is in one of a handful of states and they mean very different things. It is landed, or ready to land, or uncommitted in the worktree, or blocked by uncommitted work at the destination, or in conflict, or there is nothing to port. Each one says what it is, what follows from it, and whether anything is left to run.

That verdict is derived in `assess` next to `next`, for the same reason: `task diff` and the tab must not be able to disagree about whether the work has landed. Only a state with a port to make offers the buttons. Landed work says so and offers none, and an empty task says there is nothing to port rather than presenting a merge command for a branch sitting at its own fork point.

Once the work is in the destination the verdict names two commits, because they answer two questions. The task's own commit is the work — what to read to see what the task did — and the commit it landed as is what a `git log` of the destination shows and what a revert or a bisect would point at. A fast-forward makes those the same commit, and the tab says so instead of listing it twice. Before the work has landed there is only the first.

The change below them is labelled by where it was read from, which is not always the worktree: uncommitted work is read from the directory, and work that has been committed is read from the commit even while the directory is still there. An empty pane reads as the work being gone, and it is the one reading this screen exists to prevent.

`--clean` removes the worktree once the work is on a branch. It is opt-in and never automatic: the branch outlives the directory, but nothing does that until the port has run.

What a port does not claim: it does not re-run the tests at the destination. They ran in the worktree, and a fresh tree at the merge commit has none of the destination's ignored files, so a run there fails for reasons that have nothing to do with the change. A fast-forward reproduces the tested tracked state exactly; run the test command in the destination yourself when it matters.

In the dashboard this is the PORT tab on the task: the verdict, the destination picker, whatever is left to run, the buttons, and the change.

## Development vs stable

- `./dev/ai-code ...` = current source checkout.
- `./bin/install-ai-code` = explicit promotion.
- `ai-code ...` = promoted stable version.

This separation is intentional so AI Code can develop itself without destabilising the version used on other repositories.

## Verification

```bash
npm test
```

The test suite covers workflow transitions, approval enforcement, the planner's read-only rule and the system-prompt countermand to plan mode's plan-file instruction, worktree isolation, the pre-execution gate on uncommitted work a plan depends on, porting a task's work onto a branch, provider fallback, the circuit breaker, context assembly and its budget, per-role spend budgets, capability gating, recovery of a plan abandoned by a dead process, plan extraction from a run's closing message, the background queue and its concurrency caps, cross-process cancellation, the activity feed's rendering of every stored event shape, how a block of model text is rendered, how a unified diff is numbered and paired into two columns, what a port leaves for you to run, which state a task's work is in and which commits to name it by, and dashboard API behaviour.

The HTTP tests bind an ephemeral port and wait for the child to answer on it before asserting anything. That is not incidental: with a fixed port, a stale server on it makes the child fail to bind and exit while the test polls the stranger and passes, which is exactly how a green suite once hid a broken server.


## Mission Control control plane

Mission Control is the operational UI, not a read-only dashboard. Providers exposes provider health, routability, enable/disable, model enable/disable, connection testing and provider configuration. Routing exposes per-role strategy, preferred model, fallback order and effort. Runs and Usage expose persisted run telemetry and cost basis. Task detail exposes functional PLAN, EXECUTE, REVIEW and ACTIVITY tabs with live event streaming. Settings exposes runtime/diagnostic information.

### The activity feed

ACTIVITY renders one row per event, and the row says what happened rather than what kind of record it was: `Read — src/server.mjs` for a tool call, the opening line of the output plus `(+44 more lines)` for its result, `Explore · Running List web directory · 10.6K tok, 1 tool, 4s` for a subagent, `failed · 2 turns · 20s · $2.21 — API Error: 402 Insufficient Balance` for the run's own result. The badge is a handful of words to scan for — `tool`, `out`, `said`, `think`, `agent`, `run`, `note`, `limit`, `done`, `error` — and the left rule carries the same distinction, with the quiet kinds (a tool's output, a reasoning trace, a notice) set in the muted colour because they are context for the row above them.

An event with nothing to say is not rendered at all. Empty reasoning blocks, subagent heartbeats with no body and unpatched bookkeeping make up roughly a third of a real run's log, and a row reading `system` or `message` is worse than no row. `describeEvent` in `src/format.mjs` is the whole of this, and the CLI, the TUI and the dashboard all render through it: the browser is served that same file rather than a copy, so the three cannot drift.

### Plan and review rendering

PLAN and REVIEW render the planner's and the reviewer's markdown as prose: headings, lists, fenced code, tables. `web/components/markdown.mjs` is the only file in the dashboard that puts model output into HTML — `dangerouslySetInnerHTML` appears nowhere else, and every other component goes through htm and gets escaping for free. `marked` parses and DOMPurify sanitises, both pinned to exact versions because a floating minor on a sanitiser is not a risk worth taking, both loaded from the same CDN the rest of the dashboard already depends on. The sanitiser runs with the HTML-only profile, so SVG and MathML are not reachable from a plan, and raw HTML in a plan survives only as far as DOMPurify allows: an `onerror` handler is stripped, a `javascript:` href is dropped, and every link that does survive opens in a new tab with `rel="noopener noreferrer"`.

A reviewer that answers with a diff does not go through the renderer, because a diff sent through markdown comes out mangled. `bodyKind` in `src/format.mjs` decides which of the two a block of text is, which is why that decision lives in the file the browser is served: it is the same arrangement as `describeEvent`, and it is what makes the decision testable without a DOM.

### Reading a diff

Lines wrap rather than scrolling sideways, because a diff is read downwards and a long line — a minified bundle, a base64 blob, a path — turns sideways scrolling into the whole interaction otherwise. `pre-wrap` keeps the indentation that makes a diff legible; `overflow-wrap:anywhere` covers the lines that have no space in them to break at.

The viewer offers two views of the same diff. Unified is the default, and it is what a reviewer reads. Split puts the old and new versions of a line beside each other, which is what makes a rewrite legible as a rewrite. The pairing is GitHub's — a run of deletions pairs positionally with the run of additions after it, and the shorter side is padded — and, like the numbering, it lives in `src/format.mjs` and is served to the browser rather than reimplemented there.

Two counters advance through a diff and neither may drift: a line the classifier does not recognise as content shifts both gutters from there to the end. That is why `diffLines` treats the leading character as the whole test and reads the start lines out of each hunk header, and why the file that must never see a `\ No newline at end of file` line as content is the same one the CLI, the TUI and the dashboard all render through.

The mock provider is retained for automated tests only and is never eligible for automatic production routing. A dashboard server started with `AI_CODE_ALLOW_MOCK=1` lifts that exclusion, which is how the HTTP tests drive a whole task end to end without spawning a real agent.

### Current published pricing metadata

Anthropic: Claude Sonnet 5 is $2/MTok input and $10/MTok output; Claude Opus 4.8 is $5/MTok input and $25/MTok output. These are API list-price equivalents; Claude Code subscription usage is not represented as a direct per-token bill.

DeepSeek: `deepseek-flash` is DeepSeek-V4.1-Flash. Current official pricing uses peak/off-peak rates and cache-hit pricing; AI Code stores the rate-card metadata and computes recorded API cost using observed usage and the run timestamp.


## Model registry

AI Code does not use dashboard labels as raw provider model IDs. Each model has:
- a stable AI Code model ID (for routing)
- a provider model ID (the provider's API model name)
- an invocation model ID (the exact value passed to the agent adapter/Claude Code)
- a human display name

The Routing UI only allows selecting enabled models from this registry; arbitrary model strings are not accepted. Provider adapters own any provider-specific translation.

DeepSeek's Claude Code integration is provider-specific: DeepSeek documents `deepseek-flash` and `deepseek-v4-pro` as current API models and documents Claude-name mapping when Claude model names are used through its Anthropic-compatible endpoint. AI Code therefore keeps the DeepSeek provider model ID explicit instead of relying on accidental name mapping. citeturn1search0turn1search2
