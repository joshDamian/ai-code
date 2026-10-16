import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmp } from './tmp.mjs';
import { Store } from '../src/store.mjs';

// The `bench` commands that act through the running server, run as a person would run
// them, against a server on the scripted fake SDK.

const cwd = new URL('..', import.meta.url).pathname;
const root = tmp('cli');
let child;
let port;

before(async () => {
  child = spawn(process.execPath, ['src/server.mjs'], {
    cwd,
    env: { ...process.env, PORT: '0', BENCH_ROOT: root, BENCH_FAKE_SDK: '1', BENCH_SERVICE: '', AI_CODE_SERVICE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  port = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /localhost:(\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
});

after(() => child?.kill());

/** Runs the CLI and collects what it printed. @param {string[]} args @param {{port?: number}} [o] */
function bench(args, o = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['src/cli.mjs', ...args], {
      cwd,
      env: { ...process.env, PORT: String(o.port ?? port), BENCH_ROOT: root, BENCH_PROVIDER: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** @param {string} method @param {string} p @param {unknown} [body] */
async function api(method, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  return json;
}

let project;
let first;
let second;

test('setup: a project with two tasks, whose check passes when ok.txt exists', async () => {
  const dir = tmp('repo');
  fs.writeFileSync(path.join(dir, 'README'), 'hi');
  project = await api('POST', '/api/projects', { path: dir, name: 'demo', init: true });
  first = (await api('POST', '/api/tasks', { projectId: project.id, title: 'First task', check: 'test -f ok.txt && echo all good || { echo ok.txt is missing; exit 3; }', done: 'ok.txt exists' })).task;
  second = (await api('POST', '/api/tasks', { projectId: project.id, title: 'Second task', check: '' })).task;
});

test('tasks lists active tasks newest first, for every project or one', async () => {
  const r = await bench(['tasks']);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], new RegExp(`^${second.id.slice(0, 8)}\\s+active\\s+no check\\s+Second task$`));
  assert.match(lines[1], new RegExp(`^${first.id.slice(0, 8)}\\s+active\\s+unchecked\\s+First task$`));
  assert.equal((await bench(['tasks', 'demo'])).stdout, r.stdout);
  assert.equal((await bench(['tasks', project.id.slice(0, 6)])).stdout, r.stdout);
  const missing = await bench(['tasks', 'nope']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /No project matches nope/);
});

test('--json prints the raw answer', async () => {
  const tasks = JSON.parse((await bench(['tasks', '--json'])).stdout);
  assert.deepEqual(tasks.map((t) => t.id), [second.id, first.id]);
  const detail = JSON.parse((await bench(['task', first.id.slice(0, 5), '--json'])).stdout);
  assert.equal(detail.task.id, first.id);
  assert.equal(detail.git.ahead, 0);
  assert.equal(detail.sessions.length, 1);
  const sessions = JSON.parse((await bench(['sessions', '--json'])).stdout);
  assert.equal(sessions.length, 2);
  const update = JSON.parse((await bench(['update', '--json'])).stdout);
  assert.equal(update.canUpdate, false);
});

test('task shows branch, worktree, the bar for done and the sessions', async () => {
  const r = await bench(['task', first.id.slice(0, 4)]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^First task\n/);
  assert.match(r.stdout, new RegExp(`branch\\s+${first.branch} → ${first.base_branch}`));
  assert.match(r.stdout, new RegExp(`worktree\\s+${first.worktree}\\n`));
  assert.match(r.stdout, /done means\s+ok.txt exists/);
  assert.match(r.stdout, /check\s+test -f ok.txt/);
  assert.match(r.stdout, /last check\s+unchecked/);
  assert.match(r.stdout, /git\s+0 ahead, 0 behind, clean/);
  assert.match(r.stdout, /Sessions:\n\s+[0-9a-f]{8}\s+idle\s+First task/);
});

test('sessions lists short id, status, task and title', async () => {
  const r = await bench(['sessions', 'demo']);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], new RegExp(`^[0-9a-f]{8}\\s+idle\\s+task ${second.id.slice(0, 8)}\\s+Second task$`));
});

test('an id shorter than 4 characters, unknown or ambiguous is refused', async () => {
  // Two tasks whose ids share a prefix, planted next to the server's own.
  const store = new Store(root);
  for (const id of ['abcd1111-0000-4000-8000-000000000000', 'abcd2222-0000-4000-8000-000000000000']) {
    store.addTask({ id, project_id: project.id, title: `Planted ${id.slice(4, 8)}`, description: null, base_branch: 'main', base_commit: first.base_commit, branch: `planted-${id.slice(4, 8)}`, worktree: path.join(root, 'nowhere', id) });
  }
  store.db.close();
  const ambiguous = await bench(['task', 'abcd']);
  assert.equal(ambiguous.code, 1);
  assert.equal(ambiguous.stdout, '');
  assert.match(ambiguous.stderr, /abcd matches 2 tasks:\n {2}abcd1111 {2}active {2}Planted 1111\n {2}abcd2222 {2}active {2}Planted 2222/);
  const one = await bench(['task', 'abcd2', '--json']);
  assert.equal(JSON.parse(one.stdout).task.title, 'Planted 2222');
  const short = await bench(['task', 'abc']);
  assert.equal(short.code, 1);
  assert.match(short.stderr, /at least 4 characters/);
  const none = await bench(['task', 'ffffffff']);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /No task matches ffffffff/);
  for (const id of ['abcd1111', 'abcd2222']) assert.equal((await bench(['task', 'close', id])).code, 0);
});

test('task check prints the result and exits 1 when it fails', async () => {
  const failed = await bench(['task', 'check', first.id.slice(0, 6)]);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /^Failed: test -f ok.txt/);
  assert.match(failed.stdout, /ok.txt is missing/);
  fs.writeFileSync(path.join(first.worktree, 'ok.txt'), 'yes');
  const passed = await bench(['task', 'check', first.id.slice(0, 6)]);
  assert.equal(passed.code, 0, passed.stderr);
  assert.match(passed.stdout, /^Passed: test -f ok.txt/);
  assert.match(passed.stdout, /all good/);
  assert.match((await bench(['tasks'])).stdout, new RegExp(`${first.id.slice(0, 8)}\\s+active\\s+passed\\s+First task`));
  const json = await bench(['task', 'check', first.id.slice(0, 6), '--json']);
  assert.equal(JSON.parse(json.stdout).check_status, 'passed');
  const noCheck = await bench(['task', 'check', second.id.slice(0, 6)]);
  assert.equal(noCheck.code, 1);
  assert.match(noCheck.stderr, /no check/);
});

test('task loop turns a loop on with caps, shows it, and turns it off', async () => {
  // A check that takes a while, so the loop is still on its first one when the CLI looks.
  const looped = (await api('POST', '/api/tasks', { projectId: project.id, title: 'Looped task', check: 'sleep 5; exit 1', done: 'the thing works' })).task;

  // No check, no loop: there is nothing that would end one.
  const refused = await bench(['task', 'loop', second.id.slice(0, 6)]);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /needs a check/);

  const on = await bench(['task', 'loop', looped.id.slice(0, 6), '--max-attempts', '3', '--max-minutes', '5']);
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stdout, /^Looping [0-9a-f]{8} Looped task: `sleep 5; exit 1` runs when its session goes idle/);
  assert.match(on.stdout, /up to 3 attempts or 5 minutes\./);
  assert.match(on.stdout, /--off` ends it\.\n$/);

  // The caps have to be whole numbers, and the server refuses one no loop may be given.
  const zero = await bench(['task', 'loop', looped.id.slice(0, 6), '--max-attempts', '0']);
  assert.equal(zero.code, 1);
  assert.match(zero.stderr, /whole number/);
  const forever = await bench(['task', 'loop', looped.id.slice(0, 6), '--max-minutes', '100000']);
  assert.equal(forever.code, 1);
  assert.match(forever.stderr, /1 to 1440/);

  const shown = await bench(['task', looped.id.slice(0, 6)]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /loop\s+looping, attempt 0 of 3 \(up to 5 minutes\)/);

  const off = await bench(['task', 'loop', looped.id.slice(0, 6), '--off']);
  assert.equal(off.code, 0, off.stderr);
  assert.match(off.stdout, /^Loop off for [0-9a-f]{8} Looped task\./);
  assert.equal(JSON.parse((await bench(['task', looped.id.slice(0, 6), '--json'])).stdout).task.loop, null);
  assert.match((await bench(['task', looped.id.slice(0, 6)])).stdout, /loop\s+off/);
});

test('task close removes the worktree and hides it from tasks unless --all', async () => {
  const r = await bench(['task', 'close', second.id.slice(0, 6), '--delete-branch']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Closed .* Second task: worktree removed, sessions archived, branch .* deleted\.$/m);
  assert.equal(fs.existsSync(second.worktree), false);
  assert.doesNotMatch((await bench(['tasks'])).stdout, /Second task/);
  assert.match((await bench(['tasks', '--all'])).stdout, new RegExp(`${second.id.slice(0, 8)}\\s+closed\\s+no check\\s+Second task`));
  assert.doesNotMatch((await bench(['sessions'])).stdout, /Second task/);
  const again = await bench(['task', 'close', second.id.slice(0, 6)]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already closed/);
});

test('task merge lands the work and cleans up by default', async () => {
  const r = await bench(['task', 'merge', first.id.slice(0, 6), '--squash', '--message', 'Add ok.txt']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Merged .* First task into .* at [0-9a-f]{7}\. Worktree removed, sessions archived\.$/m);
  assert.equal(fs.existsSync(first.worktree), false);
  assert.equal(fs.readFileSync(path.join(project.path, 'ok.txt'), 'utf8'), 'yes');
  const detail = JSON.parse((await bench(['task', first.id.slice(0, 6), '--json'])).stdout);
  assert.equal(detail.task.state, 'merged');
  assert.ok(detail.sessions.every((s) => s.archived_at));
});

test('update says why it cannot update, and --yes refuses', async () => {
  const r = await bench(['update']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Cannot update: /m);
  const yes = await bench(['update', '--yes']);
  assert.equal(yes.code, 1);
  assert.match(yes.stderr, /^Cannot update: /);
});

test('with no server running, every command says so', async () => {
  const free = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  for (const args of [['tasks'], ['task', 'abcd'], ['sessions'], ['update']]) {
    const r = await bench(args, { port: free });
    assert.equal(r.code, 1, args.join(' '));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, new RegExp(`No server on port ${free}`));
  }
});
