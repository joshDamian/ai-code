// @ts-check
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { cleanEnv, providerEnv, invocationId, priceUsage } from './providers.mjs';

/** @typedef {import('./contract.mjs').Session} Session */
/** @typedef {import('./contract.mjs').Approval} Approval */
/** @typedef {import('./contract.mjs').ApprovalAnswer} ApprovalAnswer */
/** @typedef {import('./contract.mjs').PermissionMode} PermissionMode */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').SDKUserMessage} SDKUserMessage */
/** @typedef {import('@anthropic-ai/claude-agent-sdk').PermissionResult} PermissionResult */
/** @typedef {import('./store.mjs').Store} Store */

// Claude sessions, one Agent SDK query per session, owned by this server.
//
// A query is started on a session's first message and kept open: later messages are
// pushed into its input stream, so a follow-up typed mid-turn is queued by Claude Code
// itself, and interrupt, mode and model changes reach the live process. A query nobody
// has used for a while is closed to free its process; the next message resumes it from
// Claude Code's own transcript, which lives on disk.
//
// Clients never talk to a query. They send through this class and hear back through
// its events: 'session' (a row changed), 'event' (a transcript entry was stored),
// 'delta' (streaming text, not stored), 'approval' and 'approval-done'.

const IDLE_MS = 30 * 60 * 1000;
// A tool result is shown in the transcript, not replayed to the model from here, so a
// huge one is cut to what a person would read.
const RESULT_CHARS = 20000;

export const MODES = /** @type {const} */ (['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);

/**
 * The person's own CLAUDE.md. User settings are not loaded - their `env` block would
 * outrank the provider's routing - so the instructions in that directory are handed
 * over explicitly, which is what a `claude` typed in a terminal would have read.
 */
function userInstructions() {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  try {
    return fs.readFileSync(path.join(home, 'CLAUDE.md'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Claude Code keys auto-memory by working directory, so a session in a fresh worktree
 * would start with none. It is pointed at the checkout's memory instead.
 * @param {string} projectPath
 */
function memoryDir(projectPath) {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const dir = path.join(home, 'projects', projectPath.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  return fs.existsSync(dir) ? dir : null;
}

/** @param {unknown} content @returns {unknown} */
function trimResult(content) {
  if (typeof content === 'string') return content.length > RESULT_CHARS ? `${content.slice(0, RESULT_CHARS)}\n… (${content.length - RESULT_CHARS} more characters)` : content;
  if (Array.isArray(content)) return content.map((b) => (b && b.type === 'text' ? { ...b, text: trimResult(b.text) } : b?.type === 'image' ? { type: 'text', text: '[image]' } : b));
  return content;
}

/** A title from the first message: its first line, cut at a word. @param {string} text */
export function titleFrom(text) {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ');
  if (line.length <= 60) return line || 'New session';
  return `${line.slice(0, 60).replace(/\s+\S*$/, '')}…`;
}

class Live {
  /** @param {string} sessionId */
  constructor(sessionId) {
    this.sessionId = sessionId;
    /** @type {SDKUserMessage[]} */
    this.queue = [];
    /** @type {(() => void) | null} */
    this.wake = null;
    this.closed = false;
    /** @type {any} */
    this.q = null;
    this.turns = 0;
    this.lastUsed = Date.now();
    /** @type {string[]} */
    this.commands = [];
    /** @type {string|null} */
    this.providerId = null;
    /** @type {string|undefined} */
    this.lastStderr = undefined;
  }

  /** @param {SDKUserMessage} m */
  push(m) {
    this.queue.push(m);
    this.wake?.();
  }

  async *input() {
    while (!this.closed) {
      if (this.queue.length) {
        yield /** @type {SDKUserMessage} */ (this.queue.shift());
        continue;
      }
      await new Promise((r) => (this.wake = () => r(undefined)));
      this.wake = null;
    }
  }
}

export class Runtime extends EventEmitter {
  /**
   * @param {Store} store
   * @param {{query?: typeof sdkQuery, idleMs?: number}} [o] `query` is replaced in tests
   */
  constructor(store, o = {}) {
    super();
    this.store = store;
    this.query = o.query || sdkQuery;
    this.idleMs = o.idleMs ?? IDLE_MS;
    /** @type {Map<string, Live>} */
    this.live = new Map();
    /** @type {Map<string, {approval: Approval, resolve: (r: PermissionResult) => void, suggestions: any[]}>} */
    this.approvals = new Map();
    store.resetLiveSessions();
    this.reaper = setInterval(() => this.#reap(), 60000);
    this.reaper.unref();
  }

  /** @param {string} id @param {Partial<Session>} patch */
  #update(id, patch) {
    const s = this.store.updateSession(id, patch);
    this.emit('session', s);
    return s;
  }

  /** @param {string} id @param {string} kind @param {unknown} data */
  #event(id, kind, data) {
    const e = this.store.addEvent(id, kind, data);
    this.emit('event', e);
    return e;
  }

  /** @param {string} id */
  #session(id) {
    const s = this.store.getSession(id);
    if (!s) throw Object.assign(new Error('No such session'), { status: 404 });
    return s;
  }

  isLive(/** @type {string} */ id) {
    return this.live.has(id);
  }

  /** The slash commands the session's Claude Code offers, once it has started. @param {string} id */
  commands(id) {
    return this.live.get(id)?.commands || [];
  }

  /**
   * One message from the person. Starts or resumes the session's query when none is open.
   * @param {string} id @param {string} text @param {{images?: {media_type:string, data:string}[]}} [o]
   */
  send(id, text, o = {}) {
    const s = this.#session(id);
    if (s.archived_at) throw new Error('This session is archived');
    const images = o.images || [];
    if (!text.trim() && !images.length) throw new Error('Nothing to send');
    const live = this.live.get(id) || this.#start(s);
    /** @type {any[]} */
    const content = [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })), ...(text.trim() ? [{ type: 'text', text }] : [])];
    live.push({ type: 'user', message: { role: 'user', content: images.length ? content : text }, parent_tool_use_id: null });
    live.turns++;
    live.lastUsed = Date.now();
    this.#event(id, 'user', { text, images: images.length });
    const first = !s.claude_session_id && this.store.listEvents(id, { limit: 2 }).length === 1;
    this.#update(id, { status: this.#pendingFor(id) ? 'waiting' : 'running', error: null, ...(first && /^New (session|task)/.test(s.title) ? { title: titleFrom(text) } : {}) });
  }

  /** @param {Session} s */
  #start(s) {
    const provider = this.store.getProvider(s.provider_id);
    if (!provider) throw new Error(`Provider ${s.provider_id} is gone; pick another`);
    const model = s.model_id ? this.store.getModel(s.model_id) || null : null;
    const project = this.store.getProject(s.project_id);
    const env = { ...cleanEnv(), ...providerEnv(provider, model), CLAUDE_AGENT_SDK_CLIENT_APP: 'ai-code' };
    const instructions = userInstructions();
    const memory = project && path.resolve(project.path) !== path.resolve(s.cwd) ? memoryDir(project.path) : null;
    const live = new Live(s.id);
    live.providerId = provider.id;
    this.live.set(s.id, live);
    /** @type {import('@anthropic-ai/claude-agent-sdk').Options} */
    const options = {
      cwd: s.cwd,
      env,
      settingSources: ['project', 'local'],
      permissionMode: /** @type {PermissionMode} */ (s.permission_mode),
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      canUseTool: (tool, input, opts) => this.#ask(s.id, tool, input, opts),
      ...(model ? { model: invocationId(model) } : {}),
      ...(s.effort ? { effort: /** @type {any} */ (s.effort) } : {}),
      ...(s.claude_session_id ? { resume: s.claude_session_id } : {}),
      ...(instructions ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions } } : {}),
      ...(memory ? { settings: { autoMemoryDirectory: memory } } : {}),
      stderr: (/** @type {string} */ line) => {
        if (/error/i.test(line)) live.lastStderr = line.slice(0, 2000);
      },
    };
    live.q = this.query({ prompt: live.input(), options });
    this.#pump(live, s, provider.kind === 'claude-code' ? null : model);
    return live;
  }

  /** @param {Live} live @param {Session} s @param {import('./contract.mjs').Model|null} priced the model to price tokens at, for a hosted provider */
  async #pump(live, s, priced) {
    const id = s.id;
    try {
      for await (const m of live.q) {
        live.lastUsed = Date.now();
        this.#handle(live, id, /** @type {any} */ (m), priced);
      }
      if (!live.closed) this.#update(id, { status: 'idle' });
    } catch (e) {
      if (!live.closed) {
        const message = live.lastStderr && !/aborted/i.test(String(/** @type {any} */ (e)?.message)) ? `${/** @type {any} */ (e).message}\n${live.lastStderr}` : String(/** @type {any} */ (e)?.message || e);
        this.#event(id, 'error', { message });
        this.#update(id, { status: 'error', error: message.slice(0, 2000) });
      }
    } finally {
      live.closed = true;
      live.wake?.();
      if (this.live.get(id) === live) this.live.delete(id);
      this.#dropApprovals(id, 'The session ended.');
    }
  }

  /** @param {Live} live @param {string} id @param {any} m @param {import('./contract.mjs').Model|null} priced */
  #handle(live, id, m, priced) {
    if (m.type === 'stream_event') {
      const ev = m.event;
      if (m.parent_tool_use_id || ev?.type !== 'content_block_delta') return;
      if (ev.delta?.type === 'text_delta') this.emit('delta', { session_id: id, text: ev.delta.text });
      else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) this.emit('delta', { session_id: id, text: ev.delta.thinking, thinking: true });
      return;
    }
    if (m.type === 'system') {
      if (m.subtype === 'init') {
        live.commands = m.slash_commands || [];
        const s = this.store.getSession(id);
        if (s && s.claude_session_id !== m.session_id) this.#update(id, { claude_session_id: m.session_id });
        this.#event(id, 'init', { model: m.model, permissionMode: m.permissionMode, cwd: m.cwd, version: m.claude_code_version });
      } else if (m.subtype === 'compact_boundary') this.#event(id, 'notice', { text: 'Context compacted' });
      else if (m.subtype === 'api_retry') this.#event(id, 'notice', { text: `API error, retrying (attempt ${m.attempt ?? '?'})` });
      return;
    }
    if (m.type === 'assistant') {
      const content = (m.message?.content || []).filter((/** @type {any} */ b) => !(b.type === 'thinking' && !b.thinking) && b.type !== 'redacted_thinking');
      if (!content.length && !m.error) return;
      this.#event(id, 'assistant', { id: m.message?.id, content, parent: m.parent_tool_use_id, error: m.error || null, model: m.message?.model });
      return;
    }
    if (m.type === 'user') {
      if (m.isReplay) return;
      const blocks = Array.isArray(m.message?.content) ? m.message.content.filter((/** @type {any} */ b) => b.type === 'tool_result') : [];
      if (!blocks.length) return;
      this.#event(id, 'tool_result', {
        parent: m.parent_tool_use_id,
        results: blocks.map((/** @type {any} */ b) => ({ tool_use_id: b.tool_use_id, is_error: !!b.is_error, content: trimResult(b.content) })),
      });
      return;
    }
    if (m.type === 'result') {
      // Claude Code says how many sends it still holds, which is right after an
      // interrupt or when queued sends coalesce; sends not yet handed to it are added.
      live.turns = (typeof m.queued_turn_count === 'number' ? m.queued_turn_count : Math.max(0, live.turns - 1)) + live.queue.length;
      const usage = Object.values(m.modelUsage || {});
      const input = usage.reduce((n, u) => n + (u.inputTokens || 0) + (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0), 0);
      const output = usage.reduce((n, u) => n + (u.outputTokens || 0), 0);
      const hosted = priced
        ? usage.reduce((n, u) => n + (priceUsage(priced, { input_tokens: u.inputTokens, output_tokens: u.outputTokens, cache_read_input_tokens: u.cacheReadInputTokens, cache_creation_input_tokens: u.cacheCreationInputTokens }) ?? 0), 0)
        : null;
      const total = hosted ?? m.total_cost_usd ?? 0;
      const s = /** @type {Session} */ (this.store.getSession(id));
      this.#event(id, 'result', {
        subtype: m.subtype,
        is_error: !!m.is_error,
        duration_ms: m.duration_ms,
        turns: m.num_turns,
        cost: total,
        text: m.subtype === 'success' ? undefined : (m.errors || []).join('\n') || m.result || null,
      });
      // Totals are cumulative for the query, and a resumed query carries its
      // transcript's earlier totals, so the session's figure is the largest seen.
      this.#update(id, {
        status: live.turns > 0 ? 'running' : this.#pendingFor(id) ? 'waiting' : 'idle',
        cost: Math.max(s.cost, total),
        input_tokens: Math.max(s.input_tokens, input),
        output_tokens: Math.max(s.output_tokens, output),
        ...(m.is_error && m.subtype !== 'error_during_execution' ? { error: (m.errors || []).join('\n').slice(0, 2000) || null } : {}),
      });
      if (live.turns === 0) this.emit('turn-done', { session: this.store.getSession(id), ok: !m.is_error });
      return;
    }
    if (m.type === 'prompt_suggestion') this.emit('suggestion', { session_id: id, text: m.suggestion || m.text || '' });
  }

  /**
   * The SDK's question about one tool call, held until a person answers it.
   * @param {string} id @param {string} tool @param {Record<string, unknown>} input @param {any} opts
   * @returns {Promise<PermissionResult>}
   */
  #ask(id, tool, input, opts) {
    return new Promise((resolve) => {
      /** @type {Approval} */
      const approval = {
        id: this.store.id(),
        session_id: id,
        tool,
        input,
        title: opts.title || null,
        reason: opts.decisionReason || opts.blockedPath || null,
        created_at: new Date().toISOString(),
      };
      this.approvals.set(approval.id, { approval, resolve, suggestions: opts.suggestions || [] });
      opts.signal?.addEventListener('abort', () => this.#finish(approval.id, { behavior: 'deny', message: 'Cancelled' }));
      this.#update(id, { status: 'waiting' });
      this.emit('approval', approval);
    });
  }

  /** @param {string} approvalId @param {PermissionResult} result */
  #finish(approvalId, result) {
    const held = this.approvals.get(approvalId);
    if (!held) return false;
    this.approvals.delete(approvalId);
    held.resolve(result);
    const sid = held.approval.session_id;
    this.emit('approval-done', { id: approvalId, session_id: sid });
    const s = this.store.getSession(sid);
    if (s && s.status === 'waiting' && !this.#pendingFor(sid)) this.#update(sid, { status: (this.live.get(sid)?.turns || 0) > 0 ? 'running' : 'idle' });
    return true;
  }

  /** @param {string} id */
  #pendingFor(id) {
    for (const { approval } of this.approvals.values()) if (approval.session_id === id) return true;
    return false;
  }

  /** @param {string} id @param {string} message */
  #dropApprovals(id, message) {
    for (const [aid, { approval }] of this.approvals) if (approval.session_id === id) this.#finish(aid, { behavior: 'deny', message });
  }

  /** @param {string} [sessionId] @returns {Approval[]} */
  pending(sessionId) {
    return [...this.approvals.values()].map((h) => h.approval).filter((a) => !sessionId || a.session_id === sessionId);
  }

  /**
   * A person's answer to an approval. A question is answered with its answers, a plan
   * with the mode to carry on in; everything else is allow or deny.
   * @param {string} approvalId @param {ApprovalAnswer} a
   */
  answer(approvalId, a) {
    const held = this.approvals.get(approvalId);
    if (!held) throw Object.assign(new Error('That request is no longer waiting'), { status: 404 });
    const { approval, suggestions } = held;
    if (!a.allow) return this.#finish(approvalId, { behavior: 'deny', message: a.message?.trim() || 'The user declined this.' });
    /** @type {any[]} */
    const updates = [];
    let input = approval.input;
    if (approval.tool === 'AskUserQuestion') input = { ...input, answers: a.answers || {} };
    if (approval.tool === 'ExitPlanMode') {
      const mode = a.mode && a.mode !== 'plan' ? a.mode : 'default';
      updates.push({ type: 'setMode', mode, destination: 'session' });
      this.#update(approval.session_id, { permission_mode: mode });
    }
    if (a.always) updates.push(...suggestions.map((u) => ({ ...u, destination: 'session' })));
    return this.#finish(approvalId, { behavior: 'allow', updatedInput: input, ...(updates.length ? { updatedPermissions: updates } : {}) });
  }

  /** Stops the turn in flight. Queued messages are dropped by Claude Code with it. @param {string} id */
  async interrupt(id) {
    const live = this.live.get(id);
    if (!live) return false;
    this.#dropApprovals(id, 'The user interrupted.');
    await live.q.interrupt().catch(() => {});
    return true;
  }

  /** @param {string} id @param {PermissionMode} mode */
  async setMode(id, mode) {
    if (!MODES.includes(/** @type {any} */ (mode))) throw new Error(`Unknown mode ${mode}`);
    this.#session(id);
    const live = this.live.get(id);
    if (live) await live.q.setPermissionMode(mode);
    return this.#update(id, { permission_mode: mode });
  }

  /**
   * A different model, or a different provider. A model on the same provider is switched
   * in place; a provider change needs a new process, so the query is closed and the next
   * message resumes the conversation under the new environment.
   * @param {string} id @param {{providerId?:string, modelId?:string|null, effort?:string|null}} o
   */
  async setModel(id, o) {
    const s = this.#session(id);
    const providerId = o.providerId || s.provider_id;
    const provider = this.store.getProvider(providerId);
    if (!provider) throw new Error('No such provider');
    const modelId = o.modelId === undefined ? (providerId === s.provider_id ? s.model_id : null) : o.modelId;
    const model = modelId ? this.store.getModel(modelId) : null;
    if (modelId && (!model || model.provider_id !== providerId)) throw new Error('That model is not on that provider');
    const live = this.live.get(id);
    const effortChanged = o.effort !== undefined && o.effort !== s.effort;
    if (live && (providerId !== live.providerId || effortChanged)) {
      if (live.turns > 0) throw new Error('Wait for the turn to finish, or stop it, before changing provider or effort');
      this.close(id);
    } else if (live && model) await live.q.setModel(invocationId(model));
    return this.#update(id, { provider_id: providerId, model_id: modelId, ...(o.effort !== undefined ? { effort: o.effort } : {}) });
  }

  /** Closes a session's query. Its transcript stays, and the next message resumes it. @param {string} id */
  close(id) {
    const live = this.live.get(id);
    if (!live) return;
    live.closed = true;
    this.live.delete(id);
    this.#dropApprovals(id, 'The session was closed.');
    try {
      live.q.close();
    } catch {
      /* already gone */
    }
    const s = this.store.getSession(id);
    if (s && s.status !== 'error') this.#update(id, { status: 'idle' });
  }

  #reap() {
    const cutoff = Date.now() - this.idleMs;
    for (const [id, live] of this.live) if (live.turns === 0 && !this.#pendingFor(id) && live.lastUsed < cutoff) this.close(id);
  }

  shutdown() {
    clearInterval(this.reaper);
    for (const id of [...this.live.keys()]) this.close(id);
  }
}
