// Task detail: PLAN / EXECUTE / REVIEW / ACTIVITY tabs with contextual actions.
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StatusBadge } from '../components/status.mjs';
import { describeEvent, formatDuration, formatTokens, formatCost } from '../../format.mjs';

const e = React.createElement;

const TABS = [
  { key: '1', id: 'plan', label: 'PLAN' },
  { key: '2', id: 'execute', label: 'EXECUTE' },
  { key: '3', id: 'review', label: 'REVIEW' },
  { key: '4', id: 'activity', label: 'ACTIVITY' },
];


// $EDITOR, or vi when it is unset. Split on whitespace so values like
// `code --wait` carry their flags.
function editorCommand() {
  const [command, ...args] = (process.env.EDITOR || 'vi').split(/\s+/);
  return { command, args };
}

// A full-screen editor restores the screen on exit; a line-based one may leave
// it scrolled. Clearing first puts the render that follows `setEditing(false)`
// — a different frame from the editing one, so Ink cannot dedupe it away — at
// the top of an empty screen rather than on top of the editor's leftovers. The
// cursor is hidden again because Ink only hides it once, at mount.
function repaint() {
  process.stdout.write('\u001B[2J\u001B[3J\u001B[H\u001B[?25l');
}

function wrap(text, width = 90) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > width) {
      let cut = rest.lastIndexOf(' ', width);
      if (cut <= 0) cut = width;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    out.push(rest);
  }
  return out;
}

export function TaskDetailScreen({ api, taskId, isActive, onBack, setTyping, onError, onMessage, setFooter }) {
  const [task, setTask] = useState(null);
  const [runs, setRuns] = useState([]);
  const [events, setEvents] = useState([]);
  const [tab, setTab] = useState('plan');
  const [busy, setBusy] = useState(null);
  const [refining, setRefining] = useState(false);
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [selected, setSelected] = useState(0);

  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const childRef = useRef(null); // the running $EDITOR, if any
  const goneRef = useRef(false); // set on unmount, so the editor path bails out
  const releasedRef = useRef(false); // true while we hold Ink's terminal slot
  const pendingFileRef = useRef(null); // temp file the editor is working on
  const seenEventRef = useRef(new Set()); // event ids already in `events`
  const seenRunRef = useRef(new Set()); // run ids already in `runs`

  const loadShow = async () => {
    try {
      const d = await api.taskShow(taskId);
      setTask(d.task);
      setRuns(d.runs);
      for (const r of d.runs) seenRunRef.current.add(r.id);
    } catch (err) {
      onError?.(err.message);
    }
  };

  useEffect(() => {
    setTab('plan');
    seenEventRef.current = new Set();
    seenRunRef.current = new Set();
    loadShow();
  }, [taskId]);

  // Live event stream. The server pushes run events and a fresh task snapshot
  // and closes the stream once the task is COMPLETE or FAILED, so this replaces
  // the polling intervals the screen used to run. `close()` aborts the request
  // and the reader with it, which is what keeps a stale subscription from
  // writing into state after a navigation or unmount.
  useEffect(() => {
    let live = true;
    const stream = api.streamTask(taskId, {
      onEvent: (ev) => {
        if (!live || seenEventRef.current.has(ev.id)) return;
        seenEventRef.current.add(ev.id);
        setEvents((prev) => [...prev, ev]);
        // A new run id, or the end of a run, means the run rows have moved on;
        // pull them once rather than on a timer. The state frames carry only
        // the task, so this fetch is what keeps the execute tab current.
        if (ev.run_id && !seenRunRef.current.has(ev.run_id)) {
          seenRunRef.current.add(ev.run_id);
          loadShow();
        } else if (ev.type === 'completed') {
          loadShow();
        }
      },
      onState: ({ task: next }) => {
        if (live && next) setTask(next);
      },
      onError: (message) => {
        if (live) onError?.(message);
      },
      onEnd: () => {
        if (live) loadShow();
      },
    });
    return () => {
      live = false;
      stream.close();
    };
  }, [taskId]);

  useEffect(() => {
    setTyping?.(refining || editing);
  }, [refining, editing]);

  // Ink refcounts raw mode across every active useInput, and the App-level
  // handler never deactivates, so the count only drops to zero if this screen
  // gives up its own slot. Dropping to zero is also what detaches Ink's stdin
  // reader — without that, the editor and Ink would split the user's keystrokes
  // between them. Releasing exactly one slot here, and reclaiming exactly one
  // on the way back, leaves the count where Ink expects it.
  const releaseTerminal = () => {
    if (isRawModeSupported) {
      releasedRef.current = true;
      setRawMode(false);
    }
    stdin.pause();
  };

  const reclaimTerminal = () => {
    stdin.resume();
    if (releasedRef.current) {
      releasedRef.current = false;
      setRawMode(true);
    }
  };

  // Resolves with the editor's exit code, or -1 if it could not be spawned.
  const launchEditor = (file, { command, args }) =>
    new Promise((resolve) => {
      const child = spawn(command, [...args, file], { stdio: 'inherit' });
      childRef.current = child;
      child.on('error', () => resolve(-1));
      child.on('close', (code) => resolve(code ?? -1));
    });

  // The `E` flow: write the plan out, hand the terminal over, read it back and
  // PATCH the result. Runs from an effect rather than the key handler so that
  // this screen's useInput has already been deactivated (and its raw mode slot
  // released) before the editor is spawned.
  const editInEditor = async () => {
    const file = pendingFileRef.current;
    const editor = editorCommand();
    releaseTerminal();
    const code = await launchEditor(file, editor);
    childRef.current = null;
    // The unmount cleanup already killed the editor and took the terminal back.
    if (goneRef.current) return;
    reclaimTerminal();
    repaint();
    setEditing(false);

    let text = null;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      return onError?.(`Cannot read edited plan: ${err.message}`);
    } finally {
      try {
        fs.unlinkSync(file);
      } catch {
        // Best-effort cleanup of a file in the OS temp dir.
      }
    }
    if (code !== 0) return onError?.(`${editor.command} did not exit cleanly (code ${code}) — plan not saved.`);
    await run('Save plan', () => api.updatePlan(taskId, text));
  };

  useEffect(() => {
    if (editing) editInEditor();
  }, [editing]);

  // Leaving the screen mid-edit must not strand the terminal in the editor's
  // hands with a child process still holding stdio.
  useEffect(
    () => () => {
      goneRef.current = true;
      childRef.current?.kill();
      reclaimTerminal();
    },
    [],
  );

  const startEdit = () => {
    const file = path.join(os.tmpdir(), `ai-code-plan-${taskId}.md`);
    try {
      fs.writeFileSync(file, task.plan || '', 'utf8');
    } catch (err) {
      return onError?.(`Cannot stage the plan at ${file}: ${err.message}`);
    }
    pendingFileRef.current = file;
    setEditing(true);
  };

  const run = async (label, fn) => {
    setBusy(label);
    try {
      await fn();
      await loadShow();
      onMessage?.({ text: `${label} done`, color: 'green' });
    } catch (err) {
      onError?.(err.message);
      await loadShow();
    } finally {
      setBusy(null);
    }
  };

  const submitFeedback = async (value) => {
    setRefining(false);
    if (!value.trim()) return;
    await run('Refine', () => api.refine(taskId, value.trim()));
    setFeedback('');
  };

  // A run row with status `running` is the only reliable sign that an agent is
  // mid-flight. The task state is not: PLANNING is both "a planner is running"
  // and "waiting for the user to start one", and states linger in the database
  // after a crash or a cancel, where runs do not.
  const activeRun = runs.find((r) => r.status === 'running') || null;

  // Contextual footer binds, lifted to the App-level footer.
  useEffect(() => {
    const binds = [['1-4', 'tabs'], ['Esc', 'back']];
    if (task) {
      if (activeRun) binds.push(['c', 'cancel']);
      if (!activeRun && task.state !== 'COMPLETE' && task.state !== 'CANCELLED') binds.push(['x', 'close']);
      if (tab === 'plan') {
        if (task.state === 'PLANNING' && !activeRun) binds.push(['p', 'start planning']);
        if (task.state === 'AWAITING_APPROVAL') binds.push(['a', 'approve'], ['r', 'reject'], ['f', 'refine'], ['E', 'edit']);
        if (task.state === 'FAILED') binds.push(['p', 'replan']);
      }
      if (task.state === 'APPROVED') binds.push(['e', 'execute']);
      if (tab === 'review' && task.state === 'REPAIRING') binds.push(['r', 'repair']);
    }
    setFooter?.(binds);
  }, [tab, task?.state, activeRun?.id]);

  useInput(
    (input, key) => {
      if (refining) {
        if (key.escape) setRefining(false);
        return;
      }
      if (key.escape || key.backspace) return onBack();
      const tabMatch = TABS.find((t) => t.key === input);
      if (tabMatch) return setTab(tabMatch.id);
      if (!task || busy) return;

      // Cancel is offered whenever an agent is live, from any tab. It is not
      // gated on the task state for the same reason the footer bind is not.
      if (input === 'c' && activeRun) return run('Cancel', () => api.cancel(taskId));
      if (input === 'x' && !activeRun && task.state !== 'COMPLETE' && task.state !== 'CANCELLED') return run('Close', () => api.close(taskId));

      if (tab === 'plan') {
        if (input === 'p' && task.state === 'PLANNING' && !activeRun) return run('Planning', () => api.plan(taskId));
        if (input === 'p' && task.state === 'FAILED') return run('Replan', () => api.replan(taskId));
        if (task.state === 'AWAITING_APPROVAL') {
          if (input === 'a') return run('Approve', () => api.approve(taskId));
          if (input === 'r') return run('Reject', () => api.reject(taskId));
          if (input === 'f') {
            setFeedback('');
            setRefining(true);
            return;
          }
          if (input === 'E') return startEdit();
        }
      }
      if (input === 'e' && task.state === 'APPROVED') return run('Execute', () => api.execute(taskId));
      if (tab === 'review' && input === 'r' && task.state === 'REPAIRING') return run('Repair', () => api.repair(taskId));

      if (tab === 'execute' && runs.length) {
        if (input === 'j' || key.downArrow) setSelected((i) => Math.min(i + 1, runs.length - 1));
        if (input === 'k' || key.upArrow) setSelected((i) => Math.max(i - 1, 0));
      }
    },
    // While the editor is open this screen must not hold a raw mode slot, or
    // Ink would keep reading stdin alongside the child process.
    { isActive: isActive && !editing },
  );

  if (!task) return e(Text, { color: 'gray' }, 'Loading task…');

  const desc = task.description && task.description !== task.title ? task.description : null;

  return e(
    Box,
    { flexDirection: 'column' },
    e(
      Box,
      { flexDirection: 'row', justifyContent: 'space-between' },
      e(Text, { bold: true }, task.title),
      e(Box, { flexDirection: 'row' }, e(StatusBadge, { state: task.state }), e(Text, { color: 'gray' }, `  ${String(task.id).slice(0, 8)}`)),
    ),
    desc ? e(Box, { marginTop: 1 }, e(Text, { color: 'gray', wrap: 'wrap' }, desc)) : null,
    e(Box, { height: 1 }),
    e(
      Box,
      { flexDirection: 'row' },
      ...TABS.map((t) =>
        e(
          Text,
          {
            key: t.id,
            color: t.id === tab ? 'black' : 'gray',
            backgroundColor: t.id === tab ? 'blue' : undefined,
            bold: t.id === tab,
          },
          ` [${t.key}] ${t.label} `,
        ),
      ),
      busy ? e(Box, { marginLeft: 2 }, e(Text, { color: 'yellow' }, e(Spinner, { type: 'dots' }), ` ${busy}…`)) : null,
    ),
    e(Box, { height: 1 }),
    tab === 'plan' && renderPlan(task, refining, editing, feedback, setFeedback, submitFeedback),
    tab === 'execute' && renderExecute(task, runs, selected),
    tab === 'review' && renderReview(task),
    tab === 'activity' && renderActivity(events),
  );
}

function renderPlan(task, refining, editing, feedback, setFeedback, submitFeedback) {
  if (editing) {
    return e(Text, { color: 'yellow' }, 'Plan is open in $EDITOR — save and quit to apply your edits.');
  }
  if (refining) {
    return e(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: 'blue', paddingX: 1 },
      e(Text, { bold: true }, 'Refine plan — feedback:'),
      e(TextInput, { value: feedback, onChange: setFeedback, onSubmit: submitFeedback }),
      e(Text, { color: 'gray' }, 'Enter to submit, Esc to cancel'),
    );
  }
  if (task.state === 'PLANNING' && !task.plan) {
    // A planner is only "in progress" when a run says so. Otherwise this is a
    // task sitting in PLANNING with nothing to move it, and it needs the key.
    return activeRun
      ? e(Text, { color: 'yellow' }, 'Planning in progress… press c to cancel.')
      : e(Text, { color: 'yellow' }, 'No plan yet — press p to start the planner.');
  }
  if (!task.plan) return e(Text, { color: 'gray' }, 'No plan yet.');
  return e(
    Box,
    { flexDirection: 'column' },
    ...wrap(task.plan).map((line, i) => e(Text, { key: i }, line)),
  );
}

// What the tree looked like when the plan was written. The execution gate refuses
// when a file the planner saw is still dirty, so the operand it refuses on is
// worth a line: without it the refusal arrives with nothing to compare it to.
function planBase(task) {
  try {
    return task.plan_base ? JSON.parse(task.plan_base) : null;
  } catch {
    return null;
  }
}

function renderExecute(task, runs, selected) {
  const base = planBase(task);
  return e(
    Box,
    { flexDirection: 'column' },
    e(Text, { bold: true }, 'Worktree'),
    e(Text, { color: 'gray' }, `  branch: ${task.branch || '—'}`),
    e(Text, { color: 'gray' }, `  dir:    ${task.worktree || '—'}`),
    e(Text, { color: 'gray' }, `  base:   ${task.base_commit ? String(task.base_commit).slice(0, 12) : '—'}`),
    base ? e(Text, { color: 'gray' }, `  planned against: ${String(base.head || '').slice(0, 12) || '—'} · ${base.dirty && base.dirty.length ? `${base.dirty.length} file(s) dirty` : 'clean'}`) : null,
    base && base.conflicts && base.conflicts.length ? e(Text, { color: 'yellow' }, `  plan conflicts:  ${base.conflicts.join(', ')}`) : null,
    e(Box, { height: 1 }),
    e(Text, { bold: true }, `Runs (${runs.length})`),
    runs.length === 0
      ? e(Text, { color: 'gray' }, '  No runs yet.')
      : e(
          Box,
          { flexDirection: 'column' },
          ...runs.map((r, i) =>
            e(
              Box,
              { key: r.id, flexDirection: 'row' },
              e(Text, { color: i === selected ? 'blue' : undefined, bold: i === selected }, `${i === selected ? '›' : ' '} `),
              e(Text, {}, `${(r.role || '').padEnd(12)} `),
              e(StatusBadge, { state: r.status }),
              e(Text, { color: 'gray' }, `  ${(r.provider_id || '').padEnd(22)} ${(r.model_id || '').padEnd(20)} ${formatTokens(r.tokens)} tok  ${formatCost(r.cost)}  ${formatDuration(r.duration_ms)}`),
            ),
          ),
        ),
  );
}

function renderReview(task) {
  if (task.state === 'REPAIRING') {
    return e(
      Box,
      { flexDirection: 'column' },
      e(Text, { color: 'yellow', bold: true }, 'Review failed — repair required. Press r to repair.'),
      e(Box, { height: 1 }),
      ...wrap(task.review || '').map((line, i) => e(Text, { key: i }, line)),
    );
  }
  if (!task.review) return e(Text, { color: 'gray' }, 'No review yet.');
  return e(Box, { flexDirection: 'column' }, ...wrap(task.review).map((line, i) => e(Text, { key: i }, line)));
}

// Ink's colour names, by the kind `describeEvent` reports. The quiet kinds are the
// ones that carry context for the row above rather than news of their own.
const KIND_COLOR = { error: 'red', limit: 'yellow', done: 'green', out: 'gray', think: 'gray', note: 'gray' };

function renderActivity(events) {
  // Filtered before the slice, so the last 30 rows are 30 rows with something in
  // them rather than 30 raw events of which a third render blank.
  const rows = events.map((ev) => ({ ev, described: describeEvent(ev) })).filter((r) => r.described);
  if (!rows.length) return e(Text, { color: 'gray' }, 'No activity yet.');
  return e(
    Box,
    { flexDirection: 'column' },
    ...rows.slice(-30).map(({ ev, described }) =>
      e(
        Box,
        { key: ev.id, flexDirection: 'row' },
        e(Text, { color: 'gray' }, `${new Date(ev.created_at).toLocaleTimeString()}  `),
        e(Text, { color: KIND_COLOR[described.kind] }, `${described.kind.padEnd(6)}`),
        e(Text, {}, described.text),
      ),
    ),
  );
}
