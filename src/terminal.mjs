import fs from 'node:fs';
import pty from 'node-pty';
import { cleanEnv } from './providers.mjs';

// Interactive shells over a WebSocket: in a task's worktree, in a project's checkout,
// or running `claude --resume` on a session's conversation.
//
// The lifetime rule is the tmux one: a shell is keyed by what it is for and outlives
// the tab that opened it, so a refresh or a phone locking its screen comes back to the
// same shell. A timer started when the last reader leaves stops a shell nobody comes
// back to from living for the rest of the day.

// How long a session with no reader is kept before it is killed. Long enough to
// survive a refresh, a laptop lid, or a second look after lunch; short enough that a
// closed tab does not hold a shell for the life of the server.
const DEFAULT_REAP_MS = 10 * 60 * 1000;

// What a reconnect replays. Bounded because a shell can print without limit - `yes`
// in this terminal must not grow the server's heap until the process dies.
const SCROLLBACK_CHARS = 256 * 1024;

// Shells alive at once. A cap, so a client bug cannot fork-bomb the machine.
const MAX_SESSIONS = 12;

// The environment the shell starts with. The ambient Anthropic routing is stripped for
// the same reason childEnv strips it from an agent run: this shell is where a person
// types `claude` by hand, and an inherited ANTHROPIC_BASE_URL would quietly bill
// whatever endpoint it names instead of their own login.
//
// PORT is deliberately left alone. The agent runs get PORT=0 because a server one of
// them starts must not collide with the dashboard holding the default port, and
// because an agent that could not bind was the thing that once killed the dashboard.
// This is a person's own shell, and hiding their port from them would be a surprise
// rather than a protection.
function shellEnv(extra = {}) {
  const env = { ...cleanEnv(), ...extra };
  // The emulator on the other end is xterm.js, and it is the terminal the shell is
  // actually talking to - so this is a fact about the tty, not a preference. It has to
  // be set rather than inherited: the server may have been started by launchd, where
  // TERM is `dumb` or absent, and a shell that believes that answers in no colour at
  // all.
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  // Shell integrations (Ghostty, iTerm2, etc.) key off TERM_PROGRAM to inject hooks
  // that query the real terminal for colors, cursor shape, etc. xterm.js doesn't
  // answer those queries, so the responses render as visible garbage.
  delete env.TERM_PROGRAM;
  delete env.TERM_PROGRAM_VERSION;
  return env;
}

// The shell to run. $SHELL is the person's own answer, and the fallback is the login
// shell each platform ships - the same one a terminal window would have opened.
function loginShell() {
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

// The tail of what a shell has written, in the chunks it arrived in.
//
// Chunks rather than one string because trimming has to be cheap: `yes` produces
// megabytes a second and a per-chunk concat of the whole buffer would be quadratic.
// Whole chunks are dropped from the front, so the cut never lands inside one - the
// one exception is a single chunk larger than the whole buffer, which is sliced and
// may leave a partial escape sequence at the front of the replay. That costs a
// mangled first line after a reconnect, against a buffer that cannot be bounded any
// other way.
class Scrollback {
  constructor(limit) {
    this.limit = limit;
    this.chunks = [];
    this.size = 0;
  }

  push(chunk) {
    if (chunk.length >= this.limit) {
      this.chunks = [chunk.slice(chunk.length - this.limit)];
      this.size = this.limit;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit) this.size -= this.chunks.shift().length;
  }

  text() {
    return this.chunks.join('');
  }
}

// node-pty 1.1.0 ships its macOS and Linux prebuilds with `spawn-helper` at mode 644,
// and its own post-install script only repairs `build/Release` - so on the prebuild
// path (the one used here, which needs no compiler) every spawn fails with
// `posix_spawnp failed` until the bit is set. Done here rather than in a postinstall
// because it costs one stat on the first spawn, survives an install that ran with
// lifecycle scripts off, and heals a node_modules that was unpacked by hand.
let helperChecked = false;
function ensureSpawnHelper() {
  if (helperChecked) return;
  helperChecked = true;
  const helper = new URL(`../node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`, import.meta.url).pathname;
  try {
    if (!(fs.statSync(helper).mode & 0o111)) fs.chmodSync(helper, 0o755);
  } catch {
    // No prebuild for this platform, or a read-only node_modules: the spawn below
    // reports whatever is actually wrong far better than this can.
  }
}

// One shell and everything attached to it.
export class TerminalSessions {
  constructor(options = {}) {
    this.reapMs = options.reapMs ?? DEFAULT_REAP_MS;
    this.sessions = new Map();
  }

  get size() {
    return this.sessions.size;
  }

  // The session for (task, target), started if there is not one already. A session
  // whose shell has exited is dropped first: reattaching to a dead pty would give the
  // client a terminal that accepts keystrokes and answers none of them.
  // `command` is a shell line run by a login shell in place of an interactive one, so it
  // finds what the person's PATH finds; `env` is laid over the clean environment.
  /** @param {{key:string, cwd:string, command?:string|null, env?:Record<string,string>, cols?:number, rows?:number}} spec */
  open({ key, cwd, command = null, env = {}, cols = 80, rows = 24 }) {
    const existing = this.sessions.get(key);
    if (existing && existing.alive) return existing;
    if (existing) this.#dispose(existing);
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Too many terminals open (${this.sessions.size}); close one first`);
    }

    ensureSpawnHelper();
    const args = command ? ['-l', '-c', command] : ['-l'];
    const file = loginShell();
    const p = pty.spawn(file, args, { name: 'xterm-256color', cwd, cols, rows, env: shellEnv(env) });
    const session = {
      key,
      cwd,
      pty: p,
      cols,
      rows,
      scrollback: new Scrollback(SCROLLBACK_CHARS),
      sockets: new Set(),
      reap: null,
      alive: true,
      exited: null,
    };

    p.onData((d) => {
      session.scrollback.push(d);
      for (const ws of session.sockets) send(ws, d);
    });
    // `exit` is the shell ending, not the session being closed by us - a pty we killed
    // reports its signal here too, and by then the session is already out of the map.
    p.onExit(({ exitCode, signal }) => {
      if (!session.alive) return;
      session.alive = false;
      session.exited = { code: exitCode, signal };
      this.#dispose(session, `shell exited (${exitCode})`);
    });

    this.sessions.set(key, session);
    return session;
  }

  // One reader joins. The replay happens before the socket joins the fan-out, so a
  // chunk produced between the two cannot land ahead of the history it follows.
  attach(session, ws) {
    if (session.reap) {
      clearTimeout(session.reap);
      session.reap = null;
    }
    const history = session.scrollback.text();
    if (history) send(ws, history);
    session.sockets.add(ws);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // a frame this cannot read is a frame it must not act on
      }
      if (msg.type === 'input' && typeof msg.data === 'string') {
        if (session.alive) session.pty.write(msg.data);
      } else if (msg.type === 'resize') {
        this.resize(session, Number(msg.cols), Number(msg.rows));
      }
    });
    // A socket error always ends in a close, and detach belongs to the close alone:
    // doing it in both would start the reap timer twice.
    ws.on('error', () => {});
    ws.on('close', () => this.detach(session, ws));
  }

  // The last reader leaving does not end the shell - that is the whole point of the
  // session - it starts the clock on how long it waits for one to come back.
  detach(session, ws) {
    session.sockets.delete(ws);
    if (session.sockets.size || !session.alive || session.reap) return;
    session.reap = setTimeout(() => this.#dispose(session, 'terminal timed out'), this.reapMs);
    // Unref'd so a shell waiting out its ten minutes never holds up a process exit.
    // The timer still fires; it just is not a reason for the event loop to stay up.
    session.reap.unref?.();
  }

  resize(session, cols, rows) {
    if (!session.alive || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
    const c = Math.max(2, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    // Only when it changed: a redraw costs the shell a SIGWINCH, and the browser's
    // observer fires on every frame of a window drag.
    if (c === session.cols && r === session.rows) return;
    session.cols = c;
    session.rows = r;
    try {
      session.pty.resize(c, r);
    } catch {
      // A pty that died between the check and the call: its exit handler is already
      // closing this session out.
    }
  }

  killAll() {
    for (const session of [...this.sessions.values()]) this.#dispose(session, 'server shutting down');
  }

  // The one place a session ends, so there is one place that has to remember every
  // thing ending means: the timer is cancelled, the map is cleared, the readers are
  // told, and the process is killed.
  //
  // Sockets are closed rather than dropped. A client left holding an open socket with
  // no shell behind it looks connected, and a terminal that looks connected and
  // answers nothing is worse than one that says it ended. 1000 is the code that says
  // the shell itself ended, which the client reads as "do not reconnect": retrying a
  // command that exits immediately would spawn a shell every two seconds forever.
  #dispose(session, reason = 'terminal closed') {
    if (session.reap) {
      clearTimeout(session.reap);
      session.reap = null;
    }
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
    for (const ws of session.sockets) {
      try {
        ws.close(session.exited ? 1000 : 1001, reason);
      } catch {
        // Already closing or gone; nothing to tell.
      }
    }
    session.sockets.clear();
    if (session.alive) {
      session.alive = false;
      try {
        session.pty.kill();
      } catch {
        // Already dead, which is what was wanted.
      }
    }
  }
}

// PTY output is sent as the raw text it is rather than wrapped in JSON: it is the
// hot path of this protocol, it can arrive in hundred-kilobyte chunks, and every
// client writes it straight into an emulator. The control channel runs the other way,
// where the volumes are keystrokes.
function send(ws, data) {
  if (ws.readyState !== 1) return;
  try {
    ws.send(data);
  } catch {
    // A socket that failed mid-send is closed by the runtime; its close handler is
    // what removes it from the fan-out.
  }
}
