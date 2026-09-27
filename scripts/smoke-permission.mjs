#!/usr/bin/env node
// Step 0: does the installed claude actually delegate permission prompts to a local
// MCP tool?
//
// The supervised-session design rests on one external fact - that `claude` carries
// `--permission-prompt-tool`, that with `--print` and `--permission-prompts host` it
// calls that tool once per gated action, and that it acts on the answer the tool
// gives. That fact was read off the binary before this script existed, which is a
// reading and not a run. This turns it into a run and leaves the bytes behind.
//
// What it does, per run:
//   1. starts a mock permission endpoint answering with one decision (allow, deny)
//   2. writes an MCP config pointing at scripts/mcp-tap.mjs, which wraps the real
//      src/permission-mcp.mjs and records both directions of the conversation
//   3. spawns the installed claude with the production flag combination on a prompt
//      that forces one Write
//   4. records what claude asked, what it was answered, what the tool posted over
//      HTTP, and whether the action actually happened
//
// The output is tests/fixtures/permission-roundtrip.json. It is an observation, not
// an expectation: nothing in this repository should hand-write the request or
// decision shapes now that a recorded one exists, and the test that reads it asserts
// against these bytes.
//
//   node scripts/smoke-permission.mjs [--keep] [--label allow|deny]
//
// Exits non-zero if the delegation did not fire, which is the one outcome that
// invalidates the design rather than merely failing to observe it.
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixturePath = path.join(root, 'tests', 'fixtures', 'permission-roundtrip.json');
const mcpPath = path.join(root, 'src', 'permission-mcp.mjs');
const tapPath = path.join(here, 'mcp-tap.mjs');

// The tool name claude is told to call. Spelled the way src/agents.mjs spells it -
// `mcp__<server>__<tool>` for the server key and tool name in the config below -
// because a mismatch here would smoke-test a name the product does not use.
const SERVER_KEY = 'ai-code-permissions';
const PERMISSION_TOOL = `mcp__${SERVER_KEY}__approve`;

// One Write, in a directory that is thrown away. The prompt is deliberately the
// smallest thing that cannot be done without a gated tool, so what the run proves is
// about the gate and not about the task.
const PROMPT = 'Write the text "hello" to a file named test.txt in the current directory.';

// A whole run, bounded. A prompt that is never answered is the failure this is here
// to catch, and waiting forever to catch it reads as a hang rather than as a result.
const RUN_TIMEOUT_MS = 180000;

const keep = process.argv.includes('--keep');
const only = (() => {
  const i = process.argv.indexOf('--label');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const version = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();

// The decision the mock endpoint answers with, swapped between runs. The two bodies
// are the two shapes src/service.mjs's `permissionDecision` produces - that function
// is the server's only source of them, and these are copies of its output rather
// than a second definition of it. The deny message is its wording.
let answering = { behavior: 'allow', updatedInput: {} };

const http_bodies = [];
const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.includes('/permissions')) {
    res.writeHead(404);
    return res.end();
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let posted;
    try {
      posted = JSON.parse(body);
    } catch {
      res.writeHead(400);
      return res.end('unreadable request');
    }
    // Answered the way the real endpoint answers an allow: the input is echoed back
    // as `updatedInput`, so the action claude performs is the one it proposed.
    http_bodies.push(posted);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answering.behavior === 'allow' ? { behavior: 'allow', updatedInput: posted.input ?? {} } : answering));
  });
});

await new Promise((resolve, reject) => {
  server.on('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const endpoint = `http://127.0.0.1:${server.address().port}`;

// One run: its own directory, its own tap log, its own claude process.
function roundTrip(label, decision) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ai-code-smoke-${label}-`));
  const tapLog = path.join(dir, 'mcp-wire.jsonl');
  const configPath = path.join(dir, 'mcp-config.json');
  fs.writeFileSync(tapLog, '');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          [SERVER_KEY]: {
            command: process.execPath,
            // The tap, wrapping the real server. Both are named absolutely: the
            // agent's own working directory is the fixture above, not this checkout.
            args: [tapPath, mcpPath],
            env: {
              AI_CODE_RUN_ID: `smoke-${label}`,
              AI_CODE_SESSION_ID: `smoke-${label}`,
              AI_CODE_PERMISSION_ENDPOINT: endpoint,
              AI_CODE_PERMISSION_TIMEOUT_MS: '120000',
              AI_CODE_TAP_LOG: tapLog,
            },
          },
        },
      },
      null,
      2
    ),
    { mode: 0o600 }
  );

  // The production invocation: --print is what makes --permission-prompt-tool take
  // effect, `host` is what routes the prompt to the tool rather than to the SDK
  // host, and the mode is pinned rather than left to the CLI's default.
  const argv = [
    '--print',
    '--permission-mode',
    'default',
    '--permission-prompts',
    'host',
    '--permission-prompt-tool',
    PERMISSION_TOOL,
    '--mcp-config',
    configPath,
    '--',
    PROMPT,
  ];

  answering = decision === 'deny' ? { behavior: 'deny', message: 'The person watching this session denied this action. Do not retry it or reach the same result another way.' } : { behavior: 'allow' };

  return new Promise((resolve) => {
    const before = http_bodies.length;
    const child = spawn('claude', argv, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const file = path.join(dir, 'test.txt');
      const written = fs.existsSync(file);
      resolve({
        dir,
        tapLog,
        run: {
          label,
          decision,
          // What claude sent the tool, and what the tool answered it, taken from the
          // recorded conversation rather than from the tool's stderr or this
          // script's expectations.
          wire: readWire(tapLog),
          http: http_bodies.slice(before),
          outcome: {
            exitCode: code,
            signal: signal || null,
            fileWritten: written,
            fileContent: written ? fs.readFileSync(file, 'utf8') : null,
            reply: stdout.trim(),
          },
          stderrTail: stderr.trim().slice(-2000),
        },
      });
    });
  });
}

// The recorded conversation, as frames. Each line is one message in one direction;
// a line that will not parse is kept as text so the record cannot silently lose the
// thing that went wrong.
function readWire(logPath) {
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const entry = JSON.parse(line);
      try {
        return { dir: entry.dir, msg: JSON.parse(entry.line) };
      } catch {
        return { dir: entry.dir, raw: entry.line };
      }
    });
}

// The ask, as claude wrote it: the arguments of the `tools/call` frame it sent.
const asksOf = (wire) =>
  wire
    .filter((f) => f.dir === 'in' && f.msg?.method === 'tools/call')
    .map((f) => f.msg.params?.arguments)
    .filter(Boolean);

// The answer, as the tool wrote it: the decision JSON inside the single content
// block it replied with.
const answersOf = (wire) =>
  wire
    .filter((f) => f.dir === 'out' && f.msg?.result?.content?.[0]?.text)
    .map((f) => {
      try {
        return JSON.parse(f.msg.result.content[0].text);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const runs = [];
for (const label of ['allow', 'deny'].filter((l) => !only || l === only)) {
  process.stdout.write(`\n[smoke] ${label}: ${PROMPT}\n`);
  const { dir, run } = await roundTrip(label, label);
  runs.push(run);
  const asks = asksOf(run.wire);
  const answers = answersOf(run.wire);
  process.stdout.write(`[smoke] ${label}: claude exited ${run.outcome.exitCode}, asked ${asks.length}x, answered ${answers.length}x, file written: ${run.outcome.fileWritten}\n`);
  process.stdout.write(`[smoke] ${label}: artifacts in ${dir}${keep ? '' : ' (removed)'}\n`);
  for (const a of asks) process.stdout.write(`  asked:    ${JSON.stringify(a)}\n`);
  for (const a of answers) process.stdout.write(`  answered: ${JSON.stringify(a)}\n`);
  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
}

server.close();

const fixture = {
  recordedAt: new Date().toISOString(),
  claudeVersion: version,
  claudePath: execFileSync('which', ['claude'], { encoding: 'utf8' }).trim(),
  permissionTool: PERMISSION_TOOL,
  prompt: PROMPT,
  runs: runs.map((r) => ({
    label: r.label,
    decision: r.decision,
    asked: asksOf(r.wire),
    answered: answersOf(r.wire),
    http: r.http,
    wire: r.wire,
    outcome: r.outcome,
    stderrTail: r.stderrTail,
  })),
};

fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

// The verdict. The gate fired if the tool was asked at least once per run; it
// gated if the allow run's file exists and the deny run's does not. Anything less
// and the rest of the feature is built on a flag that does not do what it says.
process.stdout.write(`\n[smoke] wrote ${path.relative(root, fixturePath)} (claude ${version})\n`);
const failures = [];
for (const r of fixture.runs) {
  if (!r.asked.length) failures.push(`${r.label}: claude never called the permission tool`);
  if (!r.answered.length) failures.push(`${r.label}: the tool never answered`);
  if (r.label === 'allow' && !r.outcome.fileWritten) failures.push('allow: the action did not happen');
  if (r.label === 'deny' && r.outcome.fileWritten) failures.push('deny: the action happened anyway');
}
if (failures.length) {
  process.stderr.write(`✗ Step 0 failed\n  ${failures.join('\n  ')}\n`);
  process.exit(1);
}
process.stdout.write('✓ Step 0 passed: claude delegated, and acted on what it was told\n');
