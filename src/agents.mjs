import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Ordered failure classification. First match wins, so the order is the design:
// a 429 has to read as RATE_LIMIT before the broader patterns can claim it, and
// anything unrecognised lands on AGENT_FAILURE rather than being swallowed.
function classify(text) {
  const s = String(text || '').toLowerCase();
  // A 429 is often reported alongside a body that would also match USAGE_LIMIT, so
  // rate limiting has to be tested first.
  if (/rate.?limit|429|too many requests/.test(s)) return 'RATE_LIMIT';
  // An exhausted account. `402` is the status DeepSeek reports when the balance is
  // gone, and it arrives on its own as often as it does inside a sentence, so the
  // bare code is matched the way 401 and 403 already are. Getting this wrong is
  // expensive: as an AGENT_FAILURE it retries the whole fallback chain against a
  // wallet that is empty, which is what turned one planning run into 266s.
  if (/usage.?limit|quota|credit|spend limit|\b402\b|insufficient (balance|funds|credit)|balance is too low|payment required/.test(s)) return 'USAGE_LIMIT';
  if (/unauthori[sz]ed|invalid.*key|authentication|\b401\b|\b403\b/.test(s)) return 'AUTH_FAILURE';
  // These two say the request was wrong, not the provider, so neither carries a
  // health penalty. CONTEXT_TOO_LARGE must be tested before TIMEOUT because
  // several gateways report an over-length prompt as a timeout.
  if (/model.?(not.?(found|available)|does not exist|deprecated)|unknown model|no such model/.test(s)) return 'MODEL_UNAVAILABLE';
  if (/context.?(length|window)|maximum context|prompt is too long|too many tokens|token limit/.test(s)) return 'CONTEXT_TOO_LARGE';
  // Only the four gateway statuses count as "down" - a bare 5xx match would claim
  // any three-digit number that happens to appear in a success message.
  if (/\beconnrefused\b|\benotfound\b|\beai_again\b|socket hang up|bad gateway|service unavailable|connection (refused|reset)|\b(500|502|503|504)\b/.test(s)) return 'PROVIDER_DOWN';
  if (/timeout|timed out|etimedout/.test(s)) return 'TIMEOUT';
  return 'AGENT_FAILURE';
}

// Sleeps, or rejects early with whatever reason the signal was aborted with.
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Agent cancelled'), { code: 'CANCELLED' }));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });

// A provider that never leaves the machine. Used by the test suite and by any
// install that has not configured a real provider yet.
export async function* runMock(input) {
  yield { type: 'started', data: { provider: 'mock', role: input.role } };
  if (input.mockDelayMs) await sleep(input.mockDelayMs, input.signal);
  if (input.mockFailure) {
    throw Object.assign(new Error(input.mockFailure), {
      code: input.mockCode || input.mockFailure,
      sessionId: input.mockSessionId ?? null,
    });
  }
  // A real agent's stream is mostly tool calls, and the per-role budget counts
  // them. The mock emits them on demand so that budget is exercisable without a
  // provider, in the same shape a claude assistant message carries them.
  for (let i = 0; i < (input.mockToolCalls || 0); i++) {
    yield { type: 'message', data: { message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `file-${i}.mjs` } }] } } };
  }
  // Which files the run looked at. The execution gate compares the dirty set
  // against exactly this, so a test that cannot name these would be testing the
  // context ranker rather than the gate.
  for (const file of input.mockReadPaths || []) {
    yield { type: 'message', data: { message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: file } }] } } };
  }
  // An implementer's whole job is writing files. The check that follows its run
  // compares the worktree's dirty set against the plan's baseline, and a mock that
  // cannot write leaves that comparison with nothing to compare. Only that role
  // writes: a planner or reviewer that did would be the planning violation that
  // check already exists to catch.
  for (const file of (input.role === 'implementer' && input.mockWrites) || []) {
    const dest = path.join(input.worktree, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, '// written by the mock implementer\n');
  }
  // Usage is what the cost ceiling is computed from, so it is emittable too.
  if (input.mockUsage) yield { type: 'message', data: { usage: input.mockUsage } };
  if (input.role === 'planner') {
    // Overridable for the same reason the reviewer's verdict is: the plan a refine
    // returns has to be able to differ from the plan it was given, or nothing can test
    // what a revision is - the fixed string would make every refine a no-op, and a
    // no-op refine is deliberately not recorded as a revision at all.
    yield { type: 'message', data: input.mockPlanText || 'Proposed plan: inspect the relevant module, make the smallest change, add/update tests, run verification.' };
  } else if (input.role === 'reviewer') {
    yield { type: 'message', data: input.mockReviewText || 'Review complete: compare implementation against the approved plan and test results.' };
  } else {
    yield { type: 'message', data: `${input.role} completed.` };
  }
  yield { type: 'completed', data: { ok: true, resumed: input.resumeSession || null } };
}

// Plan mode tells the model to save its work to a plans file. The tool that would
// write it is denied above, so the instruction can only produce a doomed call: a
// planning run spent a turn on a Write that could not succeed, sometimes another
// searching for a tool to replace it, and only then planned. This is the one place
// that countermands it.
//
// It has to be the system prompt, not the task prompt. The instruction comes from
// plan mode's own system reminder, which outranks anything in the user turn - a
// task-prompt clause saying the same words left the Write attempt in place, and
// the run's closing line quoting that clause is how we know the clause arrived.
// An appended system prompt does reach the model at the same level, and the
// attempt disappears. Measured on three runs of the same trivial planning task:
// no append, 1 Write; an unrelated append, 1 Write; this append, 0.
//
// Replacing plan mode instead would remove the reminder at the source, but plan
// mode's read-only preamble also covers tools --disallowedTools does not name -
// publishing, notebook edits, whatever the CLI adds next - so it is worth more
// than the turn it costs.
const READ_ONLY_NOTICE =
  'No tool that writes a file exists in this session. Do not attempt Write, Edit, or any other file-creating tool, and do not search for one. Do not attempt to write a plan file. The deliverable is the text of your reply.';

// The permission flags are the whole safety story: a planner or reviewer may not
// write, and only an implementation role may run commands without prompting.
// Built here rather than inside runClaude so the argv is a value a test can read
// without spawning an agent.
export function claudeArgs(input) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (input.model) args.push('--model', input.model);
  if (input.effort) args.push('--effort', input.effort);
  if (input.role === 'planner') {
    args.push('--permission-mode', 'plan', '--disallowedTools', 'Edit', 'Write', 'Bash');
    args.push('--append-system-prompt', READ_ONLY_NOTICE);
  } else if (input.role === 'reviewer') {
    args.push('--permission-mode', 'plan', '--disallowedTools', 'Edit', 'Write');
    args.push('--append-system-prompt', READ_ONLY_NOTICE);
  } else {
    args.push('--dangerously-skip-permissions');
  }
  if (input.resumeSession) args.push('--resume', input.resumeSession);
  // `--` so a prompt that starts with a dash is not read as a flag.
  args.push('--', input.prompt);
  return args;
}

// Drives the claude binary.
export async function* runClaude(input) {
  const env = childEnv(input.env);
  yield* runProcess('claude', claudeArgs(input), { cwd: input.cwd, env, role: input.role, signal: input.signal });
}

async function* runProcess(cmd, args, { cwd, env, role, signal }) {
  const child = spawn(cmd, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    // A detached child leads its own process group, so a kill can reach every
    // process the agent spawned instead of just the top one.
    detached: process.platform !== 'win32',
  });
  let stderr = '';
  let sessionId = null;
  let aborted = null;
  let apiError = null;

  const killGroup = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch {
      // No process group (already gone, or not our child): fall back to the pid.
      try {
        child.kill(sig);
      } catch {
        /* already dead */
      }
    }
  };

  const onAbort = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    aborted = signal.reason instanceof Error ? signal.reason : Object.assign(new Error('Agent cancelled'), { code: 'CANCELLED' });
    killGroup('SIGTERM');
    // Escalate only if it is still running, and do not hold the event loop open.
    const t = setTimeout(() => killGroup('SIGKILL'), 5000);
    t.unref?.();
    child.once('close', () => clearTimeout(t));
  };

  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  yield { type: 'started', data: { cmd, role, args: args.filter((x) => !String(x).toLowerCase().includes('token')) } };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  // stream-json is one JSON object per line, and a chunk can split any line.
  let buffer = '';
  for await (const chunk of child.stdout) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        // Not JSON: the binary wrote a plain log line. Pass it through as text.
        yield { type: 'message', data: line };
        continue;
      }
      if (obj.session_id) sessionId = obj.session_id;
      if (obj.api_error_status || obj.is_error) apiError = { status: obj.api_error_status || null, message: String(obj.result || '') };
      // Thinking-token accounting is noise for every consumer downstream.
      if (obj.subtype === 'thinking_tokens') continue;
      if (obj.type === 'assistant' || obj.type === 'result' || obj.message?.content || obj.usage) {
        yield { type: obj.type === 'result' ? 'result' : 'message', data: obj };
      } else {
        yield { type: obj.type || 'event', data: obj };
      }
    }
  }
  // A final line without a trailing newline is still a whole object.
  if (buffer.trim()) {
    try {
      const obj = JSON.parse(buffer);
      yield { type: obj.type || 'message', data: obj };
    } catch {
      yield { type: 'message', data: buffer };
    }
  }

  for await (const chunk of child.stderr) stderr += chunk;
  const code = await new Promise((r) => child.on('close', r));
  signal?.removeEventListener('abort', onAbort);

  if (aborted) {
    aborted.sessionId = sessionId;
    throw aborted;
  }
  if (code !== 0) {
    // claude writes its own progress notices to stderr; they are not the failure.
    const notable = stderr
      .split('\n')
      .filter((l) => l.trim() && !/^\[claude-code:/.test(l.trim()) && !/^⚠\s*claude\.ai connectors/.test(l.trim()))
      .join('\n')
      .trim();
    const err = new Error(notable || apiError?.message || `claude exited ${code}`);
    // A structured API error status is a better signal than the stderr text.
    err.code = apiError?.status ? classify(String(apiError.status)) : classify(stderr);
    err.sessionId = sessionId;
    throw err;
  }
  yield { type: 'completed', data: { exitCode: code, sessionId } };
}

// A claude-code provider must not inherit the ambient Anthropic routing a user
// may have set for their own terminal, or a subscription login silently bills a
// third-party endpoint instead.
const AMBIENT_ROUTING_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_EFFORT_LEVEL',
];

function childEnv(extra) {
  const env = { ...process.env };
  for (const k of AMBIENT_ROUTING_VARS) delete env[k];
  return { ...env, ...(extra || {}) };
}

// DeepSeek is reached through Claude Code's Anthropic-compatible endpoint, so the
// provider config is expressed entirely as environment variables.
export function providerEnv(provider, model) {
  if (provider.kind === 'deepseek') {
    const keyEnv = provider.config.apiKeyEnv || 'DEEPSEEK_API_KEY';
    const key = process.env[keyEnv];
    // A missing key is an auth failure, not an agent failure: it must open the
    // circuit on the first attempt instead of retrying eight times against the
    // same unset variable.
    if (!key) throw Object.assign(new Error(`Missing ${keyEnv} for DeepSeek provider`), { code: 'AUTH_FAILURE' });
    const mid = model.invocationModelId || model.providerModelId || model.name;
    return {
      AI_CODE_PROVIDER: provider.id,
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_MODEL: mid,
      ANTHROPIC_DEFAULT_OPUS_MODEL: mid,
      ANTHROPIC_DEFAULT_SONNET_MODEL: mid,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: mid,
      CLAUDE_CODE_SUBAGENT_MODEL: mid,
      CLAUDE_CODE_EFFORT_LEVEL: provider.config.effort || 'max',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(provider.config.autoCompactWindow || 786432),
    };
  }
  return { AI_CODE_PROVIDER: provider.id };
}

export async function* runAgent(provider, model, input) {
  if (provider.kind === 'mock') {
    yield* runMock({
      ...input,
      mockDelayMs: provider.config.delayMs || 0,
      mockCode: provider.config.failCode,
      mockSessionId: provider.config.sessionId,
      mockToolCalls: provider.config.toolCalls || 0,
      mockReadPaths: provider.config.readPaths || [],
      mockWrites: provider.config.writes || [],
      mockUsage: provider.config.usage || null,
      mockReviewText: provider.config.reviewText || null,
      mockPlanText: provider.config.planText || null,
      mockFailure: provider.config.failRoles?.includes(input.role) ? 'SIMULATED_FAILURE' : null,
    });
    return;
  }
  if (provider.kind === 'claude-code' || provider.kind === 'deepseek') {
    yield* runClaude({
      ...input,
      model: model.invocationModelId || model.providerModelId || model.name,
      effort: input.effort,
      env: providerEnv(provider, model),
    });
    return;
  }
  throw new Error(`Unsupported agent provider: ${provider.kind}`);
}

export { classify, runProcess, childEnv };
