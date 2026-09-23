// Full-page task view (not a modal). URL hash: #/tasks/:id
import { html, useState, useEffect, useRef, useCallback, bodyKind } from '../lib.mjs';
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

export function TaskDetail({ id, navigate }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('plan');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api.taskShow(id);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [id]);

  useEffect(() => {
    setData(null);
    setTab('plan');
    load();
  }, [id, load]);

  // Ground truth for "something is happening" is a run with status running, not the
  // task state. States linger in the database after a crash or a cancel; runs do not.
  const live = !!(data && data.runs.some((r) => r.status === 'running'));
  const working = data ? WORKING_STATES.has(data.task.state) : false;

  useEffect(() => {
    if (!live && !working) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [live, working, load]);

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
  const activeRun = runs.find((r) => r.status === 'running') || null;

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
        ${TABS.map((t) => html`<button key=${t} class="tab ${tab === t ? 'active' : ''}" onClick=${() => setTab(t)}>${t.toUpperCase()}</button>`)}
      </div>

      <div class="tab-content">
        ${tab === 'plan' ? html`<${PlanTab} task=${task} busy=${busy} run=${run} activeRun=${activeRun} lastRun=${runs[runs.length - 1] || null} />` : null}
        ${tab === 'execute' ? html`<${ExecuteTab} task=${task} runs=${runs} busy=${busy} run=${run} />` : null}
        ${tab === 'review' ? html`<${ReviewTab} task=${task} busy=${busy} run=${run} activeRun=${activeRun} />` : null}
        ${tab === 'port' ? html`<${PortTab} task=${task} branches=${data.branches || []} busy=${busy} run=${run} />` : null}
        ${tab === 'activity' ? html`<${ActivityTab} taskId=${task.id} />` : null}
      </div>

      ${
        activeRun
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

function PlanTab({ task, busy, run, activeRun, lastRun }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.plan || '');
  const [refining, setRefining] = useState(false);
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    setDraft(task.plan || '');
  }, [task.plan]);

  // PLANNING is both "a planner is running" and "ready for a planner to run". Only the
  // first is a spinner; the second needs a way out, or a failed or cancelled plan
  // strands the task behind a loading indicator forever.
  if (task.state === 'PLANNING') {
    if (activeRun || busy) return html`<${Spinner} message="Planning in progress..." />`;
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
      ${
        editing
          ? html`
              <${TextArea} value=${draft} onInput=${setDraft} rows=${16} loading=${busy} />
              <div class="row">
                <button
                  class="btn"
                  disabled=${busy}
                  onClick=${() => run(async () => {
                    await api.updatePlan(task.id, draft);
                    setEditing(false);
                  }, 'Plan saved.')}
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
          : bodyKind(task.plan) === 'empty'
            ? html`<pre class="code-block">No plan yet.</pre>`
            : html`<${Markdown} text=${task.plan} />`
      }

      ${
        refining
          ? html`
              <div class="card">
                <${TextArea} label="Feedback" value=${feedback} onInput=${setFeedback} rows=${4} placeholder="What should change?" loading=${busy} />
                <div class="row">
                  <button
                    class="btn"
                    disabled=${busy || !feedback.trim()}
                    onClick=${() => run(async () => {
                      await api.taskRefine(task.id, feedback);
                      setFeedback('');
                      setRefining(false);
                    }, 'Refine requested.')}
                  >
                    Submit feedback
                  </button>
                  <button class="btn secondary" onClick=${() => setRefining(false)}>Cancel</button>
                </div>
              </div>
            `
          : null
      }

      ${
        !editing && task.state === 'AWAITING_APPROVAL'
          ? html`
              <div class="row">
                <button class="btn" disabled=${busy} onClick=${() => run(() => api.taskApprove(task.id), 'Plan approved.')}>Approve</button>
                <button class="btn danger" disabled=${busy} onClick=${() => run(() => api.taskReject(task.id), 'Plan rejected.')}>Reject</button>
                <button class="btn secondary" disabled=${busy} onClick=${() => setRefining((r) => !r)}>Refine</button>
                <button class="btn secondary" disabled=${busy} onClick=${() => setEditing(true)}>Edit</button>
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

function ExecuteTab({ task, runs, busy, run }) {
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

function ReviewTab({ task, busy, run, activeRun }) {
  if (task.state === 'REVIEWING') {
    if (activeRun || busy) return html`<${Spinner} message="Review in progress..." />`;
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

function ActivityTab({ taskId }) {
  const [events, setEvents] = useState([]);
  const [older, setOlder] = useState([]);
  const [meta, setMeta] = useState(null);
  const [allLoaded, setAllLoaded] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const pendingRef = useRef([]);
  const flushRef = useRef(0);
  const endRef = useRef(null);
  const boxRef = useRef(null);

  useEffect(() => {
    setEvents([]);
    setOlder([]);
    setMeta(null);
    setAllLoaded(false);
    pendingRef.current = [];
    let es = null;

    // Each frame committed on its own would re-render the entire list per event —
    // at tens of thousands of events that blocks the main thread outright. Buffer
    // the frames and commit once per tick instead. setTimeout rather than rAF so the
    // buffer still drains in a background tab.
    function flush() {
      flushRef.current = 0;
      const batch = pendingRef.current;
      if (!batch.length) return;
      pendingRef.current = [];
      setEvents((list) => {
        const next = list.concat(batch);
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
      });
    }
    function schedule() {
      if (!flushRef.current) flushRef.current = setTimeout(flush, FLUSH_MS);
    }

    try {
      es = new EventSource(taskStreamUrl(taskId));
      es.addEventListener('meta', (e) => {
        try {
          const parsed = JSON.parse(e.data);
          // How many events this task has in total, versus how many the server sent
          // us. Drives the truncation notice.
          if (parsed && Number.isFinite(parsed.total)) setMeta(parsed);
        } catch (err) {
          /* ignore malformed frame */
        }
      });
      es.addEventListener('event', (e) => {
        try {
          pendingRef.current.push(JSON.parse(e.data));
          schedule();
        } catch (err) {
          /* ignore malformed event */
        }
      });
      es.addEventListener('error', () => {
        /* EventSource retries automatically; nothing to surface here */
      });
    } catch (err) {
      showToast('Could not open activity stream.', 'error');
    }
    return () => {
      if (es) es.close();
      if (flushRef.current) clearTimeout(flushRef.current);
      flushRef.current = 0;
    };
  }, [taskId]);

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
