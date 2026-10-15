// @ts-check
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { cleanEnv, providerEnv, invocationId, priceUsage } from './providers.mjs';
import { runCheck, CHECK_TIMEOUT_MS } from './check.mjs';
import { workingTree } from './git.mjs';
import { benchApproval } from './tools.mjs';

/** @typedef {import('./contract.mjs').Session} Session */
/** @typedef {import('./contract.mjs').Task} Task */
/** @typedef {import('./contract.mjs').SlashCommand} SlashCommand */
/** @typedef {import('./check.mjs').CheckResult & {fresh:boolean}} CheckRun */
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
// Attached files: per file, and per message.
const MAX_FILE = 60 * 1024 * 1024;
const MAX_FILES = 60 * 1024 * 1024;
// A file uploaded on its own, streamed to disk rather than sent inside a JSON message:
// an APK, an archive, a build. Big enough for those, small enough to keep a disk sane.
export const MAX_UPLOAD = 300 * 1024 * 1024;

/** A file name that is safe on disk: no path, no odd characters. @param {unknown} name */
const safeName = (name) => path.basename(String(name || 'file')).replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';

// Bench's own plugin: skills and agents every session gets, whatever project it is in,
// without writing anything into that project. It ships inside the release, beside src/,
// so a Bench update upgrades it for every project at once.
export const PACK = fileURLToPath(new URL('../pack', import.meta.url));

// How many times one message from a person can be sent back to work by a failing check,
// before the stop is let through and the failure is left for the person to read.
export const CHECK_TRIES = 3;

// A folder's command list, learned from a session there or from a probe, is trusted this
// long before a session with nothing live asks Claude Code again.
const COMMANDS_FRESH_MS = 10 * 60 * 1000;
// A probe starts Claude Code only to ask for its commands; one that takes longer than
// this has something wrong, and the composer goes without suggestions.
const COMMANDS_PROBE_MS = 20 * 1000;

/** @param {any[]} list @returns {SlashCommand[]} */
const commandList = (list) => (list || []).map((c) => ({ name: String(c.name), description: String(c.description || ''), argumentHint: String(c.argumentHint || '') }));

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

/**
 * TMPDIR covers every tool that asks the system for a temporary folder. This covers the
 * rest: a path typed out as /tmp/... by the model itself.
 * @param {string} dir
 */
function scratchNote(dir) {
  return `# Scratch files\n\nThis session's scratch folder is ${dir}, and TMPDIR points at it. Put anything temporary there - logs, screenshots, downloads and throwaway scripts - rather than in /tmp or in the project. Bench deletes the folder when the session is archived, so nothing in it outlives the session; anything worth keeping belongs in the project.`;
}

/** The worktree's state, or null when git cannot say. @param {string} dir */
function treeOf(dir) {
  try {
    return workingTree(dir);
  } catch {
    return null;
  }
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
    /** The slash commands this session's Claude Code offers, once it has said. @type {SlashCommand[]|null} */
    this.commands = null;
    /** @type {string|null} */
    this.providerId = null;
    /** @type {string|undefined} */
    this.lastStderr = undefined;
    /** Stops a failing check has refused since the person last wrote. */
    this.checkTries = 0;
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
   * @param {{query?: typeof sdkQuery, idleMs?: number, mcp?: (sessionId: string) => import('@anthropic-ai/claude-agent-sdk').McpSdkServerConfigWithInstance}} [o]
   * `query` is replaced in tests. `mcp` makes a session's bench MCP server; the Service
   * hands it in, so this module never needs the Service itself.
   */
  constructor(store, o = {}) {
    super();
    this.store = store;
    this.query = o.query || sdkQuery;
    this.idleMs = o.idleMs ?? IDLE_MS;
    this.mcp = o.mcp || null;
    /** @type {Map<string, Live>} */
    this.live = new Map();
    /** Claude Code's own process, by pid, for the session it is running. Filled by the
     * spawn hook below and cleared when the process exits, so the Dashboard can say
     * which conversation is holding a process rather than guessing from a command line.
     * @type {Map<number, string>} */
    this.claudePids = new Map();
    /** @type {Map<string, {approval: Approval, resolve: (r: PermissionResult) => void, suggestions: any[]}>} */
    this.approvals = new Map();
    /** A task's check in flight, shared by every session that stops while it runs.
     * @type {Map<string, Promise<CheckRun|null>>} */
    this.checks = new Map();
    /** Command lists by working directory, so a session that is not running still has one.
     * @type {Map<string, {at:number, list:SlashCommand[]}>} */
    this.commandCache = new Map();
    /** @type {Map<string, Promise<SlashCommand[]>>} */
    this.commandProbes = new Map();
    store.resetLiveSessions();
    // A check that was running when the server stopped never finished: it was not judged.
    for (const t of store.listTasks()) if (t.check_status === 'running') store.updateTask(t.id, { check_status: null, check_tree: null });
    this.sweepScratch();
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

  /** Adds an entry to a session's transcript from outside a turn: a bench tool's note. @param {string} id @param {string} kind @param {unknown} data */
  record(id, kind, data) {
    return this.#event(id, kind, data);
  }

  isLive(/** @type {string} */ id) {
    return this.live.has(id);
  }

  /** Every running Claude Code process, by pid, for the session it belongs to. @returns {Map<number, string>} */
  pids() {
    return this.claudePids;
  }

  /**
   * The slash commands a session can use, as far as Bench knows without asking: its live
   * process's list, else the last list seen for its folder. Empty when there is neither;
   * listCommands() asks. @param {string} id @returns {SlashCommand[]}
   */
  commands(id) {
    const live = this.live.get(id)?.commands;
    if (live) return live;
    const s = this.store.getSession(id);
    return (s && this.commandCache.get(s.cwd)?.list) || [];
  }

  /**
   * The slash commands a session can use, asking Claude Code when nothing live or recent
   * says. The list depends on the folder (its commands and skills) and on Bench's plugin,
   * not on the conversation, so a session that has never run gets one too.
   * @param {string} id @returns {Promise<SlashCommand[]>}
   */
  async listCommands(id) {
    const s = this.#session(id);
    const live = this.live.get(id)?.commands;
    if (live) return live;
    const cached = this.commandCache.get(s.cwd);
    if (cached && Date.now() - cached.at < COMMANDS_FRESH_MS) return cached.list;
    let probe = this.commandProbes.get(s.cwd);
    if (!probe) {
      probe = this.#probeCommands(s).finally(() => this.commandProbes.delete(s.cwd));
      this.commandProbes.set(s.cwd, probe);
    }
    return probe;
  }

  /**
   * Starts Claude Code in the session's folder with an input that never sends anything,
   * asks for its commands, and closes it. No message means no model call; it takes
   * under a second. @param {Session} s @returns {Promise<SlashCommand[]>}
   */
  async #probeCommands(s) {
    /** @type {() => void} */
    let stop = () => {};
    const idle = (async function* () {
      await new Promise((r) => (stop = () => r(undefined)));
    })();
    let env = { ...cleanEnv(), CLAUDE_AGENT_SDK_CLIENT_APP: 'bench' };
    try {
      const provider = this.store.getProvider(s.provider_id);
      const model = s.model_id ? this.store.getModel(s.model_id) || null : null;
      if (provider) env = { ...env, ...providerEnv(provider, model) };
    } catch {
      /* a provider missing its key still has commands to list */
    }
    /** @type {any} */
    const q = this.query({ prompt: /** @type {any} */ (idle), options: { cwd: s.cwd, env, settingSources: ['project', 'local'], plugins: [{ type: 'local', path: PACK }] } });
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    try {
      const list = commandList(await Promise.race([q.supportedCommands(), new Promise((_, no) => (timer = setTimeout(() => no(new Error('timed out')), COMMANDS_PROBE_MS)))]));
      this.commandCache.set(s.cwd, { at: Date.now(), list });
      return list;
    } catch {
      return this.commandCache.get(s.cwd)?.list || [];
    } finally {
      clearTimeout(timer);
      stop();
      try {
        q.close();
      } catch {
        /* already gone */
      }
    }
  }

  /** A session's process said what its commands are. @param {string} id @param {Live} live @param {any[]} list */
  #setCommands(id, live, list) {
    live.commands = commandList(list);
    const s = this.store.getSession(id);
    if (s) this.commandCache.set(s.cwd, { at: Date.now(), list: live.commands });
    this.emit('commands', { session_id: id, commands: live.commands });
  }

  /** Where a session's attached files are kept. It is opened to the session, so reading them asks nothing. @param {string} id */
  attachmentsDir(id) {
    return path.join(this.store.dir, 'attachments', id);
  }

  /**
   * A session's scratch folder: its TMPDIR, where logs, screenshots and throwaway scripts
   * go instead of /tmp or the project. It lives with the data, not in /tmp, so a big one
   * does not fill a memory-backed /tmp, and it is removed when the session is archived.
   * @param {string} id
   */
  scratchDir(id) {
    return path.join(this.store.dir, 'scratch', id);
  }

  /** Removes a session's scratch folder. @param {string} id */
  dropScratch(id) {
    fs.rmSync(this.scratchDir(id), { recursive: true, force: true });
  }

  /**
   * Removes the scratch folders of sessions that are archived or gone. Archiving removes
   * its own; this catches the rest - a crash between the two, or folders from before.
   */
  sweepScratch() {
    let names = [];
    try {
      names = fs.readdirSync(path.join(this.store.dir, 'scratch'));
    } catch {
      return;
    }
    for (const id of names) {
      const s = this.store.getSession(id);
      if ((!s || s.archived_at) && !this.live.has(id)) this.dropScratch(id);
    }
  }

  /**
   * Saves attached files under the session's attachments folder, and returns the lines
   * that tell Claude where they are. Claude reads them with its own Read tool, which
   * handles PDFs and text alike, so a long document costs context only when it is read.
   * @param {string} id @param {{name:string, media_type?:string, data:string}[]} files
   */
  #saveFiles(id, files) {
    const dir = this.attachmentsDir(id);
    fs.mkdirSync(dir, { recursive: true });
    let total = 0;
    return files.map((f) => {
      const bytes = Buffer.from(f.data, 'base64');
      if (bytes.length > MAX_FILE) throw Object.assign(new Error(`${f.name} is over ${MAX_FILE / 1024 / 1024} MB`), { status: 413 });
      total += bytes.length;
      if (total > MAX_FILES) throw Object.assign(new Error(`Attachments over ${MAX_FILES / 1024 / 1024} MB in one message`), { status: 413 });
      const safe = safeName(f.name);
      const file = path.join(dir, `${Date.now().toString(36)}-${safe}`);
      fs.writeFileSync(file, bytes);
      return { name: safe, path: file, size: bytes.length, type: f.media_type || '' };
    });
  }

  /**
   * Streams one uploaded file into the session's attachments folder. The message that
   * names it comes later, in send()'s `uploads`, by the `file` returned here.
   * @param {string} id @param {string} name @param {string} type @param {NodeJS.ReadableStream} body
   * @returns {Promise<{file:string, name:string, size:number, type:string}>}
   */
  async receiveFile(id, name, type, body) {
    const s = this.#session(id);
    if (s.archived_at) throw Object.assign(new Error('This session is archived'), { status: 409 });
    const dir = this.attachmentsDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const safe = safeName(name);
    const file = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${safe}`;
    const full = path.join(dir, file);
    let size = 0;
    const limit = new Transform({
      transform(chunk, _enc, done) {
        size += chunk.length;
        if (size > MAX_UPLOAD) done(Object.assign(new Error(`${safe} is over ${MAX_UPLOAD / 1024 / 1024} MB`), { status: 413 }));
        else done(null, chunk);
      },
    });
    try {
      await pipeline(body, limit, fs.createWriteStream(full));
    } catch (e) {
      fs.rmSync(full, { force: true });
      throw e;
    }
    if (!size) {
      fs.rmSync(full, { force: true });
      throw Object.assign(new Error(`${safe} is empty`), { status: 400 });
    }
    return { file, name: safe, size, type: String(type || '').slice(0, 120) };
  }

  /**
   * Files received by receiveFile(), named by the `file` it returned. Only names in the
   * session's own attachments folder are accepted.
   * @param {string} id @param {{file:string, type?:string}[]} uploads
   */
  #uploaded(id, uploads) {
    const dir = this.attachmentsDir(id);
    return uploads.map((u) => {
      const file = String(u?.file || '');
      const full = path.join(dir, file);
      if (!file || path.basename(file) !== file || !fs.existsSync(full)) throw Object.assign(new Error('An attached file is missing; attach it again'), { status: 400 });
      return { name: file.replace(/^[a-z0-9]+-[a-z0-9]{1,4}-/, ''), path: full, size: fs.statSync(full).size, type: String(u.type || '') };
    });
  }

  /**
   * One message from the person. Starts or resumes the session's query when none is open.
   * Images go inline; any other file is saved and named in the message.
   * @param {string} id @param {string} text
   * @param {{images?: {media_type:string, data:string}[], files?: {name:string, media_type?:string, data:string}[], uploads?: {file:string, type?:string}[]}} [o]
   */
  send(id, text, o = {}) {
    const s = this.#session(id);
    if (s.archived_at) throw new Error('This session is archived');
    const images = o.images || [];
    const saved = [...(o.uploads?.length ? this.#uploaded(id, o.uploads) : []), ...(o.files?.length ? this.#saveFiles(id, o.files) : [])];
    if (!text.trim() && !images.length && !saved.length) throw new Error('Nothing to send');
    const note = saved.length ? `\n\nAttached file${saved.length === 1 ? '' : 's'} (read ${saved.length === 1 ? 'it' : 'them'} as needed):\n${saved.map((f) => `- ${f.path}`).join('\n')}` : '';
    const archive = saved.some((f) => /\.(apk|aab|apks|xapk|ipa|jar|aar|zip)$/i.test(f.name));
    const hint = archive ? '\n(An .apk, .aab, .ipa, .jar or .zip is a zip archive: inspect it with Bash - unzip -l, unzip -p, aapt or apkanalyzer where installed - rather than Read.)' : '';
    const body = `${text}${note}${hint}`.trim();
    const live = this.live.get(id) || this.#start(s);
    live.checkTries = 0;
    /** @type {any[]} */
    const content = [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })), ...(body ? [{ type: 'text', text: body }] : [])];
    live.push({ type: 'user', message: { role: 'user', content: images.length ? content : body }, parent_tool_use_id: null });
    live.turns++;
    live.lastUsed = Date.now();
    this.#event(id, 'user', { text, images: images.length, files: saved.map(({ name, size, type }) => ({ name, size, type })) });
    const first = !s.claude_session_id && this.store.listEvents(id, { limit: 2 }).length === 1;
    const title = text.trim() ? titleFrom(text) : saved.length ? titleFrom(saved.map((f) => f.name).join(', ')) : null;
    this.#update(id, { status: this.#pendingFor(id) ? 'waiting' : 'running', error: null, ...(first && title && /^New (session|task)/.test(s.title) ? { title } : {}) });
  }

  /** @param {Session} s */
  #start(s) {
    const provider = this.store.getProvider(s.provider_id);
    if (!provider) throw new Error(`Provider ${s.provider_id} is gone; pick another`);
    const model = s.model_id ? this.store.getModel(s.model_id) || null : null;
    const project = this.store.getProject(s.project_id);
    const scratch = this.scratchDir(s.id);
    fs.mkdirSync(scratch, { recursive: true });
    const env = { ...cleanEnv(), ...providerEnv(provider, model), TMPDIR: scratch, TMP: scratch, TEMP: scratch, CLAUDE_AGENT_SDK_CLIENT_APP: 'bench' };
    const instructions = [userInstructions(), scratchNote(scratch), this.#taskBrief(s)].filter(Boolean).join('\n\n') || null;
    const memory = project && path.resolve(project.path) !== path.resolve(s.cwd) ? memoryDir(project.path) : null;
    fs.mkdirSync(this.attachmentsDir(s.id), { recursive: true });
    const live = new Live(s.id);
    live.providerId = provider.id;
    this.live.set(s.id, live);
    /** @type {import('@anthropic-ai/claude-agent-sdk').Options} */
    const options = {
      cwd: s.cwd,
      additionalDirectories: [this.attachmentsDir(s.id), scratch],
      env,
      settingSources: ['project', 'local'],
      plugins: [{ type: 'local', path: PACK }],
      permissionMode: /** @type {PermissionMode} */ (s.permission_mode),
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      // After each turn the model predicts what a person would type next; the dashboard
      // offers it as the first quick reply.
      promptSuggestions: true,
      canUseTool: (tool, input, opts) => this.#ask(s.id, tool, input, opts),
      // Bench's own tools, acting on this session's task and project. In-process: no
      // port, nothing to log in to, nothing exposed.
      ...(this.mcp ? { mcpServers: { bench: this.mcp(s.id) } } : {}),
      // A task session may not stop on a failing check: Bench runs it, and a failure goes
      // back to the model as the reason it has to keep going. A reviewer only reads and
      // reports, so the check does not hold it.
      ...(s.task_id && s.purpose !== 'review' ? { hooks: { Stop: [{ hooks: [(input, _id, { signal }) => this.#onStop(s.id, /** @type {any} */ (input), signal)], timeout: CHECK_TIMEOUT_MS / 1000 + 60 }] } } : {}),
      ...(model ? { model: invocationId(model) } : {}),
      ...(s.effort ? { effort: /** @type {any} */ (s.effort) } : {}),
      ...(s.claude_session_id ? { resume: s.claude_session_id } : {}),
      ...(instructions ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions } } : {}),
      ...(memory ? { settings: { autoMemoryDirectory: memory } } : {}),
      stderr: (/** @type {string} */ line) => {
        if (/error/i.test(line)) live.lastStderr = line.slice(0, 2000);
      },
      // Claude Code's process is spawned by the SDK, which by default does not say what
      // it started. This is the hook that hands it back, and it is what lets the
      // Dashboard name the conversation holding a process instead of reading argv. The
      // child is spawned exactly as the SDK would have - same command, args, cwd, env
      // and signal, with piped stdio - so nothing about the run changes but the record
      // of the pid.
      spawnClaudeCodeProcess: (/** @type {import('@anthropic-ai/claude-agent-sdk').SpawnOptions} */ spawnOptions) => {
        const child = spawn(spawnOptions.command, spawnOptions.args, {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          signal: spawnOptions.signal,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (child.pid) this.claudePids.set(child.pid, s.id);
        const forget = () => {
          if (child.pid) this.claudePids.delete(child.pid);
        };
        child.on('exit', forget);
        child.on('error', forget);
        return child;
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
        // The init message names the commands; supportedCommands() describes them.
        live.q.supportedCommands?.().then((/** @type {any[]} */ list) => !live.closed && this.#setCommands(id, live, list)).catch(() => {});
        const s = this.store.getSession(id);
        if (s && s.claude_session_id !== m.session_id) this.#update(id, { claude_session_id: m.session_id });
        this.#event(id, 'init', { model: m.model, permissionMode: m.permissionMode, cwd: m.cwd, version: m.claude_code_version });
        // A plugin that fails to load is otherwise silent: its skills are just missing.
        for (const e of m.plugin_errors || []) this.#event(id, 'notice', { text: `Plugin ${e.plugin} did not load fully: ${e.message}` });
      } else if (m.subtype === 'commands_changed') this.#setCommands(id, live, m.commands);
      else if (m.subtype === 'compact_boundary') this.#event(id, 'notice', { text: 'Context compacted' });
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
    // Bench's own tools: the read-only ones never ask, `log` asks only in the modes that
    // ask about edits, and the rest are put to the person in words rather than a tool id.
    const bench = benchApproval(tool, input, this.store.getSession(id), (taskId) => this.store.getTask(taskId));
    if (bench?.allow) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    return new Promise((resolve) => {
      /** @type {Approval} */
      const approval = {
        id: this.store.id(),
        session_id: id,
        tool,
        input,
        title: bench?.title || opts.title || null,
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

  // -- the task's check -------------------------------------------------------------

  /**
   * What a task's sessions are told about its bar for done, so they know it from the
   * start rather than finding out when a stop is refused. @param {Session} s
   */
  #taskBrief(s) {
    const t = s.task_id ? this.store.getTask(s.task_id) : null;
    if (!t || (!t.done && !t.check_command) || s.purpose === 'review') return null;
    return [
      "# This task's bar for done",
      t.done ? `Done means: ${t.done}` : null,
      t.check_command ? `When you stop, Bench runs \`${t.check_command}\` in this worktree. If it fails you are handed its output and sent back to work, so run it yourself before you stop.` : null,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * The Stop hook. A check that ran fresh and failed refuses the stop, up to CHECK_TRIES
   * times per message from the person. A result Bench already had - nothing changed since
   * it ran - never refuses one: the model was not asked to change anything, or changed
   * nothing, and sending it round again would be a loop.
   * @param {string} id @param {{background_tasks?:unknown[]}} input @param {AbortSignal} signal
   * @returns {Promise<import('@anthropic-ai/claude-agent-sdk').HookJSONOutput>}
   */
  async #onStop(id, input, signal) {
    const s = this.store.getSession(id);
    const live = this.live.get(id);
    // Work still running in the background will wake the session again; check then.
    if (!s?.task_id || !live || input.background_tasks?.length) return {};
    const r = await this.check(s.task_id, { sessionId: id, signal });
    if (!r || r.ok || !r.fresh) return {};
    const t = /** @type {Task} */ (this.store.getTask(s.task_id));
    live.checkTries++;
    if (live.checkTries > CHECK_TRIES) {
      this.#event(id, 'notice', { text: `The check still fails after ${CHECK_TRIES} tries. Stopping here so you can look.` });
      return {};
    }
    const how = r.timedOut ? 'timed out' : `failed (exit ${r.code})`;
    return {
      decision: 'block',
      reason:
        `Bench ran this task's check, \`${t.check_command}\`, and it ${how}. The end of its output:\n\n${r.output || '(no output)'}\n\n` +
        (t.done ? `Done means: ${t.done}\n\n` : '') +
        `Fix what it shows, run the check yourself, and stop once it passes. If it cannot pass for a reason outside this task, say why and stop. (Try ${live.checkTries} of ${CHECK_TRIES}.)`,
    };
  }

  /**
   * Runs a task's check in its worktree and records the result on the task. Skipped when
   * the working tree is the one the last run already judged, unless `force`. A run already
   * going for the same task is shared rather than started twice.
   * @param {string} taskId
   * @param {{sessionId?:string, signal?:AbortSignal, force?:boolean}} [o]
   * @returns {Promise<CheckRun|null>} null when there is nothing to run
   */
  async check(taskId, o = {}) {
    const t = this.store.getTask(taskId);
    if (!t || t.state !== 'active' || !t.check_command || !fs.existsSync(t.worktree)) return null;
    const tree = treeOf(t.worktree);
    if (!o.force && tree && tree === t.check_tree && (t.check_status === 'passed' || t.check_status === 'failed')) {
      return { ok: t.check_status === 'passed', code: null, output: t.check_output || '', ms: 0, timedOut: false, fresh: false };
    }
    const going = this.checks.get(taskId);
    if (going) return going;
    const run = (async () => {
      this.#taskUpdate(taskId, { check_status: 'running' });
      const r = await runCheck(/** @type {string} */ (t.check_command), t.worktree, { env: cleanEnv(), signal: o.signal });
      if (o.signal?.aborted) {
        // Stopped by the person, not judged: the next stop runs it again.
        this.#taskUpdate(taskId, { check_status: null, check_tree: null });
        return null;
      }
      // The tree after the run, so files the check itself writes do not make the next
      // stop look like a change.
      this.#taskUpdate(taskId, { check_status: r.ok ? 'passed' : 'failed', check_tree: treeOf(t.worktree), check_output: r.output, check_at: new Date().toISOString() });
      if (o.sessionId) this.#event(o.sessionId, 'check', { command: t.check_command, ok: r.ok, code: r.code, output: r.output, ms: r.ms, timedOut: r.timedOut });
      return { ...r, fresh: true };
    })();
    this.checks.set(taskId, run);
    try {
      return await run;
    } finally {
      this.checks.delete(taskId);
    }
  }

  /** @param {string} id @param {Partial<Task>} patch */
  #taskUpdate(id, patch) {
    this.emit('task', this.store.updateTask(id, patch));
  }

  /** A turn is in flight, or an approval is waiting on a person. @param {string} id */
  busy(id) {
    const live = this.live.get(id);
    return !!live && (live.turns > 0 || !!this.#pendingFor(id));
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
    this.sweepScratch();
  }

  shutdown() {
    clearInterval(this.reaper);
    for (const id of [...this.live.keys()]) this.close(id);
  }
}
