#!/usr/bin/env node
// The MCP server claude delegates its permission prompts to during a supervised
// session. One tool, one job: take the action claude is about to perform, ask the
// ai-code server, and block until a person answers.
//
// It is a stdio server in the shape MCP describes - newline-delimited JSON-RPC 2.0
// on stdin and stdout - written against node's builtins rather than against
// `@modelcontextprotocol/sdk`, because this repo has no runtime dependencies and
// the surface it needs is four methods. The protocol was read off the wire from a
// real 2.1.283 run rather than from the spec, and the two shapes it has to get
// exactly right are:
//
//   request   {"tool_name":"Write","input":{...},"tool_use_id":"call_00_..."}
//   decision  {"behavior":"allow","updatedInput":{...}}
//             {"behavior":"deny","message":"..."}
//
// returned as the `text` of a single content block. Anything else - a body that
// does not parse, a malformed decision - is refused by claude with "invalid
// permission result", which is the fail-closed answer and was confirmed by
// execution before this file existed.
//
// Fail closed is the rule throughout. A connection that fails, a response that
// never arrives, a reply that is not a decision: every one of them denies. There
// is no path through this file that allows an action because something went wrong.
const ENDPOINT = process.env.AI_CODE_PERMISSION_ENDPOINT || '';
const SESSION = process.env.AI_CODE_SESSION_ID || '';
const RUN = process.env.AI_CODE_RUN_ID || '';
// The server's own timeout, plus a margin. The margin is what keeps the two clocks
// from racing: the server sweeps the row to `timeout` at its deadline and answers
// this request with that denial, so this timer should never be the one that fires.
// It is here for the case the server cannot cover - a socket that is open and
// silent, where no answer and no error ever arrives.
const SERVER_TIMEOUT_MS = Number(process.env.AI_CODE_PERMISSION_TIMEOUT_MS) || 120000;
const CLIENT_TIMEOUT_MS = SERVER_TIMEOUT_MS + 15000;

// The tool claude was told to call. The name is a constant here and in
// src/agents.mjs, which is what writes the `mcp__<server>__<tool>` value into the
// argv - a mismatch is a session that can ask for nothing.
const TOOL_NAME = 'approve';

// Everything this process writes is diagnostics. stdout is the protocol, so a
// stray line on it corrupts a frame; stderr is where a person debugging a session
// will find out why nothing was allowed.
const note = (msg) => process.stderr.write(`[permission-mcp] ${msg}\n`);

const allow = (updatedInput) => ({ behavior: 'allow', updatedInput: updatedInput || {} });
const deny = (message) => ({ behavior: 'deny', message });

// The decision, as the single text block claude reads it from. A non-2xx status is
// a denial rather than a crash: the server refusing to record a request is a
// request that was not recorded, and an action nobody recorded is not one a person
// approved.
async function decide(args) {
  if (!ENDPOINT || !SESSION) {
    return deny('This session has no permission endpoint, so nothing can be approved.');
  }
  const body = {
    tool: args?.tool_name ?? 'unknown',
    input: args?.input ?? {},
    // The directory the agent is working in. It is not in the request claude sends;
    // it is this process's own working directory, which claude sets to the tree the
    // session is running in - verified by execution, and the only place the answer
    // is available at all.
    cwd: process.cwd(),
    run_id: RUN || null,
  };
  const timer = AbortSignal.timeout(CLIENT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${ENDPOINT}/api/sessions/${SESSION}/permissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: timer,
    });
  } catch (e) {
    // A refused connection, a server that has exited, a socket that went quiet for
    // longer than the margin. None of them is an approval.
    note(`no answer from ${ENDPOINT}: ${e.message}`);
    return deny('The permission endpoint did not answer, so this action was not approved.');
  }
  if (!res.ok) {
    note(`endpoint answered ${res.status}`);
    return deny(`The permission endpoint answered ${res.status}, so this action was not approved.`);
  }
  let decision;
  try {
    decision = await res.json();
  } catch (e) {
    note(`unreadable decision: ${e.message}`);
    return deny('The permission answer could not be read, so this action was not approved.');
  }
  // The server answers with the decision it recorded, so the row and what the agent
  // was told cannot disagree. Anything that is not the allow shape is a denial.
  if (decision?.behavior === 'allow') return allow(decision.updatedInput ?? args?.input ?? {});
  return deny(decision?.message || 'Denied.');
}

// A human-readable one-liner for the prompt the dashboard shows. Written here
// rather than server-side because this is where the tool input is, and the server
// stores the input verbatim - a summary derived at write time could not be
// re-derived for a request recorded before the summariser changed.
function summarise(tool, input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url']) {
    if (typeof input[key] === 'string') return input[key];
  }
  return '';
}

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

async function handle(msg) {
  const { id, method, params } = msg;
  // A notification has no id and gets no reply; answering one is a protocol error.
  if (id === undefined || id === null) return;
  if (method === 'initialize') {
    // Echo the client's protocol version rather than naming one of our own: this
    // server implements four methods and none of them moved between revisions, and
    // claiming a version newer than the client's is the one way to be refused.
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'ai-code-permissions', version: '1.0.0' },
    });
  }
  if (method === 'tools/list') {
    return reply(id, {
      tools: [
        {
          name: TOOL_NAME,
          description:
            'Ask the person watching this AI Code session to approve or deny an action. Returns the decision.',
          inputSchema: {
            type: 'object',
            properties: {
              tool_name: { type: 'string', description: 'The tool the agent wants to use.' },
              input: { type: 'object', description: 'The arguments that tool would be called with.' },
              tool_use_id: { type: 'string' },
            },
            required: ['tool_name', 'input'],
          },
        },
      ],
    });
  }
  if (method === 'tools/call') {
    const args = params?.arguments || {};
    const what = summarise(args.tool_name, args.input);
    note(`asking: ${args.tool_name}${what ? ` ${what}` : ''}`);
    const decision = await decide(args);
    note(`${decision.behavior}: ${args.tool_name}`);
    return reply(id, {
      content: [{ type: 'text', text: JSON.stringify(decision) }],
      isError: false,
    });
  }
  if (method === 'ping') return reply(id, {});
  // An unknown method is answered rather than ignored, so a client waiting on it
  // is not left hanging on a reply that is never coming.
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      note(`unparseable frame: ${line.slice(0, 200)}`);
      continue;
    }
    // Not awaited: a second call can arrive while the first is blocked on a person,
    // and serialising them here would make the queue this process's problem rather
    // than the server's, where it is recorded.
    handle(msg).catch((e) => note(`handler failed: ${e.message}`));
  }
});

process.stdin.on('end', () => process.exit(0));
// The order the two flags have to be set in: a write after an exit is a crash, and
// a crash is a non-zero exit claude reads as a failed tool rather than a denial.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// One line at startup, so a session log says the gate was loaded rather than
// leaving "every action was denied" to be diagnosed from nothing.
if (ENDPOINT && SESSION) note(`gating ${SESSION} via ${ENDPOINT}`);
else note('no endpoint or session id in the environment; every action will be denied');
