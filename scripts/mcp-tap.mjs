#!/usr/bin/env node
// Records both directions of a stdio MCP conversation and passes them through
// unchanged.
//
// This exists because the permission round trip is the one mechanism in supervised
// sessions that was designed against an external binary rather than against this
// repository, and "the flags fired the tool" is a claim only the wire can settle.
// The alternative - a debug hook inside src/permission-mcp.mjs - would put a
// recorder for the agent's tool inputs into the code path that a session runs on,
// and a log line written from there is one more thing between an action and its
// prompt. So the recorder wraps the server from outside instead: claude spawns this
// file, this file spawns the real server, and neither of them knows it is there.
//
// Not a general-purpose tool. It is spawned by scripts/smoke-permission.mjs, it
// writes where AI_CODE_TAP_LOG points, and it is silent on stdout except for the
// protocol - a stray line there corrupts a frame and is read as a dead server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const [target, ...rest] = process.argv.slice(2);
const log = process.env.AI_CODE_TAP_LOG || '';

if (!target) {
  process.stderr.write('[mcp-tap] no server to run\n');
  process.exit(1);
}

// Best-effort by design: a recorder that throws is a recorder that breaks the thing
// it was invited in to observe.
function record(dir, line) {
  if (!log || !line.trim()) return;
  try {
    fs.appendFileSync(log, `${JSON.stringify({ dir, line })}\n`);
  } catch {
    /* the conversation matters more than the transcript of it */
  }
}

// Full lines only, and split on the decoder's own boundaries rather than the
// chunk's: a multi-byte character straddling two reads would otherwise be recorded
// as a replacement character, which is exactly the kind of corruption that makes a
// captured fixture untrustworthy.
function recorder(dir) {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  return (chunk, flush = false) => {
    buf += decoder.write(chunk);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      record(dir, buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
    if (flush && buf) {
      record(dir, buf);
      buf = '';
    }
  };
}

const child = spawn(process.execPath, [target, ...rest], { stdio: ['pipe', 'pipe', 'pipe'] });
const inbound = recorder('in');
const outbound = recorder('out');

process.stdin.on('data', (chunk) => {
  inbound(chunk);
  child.stdin.write(chunk);
});
process.stdin.on('end', () => {
  inbound(Buffer.alloc(0), true);
  child.stdin.end();
});

child.stdout.on('data', (chunk) => {
  outbound(chunk);
  process.stdout.write(chunk);
});
child.stdout.on('end', () => {
  outbound(Buffer.alloc(0), true);
  process.stdout.end();
});

// The server's own diagnostics. Never the protocol, so it is passed through rather
// than recorded - stderr is where a person debugging a session already looks.
child.stderr.pipe(process.stderr);

child.on('exit', (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
child.on('error', (e) => {
  process.stderr.write(`[mcp-tap] could not start ${target}: ${e.message}\n`);
  process.exit(1);
});

// Signals are passed on rather than acted on, for the reason permission-mcp.mjs
// exits 0 on them: a signal that killed this wrapper without reaching the server
// would leave a pipe open and an agent waiting on it.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  });
}
