import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Service } from '../src/service.mjs';
import { Store } from '../src/store.mjs';
import { titleFrom, PACK } from '../src/runtime.mjs';
import { parseEnv, loadEnvFile, addToEnvFile, readEnvFile, envFile } from '../src/env.mjs';
import { fakeQuery, calls, COMMANDS } from './fake-sdk.mjs';
import { slashMatches } from '../web/format.mjs';
import { tmp } from './tmp.mjs';
import { workingTree } from '../src/git.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();


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
  assert.deepEqual(opts.plugins, [{ type: 'local', path: PACK }], "every session gets Bench's own plugin");
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
  assert.equal(next.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, '1', 'a hosted endpoint gets no Anthropic betas');
  assert.equal(live.options.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, undefined, 'the Claude login keeps them');
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

test('a push subscription remembers what each device asked to be woken for', () => {
  const store = new Store(tmp('push'));
  const keys = { p256dh: 'p', auth: 'a' };
  store.addPushSubscription({ endpoint: 'https://push/1', keys });
  assert.equal(store.listPushSubscriptions().length, 1);
  assert.equal(store.listPushSubscriptions()[0].choices, null, 'no answer yet means every alert comes through');
  assert.equal(store.setPushChoices('https://push/1', { approvals: true, finished: false, errors: true }), 1);
  assert.equal(store.listPushSubscriptions()[0].choices, JSON.stringify({ approvals: true, finished: false, errors: true }));
  // Re-subscribing - a rotated key, or the page asking again - keeps the choice it had.
  store.addPushSubscription({ endpoint: 'https://push/1', keys: { p256dh: 'p2', auth: 'a2' } });
  const [row] = store.listPushSubscriptions();
  assert.equal(row.p256dh, 'p2');
  assert.equal(row.choices, JSON.stringify({ approvals: true, finished: false, errors: true }), 'a re-subscribe does not wipe the choice');
  assert.equal(store.setPushChoices('https://push/none', {}), 0, 'an endpoint that was never subscribed has nothing to update');
});

test('attached files are saved where the session can read them, and named in the message', async () => {  const { svc, project } = setup();
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
  assert.deepEqual(calls.at(-1).options.additionalDirectories, [dir, svc.runtime.scratchDir(s.id)]);
  const user = svc.events(s.id).find((e) => e.kind === 'user');
  assert.deepEqual(user.data.files.map((f) => f.name), ['notes.md', 'spec.pdf']);
  assert.equal(user.data.text, 'summarise these', 'the stored message is what the person typed');
  // The fake echoes what it was sent, so the reply shows the paths reached Claude.
  const reply = svc.events(s.id).find((e) => e.kind === 'assistant').data.content[0].text;
  assert.match(reply, new RegExp(`Attached files.*\\n- ${dir}/.*notes\\.md`, 's'));

  assert.throws(() => svc.send(s.id, '', { files: [{ name: 'big.bin', data: Buffer.alloc(61 * 1024 * 1024).toString('base64') }] }), /over 60 MB/);
  svc.deleteSession(s.id);
  assert.ok(!fs.existsSync(dir), 'deleting the session removes its files');
  svc.shutdown();
});

test('a large file is streamed to disk and attached by name, an APK included', async () => {
  const { Readable } = await import('node:stream');
  const { svc, project } = setup();
  const s = svc.createSession({ projectId: project.id });
  // Bigger than the 60 MB a base64 attachment may be.
  const apk = Buffer.alloc(65 * 1024 * 1024, 7);
  const up = await svc.runtime.receiveFile(s.id, '../app-release.apk', 'application/vnd.android.package-archive', Readable.from([apk.subarray(0, 1e6), apk.subarray(1e6)]));
  assert.equal(up.name, 'app-release.apk');
  assert.equal(up.size, apk.length);
  assert.ok(!up.file.includes('/'));
  const dir = svc.runtime.attachmentsDir(s.id);
  assert.equal(fs.statSync(path.join(dir, up.file)).size, apk.length);

  svc.send(s.id, 'what permissions does this ask for?', { uploads: [{ file: up.file, type: up.type }] });
  await until(() => svc.session(s.id).status === 'idle');
  const user = svc.events(s.id).find((e) => e.kind === 'user');
  assert.deepEqual(user.data.files, [{ name: 'app-release.apk', size: apk.length, type: 'application/vnd.android.package-archive' }]);
  const reply = svc.events(s.id).find((e) => e.kind === 'assistant').data.content[0].text;
  assert.match(reply, /app-release\.apk/);
  assert.match(reply, /zip archive/, 'Claude is told how to open an APK');

  assert.throws(() => svc.send(s.id, 'x', { uploads: [{ file: '../../etc/passwd' }] }), /missing/);
  assert.throws(() => svc.send(s.id, 'x', { uploads: [{ file: 'nope.apk' }] }), /missing/);
  await assert.rejects(svc.runtime.receiveFile(s.id, 'empty.bin', '', Readable.from([])), /empty/);
  assert.equal(fs.readdirSync(dir).length, 1, 'a failed upload leaves nothing behind');
  svc.shutdown();
});

test('effort comes from the defaults, reaches the SDK, and a change restarts the session on resume', async () => {
  const { svc, project } = setup();
  assert.equal(svc.defaults().effort, null);
  svc.setDefaults({ effort: 'high' });
  const s = svc.createSession({ projectId: project.id });
  assert.equal(s.effort, 'high');
  svc.send(s.id, 'hi');
  await until(() => svc.session(s.id).status === 'idle');
  const first = calls.at(-1);
  assert.equal(first.options.effort, 'high');

  await svc.updateSession(s.id, { effort: 'max' });
  assert.equal(first.closed, true, 'effort is fixed at spawn, so the process is replaced');
  svc.send(s.id, 'again');
  await until(() => calls.at(-1) !== first && svc.session(s.id).status === 'idle');
  assert.equal(calls.at(-1).options.effort, 'max');
  assert.equal(calls.at(-1).options.resume, svc.session(s.id).claude_session_id);

  await svc.updateSession(s.id, { effort: null });
  assert.equal(svc.session(s.id).effort, null, 'cleared back to the model default');
  await assert.rejects(svc.updateSession(s.id, { effort: 'extreme' }), /Unknown effort/);
  assert.throws(() => svc.setDefaults({ effort: 'extreme' }), /Unknown effort/);
  svc.shutdown();
});

test('a project can be cloned or created into the projects folder, or anywhere chosen', async () => {
  const { svc, dir: source } = setup();
  const home = tmp('projects');
  svc.setDefaults({ projectsDir: path.join(home, 'bench-projects') });
  assert.equal(svc.defaults().projectsDir, path.join(home, 'bench-projects'));

  // Cloned by URL into the default folder, which is made on first use.
  const cloned = await svc.cloneProject({ repo: `file://${source}` });
  assert.equal(cloned.path, fs.realpathSync(path.join(home, 'bench-projects', path.basename(source))));
  assert.equal(git(cloned.path, 'log', '-1', '--format=%s'), 'first');
  assert.ok(git(cloned.path, 'branch', '-r').includes('origin/feature'), 'the remote branches came too');

  // Into a folder of the person's choosing, under a name of their choosing.
  const elsewhere = tmp('elsewhere');
  const named = await svc.cloneProject({ repo: source, dir: elsewhere, name: 'my copy' });
  assert.equal(named.path, fs.realpathSync(path.join(elsewhere, 'my copy')));
  await assert.rejects(svc.cloneProject({ repo: source, dir: elsewhere, name: 'my copy' }), /already exists/);
  await assert.rejects(svc.cloneProject({ repo: '--upload-pack=touch /tmp/x' }), /not a repository/);
  await assert.rejects(svc.cloneProject({ repo: path.join(home, 'nope') }), (e) => e.status === 400);
  assert.ok(!fs.existsSync(path.join(home, 'bench-projects', 'nope')), 'a failed clone leaves nothing behind');

  // A new, empty project.
  const fresh = svc.createProject({ name: 'Fresh idea' });
  assert.equal(fresh.name, 'Fresh idea');
  assert.equal(fresh.path, fs.realpathSync(path.join(home, 'bench-projects', 'Fresh idea')));
  assert.equal(git(fresh.path, 'rev-list', '--count', 'HEAD'), '1', 'it has a first commit to branch from');
  // A name cannot climb out of the folder: it becomes a folder inside it.
  const odd = svc.createProject({ name: '../escape' });
  assert.equal(odd.path, fs.realpathSync(path.join(home, 'bench-projects', 'escape')));
  assert.ok(!fs.existsSync(path.join(home, 'escape')));
  svc.shutdown();
});

test('provider keys are kept in the data folder env file, which the shell environment outranks', () => {
  assert.deepEqual(parseEnv(`# keys\nexport A='x y'\nB="q\\"z"\nC=plain # note\n\nnot a line\n`), { A: 'x y', B: 'q"z', C: 'plain' });

  const root = tmp('envroot');
  assert.deepEqual(readEnvFile(root), {}, 'no file is no keys');
  assert.deepEqual(addToEnvFile(root, { BENCH_T_ONE: 'sk-1', BENCH_T_TWO: 'has "quotes" $x', BENCH_T_EMPTY: '' }), ['BENCH_T_ONE', 'BENCH_T_TWO']);
  assert.deepEqual(addToEnvFile(root, { BENCH_T_ONE: 'changed' }), [], 'a key already in the file is left alone');
  assert.equal(fs.statSync(envFile(root)).mode & 0o777, 0o600);
  assert.deepEqual(readEnvFile(root), { BENCH_T_ONE: 'sk-1', BENCH_T_TWO: 'has "quotes" $x' });

  process.env.BENCH_T_ONE = 'from-shell';
  delete process.env.BENCH_T_TWO;
  try {
    assert.deepEqual(loadEnvFile(root), ['BENCH_T_TWO']);
    assert.equal(process.env.BENCH_T_ONE, 'from-shell');
    assert.equal(process.env.BENCH_T_TWO, 'has "quotes" $x');
  } finally {
    delete process.env.BENCH_T_ONE;
    delete process.env.BENCH_T_TWO;
  }
});

test("Bench's plugin is one Claude Code can load: a named manifest, and skills named for their folders", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PACK, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'bench');
  const skills = fs.readdirSync(path.join(PACK, 'skills'));
  assert.ok(skills.length, 'the pack has skills');
  for (const dir of skills) {
    const text = fs.readFileSync(path.join(PACK, 'skills', dir, 'SKILL.md'), 'utf8');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
    assert.ok(front, `${dir}: SKILL.md starts with frontmatter`);
    assert.match(front, new RegExp(`^name: ${dir}$`, 'm'), `${dir}: its name is its folder`);
    assert.match(front, /^description: .+/m, `${dir}: it has a description`);
  }
});

// -- a task's check ---------------------------------------------------------------------

test('a failing check sends the session back to work, and a pass lets it stop', async () => {
  const { svc, project, root } = setup();
  // Fails the first time it runs and passes after, like a test the model then fixes.
  const marker = path.join(root, 'ran-once');
  const check = `test -f ${marker} || { touch ${marker}; echo "1 test failed"; exit 1; }`;
  const { task, session } = svc.createTask(project.id, { title: 'Fix it', done: 'the export keeps every row', check });
  const opts = calls.at(-1)?.options;
  svc.send(session.id, 'go');
  await until(() => svc.session(session.id).status === 'idle' && svc.events(session.id).some((e) => e.kind === 'result'));
  const live = calls.at(-1);
  assert.match(live.options.systemPrompt.append, /Done means: the export keeps every row/, 'the session is told the bar up front');
  assert.match(live.options.systemPrompt.append, /Bench runs `test -f/);
  assert.equal(live.blocked.length, 1, 'stopped once by the failure');
  assert.match(live.blocked[0], /1 test failed/);
  assert.match(live.blocked[0], /Done means: the export keeps every row/);
  const checks = svc.events(session.id).filter((e) => e.kind === 'check').map((e) => e.data.ok);
  assert.deepEqual(checks, [false, true]);
  assert.equal(svc.task(task.id).check_status, 'passed');
  void opts;
  svc.shutdown();
});

test('a check that keeps failing is let go after three tries, and nothing changed means no rerun', async () => {
  const { svc, project } = setup();
  const { task, session } = svc.createTask(project.id, { title: 'Never passes', check: 'echo nope; exit 3' });
  svc.send(session.id, 'go');
  await until(() => svc.session(session.id).status === 'idle' && svc.events(session.id).some((e) => e.kind === 'result'), 10000);
  assert.equal(calls.at(-1).blocked.length, 3);
  assert.equal(svc.events(session.id).filter((e) => e.kind === 'check').length, 4);
  assert.ok(svc.events(session.id).some((e) => e.kind === 'notice' && /still fails after 3 tries/.test(e.data.text)));
  assert.equal(svc.task(task.id).check_status, 'failed');
  assert.match(svc.task(task.id).check_output, /nope/);

  // A question afterwards changes no file, so the check does not run again.
  const before = svc.events(session.id).filter((e) => e.kind === 'check').length;
  svc.send(session.id, 'what failed?');
  await until(() => svc.events(session.id).filter((e) => e.kind === 'result').length === 2);
  assert.equal(svc.events(session.id).filter((e) => e.kind === 'check').length, before);
  svc.shutdown();
});

test("a task takes its project's check, and changing the bar forgets the old result", async () => {
  const { svc, project } = setup();
  svc.store.updateProject(project.id, { check_command: 'true' });
  assert.equal(svc.project(project.id).check_command, 'true');
  const { task } = svc.createTask(project.id, { title: 'Default check' });
  assert.equal(task.check_command, 'true');
  const none = svc.createTask(project.id, { title: 'No check', check: '' }).task;
  assert.equal(none.check_command, null, 'an empty check means none');

  const ran = await svc.checkTask(task.id);
  assert.equal(ran.check_status, 'passed');
  assert.ok(ran.check_tree);
  const changed = svc.editTask(task.id, { check: 'false' });
  assert.equal(changed.check_command, 'false');
  assert.equal(changed.check_status, null);
  assert.equal((await svc.checkTask(task.id)).check_status, 'failed');
  assert.throws(() => svc.editTask(task.id, { title: ' ' }), /title cannot be empty/);
  svc.store.updateProject(project.id, { check_command: '' });
  assert.equal(svc.project(project.id).check_command, null);
  svc.shutdown();
});

test('a session outside a task has no stop hook', async () => {
  const { svc, project } = setup();
  const s = svc.createSession({ projectId: project.id });
  svc.send(s.id, 'hi');
  await until(() => svc.events(s.id).some((e) => e.kind === 'result'));
  assert.equal(calls.at(-1).options.hooks, undefined);
  svc.shutdown();
});

// -- a session's scratch folder ----------------------------------------------------------

test("a session's temporary files go in its own scratch folder, which archiving removes", async () => {
  const { svc, project } = setup();
  const s = svc.createSession({ projectId: project.id });
  svc.send(s.id, 'hi');
  await until(() => svc.events(s.id).some((e) => e.kind === 'result'));
  const scratch = svc.runtime.scratchDir(s.id);
  const { options } = calls.at(-1);
  assert.equal(options.env.TMPDIR, scratch);
  assert.equal(options.env.TMP, scratch);
  assert.ok(fs.existsSync(scratch), 'made before the session starts');
  assert.ok(options.additionalDirectories.includes(scratch), 'readable and writable without asking');
  assert.match(options.systemPrompt.append, new RegExp(`scratch folder is ${scratch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  fs.writeFileSync(path.join(scratch, 'shot.png'), 'x');
  svc.archiveSession(s.id);
  assert.ok(!fs.existsSync(scratch), 'archiving removes it');
  svc.shutdown();
});

test('closing a task or deleting a session removes the scratch folder too', async () => {
  const { svc, project } = setup();
  const { task, session } = svc.createTask(project.id, { title: 'Scratch', prompt: 'hi' });
  await until(() => svc.events(session.id).some((e) => e.kind === 'result'));
  assert.ok(fs.existsSync(svc.runtime.scratchDir(session.id)));
  svc.closeTask(task.id);
  assert.ok(!fs.existsSync(svc.runtime.scratchDir(session.id)), 'closing the task archived it');

  const s = svc.createSession({ projectId: project.id });
  svc.send(s.id, 'hi');
  await until(() => svc.events(s.id).some((e) => e.kind === 'result'));
  svc.deleteSession(s.id);
  assert.ok(!fs.existsSync(svc.runtime.scratchDir(s.id)));
  svc.shutdown();
});

test("the sweep removes scratch left by sessions that are gone, and keeps a live session's", async () => {
  const { svc, project } = setup();
  const s = svc.createSession({ projectId: project.id });
  svc.send(s.id, 'hi');
  await until(() => svc.events(s.id).some((e) => e.kind === 'result'));
  const orphan = svc.runtime.scratchDir('no-such-session');
  fs.mkdirSync(orphan, { recursive: true });
  svc.runtime.sweepScratch();
  assert.ok(!fs.existsSync(orphan));
  assert.ok(fs.existsSync(svc.runtime.scratchDir(s.id)));
  svc.shutdown();
});

test('a check left running by a stopped server is forgotten on start, not shown as running forever', () => {
  const { svc, project, root } = setup();
  const { task } = svc.createTask(project.id, { title: 'Interrupted', check: 'true' });
  svc.store.updateTask(task.id, { check_status: 'running', check_tree: 'abc' });
  svc.shutdown();
  const again = new Service(root, { query: fakeQuery });
  assert.equal(again.task(task.id).check_status, null);
  assert.equal(again.task(task.id).check_tree, null);
  again.shutdown();
});

test('the working tree id changes with any edit, new file or deletion, and with nothing else', () => {
  const { dir } = setup();
  const g = (cmd) => execFileSync('git', cmd, { cwd: dir });
  const tree = () => workingTree(dir);
  const t0 = tree();
  assert.equal(tree(), t0, 'stable when nothing changed');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  const t1 = tree();
  assert.notEqual(t1, t0);
  g(['add', 'a.txt']);
  assert.equal(tree(), t1, 'staging does not change it');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'n');
  const t2 = tree();
  assert.notEqual(t2, t1);
  fs.rmSync(path.join(dir, 'new.txt'));
  assert.equal(tree(), t1, 'back to the same files, back to the same id');
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), 'a.txt', "the person's own staging is untouched");
});

// -- slash commands -------------------------------------------------------------------------

test('a session that has never run still gets its commands, described, without a message sent', async () => {
  const { svc, project } = setup();
  const s = svc.createSession({ projectId: project.id });
  const before = calls.length;
  const list = await svc.runtime.listCommands(s.id);
  assert.deepEqual(list, COMMANDS);
  const probe = calls.at(-1);
  assert.equal(calls.length, before + 1, 'one probe');
  assert.equal(probe.options.cwd, s.cwd);
  assert.deepEqual(probe.options.plugins, [{ type: 'local', path: PACK }], "it sees Bench's plugin, as a session would");
  assert.equal(probe.closed, true, 'the probe is closed once it has answered');
  assert.equal(svc.events(s.id).length, 0, 'nothing was sent');
  assert.equal(svc.session(s.id).status, 'idle');

  // Asked again, and by a second session in the same folder, the folder's list is reused.
  const other = svc.createSession({ projectId: project.id });
  assert.deepEqual(await svc.runtime.listCommands(s.id), COMMANDS);
  assert.deepEqual(await svc.runtime.listCommands(other.id), COMMANDS);
  assert.deepEqual(svc.runtime.commands(other.id), COMMANDS, 'and known without asking');
  assert.equal(calls.length, before + 1, 'no second probe');
  svc.shutdown();
});

test("a running session's commands come from its own process, and a change is pushed", async () => {
  const { svc, project } = setup();
  const s = svc.createSession({ projectId: project.id });
  /** @type {any[]} */
  const pushed = [];
  svc.runtime.on('commands', (m) => m.session_id === s.id && pushed.push(m.commands));
  svc.send(s.id, 'hi');
  await until(() => pushed.length === 1);
  assert.deepEqual(pushed[0], COMMANDS, 'pushed when the session starts');
  svc.send(s.id, 'new skill');
  await until(() => pushed.length === 2);
  assert.deepEqual(pushed[1].map((c) => c.name), ['compact', 'bench:make-verify', 'deploy']);
  assert.deepEqual((await svc.runtime.listCommands(s.id)).map((c) => c.name), ['compact', 'bench:make-verify', 'deploy']);
  svc.shutdown();
});

test('the composer matches commands by name, after a plugin prefix, then anywhere in the name', () => {
  const cmds = ['compact', 'bench:make-verify', 'verify', 'code-review', 'security-review'].map((name) => ({ name, description: '', argumentHint: '' }));
  const names = (t) => slashMatches(cmds, t).map((c) => c.name);
  assert.deepEqual(names('/'), ['bench:make-verify', 'code-review', 'compact', 'security-review', 'verify']);
  assert.deepEqual(names('/make'), ['bench:make-verify']);
  assert.deepEqual(names('/ver'), ['verify', 'bench:make-verify']);
  assert.deepEqual(names('/review'), ['code-review', 'security-review']);
  assert.deepEqual(names('/compact now'), [], 'a space means the command is chosen');
  assert.deepEqual(names('hello'), []);
});
