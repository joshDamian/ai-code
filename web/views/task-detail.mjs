// Full-page task view (not a modal). URL hash: #/tasks/:id
import { html, useState, useEffect, useRef, useCallback, useMemo, bodyKind, describeEvent, formatDuration } from '../lib.mjs';
import { api, taskStreamUrl } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { StatusBadge } from '../components/status-badge.mjs';
import { TextArea, Select } from '../components/form.mjs';
import { DiffViewer } from '../components/diff-viewer.mjs';
import { EventStream } from '../components/event-stream.mjs';
import { Markdown } from '../components/markdown.mjs';

// States in which the harness may have an agent mid-flight. This previously listed
// EXECUTING, which is not a real state (the implementation state is IMPLEMENTING),
// and omitted TESTING. It also claimed PLANNING, which is usually the opposite:
// a task parked in PLANNING with no run is waiting for the user to start one.
const WORKING_STATES = new Set(['IMPLEMENTING', 'TESTING', 'REVIEWING', 'REPAIRING']);
const TABS = ['plan', 'execute', 'review', 'port', 'activity'];

export function TaskDetail({ id, navigate, onTitle }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('plan');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // When the revision on screen landed. Session-local, and only ever set for a
  // revision that arrived while the user was looking at another tab: the marker means
  // "this changed under you", not "this plan has a predecessor".
  const [revisedAt, setRevisedAt] = useState(null);
  // The plan timestamp the user has seen. `undefined` until the first payload, because
  // a revision that landed before this page opened is not news.
  const seenPlanAtRef = useRef(undefined);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const liveRef = useRef(null);
  // The newest event belonging to the run the server says is live, which is what the
  // plan tab reads for its action line.
  const actionRef = useRef(null);
  const buffer = useMemo(() => createEventBuffer(), [id]);

  const load = useCallback(async () => {
    try {
      const d = await api.taskShow(id);
      liveRef.current = d.live || null;
      setData(d);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [id]);

  useEffect(() => {
    setData(null);
    setTab('plan');
    setRevisedAt(null);
    seenPlanAtRef.current = undefined;
    liveRef.current = null;
    actionRef.current = null;
    load();
  }, [id, load]);

  // The header breadcrumb's subject. The shell owns the header and this page is the
  // only thing that knows what it is showing, so the title is handed up rather than
  // derived from the route there. Cleared on the way out: a task's title outliving
  // the page it names would put the wrong subject over the next view.
  useEffect(() => {
    if (!onTitle) return undefined;
    onTitle(data?.task?.title || null);
    return () => onTitle(null);
  }, [data?.task?.title, onTitle]);

  // The one event stream on the page. It used to live in the activity tab, which tore
  // it down on every tab switch: a refine that landed while the user was reading the
  // plan was never seen, and the plan sat stale until a reload. Hoisted here it
  // survives the switch, and the `state` frame the server already sends every 500ms -
  // which the tab used to drop - becomes what keeps the task current.
  useEffect(() => {
    buffer.reset();
    let es = null;
    try {
      es = new EventSource(taskStreamUrl(id));
      es.addEventListener('meta', (e) => {
        try {
          const parsed = JSON.parse(e.data);
          // How many events this task has in total, versus how many the server sent
          // us. Drives the truncation notice.
          if (parsed && Number.isFinite(parsed.total)) buffer.setMeta(parsed);
        } catch (err) {
          /* ignore malformed frame */
        }
      });
      es.addEventListener('event', (e) => {
        try {
          const ev = JSON.parse(e.data);
          buffer.push(ev);
          // Kept here rather than derived from the rendered list, because the plan tab
          // reads it on its own one-second clock: re-parsing the plan markdown for every
          // event of a token stream is what makes a live tab stutter.
          if (ev.run_id && ev.run_id === liveRef.current?.runId) actionRef.current = ev;
        } catch (err) {
          /* ignore malformed event */
        }
      });
      es.addEventListener('state', (e) => {
        let frame;
        try {
          frame = JSON.parse(e.data);
        } catch (err) {
          return;
        }
        if (!frame || !frame.task) return;
        const next = frame.live || null;
        // The frame carries the task but not the runs' cost, tokens or duration, so
        // both ends of a run - a new run id, and a run id going away - are worth one
        // full read rather than a timer.
        const started = next && next.runId !== liveRef.current?.runId;
        const ended = !next && !!liveRef.current;
        liveRef.current = next;
        if (started) actionRef.current = null;
        if (started || ended) load();

        const at = frame.task.plan_at || null;
        if (seenPlanAtRef.current === undefined) {
          seenPlanAtRef.current = at;
        } else if (at !== seenPlanAtRef.current) {
          // The ref moves whether or not the user is looking, so a second revision is
          // not mistaken for the first. What clears the marker is acting on the
          // revision, not glancing at the tab it is on.
          seenPlanAtRef.current = at;
          setRevisedAt(Date.now());
          // No toast for the tab the user is already reading: the notice below the
          // plan says the same thing and does not disappear on its own.
          if (tabRef.current !== 'plan') showToast('Plan revised.', 'success');
        }
        // One update per frame rather than one per field, so the task, the live run
        // and the revision marker all describe the same instant.
        setData((d) => (d ? { ...d, task: frame.task, live: next } : d));
        // A finished task is the one case the browser must not reconnect on. Every
        // other stream ending is the tick cap closing a resting task, and the next
        // connection is answered by a fresh tail; this one would be answered by a
        // stream that ends on its first tick, and the retry is a second.
        if (frame.task.state === 'COMPLETE' || frame.task.state === 'FAILED') es.close();
      });
      es.addEventListener('error', () => {
        /* EventSource retries automatically; nothing to surface here */
      });
    } catch (err) {
      showToast('Could not open activity stream.', 'error');
    }
    return () => {
      if (es) es.close();
      buffer.stop();
    };
  }, [id, buffer, load]);

  // Acting on the revision is the acknowledgement. Opening the tab is not: the dot
  // says "this changed under you", and clearing it on arrival would mean the sentence
  // it was pointing at had already been dismissed by the time it was read.
  const readAction = useCallback(() => actionRef.current, []);
  const acknowledgeRevision = useCallback(() => setRevisedAt(null), []);

  // The server's answer, not a scan of the runs table: a run row sits at 'running'
  // for as long as it takes something to notice the process that owned it is gone,
  // and a task state is set before its run starts and cleared after it ends.
  const live = data?.live || null;
  const liveOn = !!live;
  const working = data ? WORKING_STATES.has(data.task.state) : false;
  // Read from the task and the server's live run, never from the current tab, so the
  // banner below and the dot on the tabs bar always name the same step.
  const step = data ? nextStep(data.task, live) : null;

  useEffect(() => {
    if (!liveOn && !working) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [liveOn, working, load]);

  // `okMsg` may be a function of what `fn` returned, because an operation that can end
  // more than one way - a port that lands, or one that stops short and leaves a command
  // for you - cannot be reported from a string fixed at the call site. That mismatch is
  // what let a port that merged nothing toast "Ported".
  async function run(fn, okMsg) {
    setBusy(true);
    try {
      const r = await fn();
      const msg = typeof okMsg === 'function' ? okMsg(r) : okMsg;
      if (msg) showToast(msg, 'success');
      await load();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return html`
      <div class="card">
        <p class="error-text">${error}</p>
        <a href="#/tasks" class="link">← Back to tasks</a>
      </div>
    `;
  }
  if (!data) return html`<${Spinner} message="Loading task..." />`;

  const { task, runs } = data;

  return html`
    <div class="view-task-detail">
      <div class="task-header">
        <div>
          <h1>${task.title}</h1>
          <div class="task-meta muted">
            <${StatusBadge} status=${task.state} />
            <span>${task.id}</span>
            <span>· ${task.project_id}</span>
            <span>· created ${task.created_at ? new Date(task.created_at).toLocaleString() : '—'}</span>
          </div>
          ${task.description && task.description !== task.title ? html`<p class="task-description">${task.description}</p>` : null}
        </div>
        <a href="#/tasks" class="link">← Back to tasks</a>
      </div>

      <div class="tabs">
        ${TABS.map((t) => {
          // Two things light a tab the user is not on: a plan revision that landed
          // under them, and the step the workflow is waiting for.
          const revised = t === 'plan' && !!revisedAt;
          const dot = tab !== t && (revised || t === step?.tab);
          return html`
            <button key=${t} class="tab ${tab === t ? 'active' : ''}" onClick=${() => setTab(t)}>
              ${t.toUpperCase()}
              ${dot ? html`<span class="tab-dot" role="img" aria-label=${revised ? 'Plan revised' : 'Next step'}></span>` : null}
            </button>
          `;
        })}
      </div>

      ${
        // The step is named on the page it happens on, so it is only shown from
        // elsewhere. Switching tabs is all this does: the button that starts the work
        // is that tab's own, and pressing this one is not a way to press that one.
        step && step.tab !== tab
          ? html`
              <div class="next-step-banner">
                <span>${step.text}</span>
                <button class="btn" onClick=${() => setTab(step.tab)}>${step.cta} →</button>
              </div>
            `
          : null
      }

      <div class="tab-content">
        ${tab === 'plan' ? html`<${PlanTab} task=${task} busy=${busy} run=${run} live=${live} revision=${data.revision} revisedAt=${revisedAt} readAction=${readAction} onAcknowledge=${acknowledgeRevision} lastRun=${runs[runs.length - 1] || null} />` : null}
        ${tab === 'execute' ? html`<${ExecuteTab} task=${task} runs=${runs} busy=${busy} run=${run} live=${live} />` : null}
        ${tab === 'review' ? html`<${ReviewTab} task=${task} busy=${busy} run=${run} live=${live} />` : null}
        ${tab === 'port' ? html`<${PortTab} task=${task} branches=${data.branches || []} busy=${busy} run=${run} />` : null}
        ${tab === 'activity' ? html`<${ActivityTab} taskId=${task.id} store=${buffer} />` : null}
      </div>

      ${
        live
          ? html`
              <div class="action-bar">
                <button class="btn danger" disabled=${busy} onClick=${() => run(() => api.taskCancel(task.id), 'Cancel requested.')}>Cancel</button>
              </div>
            `
          : null
      }
      ${
        task.state !== 'COMPLETE' && task.state !== 'CANCELLED' && !live
          ? html`
              <div class="action-bar">
                <button class="btn danger" disabled=${busy} onClick=${() => run(() => api.taskClose(task.id), 'Task closed.')}>Close</button>
              </div>
            `
          : null
      }
    </div>
  `;
}

// The plan, and the two things that can change underneath it while it is on screen: a
// planner running - the first plan or a refine - and a revision that landed. Both are
// read from the server's `live` and from the revision the task carries, never from a
// local flag, so a reload mid-refine and a second tab see the same thing this one does.
function PlanTab({ task, busy, run, live, revision, revisedAt, readAction, onAcknowledge, lastRun }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.plan || '');
  const [refining, setRefining] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [view, setView] = useState('plan');
  const [staleDraft, setStaleDraft] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [action, setAction] = useState(null);
  // The plan the draft was seeded from, so a revision landing mid-edit can be told
  // apart from the user's own typing.
  const draftBaseRef = useRef(task.plan || '');

  const planning = live?.role === 'planner';
  const hasPlan = bodyKind(task.plan) !== 'empty';
  const elapsed = live?.startedAt && Number.isFinite(Date.parse(live.startedAt)) ? now - Date.parse(live.startedAt) : null;

  // One timer for both live numbers in this tab: how long the planner has been running
  // and how long ago the revision landed. It is also what publishes the action line,
  // which is read from the stream's ref rather than passed down - so a token stream
  // re-renders this tab once a second, not once per event.
  useEffect(() => {
    if (!planning && !revisedAt) return;
    const tick = () => {
      setNow(Date.now());
      if (planning) setAction(readAction());
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [planning, revisedAt, readAction]);

  // The draft is re-synced with the plan only while the editor is closed. Doing it
  // unconditionally is what silently replaced what somebody was typing when a revision
  // landed mid-edit, and Save then wrote the model's text back as if it were theirs.
  useEffect(() => {
    if (editing) {
      if ((task.plan || '') !== draftBaseRef.current) setStaleDraft(true);
      return;
    }
    draftBaseRef.current = task.plan || '';
    setDraft(task.plan || '');
    setStaleDraft(false);
  }, [task.plan, editing]);

  // One of the two things that clears the revision marker, and the one the dot is
  // pointing at. Reading the diff is the review the notice asked for.
  function showChanges() {
    setView('changes');
    onAcknowledge();
  }

  // The blocked POST rejects with this once the run is cancelled, which is the outcome
  // that was asked for - so it is not routed through run(), which would toast it as an
  // error. The panel stays open with the feedback intact, so resubmitting is one click.
  async function submitFeedback() {
    setSubmitting(true);
    setError(null);
    try {
      await api.taskRefine(task.id, feedback);
      setFeedback('');
      setRefining(false);
      showToast('Refine requested.', 'success');
    } catch (e) {
      if (!/Cancelled by user/.test(e.message)) {
        // A refusal can name every provider that was tried and why none was left, and
        // a toast truncates it. So it is rendered in the tab as well as toasted.
        setError(e.message);
        showToast(e.message, 'error');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const liveBlock = !planning
    ? null
    : html`
        <div class="card plan-live">
          <div class="row">
            <span class="spinner"></span>
            <b>Refining plan…</b>
            ${elapsed != null ? html`<span class="muted">${formatDuration(elapsed)}</span>` : null}
          </div>
          ${action ? html`<div class="plan-action muted">${describeEvent(action)?.text || ''}</div>` : null}
        </div>
      `;

  // PLANNING is both "a planner is running" and "ready for a planner to run". Only the
  // second is this branch; the first is the live block above, which a refine needs
  // just as much and which the state alone cannot tell you about. Without the branch a
  // failed or cancelled plan strands the task behind a loading indicator forever.
  if (task.state === 'PLANNING' && !planning) {
    return html`
      <div class="stack">
        ${
          lastRun && lastRun.role === 'planner' && lastRun.status === 'failed'
            ? html`<p class="error-text">The last planning attempt failed: ${lastRun.error || 'unknown error'}</p>`
            : html`<p class="muted">No plan yet.</p>`
        }
        <div class="row">
          <button class="btn" disabled=${busy} onClick=${() => run(() => api.taskPlan(task.id), 'Plan ready.')}>Start Planning</button>
        </div>
      </div>
    `;
  }

  return html`
    <div class="stack">
      ${liveBlock}

      ${
        // Not while editing: the editor has its own banner for the same event, and it
        // is the one that knows what to do about it. This one's button would also
        // switch the body out from under the editor, which the editor then wins.
        revisedAt && !editing && task.state === 'AWAITING_APPROVAL'
          ? html`
              <div class="plan-notice">
                <span>Revised ${formatDuration(now - revisedAt)} ago — review the changes.</span>
                <button class="link-btn" onClick=${showChanges}>See what changed</button>
              </div>
            `
          : null
      }

      ${
        hasPlan
          ? html`
              <div class="diff-modes">
                <button class="btn secondary ${view === 'plan' ? 'on' : ''}" onClick=${() => setView('plan')}>Plan</button>
                <button class="btn secondary ${view === 'changes' ? 'on' : ''}" disabled=${!revision?.hasPrev} onClick=${showChanges}>Changes vs previous</button>
              </div>
            `
          : null
      }

      ${
        editing
          ? html`
              ${
                staleDraft
                  ? html`
                      <div class="plan-notice">
                        <span>A new revision arrived while you were editing.</span>
                        <button
                          class="link-btn"
                          onClick=${() => {
                            draftBaseRef.current = task.plan || '';
                            setDraft(task.plan || '');
                            setStaleDraft(false);
                          }}
                        >
                          Load the revision
                        </button>
                        <button
                          class="link-btn"
                          onClick=${() => {
                            draftBaseRef.current = task.plan || '';
                            setStaleDraft(false);
                          }}
                        >
                          Keep mine
                        </button>
                      </div>
                    `
                  : null
              }
              <${TextArea} value=${draft} onInput=${setDraft} rows=${16} loading=${busy} />
              <div class="row">
                <button
                  class="btn"
                  disabled=${busy}
                  onClick=${() => {
                    onAcknowledge();
                    run(async () => {
                      await api.updatePlan(task.id, draft);
                      setEditing(false);
                    }, 'Plan saved.');
                  }}
                >
                  Save
                </button>
                <button
                  class="btn secondary"
                  onClick=${() => {
                    setEditing(false);
                    setDraft(task.plan || '');
                  }}
                >
                  Cancel
                </button>
              </div>
            `
          : view === 'changes'
            ? revision?.changed
              ? html`<${DiffViewer} diff=${revision.diff} />`
              : html`<p class="muted">${revision?.hasPrev ? 'Identical to the previous revision.' : 'No previous revision yet.'}</p>`
            : hasPlan
              ? html`<${Markdown} text=${task.plan} />`
              : html`<pre class="code-block">No plan yet.</pre>`
      }

      ${
        refining
          ? html`
              <div class="card">
                <${TextArea} label="Feedback" value=${feedback} onInput=${setFeedback} rows=${4} placeholder="What should change?" loading=${submitting} />
                ${error ? html`<p class="error-text">${error}</p>` : null}
                <div class="row">
                  <button class="btn" disabled=${busy || submitting || planning || !feedback.trim()} onClick=${submitFeedback}>Submit feedback</button>
                  ${
                    planning
                      ? html`<button class="btn danger" disabled=${busy} onClick=${() => run(() => api.taskCancel(task.id), 'Cancel requested.')}>
                          Cancel refine
                        </button>`
                      : html`<button class="btn secondary" onClick=${() => setRefining(false)}>Cancel</button>`
                  }
                </div>
              </div>
            `
          : null
      }

      ${
        !editing && task.state === 'AWAITING_APPROVAL'
          ? html`
              <div class="row">
                <button class="btn" disabled=${busy || planning} onClick=${() => { onAcknowledge(); run(() => api.taskApprove(task.id), 'Plan approved.'); }}>Approve</button>
                <button class="btn danger" disabled=${busy || planning} onClick=${() => { onAcknowledge(); run(() => api.taskReject(task.id), 'Plan rejected.'); }}>Reject</button>
                <button class="btn secondary" disabled=${busy || planning} onClick=${() => { onAcknowledge(); setRefining((r) => !r); }}>Refine</button>
                <button class="btn secondary" disabled=${busy || planning} onClick=${() => { onAcknowledge(); setEditing(true); }}>Edit</button>
              </div>
            `
          : null
      }

      ${
        task.state === 'FAILED'
          ? html`
              <div class="row">
                <button class="btn" disabled=${busy} onClick=${() => run(() => api.taskReplan(task.id), 'Replanning...')}>Replan</button>
              </div>
            `
          : null
      }
    </div>
  `;
}

// What the workflow wants next, and which tab it happens on.
//
// The state machine (src/service.mjs's `transitions`) moves a task one way through
// the tabs, and three of its transitions land while the user is looking at a tab
// that has nothing left to do: approving a plan takes the action row off the plan
// tab, a finished execution starts waiting for a review nobody asked for, and a
// passed review leaves the port unmentioned. Each of those is a real action on a
// tab that is not the current one, so it is named here rather than discovered by
// clicking through the tabs.
//
// Two states return null on purpose. A live run is its own nudge - the action bar
// is already offering Cancel - and PLANNING with no planner running is owned by the
// plan tab's own "Start Planning" button, which is on the tab the user starts on.
function nextStep(task, live) {
  if (live) return null;
  switch (task.state) {
    case 'APPROVED':
      return { tab: 'execute', text: 'Plan approved.', cta: 'Start execution' };
    case 'REVIEWING':
      return { tab: 'review', text: 'Execution finished.', cta: 'Start review' };
    case 'REPAIRING':
      return { tab: 'review', text: 'Review requested changes.', cta: 'Repair' };
    case 'COMPLETE':
      return { tab: 'port', text: 'Review passed.', cta: 'Port this change' };
    case 'FAILED':
      return { tab: 'plan', text: 'The last run failed.', cta: 'View details' };
    default:
      return null;
  }
}

// What the tree looked like when the plan was written, recorded by plan() so the
// execution gate has something to compare against. Worth surfacing because it is
// the only place a task says its plan was reasoned against uncommitted work - and
// a refusal to execute is otherwise the first anyone hears of it.
function planBase(task) {
  try {
    return task.plan_base ? JSON.parse(task.plan_base) : null;
  } catch {
    return null;
  }
}

function ExecuteTab({ task, runs, busy, run, live }) {
  const base = planBase(task);
  return html`
    <div class="stack">
      <div class="card">
        <h3>Worktree</h3>
        <div class="kv-grid">
          <span class="muted">Path</span>
          <code>${task.worktree || 'Not created'}</code>
          <span class="muted">Branch</span>
          <code>${task.branch || 'Not created'}</code>
          <span class="muted">Base commit</span>
          <code>${task.base_commit || 'Not created'}</code>
          ${
            base
              ? html`
                  <span class="muted">Plan baseline</span>
                  <code>${String(base.head || '').slice(0, 12)} · ${base.dirty && base.dirty.length ? `${base.dirty.length} file(s) dirty` : 'clean'}</code>
                `
              : null
          }
          ${
            base && base.conflicts && base.conflicts.length
              ? html`
                  <span class="muted">Plan conflicts</span>
                  <code>${base.conflicts.join(', ')}</code>
                `
              : null
          }
        </div>
      </div>

      ${
        // IMPLEMENTING is set before the implementer starts and moved on after it
        // ends, so a process that dies mid-run leaves the task here with nothing
        // running it. Every step a reader would guess refuses - implement wants
        // APPROVED, test wants TESTING, review wants REVIEWING - and the only
        // button was Close, which discards the worktree. The way back is `approve`,
        // a bare transition that the map allows from IMPLEMENTING, so the task can
        // be re-armed and execution started again over the work already on disk.
        // Without this the state had no exit from the dashboard at all.
        task.state === 'IMPLEMENTING' && !live
          ? html`
              <div class="card">
                <h3>No implementer running</h3>
                <p class="muted">
                  This task is implementing, but no implementer is running — the run that set this state ended
                  before it could move the task on. Re-arming it returns the task to APPROVED so execution can
                  start again; the worktree and anything already changed in it are kept.
                </p>
                <div class="row">
                  <button class="btn" disabled=${busy} onClick=${() => run(() => api.taskApprove(task.id), 'Re-armed. Start execution when ready.')}>Re-arm</button>
                </div>
              </div>
            `
          : null
      }

      ${
        task.state === 'APPROVED'
          ? html`
              <div class="row">
                <button class="btn" disabled=${busy} onClick=${() => run(() => api.taskExecute(task.id), 'Execution started.')}>Start Execution</button>
              </div>
            `
          : null
      }

      <div class="card">
        <h3>Runs</h3>
        ${
          runs && runs.length
            ? html`
                <div class="list">
                  ${runs.map(
                    (r) => html`
                      <div class="list-row" key=${r.id}>
                        <div class="list-row-main">
                          <b>${r.role}</b>
                          <span class="muted">${r.provider_id} / ${r.model_id}</span>
                        </div>
                        <div class="list-row-side">
                          <${StatusBadge} status=${r.status} />
                          <span class="muted">
                            ${Number(r.tokens || 0).toLocaleString()} tok · $${Number(r.cost || 0).toFixed(6)} ·
                            ${r.duration_ms ? `${Math.round(r.duration_ms / 1000)}s` : '—'}
                          </span>
                        </div>
                      </div>
                    `
                  )}
                </div>
              `
            : html`<div class="muted">No runs yet.</div>`
        }
      </div>
    </div>
  `;
}

// The port view: what the work changed, where it would land, and what the
// destination would make of it. Nothing here is automatic - the preview writes
// nothing, and the port is a button.
//
// The assessment is rendered as plain elements rather than through Markdown, and
// deliberately not through bodyKind. Both of those exist for model text, and none of
// this is: every word here is generated from the repository by `assess`, and
// bodyKind would read the `---` in a diff header as a reason to render an
// assessment as a diff. The diff itself is the only blob, and it goes to DiffViewer.
function PortTab({ task, branches, busy, run }) {
  const [chosen, setChosen] = useState(null);
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const load = useCallback(async () => {
    try {
      setView(await api.taskDiff(task.id, chosen || undefined));
      setError(null);
    } catch (e) {
      setError(e.message);
      setView(null);
    }
  }, [task.id, chosen]);
  useEffect(() => {
    load();
  }, [load]);

  // Empty until the assessment answers, which is what supplies the default. The
  // select then shows the branch the port would actually use rather than a blank.
  const target = chosen || view?.target || '';

  // The result is returned so the toast can be written from it rather than guessed
  // before it: every button here used to name its own outcome, including the one whose
  // outcome depends on whether the destination turned out to be checked out.
  const port = (opts) =>
    run(async () => {
      const r = await api.taskPort(task.id, opts);
      setNote(r);
      await load();
      return r;
    }, portReport);

  if (error) return html`<div class="card"><p class="error-text">${error}</p></div>`;
  if (!view) return html`<${Spinner} message="Reading the worktree..." />`;

  const conflicts = view.conflicts || [];
  const blocked = view.blockedBy || [];
  // The verdict, the steps and the source of the change all come from the server rather
  // than being derived here, so the tab and the CLI cannot disagree about what state the
  // work is in or about what a port left for you to run.
  const st = view.state || { key: 'unknown', tone: 'neutral', badge: 'Unknown', headline: 'No verdict for this task', detail: '' };
  const steps = view.next || [];
  // Landed work and empty work have no port to offer: one has already arrived and the
  // other does not exist. Offering the buttons anyway is much of what made a finished
  // port read as something still waiting to be done.
  const actionable = st.key !== 'landed' && st.key !== 'empty';
  // The commits worth being able to name, because "the work is in main" is not something
  // you can look up later and a hash and a subject line are. A fast-forward leaves no
  // commit of its own, so the task's commit is what landed and is named once rather than
  // listed twice under two labels.
  const landedAs = view.landedAs;
  const taskCommit = view.taskCommit;
  const sameCommit = !!(landedAs && taskCommit && landedAs.sha === taskCommit.sha);
  const refs = [];
  if (landedAs) refs.push({ ...landedAs, label: sameCommit ? 'Landed as' : 'Merged as' });
  if (taskCommit && !sameCommit) refs.push({ ...taskCommit, label: 'Task commit' });
  const options = [...new Set([view.target, ...branches].filter(Boolean))].map((b) => ({ value: b, label: b }));

  return html`
    <div class="stack">
      <div class="port-state ${st.tone}">
        <div class="port-head">
          <span class="badge badge-${st.tone}">${st.badge}</span>
          <h2>${st.headline}</h2>
        </div>
        <p class="muted">${st.detail}</p>
        ${refs.length ? html`<div class="refs">${refs.map((r) => html`<div class="ref" key=${r.sha}>
            <span class="muted">${r.label}</span>
            <code class="ref-sha">${r.short}</code>
            <span class="ref-subject">${r.subject}</span>
          </div>`)}</div>` : null}
        ${note ? html`<p class="port-result">${portReport(note)}</p>` : null}
      </div>

      <div class="card">
        <h3>Destination</h3>
        <${Select} label="Merge into" value=${target} disabled=${busy} onChange=${setChosen} options=${options} />
        ${view.alreadyPorted ? html`<p class="muted">Change this to ask about another branch.</p>` : null}
      </div>

      ${
        steps.length
          ? html`<div class="card">
              <h3>Next steps</h3>
              <ol class="steps">
                ${steps.map(
                  (s, i) => html`<li key=${i}>
                    <span>${s.text}</span>
                    ${s.command ? html`<pre class="code-block">${s.command}</pre>` : null}
                  </li>`
                )}
              </ol>
            </div>`
          : null
      }

      <div class="card">
        <h3>${actionable ? 'Port' : 'Nothing to do'}</h3>
        ${
          actionable
            ? html`<div class="row">
                <button class="btn secondary" disabled=${busy} onClick=${() => port({ to: target, dryRun: true })}>Preview</button>
                <button class="btn" disabled=${busy} onClick=${() => port({ to: target })}>Port onto ${view.target}</button>
                ${
                  view.worktree
                    ? html`<button class="btn secondary" disabled=${busy} onClick=${() => port({ to: target, clean: true })}>
                        Port, then remove the worktree
                      </button>`
                    : null
                }
              </div>
              <p class="muted">
                Tests are not re-run here. They ran in the worktree; the destination is a different tree, and
                this reports what the merge would do rather than vouching for the result.
              </p>`
            : html`<p class="muted">
                Nothing to run. \`ai-code task port ${task.id}\` reports this same verdict.
              </p>`
        }
      </div>

      <div class="card">
        <h3>${changeLabel(view)}</h3>
        ${
          view.diff?.trim()
            ? html`<${DiffViewer} diff=${view.diff} />`
            : html`<div class="muted">No change was found for this task.</div>`
        }
      </div>

      <div class="card">
        <h3>Details</h3>
        <div class="list">
          ${row('Worktree', worktreeText(view))}
          ${row('Destination', `${view.target} at ${String(view.targetTip || '').slice(0, 7)}`)}
          ${row('Merge', conflicts.length ? `${conflicts.length} conflict(s)` : view.clean === null ? 'Unknown' : 'Clean')}
          ${row('Touches', `${(view.files || []).length} file(s)`)}
          ${view.untracked?.length ? row('Untracked', view.untracked.map((u) => `${u.path} (${u.bytes} B)`).join(', ')) : null}
          ${blocked.length ? row('Blocked by', blocked.join(', ')) : null}
          ${conflicts.length ? row('Conflicts', conflicts.join(', ')) : null}
          ${view.premisesMoved?.length ? row('Plan premises moved', view.premisesMoved.join(', ')) : null}
        </div>
      </div>
    </div>
  `;
}

// What the diff pane is showing, which is one of three things and they are not
// interchangeable: work the worktree is still holding, the commit the branch holds, or the
// change already in the destination. Leaving the label at "Change" is much of what made a
// landed port read as work still waiting to be ported.
function changeLabel(view) {
  if (view.state?.key === 'landed') return `The change, as it landed in ${view.target}`;
  if (view.from === 'worktree') return 'The change, uncommitted in the worktree';
  if (view.from === 'commit') return `The change on ${view.branch}`;
  return 'The change';
}

// Where the work is held, which is the worktree while it is there and the branch once it
// is not. A directory that has been removed is not the same as work that has been lost,
// and the difference is the one this screen exists to make.
function worktreeText(view) {
  if (view.worktree) return view.pending ? 'Live, with uncommitted changes' : 'Live, and clean';
  return view.committed ? 'Removed - the work is on the branch' : 'Gone, and the branch holds no commit';
}

// What a port did, said from what it returned rather than from which button was
// pressed. The case that matters is the last one: the work is on the branch, the
// destination was left where it was, and the command to finish is the whole point -
// so it is named here rather than left to a payload the toast does not show.
function portReport(r) {
  if (r.dryRun) return 'Preview only. Nothing was written.';
  if (r.empty) return 'Nothing to port: the worktree holds nothing the branch lacks.';
  if (r.alreadyPorted) return `${r.target} already contains this work. Nothing was moved.`;
  if (r.landed) return `Ported onto ${r.target}${r.cleaned ? '; the worktree was removed' : ''}.`;
  return `Committed to ${r.branch}${r.cleaned ? ' and removed its worktree' : ''}. ${r.target} was left alone - see Next steps.`;
}

function row(label, value) {
  return html`<div class="list-row" key=${label}>
    <div class="list-row-main"><b>${label}</b></div>
    <div class="list-row-side"><span class="muted">${value}</span></div>
  </div>`;
}

function ReviewTab({ task, busy, run, live }) {
  if (task.state === 'REVIEWING') {
    if (live || busy) return html`<${Spinner} message="Review in progress..." />`;
    return html`
      <div class="stack">
        <p class="muted">This task is in review, but no reviewer is running.</p>
        <div class="row">
          <button class="btn" disabled=${busy} onClick=${() => run(() => api.taskReview(task.id), 'Review started.')}>Start Review</button>
        </div>
      </div>
    `;
  }
  const review = task.review || '';
  const kind = bodyKind(review);

  return html`
    <div class="stack">
      ${
        kind === 'empty'
          ? html`<div class="muted">No review yet.</div>`
          : kind === 'diff'
            ? html`<${DiffViewer} diff=${review} />`
            : html`<${Markdown} text=${review} />`
      }
      ${
        task.state === 'REPAIRING'
          ? html`
              <div class="row">
                <button class="btn" disabled=${busy} onClick=${() => run(() => api.taskRepair(task.id), 'Repair started.')}>Repair</button>
              </div>
            `
          : null
      }
    </div>
  `;
}

// The server replays a window of history on connect rather than the whole journal,
// and one SSE frame still arrives per event. Two things have to hold for the tab to
// stay responsive on a long-running task: render a bounded number of rows, and commit
// incoming frames in batches rather than one state update per frame.
const MAX_EVENTS = 500;
const FLUSH_MS = 16;

// The event buffer the stream in TaskDetail writes into. Held here rather than in the
// page's render state because two consumers read it at two very different rates: the
// activity list redraws per batch, and the plan tab wants one line from it once a
// second. Page state would make every batch re-render the plan markdown and the diff
// beside it, which is what a live tab stuttering looks like.
//
// A subscriber list rather than preact state is not a preference: an event that lands
// while the activity tab is closed still has to be in the buffer when it opens, so the
// buffer cannot belong to the tab, and it must not redraw the page to say so.
function createEventBuffer() {
  const subs = new Set();
  let events = [];
  let meta = null;
  let pending = [];
  let timer = 0;

  // Each frame committed on its own would redraw the whole list per event - at tens of
  // thousands of events that blocks the main thread outright. Commit once per tick
  // instead. setTimeout rather than rAF so the buffer still drains in a background tab.
  function flush() {
    timer = 0;
    const batch = pending;
    if (!batch.length) return;
    pending = [];
    const next = events.concat(batch);
    events = next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
    for (const fn of subs) fn();
  }

  return {
    get events() {
      return events;
    },
    get meta() {
      return meta;
    },
    setMeta(m) {
      meta = m;
      for (const fn of subs) fn();
    },
    push(ev) {
      pending.push(ev);
      if (!timer) timer = setTimeout(flush, FLUSH_MS);
    },
    on(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    reset() {
      events = [];
      meta = null;
      pending = [];
      if (timer) clearTimeout(timer);
      timer = 0;
      for (const fn of subs) fn();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = 0;
    },
  };
}

function ActivityTab({ taskId, store }) {
  const [events, setEvents] = useState(store.events);
  const [meta, setMeta] = useState(store.meta);
  const [older, setOlder] = useState([]);
  const [allLoaded, setAllLoaded] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const endRef = useRef(null);
  const boxRef = useRef(null);

  useEffect(() => {
    const sync = () => {
      setEvents(store.events);
      setMeta(store.meta);
    };
    setOlder([]);
    setAllLoaded(false);
    setAutoScroll(true);
    sync();
    return store.on(sync);
  }, [store]);

  useEffect(() => {
    if (autoScroll && endRef.current) {
      endRef.current.scrollIntoView({ block: 'end' });
    }
  }, [events, autoScroll]);

  function onScroll() {
    const el = boxRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(nearBottom);
  }

  const displayed = older.concat(events);
  const total = meta ? meta.total : displayed.length;
  const hidden = Math.max(0, total - displayed.length);
  const canPageBack = hidden > 0 && !allLoaded && !olderBusy;

  // The stream only carries the newest window. Paging back walks from the oldest
  // row on screen. A page can overlap what is already held when the live list
  // dropped rows off its front, so de-duplicate by id on the way in.
  async function loadOlder() {
    const anchor = displayed.length ? displayed[0].id : 0;
    if (!anchor) return;
    setOlderBusy(true);
    try {
      const page = await api.taskActivity(taskId, { before: anchor, limit: MAX_EVENTS });
      const fetched = (page && page.events) || [];
      setOlder((list) => {
        const seen = new Set(list.map((x) => x.id).concat(events.map((x) => x.id)));
        return fetched.filter((x) => !seen.has(x.id)).concat(list);
      });
      if (fetched.length < MAX_EVENTS) setAllLoaded(true);
    } catch (err) {
      showToast('Could not load earlier events.', 'error');
    } finally {
      setOlderBusy(false);
    }
  }

  return html`
    <div class="activity-box" ref=${boxRef} onScroll=${onScroll}>
      ${
        hidden > 0 || older.length
          ? html`
              <div class="activity-notice">
                <span>
                  ${`Showing ${displayed.length.toLocaleString()} of ${total.toLocaleString()} events${hidden > 0 ? ` · ${hidden.toLocaleString()} not loaded` : ''}`}
                </span>
                ${canPageBack ? html`<button class="link-btn" onClick=${loadOlder}>Load ${MAX_EVENTS} older</button>` : null}
                ${olderBusy ? html`<span class="spinner"></span>` : null}
              </div>
            `
          : null
      }
      <${EventStream} events=${displayed} />
      <div ref=${endRef}></div>
      ${
        !autoScroll
          ? html`
              <button
                class="btn secondary jump-btn"
                onClick=${() => {
                  setAutoScroll(true);
                  if (endRef.current) endRef.current.scrollIntoView({ block: 'end' });
                }}
              >
                New events ↓
              </button>
            `
          : null
      }
    </div>
  `;
}
