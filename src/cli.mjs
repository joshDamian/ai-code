#!/usr/bin/env node
import { Service, transitions } from './service.mjs';

const a = process.argv.slice(2);
// Constructing the Service opens the database, so every invocation - including a
// read-only one - touches shared state. The store's reaper accounts for that.
const s = new Service(process.cwd());
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));

const HELP = `AI Code

Project
  init [name] [path]
  projects
Context
  context init <project-id>
  context enrich <project-id>
Task
  task create <project-id> <title>
  task list [project-id] [--state <STATE>]
  task show <id>
  task status <id>
  task active
  task plan <id>
  task approve <id>
  task execute <id> [--background] [--force]
  task review <id>
  task repair <id>
  task diff <id> [--to <branch>]
  task port <id> [--to <branch>] [--dry-run] [--clean]
  task cancel <id>
  task close <id>
Providers
  provider list
  provider add-claude
  provider add-deepseek [model]
  provider test <provider-id> [model-id]
  provider health [provider-id]
  provider enable <provider-id>
  provider disable <provider-id>
Models
  model list [provider-id]
  model enable <model-id>
  model disable <model-id>
Routing
  routing show
  routing set <json-file>
Runs
  runs
  usage [24h|7d|30d|all]
Ranker
  eval [project-id]
Automation
  automation list
  automation add <name> <trigger> <action>
  doctor
  dashboard
  tui`;

// The Claude Code catalog. Every model runs through the same binary, so all of
// them can drive tools; they differ on reasoning depth, speed and price.
const CLAUDE_MODELS = [
  { id: 'anthropic:claude-opus-5', name: 'claude-opus-5', displayName: 'Claude Opus 5', providerModelId: 'claude-opus-5', invocationModelId: 'claude-opus-5', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 7, quality: 10, contextLength: 200000, reasoning: 'frontier', toolUse: true, streaming: true, inputCostPerMTok: 5, outputCostPerMTok: 25, billingMode: 'subscription', pricingSource: 'Anthropic official pricing', pricingUpdatedAt: '2026-08-24' },
  { id: 'anthropic:claude-opus-4-8', name: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', providerModelId: 'claude-opus-4-8', invocationModelId: 'claude-opus-4-8', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 6, quality: 10, contextLength: 200000, reasoning: 'frontier', toolUse: true, streaming: true, inputCostPerMTok: 5, outputCostPerMTok: 25, billingMode: 'subscription', pricingSource: 'Anthropic official pricing', pricingUpdatedAt: '2026-08-24' },
  { id: 'anthropic:claude-sonnet-5', name: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', providerModelId: 'claude-sonnet-5', invocationModelId: 'claude-sonnet-5', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 9, quality: 9, contextLength: 1000000, reasoning: 'strong', toolUse: true, streaming: true, inputCostPerMTok: 2, outputCostPerMTok: 10, billingMode: 'subscription', pricingSource: 'Anthropic official pricing', pricingUpdatedAt: '2026-08-10' },
  { id: 'anthropic:claude-sonnet-4-6', name: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', providerModelId: 'claude-sonnet-4-6', invocationModelId: 'claude-sonnet-4-6', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 8, quality: 9, contextLength: 200000, reasoning: 'strong', toolUse: true, streaming: true, inputCostPerMTok: 3, outputCostPerMTok: 15, billingMode: 'subscription', pricingSource: 'Anthropic official pricing', pricingUpdatedAt: '2026-05-12' },
  { id: 'anthropic:claude-haiku-4-5-20251001', name: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', providerModelId: 'claude-haiku-4-5-20251001', invocationModelId: 'claude-haiku-4-5-20251001', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 10, quality: 7, contextLength: 200000, reasoning: 'moderate', toolUse: true, streaming: true, inputCostPerMTok: 0.8, outputCostPerMTok: 4, billingMode: 'subscription', pricingSource: 'Anthropic official pricing', pricingUpdatedAt: '2026-05-12' },
];

// DeepSeek is reached through Claude Code's Anthropic-compatible endpoint, which
// is why these carry both cache and peak/off-peak rates.
const DEEPSEEK_MODELS = [
  { id: 'deepseek:deepseek-flash', name: 'deepseek-flash', displayName: 'DeepSeek V4.1 Flash', providerModelId: 'deepseek-flash', invocationModelId: 'deepseek-flash', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 10, quality: 8, contextLength: 1000000, reasoning: 'moderate', toolUse: true, streaming: true, inputCostPerMTok: 0.15, outputCostPerMTok: 0.6, cacheReadCostPerMTok: 0.003, peakInputCostPerMTok: 0.3, peakOutputCostPerMTok: 1.2, peakCacheReadCostPerMTok: 0.006, billingMode: 'api', pricingSource: 'DeepSeek official pricing', pricingUpdatedAt: '2026-09-21' },
  { id: 'deepseek:deepseek-v4-pro', name: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', providerModelId: 'deepseek-v4-pro', invocationModelId: 'deepseek-v4-pro', capabilities: ['planning', 'coding', 'review', 'repair'], speed: 7, quality: 10, contextLength: 1000000, reasoning: 'strong', toolUse: true, streaming: true, inputCostPerMTok: 0.66, outputCostPerMTok: 1.98, cacheReadCostPerMTok: 0.022, peakInputCostPerMTok: 1.32, peakOutputCostPerMTok: 3.96, peakCacheReadCostPerMTok: 0.044, billingMode: 'api', pricingSource: 'DeepSeek official pricing', pricingUpdatedAt: '2026-09-21' },
];

// Commands the task namespace accepts. `execute` and the planning verbs are async;
// the state-machine verbs are not.
const TASK_OPS = ['plan', 'approve', 'execute', 'implement', 'test', 'review', 'repair', 'reject', 'replan', 'refine', 'diff', 'port', 'cancel', 'close'];
// The steps the server will run as a background job. `port` is not one: a job
// carries no options, so a target branch would need a column on `jobs` and a step
// in the runner, and a merge is a decision rather than a long agent run.
const QUEUEABLE = new Set(['execute', 'implement', 'test', 'review', 'repair']);

const port = Number(process.env.PORT || 4317);

// Hands a job to the dashboard server. `--background` cannot run the work here:
// this process exits as soon as it has printed, and a queue in a process that is
// about to exit is a queue nobody ever drains. Spawning a server instead would
// mean orphan processes and port arbitration for no benefit.
async function enqueueRemote(taskId, kind) {
  const path = kind === 'execute' ? 'execute/background' : kind;
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ background: true }),
    });
  } catch {
    throw new Error(`no dashboard server on :${port}; start one with \`ai-code dashboard\`, or drop --background`);
  }
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || `server returned ${res.status}`);
  return j;
}

async function taskCommand(sub, rest) {
  if (sub === 'create') {
    const t = s.createTask(rest[0], rest.slice(1).join(' '));
    return out(s.prepare(t.id));
  }
  if (sub === 'list') {
    const si = rest.indexOf('--state');
    const state = si >= 0 ? rest[si + 1] : undefined;
    if (si >= 0 && (!state || state.startsWith('--'))) throw new Error('--state needs a value');
    if (state && !transitions[state]) throw new Error(`Invalid state ${state}; valid states are ${Object.keys(transitions).join(', ')}`);
    const pid = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined;
    return out(s.store.listTasks(pid, state));
  }
  // `live` and `revision` come along because they are the two things a task's own row
  // cannot answer: whether a run is in flight right now, and what the current plan
  // changed. Both are null or empty on a task that has neither.
  if (sub === 'show') {
    const task = s.task(rest[0]);
    return out({ task, runs: s.store.listRuns(rest[0]), live: s.liveRun(rest[0]), revision: s.revision(task) });
  }
  // What a background job is doing, which the run rows alone do not answer: a
  // queued job has no run yet, and the job is what says so.
  if (sub === 'status') return out({ task: s.task(rest[0]), jobs: s.store.listJobs(rest[0]), runs: s.store.listRuns(rest[0]) });
  if (sub === 'active') return out(s.store.activeJobs());
  if (!TASK_OPS.includes(sub)) return null;
  const id = rest[0];
  // Overrides the refusal to execute a plan whose read files are still dirty.
  // Named rather than silent, so a verb that cannot act on it says so instead of
  // accepting the flag and doing nothing.
  const force = rest.includes('--force');
  if (force && !['execute', 'implement'].includes(sub)) throw new Error(`--force is not supported for task ${sub}`);
  // Flags are positional scans of the same array, so the id stays rest[0] and a
  // flag's value is whatever follows it. Named rather than silent, so a verb that
  // cannot act on one says so instead of accepting it and doing nothing.
  const at = rest.indexOf('--to');
  const to = at >= 0 ? rest[at + 1] : undefined;
  const dryRun = rest.includes('--dry-run');
  const clean = rest.includes('--clean');
  if (at >= 0 && (!to || to.startsWith('--'))) throw new Error('--to needs a branch name');
  if (at >= 0 && !['diff', 'port'].includes(sub)) throw new Error(`--to is not supported for task ${sub}`);
  if (dryRun && sub !== 'port') throw new Error(`--dry-run is not supported for task ${sub}`);
  if (clean && sub !== 'port') throw new Error(`--clean is not supported for task ${sub}`);
  if (rest.includes('--background')) {
    if (!QUEUEABLE.has(sub)) throw new Error(`--background is not supported for task ${sub}`);
    // A job carries no options: enqueue takes a task and a kind, the runner's step
    // passes neither, and the jobs table has no column to hold one.
    if (force) throw new Error('--force cannot be combined with --background; run it in the foreground');
    return out(await enqueueRemote(id, sub));
  }
  const r =
    sub === 'plan' ? await s.plan(id)
    : sub === 'approve' ? s.approve(id)
    : sub === 'execute' ? await s.execute(id, { force })
    : sub === 'implement' ? await s.implement(id, { force })
    : sub === 'test' ? await s.runTests(id)
    : sub === 'review' ? await s.review(id)
    : sub === 'repair' ? await s.repair(id)
    : sub === 'reject' ? s.reject(id)
    : sub === 'replan' ? s.replan(id)
    : sub === 'refine' ? await s.refine(id, rest.slice(1).join(' '))
    : sub === 'diff' ? s.diff(id, { to })
    : sub === 'port' ? await s.port(id, { to, dryRun, clean })
    : sub === 'cancel' ? s.cancelTask(id)
    : sub === 'close' ? s.closeTask(id)
    // Named rather than left to the last arm. This chain used to end in cancelTask,
    // so any verb added to TASK_OPS without a line here cancelled the task.
    : (() => { throw new Error(`Unhandled task operation: ${sub}`); })();
  return out(r);
}

async function providerCommand(sub, rest) {
  if (sub === 'list') return out({ providers: s.store.listProviders(), models: s.store.listModels() });

  if (sub === 'add-claude') {
    s.addProvider({ id: 'anthropic-claude-code', name: 'Anthropic / Claude Code', kind: 'claude-code', enabled: true, config: { routable: true, billingMode: 'subscription' } });
    for (const m of CLAUDE_MODELS) s.addModel({ ...m, providerId: 'anthropic-claude-code' });
    return out(s.store.getProvider('anthropic-claude-code'));
  }

  if (sub === 'add-deepseek') {
    s.addProvider({ id: 'deepseek-claude-code', name: 'DeepSeek via Claude Code', kind: 'deepseek', enabled: true, config: { apiKeyEnv: 'DEEPSEEK_API_KEY', effort: 'max', routable: true, billingMode: 'api' } });
    for (const m of DEEPSEEK_MODELS) s.addModel({ ...m, providerId: 'deepseek-claude-code' });
    return out(s.store.getProvider('deepseek-claude-code'));
  }

  if (sub === 'test') return out(await s.testProvider(rest[0], rest[1]));
  if (sub === 'health') {
    // The circuit-breaker state is otherwise only visible in the two UIs, and this
    // is the command a user reaches for when routing has gone somewhere unexpected.
    const all = s.providerHealthList();
    if (rest[0]) {
      const one = all.find((h) => h.providerId === rest[0]);
      if (!one) return null;
      return out(one);
    }
    return out(all);
  }
  if (sub === 'enable' || sub === 'disable') return out(s.updateProvider(rest[0], { enabled: sub === 'enable' }));
  return null;
}

async function main() {
  const [cmd, sub, ...rest] = a;

  if (!cmd || cmd === 'help' || cmd === '--help') return out(HELP);

  if (cmd === 'init') {
    const p = s.initProject(sub || 'project', rest[0] || process.cwd());
    s.contextInit(p.id);
    return out(p);
  }
  if (cmd === 'projects') return out(s.store.listProjects());
  if (cmd === 'context' && sub === 'init') return out(s.contextInit(rest[0]));
  // Opt-in and LLM-backed, unlike `context init`, which is deterministic.
  if (cmd === 'context' && sub === 'enrich') return out(await s.contextEnrich(rest[0]));
  // A null result means the subcommand was not recognised, so control falls
  // through to the unknown-command error at the bottom rather than printing null.
  if (cmd === 'task') {
    const r = await taskCommand(sub, rest);
    if (r !== null) return r;
  }
  if (cmd === 'provider') {
    const r = await providerCommand(sub, rest);
    if (r !== null) return r;
  }

  if (cmd === 'model') {
    if (sub === 'list') return out(s.store.listModels(rest[0]));
    if (sub === 'enable' || sub === 'disable') return out(s.updateModel(rest[0], { enabled: sub === 'enable' }));
  }

  if (cmd === 'routing' && sub === 'show') return out(s.getRouting());
  if (cmd === 'routing' && sub === 'set') {
    const fs = await import('node:fs');
    return out(s.saveRouting(JSON.parse(fs.readFileSync(rest[0], 'utf8'))));
  }
  if (cmd === 'eval') {
    const { plannerCases, evaluate } = await import('./ranker-eval.mjs');
    const projects = s.store.listProjects();
    const project = sub ? projects.find((p) => p.id === sub || p.name === sub) : projects[0];
    if (!project) throw Error(`Unknown project: ${sub}`);
    const cases = plannerCases(s.store, project);
    // The summary carries how many runs fed it, because a metric over four runs
    // and a metric over four hundred read the same and mean different things.
    return out({ cases: cases.length, ...evaluate(project, cases).summary });
  }
  if (cmd === 'runs') return out(s.store.listRuns());
  if (cmd === 'usage') return out(s.usage(rest[0] || '7d'));
  if (cmd === 'automation' && sub === 'list') return out(s.store.listAutomations());
  if (cmd === 'automation' && sub === 'add') {
    return out(s.store.addAutomation({ id: s.store.id(), name: rest[0], trigger: rest[1], action: rest.slice(2).join(' '), enabled: true, createdAt: new Date().toISOString() }));
  }
  if (cmd === 'doctor') return out(await s.doctor());

  // `dashboard` starts the server in this process; `tui` starts the server too if
  // it cannot find one already listening.
  if (cmd === 'dashboard') {
    await import('./server.mjs');
    return;
  }
  if (cmd === 'tui') {
    const { startTUI } = await import('./tui/app.mjs');
    return startTUI(s);
  }

  throw Error(`Unknown command: ${cmd} ${sub || ''}`);
}

main().catch((e) => {
  console.error(`AI Code: ${e.message}`);
  process.exitCode = 1;
});
