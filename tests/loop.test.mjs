import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { Service } from '../src/service.mjs';
import { fakeQuery, calls } from './fake-sdk.mjs';
import { tmp } from './tmp.mjs';

// Loop until done: a task a person marked to loop, fed its failing check between turns.
//
// A loop runs turns back to back with no I/O between them (a check whose answer the tree
// has not changed is answered from the record, and the fake sessions answer at once), so a
// test cannot stand in the middle of one and look around. These tests set up the state a
// loop acts on - a worktree that changes underneath it, a session held open on the person,
// a check still running when the task goes away - and then read the record it leaves.

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function repo() {
  const dir = tmp('repo');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'first');
  return dir;
}

function setup() {
  const root = tmp('loop');
  process.env.BENCH_WORKTREE_ROOT = path.join(root, 'worktrees');
  const svc = new Service(root, { query: fakeQuery });
  const project = svc.addProject({ path: repo() });
  return { svc, project, root };
}

/** Resolves once `fn` is true. A loop runs a turn at a time, so it needs longer than most. */
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

const sent = (svc, id) => svc.events(id).filter((e) => e.kind === 'user').map((e) => e.data.text);
const pauses = (ms = 250) => new Promise((r) => setTimeout(r, ms));

/** A check that fails for a while, so the loop is still running when the test takes it away. */
const SLOW_FAIL = 'sleep 0.3; exit 1';

/**
 * Writes `text` to `file` in `dir` a moment from now, from a process of its own: a turn
 * landing work in the worktree happens while the loop is running, and this is the only way
 * a test can act while it is.
 * @param {string} dir @param {string} file @param {string} text @param {number} ms
 */
function landsIn(dir, file, text, ms = 80) {
  return spawn('sh', ['-c', `sleep ${ms / 1000}; printf '%s\\n' ${JSON.stringify(text)} > ${JSON.stringify(path.join(dir, file))}`], { stdio: 'ignore' });
}

test('a failing check sends the session back to work, and a pass ends the loop', async () => {
  const { svc, project } = setup();
  const { task, session } = svc.createTask(project.id, { title: 'Loop it', check: 'test -f ok.txt', loop: { max_attempts: 100, max_minutes: 30 } });

  // The work lands while the loop is going: the next check it runs sees it.
  landsIn(svc.task(task.id).worktree, 'ok.txt', 'there', 80);

  await until(() => svc.task(task.id).loop?.state === 'done');
  const t = svc.task(task.id);
  assert.ok(t.loop.attempts >= 1, 'the check failed at least once before it passed');
  assert.equal(t.loop.reason, null);
  assert.equal(t.loop.session_id, session.id, 'the loop is bound to the task’s session');
  assert.ok(t.loop.ended_at);

  // What went back: the failure, its output, and which attempt it was.
  const first = sent(svc, session.id).find((x) => x.startsWith('The check still fails'));
  assert.match(first, /`test -f ok\.txt` failed \(exit 1\)/, 'the message says what failed');
  assert.match(first, /Loop attempt 1 of 100/);
  assert.ok(
    svc.events(session.id).some((e) => e.kind === 'loop' && /Loop attempt 1 of 100/.test(e.data.text)),
    'an attempt is a visible line in the transcript'
  );
  assert.ok(
    svc.taskLog(task.id).some((e) => e.kind === 'loop' && /Loop attempt 1 of 100: the check failed \(exit 1\)\. Sent back to work\./.test(e.decision) && /\(no output\)/.test(e.evidence)),
    'and an auditable entry in the task log, with the check result'
  );
  assert.equal(t.check_status, 'passed', 'the loop ended on the check Bench ran');

  // The pass is in the log too, and nothing more is sent.
  assert.ok(
    svc.taskLog(task.id).some((e) => e.kind === 'loop' && /Loop done: the check passed/.test(e.decision)),
    'the log says the loop ended, and why'
  );
  const after = sent(svc, session.id).length;
  await pauses();
  assert.equal(sent(svc, session.id).length, after, 'and the loop is over');
  svc.shutdown();
});

test('a cap is mandatory: at max attempts it stops, asks for a write-up, and records why', async () => {
  const { svc, project } = setup();
  const { task, session } = svc.createTask(project.id, { title: 'Never passes', check: 'echo nope; exit 3', done: 'the export keeps every row', loop: { max_attempts: 2, max_minutes: 30 } });

  await until(() => svc.task(task.id).loop?.state === 'gave-up');
  const t = svc.task(task.id);
  assert.equal(t.loop.attempts, 2, 'exactly the cap, no more');
  assert.match(t.loop.reason, /the check still fails after 2 attempts/);
  assert.equal(svc.taskLog(task.id).filter((e) => e.kind === 'loop' && /Sent back to work/.test(e.decision)).length, 2);

  // The write-up: one more message, in Plan mode, changing nothing.
  const last = sent(svc, session.id).at(-1);
  assert.match(last, /The loop on this task has ended/);
  assert.match(last, /change nothing/);
  assert.match(last, /Done means: the export keeps every row/);
  assert.equal(svc.session(session.id).permission_mode, 'plan', 'the write-up turn is read-only');
  assert.equal(calls.at(-1)?.mode, 'plan', 'and the live session was switched, not just the row');
  assert.ok(
    svc.taskLog(task.id).some((e) => e.kind === 'loop' && /Why it is stuck/.test(e.decision) && /The loop on this task has ended/.test(e.evidence)),
    'what the session said about being stuck is in the task log'
  );

  // Two attempts, one write-up, and then silence.
  const after = sent(svc, session.id).length;
  await pauses();
  assert.equal(sent(svc, session.id).length, after);
  assert.equal(svc.task(task.id).loop.state, 'gave-up');
  svc.shutdown();
});

test('the wall-clock cap ends a loop too, without waiting for the attempt cap', async () => {
  const { svc, project } = setup();
  // Held open on the person's answer, so the loop has not sent anything yet when the clock
  // it was given is already spent.
  const { task, session } = svc.createTask(project.id, { title: 'Slow', check: 'false' });
  svc.send(session.id, 'write a.txt two');
  await until(() => svc.session(session.id).status === 'waiting');
  svc.editTask(task.id, { loop: { max_attempts: 10, max_minutes: 60 } });
  const loop = svc.task(task.id).loop;
  assert.equal(loop.state, 'looping');
  svc.store.updateTask(task.id, { loop: { ...loop, started_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() } });

  svc.runtime.answer(svc.runtime.pending(session.id)[0].id, { allow: false });
  await until(() => svc.task(task.id).loop?.state === 'gave-up');
  const t = svc.task(task.id);
  assert.match(t.loop.reason, /the check still fails after 60 minutes/);
  assert.equal(t.loop.attempts, 0, 'the clock, not the attempts, ended it');
  assert.ok(t.loop.attempts < t.loop.max_attempts);
  svc.shutdown();
});

test('a loop needs a check: it is refused at creation and when turned on', () => {
  const { svc, project } = setup();
  const bare = svc.createTask(project.id, { title: 'No check', check: '' }).task;
  assert.equal(bare.loop, null);
  const noCheck = (fn) => assert.throws(fn, (e) => e.status === 400 && /check/.test(e.message));
  noCheck(() => svc.editTask(bare.id, { loop: {} }));
  noCheck(() => svc.createTask(project.id, { title: 'Loop', check: '', loop: { max_attempts: 3 } }));
  assert.equal(svc.task(bare.id).loop, null, 'the refusal left nothing behind');

  // Caps are checked too, and a loop never gets one it cannot be held to.
  const badCap = (fn) => assert.throws(fn, (e) => e.status === 400 && /whole number/.test(e.message));
  const withCheck = svc.createTask(project.id, { title: 'Has check', check: 'true' }).task;
  badCap(() => svc.editTask(withCheck.id, { loop: { max_attempts: 0 } }));
  badCap(() => svc.editTask(withCheck.id, { loop: { max_attempts: 1000 } }));
  badCap(() => svc.editTask(withCheck.id, { loop: { max_minutes: 99999 } }));
  const off = svc.editTask(withCheck.id, { loop: null });
  assert.equal(off.loop, null, 'turning off a loop that was never on is fine');
  svc.shutdown();
});

test('a loop defaults to ten attempts and two hours, and ends at once when the check passes', async () => {
  const { svc, project } = setup();
  const { task } = svc.createTask(project.id, { title: 'Already done', check: 'true', loop: {} });
  await until(() => svc.task(task.id).loop?.state === 'done');
  const loop = svc.task(task.id).loop;
  assert.equal(loop.max_attempts, 10);
  assert.equal(loop.max_minutes, 120);
  assert.equal(loop.attempts, 0, 'a check that passes first time is sent nothing');
  svc.shutdown();
});

test('turning a loop off stops it, records it, and sends nothing more', async () => {
  const { svc, project } = setup();
  const { task, session } = svc.createTask(project.id, { title: 'Off again', check: 'false' });
  // A loop turned on while the session waits on the person is on, and not yet sending.
  svc.send(session.id, 'write a.txt two');
  await until(() => svc.session(session.id).status === 'waiting');
  svc.editTask(task.id, { loop: { max_attempts: 5 } });
  assert.equal(svc.task(task.id).loop.state, 'looping');

  const off = svc.editTask(task.id, { loop: null });
  assert.equal(off.loop, null, 'off is off: the task carries no loop');
  assert.ok(
    svc.taskLog(task.id).some((e) => e.kind === 'loop' && /Loop stopped: the person turned it off/.test(e.decision)),
    'what it got through stays in the log'
  );

  // The turn it was waiting on ends, and the loop, being off, does nothing with it.
  svc.runtime.answer(svc.runtime.pending(session.id)[0].id, { allow: false });
  await until(() => svc.session(session.id).status === 'idle');
  await pauses(200);
  assert.equal(sent(svc, session.id).filter((x) => x.startsWith('The check still fails')).length, 0, 'no further turns');
  assert.equal(svc.task(task.id).loop, null);
  svc.shutdown();
});

test('a session that errors ends the loop, and says why', async () => {
  const { svc, project } = setup();
  const { task, session } = svc.createTask(project.id, { title: 'Errors', check: 'false' });
  svc.send(session.id, 'write a.txt two');
  await until(() => svc.session(session.id).status === 'waiting');
  svc.editTask(task.id, { loop: { max_attempts: 5 } });
  // The turn that ends in an error is the one already queued behind the person's answer.
  svc.send(session.id, 'fail');
  svc.runtime.answer(svc.runtime.pending(session.id)[0].id, { allow: false });

  await until(() => svc.task(task.id).loop?.state === 'error');
  const loop = svc.task(task.id).loop;
  assert.match(loop.reason, /its session errored/);
  assert.ok(
    svc.taskLog(task.id).some((e) => e.kind === 'loop' && /Loop stopped: its session errored/.test(e.decision) && /error/.test(e.evidence)),
    'the log holds why it stopped'
  );
  // Whatever was in flight when it errored, nothing follows: the loop is over.
  const attempts = loop.attempts;
  const after = sent(svc, session.id).length;
  await pauses(300);
  assert.equal(svc.task(task.id).loop.state, 'error');
  assert.equal(svc.task(task.id).loop.attempts, attempts, 'an errored session is not sent back to work');
  assert.equal(sent(svc, session.id).length, after);
  svc.shutdown();
});

test('a session waiting on the person is left alone', async () => {
  const { svc, project } = setup();
  // 'write' asks permission in the default mode, which holds the turn and the session.
  const { task, session } = svc.createTask(project.id, { title: 'Waiting', check: 'false' });
  svc.send(session.id, 'write a.txt two');
  await until(() => svc.session(session.id).status === 'waiting');

  svc.editTask(task.id, { loop: { max_attempts: 5 } });
  await pauses(150);
  assert.equal(svc.task(task.id).loop.state, 'looping', 'the loop is on and waiting, not sending');
  assert.equal(sent(svc, session.id).filter((x) => x.startsWith('The check still fails')).length, 0, 'not one message while it waits on the person');
  assert.equal(svc.runtime.pending(session.id).length, 1, 'the question is still theirs to answer');

  // Answered, the turn ends, and the loop takes over from there.
  svc.runtime.answer(svc.runtime.pending(session.id)[0].id, { allow: true });
  await until(() => svc.task(task.id).loop?.attempts >= 1);
  assert.ok(sent(svc, session.id).some((x) => x.startsWith('The check still fails')), 'and the check goes back to it');
  svc.shutdown();
});

test('a task that is closed or merged stops looping', async () => {
  const { svc, project } = setup();
  // The task goes away while its first check is still running: the loop never gets a turn.
  const closed = svc.createTask(project.id, { title: 'Closed', check: SLOW_FAIL, loop: { max_attempts: 5 } });
  assert.equal(svc.task(closed.task.id).loop.state, 'looping');
  svc.closeTask(closed.task.id);
  assert.equal(svc.task(closed.task.id).state, 'closed');
  assert.equal(svc.task(closed.task.id).loop.state, 'stopped');
  assert.match(svc.task(closed.task.id).loop.reason, /closed/);
  assert.equal(sent(svc, closed.session.id).length, 0, 'nothing was sent to a task that is gone');

  const merged = svc.createTask(project.id, { title: 'Merged', check: SLOW_FAIL, loop: { max_attempts: 5 } });
  fs.writeFileSync(path.join(merged.task.worktree, 'b.txt'), 'work\n');
  svc.mergeTask(merged.task.id, { cleanup: true });
  assert.equal(svc.task(merged.task.id).state, 'merged');
  assert.equal(svc.task(merged.task.id).loop.state, 'stopped');
  assert.match(svc.task(merged.task.id).loop.reason, /merged/);
  assert.equal(sent(svc, merged.session.id).length, 0);
  svc.shutdown();
});

test('archiving the session a loop feeds stops it', async () => {
  const { svc, project } = setup();
  const { task, session } = svc.createTask(project.id, { title: 'Archived', check: SLOW_FAIL, loop: { max_attempts: 5 } });
  assert.equal(svc.task(task.id).loop.state, 'looping');
  svc.archiveSession(session.id);
  assert.equal(svc.task(task.id).loop.state, 'stopped');
  assert.match(svc.task(task.id).loop.reason, /archived/);
  assert.equal(sent(svc, session.id).length, 0);
  svc.shutdown();
});
