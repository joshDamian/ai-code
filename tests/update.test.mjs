import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { updateStatus, startUpdate, releaseInfo } from '../src/update.mjs';
import { tmp } from './tmp.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A checkout with a stand-in bin/install, and a release installed from its first commit. */
function setup(install = 'echo installing; exit 0') {
  const src = tmp('checkout');
  git(src, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(src, 'bin'));
  fs.writeFileSync(path.join(src, 'bin', 'install'), `${install}\n`);
  git(src, 'add', '-A');
  git(src, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qm', 'one');
  const first = git(src, 'rev-parse', 'HEAD');
  const app = tmp('release');
  fs.writeFileSync(path.join(app, '.bench-release.json'), JSON.stringify({ source: src, commit: first, dirty: false, installedAt: new Date().toISOString() }));
  const data = tmp('data');
  return { src, app, first, o: { appRoot: app, logFile: path.join(data, '.bench', 'update.log'), dataRoot: data, supervised: 'systemd', systemdRun: true } };
}

/** Runs what startUpdate asks for, minus systemd-run, which a test has no user manager for. */
const run = (cmd, args, opts) => (cmd === 'systemd-run' ? spawn(args[5], args.slice(6), opts) : spawn(cmd, args, opts));

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
}

test('the status says what is installed, what the checkout holds, and how far apart they are', () => {
  const { src, first, o } = setup();
  assert.equal(releaseInfo(o.appRoot).commit, first);
  let st = updateStatus(o);
  assert.equal(st.newer, 0);
  assert.equal(st.canUpdate, true);
  assert.equal(st.sourceDirty, false);
  fs.writeFileSync(path.join(src, 'a.txt'), 'x');
  git(src, 'add', '-A');
  git(src, '-c', 'user.email=t@t', '-c', 'user.name=T', 'commit', '-qm', 'two');
  fs.writeFileSync(path.join(src, 'b.txt'), 'uncommitted');
  st = updateStatus(o);
  assert.equal(st.newer, 1);
  assert.equal(st.sourceCommit, git(src, 'rev-parse', 'HEAD'));
  assert.equal(st.sourceDirty, true, 'uncommitted changes are called out, since the install copies them');
});

test('no update without a service to restart into, without systemd-run, or without a known checkout', () => {
  const { o } = setup();
  assert.match(updateStatus({ ...o, supervised: null }).reason, /Not running as a service/);
  if (process.platform === 'linux') assert.match(updateStatus({ ...o, systemdRun: false }).reason, /systemd-run/);
  const bare = tmp('old-release');
  assert.match(updateStatus({ ...o, appRoot: bare }).reason, /installed before Bench recorded/);
  fs.mkdirSync(path.join(bare, '.git'));
  assert.match(updateStatus({ ...o, appRoot: bare }).reason, /running from its checkout/);
  assert.throws(() => startUpdate({ ...o, supervised: null, spawn: run }), /Not running as a service/);
});

test('an update runs the checkout\'s installer, logs it, and records how it ended', async () => {
  const { src, o } = setup('echo "copying $PWD"; echo "data in $BENCH_DATA_DIR"; exit 3');
  const calls = [];
  const r = startUpdate({ ...o, spawn: (cmd, args, opts) => (calls.push([cmd, args]), run(cmd, args, opts)) });
  assert.equal(r.source, src);
  if (process.platform === 'linux') {
    assert.equal(calls[0][0], 'systemd-run');
    assert.deepEqual(calls[0][1].slice(0, 2), ['--user', '--scope'], 'outside the server cgroup');
  }
  await until(() => updateStatus(o).last?.exit != null);
  const st = updateStatus(o);
  assert.equal(st.last.exit, 3);
  assert.match(st.last.tail, new RegExp(`copying ${src}`));
  assert.match(st.last.tail, new RegExp(`data in ${o.dataRoot}`));
  assert.equal(st.canUpdate, true, 'a finished update does not block the next');
});

test('a second update is refused while one is running', async () => {
  const { o } = setup('sleep 1; exit 0');
  startUpdate({ ...o, spawn: run });
  assert.equal(updateStatus(o).last.running, true);
  assert.throws(() => startUpdate({ ...o, spawn: run }), /already running/);
  await until(() => updateStatus(o).last?.exit === 0);
});
