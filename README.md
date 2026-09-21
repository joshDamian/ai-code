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

## Run a task

```bash
ai-code task create <project-id> "Add a health check endpoint"
ai-code task plan <task-id>
ai-code task approve <task-id>
ai-code task execute <task-id>
ai-code task show <task-id>
```

The dashboard:

```bash
ai-code dashboard
```

## Development vs stable

- `./dev/ai-code ...` = current source checkout.
- `./bin/install-ai-code` = explicit promotion.
- `ai-code ...` = promoted stable version.

This separation is intentional so AI Code can develop itself without destabilising the version used on other repositories.

## Verification

```bash
npm test
```

The test suite covers workflow transitions, approval enforcement, worktree isolation, provider fallback and dashboard API behaviour.


## Mission Control control plane

Mission Control is the operational UI, not a read-only dashboard. Providers exposes provider health, routability, enable/disable, model enable/disable, connection testing and provider configuration. Routing exposes per-role strategy, preferred model, fallback order and effort. Runs and Usage expose persisted run telemetry and cost basis. Task detail exposes functional PLAN, EXECUTE, REVIEW and ACTIVITY tabs with live event streaming. Settings exposes runtime/diagnostic information.

The mock provider is retained for automated tests only and is never eligible for automatic production routing.

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
