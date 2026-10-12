// A stand-in for the Agent SDK's query(), driven by what the test sends.
//
//   "write <file> <text>"  asks permission for Write, and writes the file if allowed
//   "ask"                  asks an AskUserQuestion and replies with the answer
//   "slow"                 holds the turn open until interrupted
//   "fail"                 ends the turn as an error
//   anything else          replies "echo: <text>"
//
// Every call is recorded on `calls`, so a test can see the options a session started with.
import fs from 'node:fs';
import path from 'node:path';

export const calls = [];

export function fakeQuery({ prompt, options }) {
  const sessionId = options.resume || `claude-${Math.random().toString(36).slice(2, 10)}`;
  const record = { options, mode: options.permissionMode, model: options.model, closed: false, interrupted: 0 };
  calls.push(record);
  let total = options.resume ? 0.5 : 0;
  let wakeInterrupt = null;
  const out = [];
  let notify = null;
  const emit = (m) => {
    out.push(m);
    notify?.();
  };

  (async () => {
    emit({ type: 'system', subtype: 'init', session_id: sessionId, model: options.model || 'default', permissionMode: options.permissionMode, cwd: options.cwd, slash_commands: ['compact'] });
    for await (const msg of prompt) {
      if (record.closed) break;
      const content = msg.message.content;
      const text = typeof content === 'string' ? content : content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      const id = `msg_${Math.random().toString(36).slice(2)}`;
      emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'thinking about it' } } });
      let reply = `echo: ${text}`;
      let isError = false;
      if (text.startsWith('write ')) {
        const [, file, ...rest] = text.split(' ');
        const input = { file_path: path.join(options.cwd, file), content: rest.join(' ') };
        emit({ type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'tool_use', id: 'tu1', name: 'Write', input }] } });
        const ac = new AbortController();
        const r = await options.canUseTool('Write', input, { signal: ac.signal, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'localSettings' }], title: `Claude wants to write ${file}` });
        if (r.behavior === 'allow') fs.writeFileSync(r.updatedInput.file_path, r.updatedInput.content);
        emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: r.behavior !== 'allow', content: r.behavior === 'allow' ? 'written' : r.message }] } });
        reply = r.behavior === 'allow' ? 'wrote it' : `not allowed: ${r.message}`;
      } else if (text === 'ask') {
        const r = await options.canUseTool('AskUserQuestion', { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }, { signal: new AbortController().signal });
        reply = `answered ${JSON.stringify(r.updatedInput?.answers || null)}`;
      } else if (text === 'slow') {
        if (!record.interruptPending) await new Promise((r) => (wakeInterrupt = r));
        record.interruptPending = false;
        reply = 'interrupted';
        isError = true;
      } else if (text === 'fail') isError = true;
      emit({ type: 'assistant', parent_tool_use_id: null, message: { id: `${id}b`, content: [{ type: 'text', text: reply }] } });
      total += 0.01;
      emit({
        type: 'result',
        subtype: isError ? 'error_during_execution' : 'success',
        is_error: isError,
        duration_ms: 5,
        num_turns: 1,
        total_cost_usd: total,
        modelUsage: { m: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
        queued_turn_count: 0,
        errors: isError ? ['it failed'] : [],
      });
    }
    record.closed = true;
    notify?.();
  })();

  const gen = (async function* () {
    for (;;) {
      if (out.length) {
        yield out.shift();
        continue;
      }
      if (record.closed) return;
      await new Promise((r) => (notify = r));
      notify = null;
    }
  })();
  return Object.assign(gen, {
    record,
    async interrupt() {
      record.interrupted++;
      // An interrupt can arrive before the message it stops has been read.
      if (wakeInterrupt) wakeInterrupt();
      else record.interruptPending = true;
    },
    async setPermissionMode(m) {
      record.mode = m;
    },
    async setModel(m) {
      record.model = m;
    },
    close() {
      record.closed = true;
      notify?.();
    },
  });
}
