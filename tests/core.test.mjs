import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Service } from '../src/service.mjs';
import { Store } from '../src/store.mjs';
import { titleFrom } from '../src/runtime.mjs';
import { fakeQuery, calls } from './fake-sdk.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function tmp(name) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `aic-${name}-`));
}

/** A repository with one commit on main and a second branch, `feature`, one commit ahead. */
function repo() {
  const dir = tmp('repo');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'first');
  git(dir, 'branch', 'feature');
  git(dir, 'switch', '-q', 'feature');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'feature\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'feature work');
  git(dir, 'switch', '-q', 'main');
  return dir;
}

function setup() {
  const root = tmp('root');
  process.env.BENCH_WORKTREE_ROOT = path.join(root, 'worktrees');
  const svc = new Service(root, { query: fakeQuery });
  const dir = repo();
  const project = svc.addProject({ path: dir });
  return { svc, dir, project, root };
}

/** Resolves once `fn` is true, checking as the service changes. */
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

test('a task starts from a branch the checkout does not have out, and leaves the checkout alone', () => {
  const { svc, dir, project } = setup();
  const { task, session } = svc.createTask(project.id, { title: 'Fix the thing', baseBranch: 'feature' });
  assert.equal(git(dir, 'branch', '--show-current'), 'main');
  assert.equal(task.base_branch, 'feature');
  assert.ok(fs.existsSync(path.join(task.worktree, 'f.txt')), 'the worktree is cut from feature');
  assert.match(task.branch, /^bench\/fix-the-thing-/);
  assert.equal(session.cwd, task.worktree);
  assert.equal(session.task_id, task.id);
  svc.shutdown();
});

test('a session turn is stored, priced and titled from its first message', async () => {
  const { svc, project } = setup();
  const s = svc.createSession({ projectId: project.id });
  svc.send(s.id, 'hello there\nmore');
  await until(() => svc.session(s.id).status === 'idle' && svc.events(s.id).some((e) => e.kind === 'result'));
  const kinds = svc.events(s.id).map((e) => e.kind);
  assert.deepEqual(kinds, ['user', 'init', 'assistant', 'result']);
  const after = svc.session(s.id);
  assert.equal(after.title, 'hello there');
  assert.ok(after.claude_session_id?.startsWith('claude-'));
  assert.equal(after.cost, 0.01);
  assert.equal(after.output_tokens, 5);
  const opts = calls.at(-1).options;
  assert.deepEqual(opts.settingSources, ['project', 'local'], 'user settings are never loaded');
  assert.equal(opts.env.ANTHROPIC_BASE_URL, undefined);
  svc.shutdown();
});

test('a permission request waits for a person, and their answer decides it', async () => {
  const { svc, project, dir } = setup();
  const s = svc.createSession({ projectId: project.id });
  svc.send(s.id, 'write out.txt hi');
  await until(() => svc.runtime.pending(s.id).length === 1);
  assert.equal(svc.session(s.id).status, 'waiting');
  const [a] = svc.runtime.pending(s.id);
  assert.equal(a.tool, 'Write');
  svc.runtime.answer(a.id, { allow: true });
  await until(() => svc.session(s.id).status === 'idle');
  assert.equal(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8'), 'hi');

  svc.send(s.id, 'write no.txt x');
  await until(() => svc.runtime.pending(s.id).length === 1);
  svc.runtime.answer(svc.runtime.pending(s.id)[0].id, { allow: false, message: 'not that' });
  await until(() => svc.session(s.id).status === 'idle' && svc.events(s.id).at(-2)?.data?.content?.[0]?.text?.startsWith('not allowed'));
  assert.ok(!fs.existsSync(path.join(dir, 'no.txt')));
  assert.equal(svc.events(s.id).at(-2).data.content[0].text, 'not allowed: not that');
  svc.shutdown();
});

test('a question is answered with the chosen labels', async () => {
  const { svc, project } = setup();
  const s = svc.createSession({ projectId: project.id });
  svc.send(s.id, 'ask');
  await until(() => svc.runtime.pending(s.id).length === 1);
  svc.runtime.answer(svc.runtime.pending(s.id)[0].id, { allow: true, answers: { 'Which?': 'B' } });
  await until(() => svc.events(s.id).some((e) => e.kind === 'assistant' && /answered/.test(e.data.content[0].text)));
  assert.match(svc.events(s.id).find((e) => /answered/.test(e.data.content?.[0]?.text || '')).data.content[0].text, /"Which\?":"B"/);
  svc.shutdown();
});

test('mode and model changes reach the live session; a provider change restarts it with resume', async () => {
  const { svc, project } = setup();
  const s = svc.createSession({ projectId: project.id });
  svc.send(s.id, 'hi');
  await until(() => svc.session(s.id).status === 'idle' && svc.runtime.isLive(s.id));
  const live = calls.at(-1);
  await svc.updateSession(s.id, { mode: 'acceptEdits' });
  assert.equal(live.mode, 'acceptEdits');
  await svc.updateSession(s.id, { modelId: 'anthropic:claude-sonnet-5-5' });
  assert.equal(live.model, 'claude-sonnet-5-5');
  // DeepSeek needs a key; with one, the change closes the query.
  process.env.DEEPSEEK_API_KEY = 'k';
  svc.updateProvider('deepseek-claude-code', { enabled: true });
  await svc.updateSession(s.id, { providerId: 'deepseek-claude-code', modelId: 'deepseek:deepseek-flash' });
  assert.equal(live.closed, true);
  svc.send(s.id, 'again');
  await until(() => calls.at(-1) !== live && svc.session(s.id).status === 'idle');
  const next = calls.at(-1).options;
  assert.equal(next.resume, svc.session(s.id).claude_session_id);
  assert.equal(next.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  delete process.env.DEEPSEEK_API_KEY;
  svc.shutdown();
});

test('interrupting a turn ends it and leaves the session idle', async () => {
  const { svc, project } = setup();
  const s = svc.createSession({ projectId: project.id });
  svc.send(s.id, 'slow');
  await until(() => svc.session(s.id).status === 'running' && svc.runtime.isLive(s.id));
  await svc.interrupt(s.id);
  await until(() => svc.session(s.id).status === 'idle');
  svc.shutdown();
});

test("a task's diff includes new files, and merging lands it on a base branch nobody has out", async () => {
  const { svc, dir, project } = setup();
  const { task, session } = svc.createTask(project.id, { title: 'Add b', baseBranch: 'feature' });
  svc.send(session.id, 'write b.txt bee');
  await until(() => svc.runtime.pending(session.id).length === 1);
  svc.runtime.answer(svc.runtime.pending(session.id)[0].id, { allow: true });
  await until(() => svc.session(session.id).status === 'idle');
  const tg = svc.taskGit(task.id);
  assert.deepEqual(tg.dirty, ['b.txt']);
  assert.equal(tg.files, 1);
  assert.match(svc.taskDiff(task.id).diff, /\+bee/);
  assert.equal(tg.canMerge.ok, true);

  const r = svc.mergeTask(task.id, { cleanup: true });
  assert.equal(r.task.state, 'merged');
  assert.equal(git(dir, 'show', 'feature:b.txt'), 'bee');
  assert.equal(git(dir, 'branch', '--show-current'), 'main', 'the checkout did not move');
  assert.ok(!fs.existsSync(task.worktree), 'cleanup removed the worktree');
  assert.ok(svc.session(session.id).archived_at, 'and archived the session');
  assert.throws(() => git(dir, 'rev-parse', '--verify', task.branch));
  svc.shutdown();
});

test('merging into the checked-out branch merges in the checkout, and refuses over local changes it would clobber', () => {
  const { svc, dir, project } = setup();
  const { task } = svc.createTask(project.id, { title: 'Edit a' });
  fs.writeFileSync(path.join(task.worktree, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
  assert.throws(() => svc.mergeTask(task.id), /git refused to merge/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'local edit\n', 'the local change survived');
  git(dir, 'checkout', '--', 'a.txt');
  const r = svc.mergeTask(task.id, { strategy: 'squash' });
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'two\n');
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'Edit a');
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '2', 'squash made one commit');
  assert.equal(r.task.merge_commit, git(dir, 'rev-parse', 'HEAD'));
  svc.shutdown();
});

test('a conflicting base is merged into the task, where the conflict waits to be resolved', () => {
  const { svc, dir, project } = setup();
  const { task } = svc.createTask(project.id, { title: 'Conflict' });
  fs.writeFileSync(path.join(task.worktree, 'a.txt'), 'task\n');
  svc.commitTask(task.id);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'main\n');
  git(dir, 'commit', '-qam', 'main moved');
  const before = svc.taskGit(task.id);
  assert.equal(before.behind, 1);
  assert.equal(before.canMerge.ok, false);
  assert.deepEqual(before.canMerge.conflicts, ['a.txt']);
  const r = svc.updateFromBase(task.id);
  assert.deepEqual(r.conflicts, ['a.txt']);
  assert.deepEqual(svc.taskGit(task.id).conflicted, ['a.txt']);
  assert.throws(() => svc.mergeTask(task.id), /conflicts/i);
  svc.abortTaskMerge(task.id);
  assert.deepEqual(svc.taskGit(task.id).conflicted, []);
  svc.shutdown();
});

test('switching branches refuses over uncommitted work unless it is stashed', () => {
  const { svc, dir, project } = setup();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty\n');
  assert.throws(() => svc.checkout(project.id, { branch: 'feature' }), (e) => e.code === 'DIRTY');
  const r = svc.checkout(project.id, { branch: 'feature', stash: true });
  assert.equal(r.stashed, true);
  assert.equal(git(dir, 'branch', '--show-current'), 'feature');
  assert.match(git(dir, 'stash', 'list'), /switching from main to feature/);
  const st = svc.git(project.id);
  assert.equal(st.branch, 'feature');
  assert.ok(st.branches.some((b) => b.name === 'main' && !b.current));
  svc.shutdown();
});

test('a closed task can be reopened while its branch survives', () => {
  const { svc, project } = setup();
  const { task, session } = svc.createTask(project.id, { title: 'Park it' });
  svc.closeTask(task.id);
  assert.ok(!fs.existsSync(task.worktree));
  assert.throws(() => svc.send(session.id, 'hi'), /no longer active/);
  svc.reopenTask(task.id);
  assert.ok(fs.existsSync(task.worktree));
  assert.equal(svc.session(session.id).archived_at, null);
  svc.shutdown();
});

test('a v1 database is backed up, its pipeline tables renamed, and live task worktrees imported', () => {
  const root = tmp('v1');
  const dir = repo();
  fs.mkdirSync(path.join(root, '.ai-code'));
  const wt = path.join(root, 'old-wt');
  git(dir, 'worktree', 'add', '-q', '-b', 'ai-code/old1', wt, 'main');
  fs.writeFileSync(path.join(wt, 'x.txt'), 'old work\n');
  const db = new DatabaseSync(path.join(root, '.ai-code', 'ai-code.db'));
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,language TEXT,framework TEXT,commands TEXT NOT NULL);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,state TEXT NOT NULL,plan TEXT,context TEXT,review TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,worktree TEXT,branch TEXT,base_commit TEXT,description TEXT,plan_base TEXT);
    CREATE TABLE runs(id TEXT PRIMARY KEY);
    CREATE INDEX runs_idx ON runs(id);
    CREATE TABLE models(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,name TEXT NOT NULL,capabilities TEXT NOT NULL,speed REAL,cost REAL,quality REAL,context_length INTEGER,input_cost_per_mtok REAL,output_cost_per_mtok REAL,cache_read_cost_per_mtok REAL,cache_write_cost_per_mtok REAL,pricing_source TEXT,pricing_updated_at TEXT,billing_mode TEXT,enabled INTEGER DEFAULT 1);`);
  db.prepare("INSERT INTO projects VALUES('p1','demo',?,'2026-01-01',null,null,'{}')").run(dir);
  db.prepare("INSERT INTO tasks(id,project_id,title,state,created_at,updated_at,worktree,branch,base_commit,plan_base) VALUES('t1','p1','Old task','COMPLETE','2026-01-01','2026-01-01',?,'ai-code/old1',?,?)").run(wt, git(dir, 'rev-parse', 'main'), JSON.stringify({ target_branch: 'main' }));
  db.close();

  const svc = new Service(root, { query: fakeQuery });
  const names = svc.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(names.includes('legacy_tasks') && names.includes('legacy_runs'));
  assert.ok(fs.readdirSync(path.join(root, '.bench')).some((f) => f.startsWith('bench.db.pre-v2-')), 'the v1 data moved to .bench and was snapshotted');
  assert.ok(!fs.existsSync(path.join(root, '.ai-code')));
  const t = svc.task('t1');
  assert.equal(t.state, 'active');
  assert.equal(t.base_branch, 'main');
  assert.equal(svc.taskGit('t1').files, 1);
  assert.equal(svc.store.listProviders().length, 4);
  svc.shutdown();
  // A second start finds nothing left to do.
  const again = new Store(root);
  assert.equal(again.getSetting('legacy_import'), 'done');
});

test('titles are cut at a word', () => {
  assert.equal(titleFrom('short'), 'short');
  assert.equal(titleFrom('a '.repeat(50) + 'end'), `${'a '.repeat(30).trim()}…`);
});

test('pairing codes work once and devices can be revoked', () => {
  const store = new Store(tmp('pair'));
  store.addPairing('code1', 60000);
  assert.equal(store.usePairing('nope'), false);
  assert.equal(store.usePairing('code1'), true);
  assert.equal(store.usePairing('code1'), false);
  const d = store.addDevice('Phone', 'tok');
  assert.equal(store.deviceByToken('tok').id, d.id);
  store.revokeDevice(d.id);
  assert.equal(store.deviceByToken('tok'), null);
});

test('attached files are saved where the session can read them, and named in the message', async () => {
  const { svc, project } = setup();
  const s = svc.createSession({ projectId: project.id });
  const pdf = Buffer.from('%PDF-1.4 fake').toString('base64');
  svc.send(s.id, 'summarise these', { files: [{ name: '../../notes.md', media_type: 'text/markdown', data: Buffer.from('# hi').toString('base64') }, { name: 'spec.pdf', media_type: 'application/pdf', data: pdf }] });
  await until(() => svc.session(s.id).status === 'idle');
  const dir = svc.runtime.attachmentsDir(s.id);
  const saved = fs.readdirSync(dir).sort();
  assert.equal(saved.length, 2);
  assert.ok(saved.every((f) => !f.includes('/')), 'a name cannot climb out of the folder');
  assert.ok(saved.some((f) => f.endsWith('-notes.md')));
  assert.equal(fs.readFileSync(path.join(dir, saved.find((f) => f.endsWith('.pdf')))).toString(), '%PDF-1.4 fake');
  assert.deepEqual(calls.at(-1).options.additionalDirectories, [dir]);
  const user = svc.events(s.id).find((e) => e.kind === 'user');
  assert.deepEqual(user.data.files.map((f) => f.name), ['notes.md', 'spec.pdf']);
  assert.equal(user.data.text, 'summarise these', 'the stored message is what the person typed');
  // The fake echoes what it was sent, so the reply shows the paths reached Claude.
  const reply = svc.events(s.id).find((e) => e.kind === 'assistant').data.content[0].text;
  assert.match(reply, new RegExp(`Attached files.*\\n- ${dir}/.*notes\\.md`, 's'));

  assert.throws(() => svc.send(s.id, '', { files: [{ name: 'big.bin', data: Buffer.alloc(21 * 1024 * 1024).toString('base64') }] }), /over 20 MB/);
  svc.deleteSession(s.id);
  assert.ok(!fs.existsSync(dir), 'deleting the session removes its files');
  svc.shutdown();
});
