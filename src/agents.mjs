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
  // Usage is what the cost ceiling is computed from, so it is emittable too - and
  // it comes before the tool calls, because that is the order a real provider
  // reports in: a turn's usage arrives with the turn, and the tool calls follow. A
  // mock that reported usage only at the end could not exercise the case that
  // matters, which is a run stopped mid-stream by a budget.
  if (input.mockUsage) yield { type: 'message', data: { usage: input.mockUsage } };
  // The frames claude writes with --include-partial-messages, in the order it writes
  // them: the request opens, the reasoning streams as deltas, and the CLI counts it.
  // Emitted before the tool calls for the same reason the usage above is: the silence
  // this exists to break is the one before an agent's first action.
  if (input.mockStreamEvents) {
    yield { type: 'stream_event', data: { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 1000, output_tokens: 0 } } } } };
    // Real deltas are spread over the response, and the intervals are measured in
    // real time, so a mock that emits its whole response in one tick cannot stand in
    // for a long one: `mockStreamMs` is what lets a test produce a response the
    // progress throttle and the stall timer have something to say about.
    const gap = input.mockStreamMs ? Math.max(1, Math.round(input.mockStreamMs / input.mockStreamEvents)) : 0;
    for (let i = 0; i < input.mockStreamEvents; i++) {
      if (gap) await sleep(gap, input.signal);
      yield { type: 'system', data: { type: 'system', subtype: 'thinking_tokens', estimated_tokens: (i + 1) * 10 } };
      yield { type: 'stream_event', data: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thinking '.repeat(10) } } } };
    }
    yield { type: 'stream_event', data: { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1000, output_tokens: input.mockStreamEvents * 10 } } } };
    yield { type: 'stream_event', data: { type: 'stream_event', event: { type: 'message_stop' } } };
  }
  // A real agent's stream is mostly tool calls, and the per-role budget counts
  // them. The mock emits them on demand so that budget is exercisable without a
  // provider, in the same shape a claude assistant message carries them.
  for (let i = 0; i < (input.mockToolCalls || 0); i++) {
    yield { type: 'message', data: { message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `file-${i}.mjs` } }] } } };
  }
  // A subagent's calls arrive on the parent's stream carrying the id of the spawn
  // that owns them, which is what separates them from the parent's own. Emitted on
  // demand for the same reason as the loop above: the rule that the budget does not
  // count them is only worth having if a test can show both halves at once.
  for (let i = 0; i < (input.mockSubagentToolCalls || 0); i++) {
    yield { type: 'message', data: { parent_tool_use_id: 'call_mock_subagent', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `sub-${i}.mjs` } }] } } };
  }
  // A subagent's lifetime, in the two frames the CLI writes for one: every spawn
  // opens before the wait and closes after it. Held open for a real interval,
  // because the thing the exemption measures is wall clock - a mock that opened and
  // closed in one tick would leave a run charged for nothing and prove nothing.
  // Several at once is the case worth having: they overlap, so the run is waiting
  // once, not once per spawn.
  if (input.mockSubagentMs) {
    const spawns = input.mockSubagents || 1;
    for (let i = 0; i < spawns; i++) {
      yield { type: 'system', data: { type: 'system', subtype: 'task_started', task_id: `mock-task-${i}`, tool_use_id: `call_mock_spawn_${i}`, subagent_type: 'Explore' } };
    }
    await sleep(input.mockSubagentMs, input.signal);
    for (let i = 0; i < spawns; i++) {
      yield { type: 'system', data: { type: 'system', subtype: 'task_updated', task_id: `mock-task-${i}`, patch: { status: 'completed', end_time: Date.now() } } };
    }
  }
  // A run that has streamed and then goes quiet, which is the shape a stall detector
  // has to catch and the total timeout cannot tell from a run that is merely busy.
  // After the spawns rather than before them, because the silence it stands for is
  // the run's own - the thinking it does on the far side of a wait, which is where
  // the planner of f70c23a7 was when its budget ran out. Placed before the spawns it
  // would be a silence with the run's whole remaining life still to come, and a test
  // that held a subagent open under it could never reach the spawn at all.
  if (input.mockStallMs) await sleep(input.mockStallMs, input.signal);
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
    const dest = path.join(agentCwd(input), file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, '// written by the mock implementer\n');
  }
  if (input.role === 'planner') {
    // Overridable for the same reason the reviewer's verdict is: the plan a refine
    // returns has to be able to differ from the plan it was given, or nothing can test
    // what a revision is - the fixed string would make every refine a no-op, and a
    // no-op refine is deliberately not recorded as a revision at all.
    yield { type: 'message', data: input.mockPlanText || 'Proposed plan: inspect the relevant module, make the smallest change, add/update tests, run verification.' };
  } else if (input.role === 'reviewer') {
    const text = input.mockReviewText || 'Review complete: compare implementation against the approved plan and test results.';
    yield { type: 'message', data: text };
    // The verdict rides on a result frame, which is where --json-schema puts it
    // for a real provider. A test therefore drives the decision through the same
    // field a run does, and can hand the reviewer prose that contradicts it to
    // prove the prose is not what decides. `result` is deliberately left unset so
    // finalText still resolves to the prose rather than to this frame.
    yield {
      type: 'result',
      data: { structured_output: { verdict: input.mockReviewVerdict || 'PASS', review: text } },
    };
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

// The reviewer's verdict as a shape the harness validates, rather than a word
// found in prose. Reading prose for it failed in both directions on one task:
// the word "failures" in the sentence "no test failures" was read as a finding,
// and the PASS escape hatch missed a verdict written as "## Verdict: PASS"
// because that hatch required the word to start a line. Two reviewers passed
// that task and it went to repair twice.
//
// The verdict is an enum, so a provider that ignores the schema cannot
// introduce a third answer, and the review body is a field rather than the
// reply, so it is stored exactly as written.
export const REVIEWER_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['PASS', 'FAIL'],
      description: 'PASS only if the implementation satisfies the approved plan and no finding is left open. FAIL if any finding remains.',
    },
    review: {
      type: 'string',
      description: 'The full review for a human reader: findings mapped to the approved plan, each with the test evidence for it.',
    },
  },
  required: ['verdict', 'review'],
  additionalProperties: false,
};

// The permission flags are the whole safety story: a planner or reviewer may not
// write, and only an implementation role may run commands without prompting.
// Built here rather than inside runClaude so the argv is a value a test can read
// without spawning an agent.
export function claudeArgs(input) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (input.model) args.push('--model', input.model);
  if (input.effort) args.push('--effort', input.effort);
  if (input.role === 'planner') {
    args.push('--permission-mode', 'plan', '--disallowedTools', 'Edit', 'Write', 'Bash');
    args.push('--append-system-prompt', READ_ONLY_NOTICE);
  } else if (input.role === 'reviewer') {
    args.push('--permission-mode', 'plan', '--disallowedTools', 'Edit', 'Write');
    args.push('--append-system-prompt', READ_ONLY_NOTICE);
    // The verdict is read from the validated output, never from the reply text.
    // Verified to work through both provider kinds, including the DeepSeek
    // Anthropic-compatible endpoint, which is the same binary with a different
    // base URL.
    args.push('--json-schema', JSON.stringify(REVIEWER_SCHEMA));
  } else {
    args.push('--dangerously-skip-permissions');
  }
  if (input.resumeSession) args.push('--resume', input.resumeSession);
  // `--` so a prompt that starts with a dash is not read as a flag.
  args.push('--', input.prompt);
  return args;
}

// The tree the agent runs in. Every caller in the service names it `worktree` and
// none of them names it `cwd`, which is the field the spawner reads - so the spawn
// was handed `undefined` and the child inherited the server's own working directory
// instead. That directory is the main checkout, so an implementer read and edited the
// repository the dashboard was launched from while its worktree sat beside it as a
// sibling it never entered. On 2026-09-23 run 787ded70 made nine edits into the main
// checkout that way and caught itself at 22:13:57, having already run the main
// repository's test suite and read its sources. The instruction "do not change files
// outside the worktree" was unfollowable: every relative path already was outside it.
//
// Both names are honoured rather than one being renamed, because the two callers that
// have a worktree and the two that only have a tree say different things and neither
// is wrong. Undefined stays undefined, so a caller that names neither keeps the
// inherit-from-server behaviour it had rather than being given a surprise root.
export function agentCwd(input) {
  return input?.cwd || input?.worktree || undefined;
}

// Drives the claude binary.
export async function* runClaude(input) {
  const env = childEnv(input.env);
  yield* collapseStream(
    runProcess('claude', claudeArgs(input), { cwd: agentCwd(input), env, role: input.role, signal: input.signal })
  );
}

// How often a streaming response reports itself, and how long it has to be before it
// reports at all. A response shorter than the first interval is not reported while it
// streams, because its completed block produces a row of its own the moment it
// arrives and a second row beside it would say nothing the first did not - the
// intervals are for the long response, which is the one with no row coming.
const PROGRESS_MS = 5000;
const PROGRESS_FIRST_MS = 2000;

// Collapses claude's streaming frames into the frames consumers read.
//
// Without `--include-partial-messages` the CLI writes one frame per *completed*
// content block, so a model that reasons before it acts writes nothing at all for
// the whole duration of that reasoning. On 2026-09-23 the reviewer of task 8e900a8c
// (run 14185f67) sat silent for 277s after its session started and then produced a
// single 111,625-character reasoning block - 92% of its 300s budget spent before it
// had done anything, with nothing in the log to say so. With partial messages the
// deltas arrive as they are produced, tens per second, so a run that is thinking and
// a run that is hung stop looking identical.
//
// The deltas themselves cannot be persisted: one reasoning block is tens of
// thousands of frames. They are collapsed here, at the process boundary, so no
// consumer has to know the difference - a `progress` frame per response once the
// response has been open for PROGRESS_FIRST_MS, then at most one every
// PROGRESS_MS, and one at close carrying the response's usage. The shape is the
// service's `{ type, data }`, and `data.usage` is read by the same cost accounting as
// any other frame, which is how a run's spend becomes visible while it is still
// running rather than only in its closing `result` frame.
//
// `thinking_tokens` notices are folded into the same frame rather than dropped: the
// CLI's running estimate is the most direct answer to "how much has it reasoned",
// and it is the number the progress row wants to show.
//
// The two intervals are parameters rather than constants read in place, for the same
// reason health.mjs takes `now`: watching a five-second throttle work should not cost
// a test five seconds.
export async function* collapseStream(frames, { firstMs = PROGRESS_FIRST_MS, everyMs = PROGRESS_MS } = {}) {
  let progress = null;
  let startedAt = 0;
  let emittedAt = 0;
  let force = false;
  for await (const frame of frames) {
    const obj = frame.data;
    if (frame.type === 'system' && obj?.subtype === 'thinking_tokens') {
      if (progress) progress.thinkingTokens = Number(obj.estimated_tokens) || progress.thinkingTokens;
    } else if (frame.type === 'stream_event') {
      const ev = obj.event || {};
      if (ev.type === 'message_start') {
        progress = { kind: 'thinking', chars: 0, thinkingTokens: null, usage: ev.message?.usage };
        startedAt = Date.now();
        emittedAt = 0;
      } else if (!progress) {
        // A provider that starts mid-stream still gets one.
        progress = { kind: 'thinking', chars: 0, thinkingTokens: null };
        startedAt = Date.now();
        emittedAt = 0;
      } else if (ev.type === 'content_block_start') {
        progress.kind = ev.content_block?.type || progress.kind;
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        progress.chars += String(d.thinking ?? d.text ?? d.partial_json ?? '').length;
      } else if (ev.type === 'message_delta') {
        // The closing usage is reported once per response and is the only frame that
        // carries a real output-token count, so it is emitted whatever the throttle
        // says: the cost ceiling is computed from these numbers, and a ceiling that
        // cannot see output tokens cannot stop a run.
        if (ev.usage) {
          progress.usage = ev.usage;
          force = true;
        }
      } else if (ev.type === 'message_stop') {
        progress = null;
        startedAt = 0;
        emittedAt = 0;
        force = false;
        continue;
      }
    } else {
      // A completed block or a whole turn: the response it belonged to is over.
      progress = null;
      startedAt = 0;
      emittedAt = 0;
      force = false;
      yield frame;
      continue;
    }
    if (!progress) continue;
    const now = Date.now();
    // Since the last report, or since the response opened if there has not been one.
    const due = emittedAt ? everyMs : firstMs;
    if (force || now - (emittedAt || startedAt) >= due) {
      emittedAt = now;
      force = false;
      const { kind, chars, thinkingTokens, usage } = progress;
      yield { type: 'progress', data: { kind, chars, thinkingTokens, ...(usage ? { usage } : {}) } };
    }
  }
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
      // Every frame is passed through, including the streaming ones. Deciding which
      // of them a consumer should see is collapseStream's job, and a parser that
      // dropped a frame would hide it from the one caller that wants it.
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

// A server the agent starts must not land on the port the live dashboard is holding.
// `npm start` in a worktree would answer EADDRINUSE, and on 2026-09-23 an implementer
// read that as "the port is stuck" and cleared it with
// `lsof -i :4317 | grep -v COMMAND | awk '{print $2}' | xargs kill -9` - which killed
// the dashboard, and the dashboard is the agent's own parent, so the run died with it.
// Zero asks the kernel for a free port, so the collision cannot happen at all; the
// server prints the port it actually received, which is how the agent finds it.
const AGENT_PORT = '0';

function childEnv(extra) {
  const env = { ...process.env };
  for (const k of AMBIENT_ROUTING_VARS) delete env[k];
  // Deleted rather than overridden in place: a dashboard launched as `PORT=4317
  // ai-code dashboard` would otherwise hand its own port to every agent it spawns.
  delete env.PORT;
  return { ...env, ...(extra || {}), PORT: AGENT_PORT };
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
    // Through collapseStream like a real provider, so a test can drive the streaming
    // frames - and the stall they are the evidence for - without a network.
    yield* collapseStream(
      runMock({
        ...input,
        mockDelayMs: provider.config.delayMs || 0,
        mockCode: provider.config.failCode,
        mockSessionId: provider.config.sessionId,
        mockToolCalls: provider.config.toolCalls || 0,
        mockSubagentToolCalls: provider.config.subagentToolCalls || 0,
        mockSubagents: provider.config.subagents || 1,
        mockSubagentMs: provider.config.subagentMs || 0,
        mockStreamEvents: provider.config.streamEvents || 0,
        mockStreamMs: provider.config.streamMs || 0,
        mockStallMs: provider.config.stallMs || 0,
        mockReadPaths: provider.config.readPaths || [],
        mockWrites: provider.config.writes || [],
        mockUsage: provider.config.usage || null,
        mockReviewText: provider.config.reviewText || null,
        mockReviewVerdict: provider.config.reviewVerdict || null,
        mockPlanText: provider.config.planText || null,
        mockFailure: provider.config.failRoles?.includes(input.role) ? 'SIMULATED_FAILURE' : null,
      })
    );
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
