// @ts-check
import { spawn } from 'node:child_process';

// A task's check: the command that says whether the work is done, run by Bench rather
// than by the model, so "it passes" is something Bench saw and not something it was told.

// Long enough for a real test suite, short enough that a hung one cannot hold a turn open.
export const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
// What a person reads, and what goes back to the model: the end, where failures land.
const OUTPUT_CHARS = 8000;

/** @typedef {{ok:boolean, code:number|null, output:string, ms:number, timedOut:boolean}} CheckResult */

/**
 * Runs `command` through the shell in `cwd`. The command runs in its own process group,
 * so a timeout stops everything it started, a dev server included, and nothing else.
 * @param {string} command @param {string} cwd
 * @param {{env?:NodeJS.ProcessEnv, timeoutMs?:number, signal?:AbortSignal}} [o]
 * @returns {Promise<CheckResult>}
 */
export function runCheck(command, cwd, o = {}) {
  const started = Date.now();
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    let finished = false;
    const child = spawn('sh', ['-c', command], { cwd, env: o.env || process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    /** @param {Buffer} b */
    const take = (b) => {
      out += b.toString('utf8');
      if (out.length > OUTPUT_CHARS * 2) out = out.slice(-OUTPUT_CHARS);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs ?? CHECK_TIMEOUT_MS);
    o.signal?.addEventListener('abort', kill, { once: true });
    // 'error' and 'close' can both arrive for one child; the first one decides.
    const finish = (/** @type {number|null} */ code, /** @type {string} */ extra = '') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', kill);
      // Whatever the command left running in its group goes with it.
      kill();
      const tail = (out + extra).trimEnd();
      const output = tail.length > OUTPUT_CHARS ? `… (earlier output cut)\n${tail.slice(-OUTPUT_CHARS)}` : tail;
      resolve({ ok: code === 0 && !timedOut, code, output: timedOut ? `${output}\n(stopped after ${Math.round((o.timeoutMs ?? CHECK_TIMEOUT_MS) / 1000)}s)` : output, ms: Date.now() - started, timedOut });
    };
    child.on('error', (e) => finish(null, `\n${e.message}`));
    child.on('close', (code) => finish(code));
  });
}
