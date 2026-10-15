// @ts-check
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { git, revParse } from './git.mjs';

// Updating Bench from its own Settings page: re-running `bin/install --service` in the
// checkout the running release was installed from.
//
// The install ends by restarting the service, and the server is what starts it, so the
// installer must not die with the server. On Linux, systemd stops every process in a
// unit's cgroup when it restarts the unit, a detached child included; `systemd-run
// --scope` moves the installer, and the clean-up pass it leaves running, into a scope
// of its own. On macOS, launchd stops the job's process group, and a detached child
// has a group of its own.

// The line the wrapper appends when the installer exits, so the log says how it ended
// even when nobody was watching.
const DONE = /^bench-update: exit (\d+)$/m;
// A log younger than this with no exit line is an update still running.
const RUNNING_MS = 10 * 60 * 1000;

/**
 * @typedef {{source: string, commit: string|null, dirty: boolean, installedAt: string}} ReleaseInfo
 * @typedef {{
 *   installed: ReleaseInfo|null,
 *   source: string|null,
 *   sourceCommit: string|null,
 *   sourceDirty: boolean,
 *   newer: number|null,
 *   canUpdate: boolean,
 *   reason: string|null,
 *   last: {running: boolean, exit: number|null, at: string, tail: string}|null,
 * }} UpdateStatus
 */

/** What `bin/install` wrote into the running release. @param {string} appRoot @returns {ReleaseInfo|null} */
export function releaseInfo(appRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appRoot, '.bench-release.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** @param {string} logFile */
function lastRun(logFile) {
  let text;
  let at;
  try {
    text = fs.readFileSync(logFile, 'utf8');
    at = fs.statSync(logFile).mtime;
  } catch {
    return null;
  }
  const m = DONE.exec(text);
  return {
    running: !m && Date.now() - at.getTime() < RUNNING_MS,
    exit: m ? Number(m[1]) : null,
    at: at.toISOString(),
    tail: text.replace(DONE, '').trimEnd().split('\n').slice(-30).join('\n'),
  };
}

/**
 * Where the running release came from, what the checkout holds now, and whether an
 * update can run from here.
 * @param {{appRoot: string, logFile: string, supervised: string|null, systemdRun?: boolean}} o
 * @returns {UpdateStatus}
 */
export function updateStatus(o) {
  const { appRoot, logFile, supervised } = o;
  const installed = releaseInfo(appRoot);
  const last = lastRun(logFile);
  /** @type {UpdateStatus} */
  const out = { installed, source: installed?.source || null, sourceCommit: null, sourceDirty: false, newer: null, canUpdate: false, reason: null, last };
  if (!installed) {
    out.reason = fs.existsSync(path.join(appRoot, '.git'))
      ? 'Bench is running from its checkout, not an installed copy, so there is nothing to update: restart it to run the latest code.'
      : 'This copy was installed before Bench recorded where it came from. Run bin/install --service once in the checkout; after that, Update works from here.';
    return out;
  }
  const src = installed.source;
  if (!fs.existsSync(path.join(src, 'bin', 'install'))) {
    out.reason = `The checkout it was installed from, ${src}, is gone or no longer has bin/install.`;
    return out;
  }
  try {
    out.sourceCommit = revParse(src);
    out.sourceDirty = !!git(src, ['status', '--porcelain']).trim();
    if (installed.commit && out.sourceCommit) out.newer = Number(git(src, ['rev-list', '--count', `${installed.commit}..${out.sourceCommit}`]));
  } catch {
    /* a checkout git cannot read is still one bin/install can copy */
  }
  if (!supervised) out.reason = 'Not running as a service, so nothing would start the updated server. Run bin/install --service on the machine.';
  else if (process.platform === 'linux' && !(o.systemdRun ?? hasSystemdRun())) out.reason = 'systemd-run is not available, so the installer could not outlive the restart.';
  else if (last?.running) out.reason = 'An update is already running.';
  out.canUpdate = !out.reason;
  return out;
}

let systemdRun = /** @type {boolean|null} */ (null);
function hasSystemdRun() {
  if (systemdRun === null) systemdRun = spawnSync('systemd-run', ['--version'], { stdio: 'ignore' }).status === 0;
  return systemdRun;
}

/**
 * Starts `bin/install --service` in the checkout, out of reach of the restart it ends
 * with, writing everything it prints to `logFile`. Returns at once; the server is
 * restarted by the installer, a few seconds to a minute later.
 * @param {{appRoot: string, logFile: string, dataRoot: string, supervised: string|null, systemdRun?: boolean, spawn?: (cmd: string, args: string[], opts: object) => import('node:child_process').ChildProcess}} o
 */
export function startUpdate(o) {
  const st = updateStatus(o);
  if (!st.canUpdate || !st.source) throw Object.assign(new Error(st.reason || 'Cannot update from here'), { status: 409 });
  fs.mkdirSync(path.dirname(o.logFile), { recursive: true });
  fs.writeFileSync(o.logFile, `Updating Bench from ${st.source} at ${new Date().toISOString()}\n`);
  // Paths go in as arguments, never into the script text. BENCH_DATA_DIR keeps the
  // installer on this server's data folder; PORT and the rest of the service's settings
  // are in the environment it inherits.
  const script = 'cd "$1" && BENCH_DATA_DIR="$2" sh bin/install --service >>"$3" 2>&1; echo "bench-update: exit $?" >>"$3"';
  const args = ['-c', script, 'bench-update', st.source, o.dataRoot, o.logFile];
  const spawn = o.spawn || nodeSpawn;
  const [cmd, argv] =
    process.platform === 'linux' ? ['systemd-run', ['--user', '--scope', '--quiet', '--collect', `--unit=bench-update-${Date.now()}`, 'sh', ...args]] : ['sh', args];
  const child = spawn(cmd, argv, { cwd: st.source, detached: true, stdio: 'ignore', env: process.env });
  child.on('error', (e) => fs.appendFileSync(o.logFile, `${e.message}\nbench-update: exit 127\n`));
  child.unref();
  return { started: true, source: st.source, from: st.installed?.commit || null, to: st.sourceCommit };
}
