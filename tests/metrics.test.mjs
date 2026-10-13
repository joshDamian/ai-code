import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEtime, parsePs, parseCgroupPath, rows, collect } from '../src/metrics.mjs';

// The Dashboard's numbers: what the parsers make of a machine's answers, and which
// process is attributed to which conversation. Nothing here needs a real VPS - the
// process table and the cgroup files are the parts that vary, so they are the inputs.

test('elapsed time is read in the unit ps actually used', () => {
  assert.equal(parseEtime('03:15'), 195000, 'mm:ss, not hh:mm');
  assert.equal(parseEtime('1:02:03'), 3723000);
  assert.equal(parseEtime('2-03:15:40'), 184540000); // 2d 3h 15m 40s
  assert.equal(parseEtime(''), null);
  assert.equal(parseEtime('00:00'), 0);
  assert.equal(parseEtime('later'), null);
});

test('a ps line is read whole, including a command with spaces', () => {
  const out = parsePs(
    [
      '      1       0  8928  0.0 66-10:26:29 /usr/lib/systemd/systemd --system',
      '    200     100 51200  2.5    00:30:00 /usr/bin/node /app/claude --resume abc',
      '      2       0     0  0.0 66-10:26:29 [kthreadd]',
      '    400     100     0  0.0       00:00 [nope',
      '',
    ].join('\n')
  );
  assert.equal(out.length, 4);
  assert.deepEqual(out[1], { pid: 200, ppid: 100, rssKb: 51200, pcpu: 2.5, etime: '00:30:00', etimeMs: 1800000, command: '/usr/bin/node /app/claude --resume abc' });
  // A kernel thread has a bracketed name and no arguments of its own.
  assert.equal(out[2].command, '[kthreadd]');
});

test('only a cgroup v2 line names a directory this can read', () => {
  assert.equal(parseCgroupPath('0::/user.slice/user-1000.slice/app.slice/bench.service\n'), '/user.slice/user-1000.slice/app.slice/bench.service');
  assert.equal(parseCgroupPath('0::/\n'), '/');
  // cgroup v1 lists controllers, and none of them is the unified hierarchy.
  assert.equal(parseCgroupPath('11:memory:/user.slice\n1:name=systemd:/init.scope\n'), null);
  assert.equal(parseCgroupPath(''), null);
});

// A small machine: the server, a session's Claude Code (200) with a child of its own
// (201), a terminal shell (300), and a stray process (400). The server's pid is the one
// the table is rooted at - for `collect` that is this process, since that is what it
// walks from on a real machine.
const psTable = (root) =>
  [
    `  ${root}   1  10240  0.1 01:00:00 /usr/bin/node /app/src/server.mjs`,
    `  200 ${root}  51200  2.5 00:30:00 /usr/bin/node /usr/lib/claude --resume abc`,
    '  201 200   8192  0.3 00:05:00 bash -c "npm test"',
    `  300 ${root}  20480  0.0 00:10:00 /bin/bash -l`,
    `  400 ${root}   4096  0.0 00:00:30 git status`,
  ].join('\n');

const world = {
  rootPid: 100,
  claudePids: new Map([[200, 'sess-1']]),
  terminals: [{ key: 'task:task-1', pid: 300, cwd: '/work' }],
  sessions: [{ id: 'sess-1', title: 'Fix the toggle', project_id: 'p1', task_id: 't1' }],
  projects: [{ id: 'p1', name: 'bench-src' }],
  tasks: [{ id: 'task-1', project_id: 'p1', title: 'Merge the thing' }],
};

test('a process is attributed to the conversation that started it, children included', () => {
  const out = rows(parsePs(psTable(100)), world);
  const by = (k) => out.find((r) => r.kind === k);
  assert.deepEqual(
    out.map((r) => [r.kind, r.count, r.rssKb]),
    [
      ['claude', 2, 59392], // the child it spawned is the session's too
      ['terminal', 1, 20480],
      ['server', 1, 10240],
      ['other', 1, 4096],
    ]
  );
  assert.equal(by('claude').label, 'Fix the toggle');
  assert.equal(by('claude').sessionId, 'sess-1');
  assert.equal(by('claude').taskId, 't1', 'so the row links to the task, not just the project');
  assert.equal(by('claude').sub, 'bench-src');
  assert.equal(by('claude').pid, 200);
  assert.equal(by('claude').pcpu, 2.8);
  assert.equal(by('claude').etimeMs, 1800000, 'the oldest process in the group is its age');
  assert.equal(by('terminal').label, 'Merge the thing — shell');
  // The server is the root of the walk and is never its own child.
  assert.equal(by('server').pid, 100);
  assert.equal(by('other').label, 'Other Bench processes');
});

test('a process nobody can place is counted, not hidden or guessed at', () => {
  // Same table, but the pid the SDK would have reported was never recorded. The child
  // must not be silently folded into a session it might not belong to.
  const out = rows(parsePs(psTable(100)), { ...world, claudePids: new Map() });
  assert.equal(out.find((r) => r.kind === 'claude'), undefined);
  const other = out.find((r) => r.kind === 'other');
  assert.equal(other.count, 3, '200, 201 and 400 are all unplaced');
  assert.equal(other.rssKb, 51200 + 8192 + 4096, 'the server keeps its own row');
});

test('without a cgroup the memory is summed from the tree and says so', async () => {
  const m = await collect({
    root: '/tmp',
    sessions: world.sessions,
    projects: world.projects,
    tasks: world.tasks,
    claudePids: world.claudePids,
    terminals: world.terminals,
    storageTargets: [],
    cgroupDir: null,
    psOutput: psTable(process.pid),
  });
  assert.equal(m.bench.source, 'rss');
  assert.equal(m.bench.memCurrent, (59392 + 20480 + 10240 + 4096) * 1024);
  assert.equal(m.bench.procs, 4, 'every Bench process but the unplaced ones');
  assert.equal(m.procs.length, 4);
  assert.equal(m.machine.memTotal > 0, true);
  assert.equal(m.storage.entries.length, 0);
  // The snapshot is JSON, which is how it reaches the page.
  assert.equal(JSON.parse(JSON.stringify(m)).procs[0].kind, 'claude');
});
