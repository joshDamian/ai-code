// Temporary folders for tests, all under one folder per test process that is removed
// when the process exits. A run that was killed never reaches its exit handler, so each
// run also removes the folders of earlier runs whose process is gone.
//
// Without this every run left its repositories, worktrees and uploads in /tmp, which on
// a machine where /tmp is memory filled it within days (3 GB by 2026-10-15).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIX = 'bench-test-';
const base = fs.realpathSync(os.tmpdir());

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

for (const name of fs.readdirSync(base)) {
  const pid = Number(/^bench-test-(\d+)-/.exec(name)?.[1]);
  if (pid && pid !== process.pid && !alive(pid)) fs.rmSync(path.join(base, name), { recursive: true, force: true });
}

export const ROOT = fs.mkdtempSync(path.join(base, `${PREFIX}${process.pid}-`));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

/** A new empty folder for one test. @param {string} name */
export const tmp = (name) => fs.mkdtempSync(path.join(ROOT, `${name}-`));
