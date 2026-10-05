// Full-page task view (not a modal). URL hash: #/tasks/:id
import { html, useState, useEffect, useRef, useCallback, useMemo, bodyKind, decisionView, describeEvent, formatDuration, formatTokens, formatCost, formatWhen, shortDir } from '../lib.mjs';
import { api, taskStreamUrl } from '../api.mjs';
import { onLocalhost } from '../auth.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { StatusBadge } from '../components/status-badge.mjs';
import { TextArea, Select, Toggle } from '../components/form.mjs';
import { TaskPicker } from '../components/task-picker.mjs';
import { DiffViewer } from '../components/diff-viewer.mjs';
import { Markdown } from '../components/markdown.mjs';
import { EmptyState } from '../components/empty-state.mjs';
import { RunTimeline, BarChart, compactNumber } from '../components/chart.mjs';
import { DataTable } from '../components/data-table.mjs';
import { TerminalPane } from '../components/terminal.mjs';
import { Tabs, TabPanel } from '../components/tabs.mjs';
import { Time } from '../components/time.mjs';
import { confirmAction } from '../components/confirm.mjs';
import { SkeletonRows } from '../components/skeleton.mjs';
import { MoreMenu } from '../components/menu.mjs';
import { shortId } from '../lib.mjs';

// States in which the harness may have an agent mid-flight. This previously listed
// EXECUTING, which is not a real state (the implementation state is IMPLEMENTING),
// and omitted TESTING. It also claimed PLANNING, which is usually the opposite:
// a task parked in PLANNING with no run is waiting for the user to start one.
const WORKING_STATES = new Set(['IMPLEMENTING', 'TESTING', 'REVIEWING', 'REPAIRING']);
// The terminal is dropped off localhost because the server refuses it there - a phone
// holding a valid token still gets a 403, on purpose: reaching the API is not the same
// permission as opening a shell on the machine. Rendering the tab anyway would be a tab
// whose only possible outcome is an error. Evaluated once at module load; the page's
// host cannot change without a reload.
const TABS = ['plan', 'execute', 'review', 'port', ...(onLocalhost() ? ['terminal'] : []), 'stats', 'activity'];

// The tab ids in the words a person uses for them. The ids stay as they are: they
// are what the code switches on, and what the arrow keys move between.
const TAB_LABELS = { plan: 'Plan', execute: 'Execute', review: 'Review', port: 'Port', terminal: 'Terminal', stats: 'Stats', activity: 'Activity' };

export function TaskDetail({ id, navigate, onTitle }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('plan');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // When the revision on screen landed. Session-local, and only ever set for a
  // revision that arrived while the user was looking at another tab: the marker means
  // "this changed under you", not "this plan has a predecessor".
  const [revisedAt, setRevisedAt] = useState(null);
  // The parent-task editor, closed until it is asked for: linking is a rare edit
  // and the header is where a task is read, not where it is changed.
  const [linkingParent, setLinkingParent] = useState(false);
  const [parentDraft, setParentDraft] = useState('');
  // The picker's candidates, null until the editor is first opened. Fetched
  // lazily rather than with the page: linking is a rare edit, and most visits to
  // a task never open it.
  const [candidates, setCandidates] = useState(null);
  // Bumped to reopen the event stream. The stream is closed when a task reaches
  // COMPLETE, which used to be the end of the task; a feedback re-opens the
  // workflow, so it has to re-open the stream too or the repair, its test run and
  // its verification review would all happen off screen.
  const [streamGen, setStreamGen] = useState(0);
  // The plan's two editing modes, held here rather than in the plan tab because the
  // next-step bar is what opens them: Edit and Refine sit beside Approve in the bar.
  const [planMode, setPlanMode] = useState(null);
  // What the port tab offers the bar - its chosen destination and the two port
  // calls - registered by the tab, so the bar's Port button ports where the tab says.
  const [portActions, setPortActions] = useState(null);
  const [descOpen, setDescOpen] = useState(false);
  // Whether the clamped description is hiding anything, measured rather than guessed
  // from its length: a short one with line breaks can overflow, a long line may not.
  const descRef = useRef(null);
  const [descLong, setDescLong] = useState(false);
  // The project's name, for the header. The payload carries the project's id and
  // not its name, and the id is the one thing about a project that nobody
  // recognises - so it is fetched alongside, and the header falls back to the short
  // id if the list is unavailable.
  const [projectName, setProjectName] = useState(null);
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
    setLinkingParent(false);
    setParentDraft('');
    setCandidates(null);
    setPlanMode(null);
    setPortActions(null);
    setDescOpen(false);
    seenPlanAtRef.current = undefined;
    liveRef.current = null;
    actionRef.current = null;
    load();
  }, [id, load]);

  const description = data?.task?.description;
  useEffect(() => {
    const measure = () => {
      const el = descRef.current;
      if (el && !el.classList.contains('open')) setDescLong(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [description]);

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
        // and the revision marker all describe the same instant. `parent` rides
        // along untouched: it is set when the page loads and by a link, not by the
        // stream, whose frame carries the task alone.
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
  }, [id, buffer, load, streamGen]);

  // Acting on the revision is the acknowledgement. Opening the tab is not: the dot
  // says "this changed under you", and clearing it on arrival would mean the sentence
  // it was pointing at had already been dismissed by the time it was read.
  const readAction = useCallback(() => actionRef.current, []);
  const acknowledgeRevision = useCallback(() => setRevisedAt(null), []);
  // A stream the client ended is not one the browser retries, so anything that
  // takes a task out of a terminal state has to open a new one. Only the feedback
  // path does, and it is what the repair that follows is watched through.
  const reopenStream = useCallback(() => setStreamGen((n) => n + 1), []);

  // The server's answer, not a scan of the runs table: a run row sits at 'running'
  // for as long as it takes something to notice the process that owned it is gone,
  // and a task state is set before its run starts and cleared after it ends.
  const live = data?.live || null;
  const liveOn = !!live;
  const working = data ? WORKING_STATES.has(data.task.state) : false;
  // Read from the task and the server's live run, never from the current tab, so the
  // banner below and the dot on the tabs bar always name the same step.
  const step = data ? nextStep(data.task, live, data.ported) : null;

  useEffect(() => {
    if (!liveOn && !working) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [liveOn, working, load]);

  // The parent picker's list, fetched the first time the editor is opened. Same
  // project only: the server refuses a cross-project parent, so offering one
  // would be offering a dead end. The task itself is dropped by the picker.
  const projectId = data?.task?.project_id;

  useEffect(() => {
    if (!projectId) return undefined;
    let cancelled = false;
    api
      .projects()
      .then((list) => {
        if (cancelled) return;
        const p = (list || []).find((x) => x.id === projectId);
        if (p) setProjectName(p.name);
      })
      // Swallowed: the header falls back to the project's short id, which is a
      // worse label but not a reason to put an error over the whole page.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!linkingParent || candidates !== null || !projectId) return undefined;
    let cancelled = false;
    api.tasks()
      .then((list) => {
        if (cancelled) return;
        setCandidates((list || []).filter((t) => t.project_id === projectId));
      })
      // Swallowed deliberately: an empty picker is a fine outcome, an error toast
      // over a field the user just opened is not. The picker's own empty state
      // says the list is empty, which is also what an empty answer means here.
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [linkingParent, candidates, projectId]);

  // The id is shown as eight characters and copied whole. The clipboard API needs a
  // secure context and a user gesture, and this is one - a click - so the fallback
  // path is only for a browser that refuses it, and then the id is put in the toast
  // rather than lost.
  async function copyId(full) {
    try {
      await navigator.clipboard.writeText(full);
      showToast('Task id copied.', 'success');
    } catch {
      showToast(full);
    }
  }

  // Cancel stops a run that is in flight; the work it has done so far stays, but the
  // turn is thrown away and whatever it was mid-way through is left where it is.
  async function confirmCancel(task) {
    const ok = await confirmAction({
      title: 'Cancel this run?',
      body: 'The agent stops at its next step. Changes made so far are kept.',
      confirmLabel: 'Cancel run',
      cancelLabel: 'Keep running',
      tone: 'danger',
    });
    if (ok) run(() => api.taskCancel(task.id), 'Cancel requested.');
  }

  // Close is the one that discards: the task is finished with and its worktree goes
  // with it. That is what the dialog has to say, because the button cannot.
  async function confirmClose(task) {
    const ok = await confirmAction({
      title: 'Close this task?',
      body: 'The worktree is deleted. Anything not merged is lost. This can\'t be undone.',
      confirmLabel: 'Close task',
      cancelLabel: 'Keep it',
      tone: 'danger',
    });
    if (ok) run(() => api.taskClose(task.id), 'Task closed.');
  }

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

  // A session task's turns are its conversation's runs, which the task stream does not
  // carry, so the page polls instead: briskly while a turn or its checks are running,
  // slowly otherwise, to catch a reply sent from the conversation itself.
  const sessionEngine = data?.task?.engine === 'session';
  const sessionBusy = sessionEngine && ['WORKING', 'TESTING'].includes(data.task.state);
  useEffect(() => {
    if (!sessionEngine) return undefined;
    const timer = setInterval(load, sessionBusy ? 2000 : 8000);
    return () => clearInterval(timer);
  }, [sessionEngine, sessionBusy, load]);

  if (error) {
    return html`
      <div class="card">
        <p class="error-text">${error}</p>
        <a href="#/tasks" class="link">← Back to tasks</a>
      </div>
    `;
  }
  if (!data) {
    // A skeleton in the page's own shape rather than a spinner and a sentence. The
    // header is the part that takes longest to be worth looking at, and the rows
    // below it say how much is coming.
    return html`
      <div class="view-task-detail">
        <div class="task-header">
          <div class="skeleton-lines">
            <span class="skeleton skeleton-line" style="height:24px;max-width:420px"></span>
            <span class="skeleton skeleton-line short"></span>
          </div>
        </div>
        <${SkeletonRows} count=${5} />
      </div>
    `;
  }

  const { task, runs } = data;

  return html`
    <div class="view-task-detail">
      <div class="task-header">
        <div>
          <div class="task-title-row">
            <h1>${task.title}</h1>
            <${StatusBadge} status=${task.state} />
          </div>
          <div class="task-meta muted">
            ${/* The project's name, not its UUID. The name is what a person
                 recognises; the id is 36 characters of nothing they can use. */ ''}
            <span>${projectName || shortId(task.project_id)}</span>
            <span aria-hidden="true">·</span>
            ${/* The task's own id, shortened and copyable. It was printed in full
                 in the header, where it was the longest string on the page and the
                 one nobody reads - but it is the handle for the CLI, so it has to
                 be gettable, which is what one click on it is for. */ ''}
            <button class="id-chip" type="button" title=${`Copy ${task.id}`} onClick=${() => copyId(task.id)}>
              ${shortId(task.id)}
            </button>
            <span aria-hidden="true">·</span>
            <span>created <${Time} at=${task.created_at} /></span>
            ${
              // The title from the parent row the server sent on this payload, and the
              // id when that row is gone - a link to a task that no longer exists still
              // says which task this one was built on.
              task.parent_id
                ? html`<span>
                    <span aria-hidden="true">·</span> builds on${' '}
                    <a class="link" href=${`#/tasks/${task.parent_id}`}>${data.parent?.title || shortId(task.parent_id)}</a>
                    ${data.parent ? html`<span class="muted">${' '}(${String(data.parent.state).toLowerCase().replace(/_/g, ' ')})</span>` : null}
                  </span>`
                : null
            }
            ${linkingParent
              ? null
              : html`<span aria-hidden="true">·</span>
                  <button
                    class="link-btn"
                    type="button"
                    onClick=${() => {
                      setParentDraft(task.parent_id || '');
                      setLinkingParent(true);
                    }}
                  >
                    ${task.parent_id ? 'Change parent' : 'Link a parent task'}
                  </button>`}
          </div>
          ${task.description && task.description !== task.title
            ? html`<p class="task-description ${descOpen ? 'open' : ''}" ref=${descRef}>${task.description}</p>
                ${descLong || descOpen
                  ? html`<button class="link-btn task-description-toggle" type="button" onClick=${() => setDescOpen((v) => !v)}>${descOpen ? 'Show less' : 'Show all'}</button>`
                  : null}`
            : null}
          ${
            linkingParent
              ? html`
                  <div class="card parent-link-card">
                    <${TaskPicker}
                      label="Parent task"
                      tasks=${candidates || []}
                      value=${parentDraft}
                      onInput=${setParentDraft}
                      placeholder="Search tasks by title"
                      loading=${busy || !candidates}
                      excludeId=${task.id}
                    />
                    <div class="row">
                      <button
                        class="btn"
                        disabled=${busy || !parentDraft.trim()}
                        onClick=${() =>
                          run(async () => {
                            await api.taskLink(task.id, parentDraft.trim());
                            setLinkingParent(false);
                            setParentDraft('');
                          }, 'Parent linked.')}
                      >
                        Link
                      </button>
                      ${task.parent_id
                        ? html`<button class="btn secondary" disabled=${busy} onClick=${() => run(() => api.taskLink(task.id, null), 'Parent cleared.')}>Clear</button>`
                        : null}
                      <button class="btn secondary" onClick=${() => { setLinkingParent(false); setParentDraft(''); }}>Cancel</button>
                    </div>
                  </div>
                `
              : null
          }
        </div>
        ${/* The two verbs that end a task live up here with the way out, not in a
             bar at the foot of a page that can be a thousand lines long. Cancel and
             Close both stop work, and both are irreversible - Cancel abandons a run
             in flight, Close throws the task's worktree away - so neither happens on
             a single click. */ ''}
        <div class="task-header-actions">
          <${MoreMenu}
            label="Task actions"
            items=${[
              { label: 'Copy task id', onSelect: () => copyId(task.id) },
              (task.engine === 'session' || task.state !== 'COMPLETE') && task.state !== 'CANCELLED' && !live
                ? { label: 'Close task…', danger: true, disabled: busy, onSelect: () => confirmClose(task) }
                : null,
            ]}
          />
        </div>
      </div>

      ${data.siblings?.length ? html`<${AttemptStrip} task=${task} siblings=${data.siblings} />` : null}
      ${task.engine === 'session'
        ? html`<${SessionTaskBody} task=${task} data=${data} busy=${busy} run=${run} buffer=${buffer} tab=${tab} setTab=${setTab} />`
        : html`
      <${NextStepBar}
        task=${task}
        runs=${runs}
        live=${live}
        ported=${data.ported}
        revision=${data.revision}
        tab=${tab}
        busy=${busy}
        planMode=${planMode}
        portActions=${portActions}
        readAction=${readAction}
        onGoTo=${setTab}
        onPlanMode=${(m) => {
          acknowledgeRevision();
          setPlanMode(m);
          setTab('plan');
        }}
        onApprove=${() => {
          acknowledgeRevision();
          run(() => api.taskApprove(task.id), 'Plan approved.');
        }}
        onReject=${() => {
          acknowledgeRevision();
          run(() => api.taskReject(task.id), 'Plan rejected.');
        }}
        onCancel=${() => confirmCancel(task)}
        run=${run}
      />

      <${Tabs}
        tabs=${TABS.map((t) => {
          // Two things light a tab the user is not on: a plan revision that landed
          // under them, and the step the workflow is waiting for. A stage that is
          // behind the task carries a check instead.
          const revised = t === 'plan' && !!revisedAt;
          const dot = tab !== t && (revised || t === step?.tab);
          return { id: t, label: TAB_LABELS[t] || t, dot, dotLabel: revised ? 'Plan revised' : 'Next step', done: !dot && stageDone(t, task, data.ported) };
        })}
        value=${tab}
        onChange=${setTab}
        label="Task sections"
      />

      <${TabPanel} tabId=${tab}>
        ${tab === 'plan' ? html`<${PlanTab} task=${task} runs=${runs} busy=${busy} run=${run} live=${live} revision=${data.revision} revisedAt=${revisedAt} readAction=${readAction} onAcknowledge=${acknowledgeRevision} planMode=${planMode} setPlanMode=${setPlanMode} />` : null}
        ${tab === 'execute' ? html`<${ExecuteTab} task=${task} runs=${runs} live=${live} onGoTo=${setTab} copy=${(v) => navigator.clipboard.writeText(v).then(() => showToast('Path copied.', 'success'), () => showToast(v))} />` : null}
        ${tab === 'review' ? html`<${ReviewTab} task=${task} runs=${runs} busy=${busy} run=${run} live=${live} navigate=${navigate} onReopen=${reopenStream} onGoTo=${setTab} />` : null}
        ${tab === 'port' ? html`<${PortTab} task=${task} branches=${data.branches || []} busy=${busy} run=${run} onActions=${setPortActions} />` : null}
        ${tab === 'terminal' ? html`<${TerminalTab} task=${task} live=${live} terminal=${data.terminal} />` : null}
        ${tab === 'stats' ? html`<${StatsTab} runs=${runs} live=${data.live} />` : null}
        ${tab === 'activity' ? html`<${ActivityTab} taskId=${task.id} store=${buffer} runs=${runs} root=${task.worktree} />` : null}
      <//>
        `}
    </div>
  `;
}

// The plan, and the two things that can change underneath it while it is on screen: a
// planner running - the first plan or a refine - and a revision that landed. Both are
// read from the server's `live` and from the revision the task carries, never from a
// local flag, so a reload mid-refine and a second tab see the same thing this one does.
function PlanTab({ task, runs, busy, run, live, revision, revisedAt, readAction, onAcknowledge, planMode, setPlanMode }) {
  // Opened from the next-step bar, which holds Edit and Refine beside Approve.
  const editing = planMode === 'edit';
  const setEditing = (v) => setPlanMode(v ? 'edit' : null);
  const [draft, setDraft] = useState(task.plan || '');
  const refining = planMode === 'refine';
  const setRefining = (v) => setPlanMode(v ? 'refine' : null);
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [view, setView] = useState('plan');
  const [staleDraft, setStaleDraft] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [action, setAction] = useState(null);
  // The provider registry, read once: the planning-model pick is a list of models,
  // and the health beside it is a hint about the pick rather than the authority on
  // it - the router re-reads health at the moment of the run.
  const [registry, setRegistry] = useState(null);
  // The plan the draft was seeded from, so a revision landing mid-edit can be told
  // apart from the user's own typing.
  const draftBaseRef = useRef(task.plan || '');

  const planning = live?.role === 'planner';
  const hasPlan = bodyKind(task.plan) !== 'empty';
  const elapsed = live?.startedAt && Number.isFinite(Date.parse(live.startedAt)) ? now - Date.parse(live.startedAt) : null;

  useEffect(() => {
    let mounted = true;
    api
      .providers()
      .then((d) => {
        if (!mounted) return;
        const health = new Map((d.health || []).map((h) => [h.providerId, h.state]));
        // The same filter the routing screen applies to a role's model list, so a
        // model offered here is one the router would actually consider: enabled,
        // not a mock (which routing never reaches), and carrying the capability.
        const models = (d.models || []).filter((m) => m.enabled && m.provider_id !== 'mock' && (m.capabilities || []).includes('planning'));
        setRegistry({ models, all: d.models || [], health });
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  // The pick, in one place because both branches of this tab render it: the
  // PLANNING-with-no-run branch needs it before a plan exists, and the main stack
  // covers Refine and Replan, which read the same column.
  const planningModelPicker = registry
    ? (() => {
        const label = (m) => `${m.displayName || m.name} — ${m.provider_id}`;
        const options = [{ value: '', label: 'Automatic' }, ...registry.models.map((m) => ({ value: m.id, label: label(m) }))];
        // A model the task names but the registry no longer offers - disabled, or
        // its capability taken away - would leave the select showing a value with
        // no matching option, which renders as an empty box that reads like the
        // setting was lost. Naming it as unavailable keeps the row honest about
        // what is stored, and picking Automatic is the way to clear it.
        if (task.plan_model && !options.some((o) => o.value === task.plan_model)) {
          options.push({ value: task.plan_model, label: `${task.plan_model} (unavailable)` });
        }
        const chosen = registry.all.find((m) => m.id === task.plan_model);
        const open = chosen && registry.health.get(chosen.provider_id) === 'OPEN';
        // The model that actually wrote the plan on screen. The picker shows the
        // preference, and a preference skipped for a provider at its limit left a plan
        // that read as the chosen model's work while awaiting approval.
        const wrote = [...(runs || [])].reverse().find((r) => r.role === 'planner' && r.status === 'succeeded');
        const skipped = task.plan_model && wrote?.model_id && wrote.model_id !== task.plan_model;
        return html`
          <div class="row plan-model">
            <${Select}
              label="Planning model"
              inline
              size="sm"
              value=${task.plan_model || ''}
              disabled=${busy}
              options=${options}
              onChange=${(v) => run(() => api.taskSetPlanModel(task.id, v), 'Planning model saved.')}
            />
            ${open ? html`<span class="muted">this provider is failing, so another model will be used</span>` : null}
            ${skipped ? html`<span class="warn-text">This plan was written by <span class="mono-sm">${wrote.model_id}</span>: the planning model was unavailable</span>` : null}
          </div>
        `;
      })()
    : null;

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


  // PLANNING is both "a planner is running" and "ready for a planner to run". Only the
  // second is this branch; the first is the live block above, which a refine needs
  // just as much and which the state alone cannot tell you about. Without the branch a
  // failed or cancelled plan strands the task behind a loading indicator forever.
  if (task.state === 'PLANNING' && !planning) {
    return html`
      <div class="stack">
        <div class="plan-toolbar"><p class="muted">No plan yet. Start planning from the bar above; the planner uses the model picked here.</p>${planningModelPicker}</div>
      </div>
    `;
  }

  // Before approval the model is still a choice; after it, it is a fact about the plan.
  const choosing = task.state === 'PLANNING' || task.state === 'AWAITING_APPROVAL';
  const planner = [...(runs || [])].reverse().find((r) => r.role === 'planner' && r.status === 'succeeded') || null;

  return html`
    <div class="stack">

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

      <div class="plan-toolbar">
        ${
          hasPlan && revision?.hasPrev
            ? html`
                <div class="seg" role="tablist" aria-label="Plan view">
                  <button type="button" role="tab" aria-selected=${view === 'plan'} class="seg-btn ${view === 'plan' ? 'active' : ''}" onClick=${() => setView('plan')}>Plan</button>
                  <button type="button" role="tab" aria-selected=${view === 'changes'} class="seg-btn ${view === 'changes' ? 'active' : ''}" onClick=${showChanges}>
                    Changes vs previous
                  </button>
                </div>
              `
            : html`<span></span>`
        }
        ${choosing
          ? planningModelPicker
          : html`<span class="muted plan-meta">${planner?.model_id ? html`Planned with <span class="mono-sm">${planner.model_id}</span>` : 'Planned'}${
              // The planning model is a preference: a provider at its limit or in an
              // open circuit is skipped, and the run note saying so sat one click
              // away. Said here, where the model is named, it cannot be missed.
              task.plan_model && planner?.model_id && planner.model_id !== task.plan_model
                ? html` · <span class="warn-text">${task.plan_model} was unavailable</span>`
                : null
            }${revision?.at ? html` · ${formatWhen(revision.at)}` : null}</span>`}
      </div>

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
                    // While the planner runs, the bar above holds Cancel run.
                    planning ? null : html`<button class="btn secondary" onClick=${() => setRefining(false)}>Cancel</button>`
                  }
                </div>
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
//
// `ported` is the third: a completed task whose port has already run has no step
// left to nudge towards, and the port tab holds whatever the port left to do.
function nextStep(task, live, ported) {
  if (live) return null;
  switch (task.state) {
    case 'PLANNING':
    case 'AWAITING_APPROVAL':
      return { tab: 'plan' };
    case 'APPROVED':
    case 'IMPLEMENTING':
      return { tab: 'execute' };
    case 'REVIEWING':
    case 'REPAIRING':
    case 'AWAITING_DECISION':
      return { tab: 'review' };
    case 'COMPLETE':
      return ported ? null : { tab: 'port' };
    case 'FAILED':
      return { tab: task.worktree ? 'execute' : 'plan' };
    default:
      return null;
  }
}

// Whether a stage is behind the task, for the check on its tab. Read from the state
// the task has reached, so a stage is done once the workflow has moved past it.
const PAST_PLAN = new Set(['APPROVED', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'REPAIRING', 'AWAITING_DECISION', 'COMPLETE']);
const PAST_EXECUTE = new Set(['REVIEWING', 'REPAIRING', 'AWAITING_DECISION', 'COMPLETE']);
function stageDone(tab, task, ported) {
  if (tab === 'plan') return PAST_PLAN.has(task.state);
  if (tab === 'execute') return PAST_EXECUTE.has(task.state);
  if (tab === 'review') return task.state === 'COMPLETE';
  if (tab === 'port') return !!ported;
  return false;
}

// What a live run is doing, in the words of its role.
const LIVE_VERB = { planner: 'Planning', implementer: 'Implementing', tester: 'Testing', reviewer: 'Reviewing', repair: 'Repairing', chat: 'Answering' };

// The one place on the page for the task's next move: what happened, what comes
// next, and the button that does it. It sits between the header and the tabs and is
// the same on every tab, so the action is never repeated tab by tab and never sits
// beside Close. When the next move is a form - feedback for a refine, an answer to
// the review's question - the bar names it and the form stays in its tab.
function NextStepBar({ task, runs, live, ported, revision, tab, busy, planMode, portActions, readAction, onGoTo, onPlanMode, onApprove, onReject, onCancel, run }) {
  const [now, setNow] = useState(Date.now());
  const [action, setAction] = useState(null);
  useEffect(() => {
    if (!live) return undefined;
    const tick = () => {
      setNow(Date.now());
      setAction(readAction?.() || null);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [live, readAction]);

  const lastOf = (role) => [...(runs || [])].reverse().find((r) => r.role === role) || null;
  const bar = barFor();
  if (!bar) return null;

  function barFor() {
    if (live) {
      const started = Date.parse(live.startedAt);
      const elapsed = Number.isFinite(started) ? formatDuration(now - started) : null;
      const verb = live.role === 'planner' && task.plan ? 'Refining the plan' : LIVE_VERB[live.role] || live.role;
      const doing = action ? describeEvent(action)?.text : null;
      return {
        tone: 'info',
        spinner: true,
        title: elapsed ? `${verb} · ${elapsed}` : verb,
        detail: doing || `${live.providerId || ''}${live.modelId ? ` / ${live.modelId}` : ''}`,
        actions: [{ label: 'Cancel run', kind: 'danger', onClick: onCancel }],
      };
    }
    switch (task.state) {
      case 'PLANNING': {
        const planner = lastOf('planner');
        const failed = planner && planner.status === 'failed';
        return {
          tone: failed ? 'bad' : 'info',
          icon: failed ? 'cross' : 'plan',
          title: failed ? 'The last planning attempt failed' : 'Not planned yet',
          detail: failed ? html`${planner.error || 'Unknown error'} · <a class="link" href=${`#/runs/${planner.id}`}>See the run</a>` : 'The planner reads the task and the code, and writes a plan for you to approve.',
          actions: [{ label: 'Start planning', kind: 'primary', onClick: () => run(() => api.taskPlan(task.id), 'Plan ready.') }],
        };
      }
      case 'AWAITING_APPROVAL': {
        if (planMode === 'refine') return { tone: 'info', icon: 'plan', title: 'Refining the plan', detail: 'Say what should change below, then submit it.' };
        if (planMode === 'edit') return { tone: 'info', icon: 'plan', title: 'Editing the plan', detail: 'Save or cancel your edits below.' };
        const planner = lastOf('planner');
        const by = planner?.model_id ? html`written by <span class="mono-sm">${planner.model_id}</span> ` : 'written ';
        return {
          tone: 'info',
          icon: 'plan',
          title: 'Plan ready for your approval',
          detail: html`${revision?.at ? html`${by}${formatWhen(revision.at)}. ` : null}Nothing is written until you approve.`,
          actions: [
            { label: 'Reject', kind: 'danger', onClick: onReject },
            { label: 'Edit', kind: 'secondary', onClick: () => onPlanMode('edit') },
            { label: 'Refine', kind: 'secondary', onClick: () => onPlanMode('refine') },
            { label: 'Approve plan', kind: 'primary', onClick: onApprove },
          ],
        };
      }
      case 'APPROVED':
        return {
          tone: 'info',
          icon: 'play',
          title: 'Plan approved',
          detail: 'Execution carries out the plan on a new branch, in its own worktree.',
          actions: [{ label: 'Start execution', kind: 'primary', onClick: () => run(() => api.taskExecute(task.id), 'Execution started.') }],
        };
      case 'IMPLEMENTING':
        return {
          tone: 'warn',
          icon: 'alert',
          title: 'No implementer running',
          detail: 'The implementer stopped before finishing. Reset the task to start execution again. Changes made so far are kept.',
          actions: [{ label: 'Reset', kind: 'primary', onClick: () => run(() => api.taskApprove(task.id), 'Reset. Start execution when ready.') }],
        };
      case 'REVIEWING': {
        const reviewer = lastOf('reviewer');
        const failed = reviewer && reviewer.status !== 'succeeded' && reviewer.status !== 'running' ? reviewer : null;
        return {
          tone: failed ? 'bad' : 'info',
          icon: failed ? 'cross' : 'review',
          title: failed ? 'The last review did not finish' : 'Ready for review',
          detail: failed
            ? html`${failed.error || `The reviewer ${failed.status}`} · ${formatWhen(failed.ended_at || failed.started_at)}. The change is untouched.`
            : 'The reviewer checks the change against the approved plan.',
          actions: [{ label: failed ? 'Try the review again' : 'Start review', kind: 'primary', onClick: () => run(() => api.taskReview(task.id), 'Review started.') }],
        };
      }
      case 'REPAIRING':
        return {
          tone: 'warn',
          icon: 'alert',
          title: 'Review requested changes',
          detail: task.feedback ? html`Your feedback: “${task.feedback}”` : 'The repair fixes what the review found, then the change is reviewed again.',
          actions: [{ label: 'Repair', kind: 'primary', onClick: () => run(() => api.taskRepair(task.id), 'Repair started.') }],
        };
      case 'AWAITING_DECISION':
        return {
          tone: 'warn',
          icon: 'question',
          title: 'The review needs your decision',
          detail: 'Pick an option or write the instruction yourself. Nothing runs until you approve a repair.',
          actions: tab === 'review' ? [] : [{ label: 'Go to the question', kind: 'primary', onClick: () => onGoTo('review') }],
        };
      case 'COMPLETE': {
        if (ported) return null;
        if (tab === 'port' && portActions) {
          if (!portActions.actionable) return { tone: 'good', icon: 'check', title: 'Review passed', detail: portActions.headline || 'Nothing to port.' };
          return {
            tone: 'good',
            icon: 'check',
            title: 'Review passed',
            detail: html`Porting commits the change and merges it into <b>${portActions.target}</b>.`,
            actions: [
              { label: 'Preview', kind: 'secondary', onClick: portActions.preview },
              { label: `Port onto ${portActions.target}`, kind: 'primary', onClick: portActions.port },
            ],
          };
        }
        return {
          tone: 'good',
          icon: 'check',
          title: 'Review passed',
          detail: 'Port the change to merge it into a branch.',
          actions: [{ label: 'Port this change', kind: 'primary', onClick: () => onGoTo('port') }],
        };
      }
      case 'FAILED': {
        const last = [...(runs || [])].reverse().find((r) => r.status === 'failed') || null;
        return {
          tone: 'bad',
          icon: 'cross',
          title: 'The last run failed',
          detail: last?.error || 'Unknown error',
          actions: [
            { label: 'Replan', kind: task.worktree ? 'secondary' : 'primary', onClick: () => run(() => api.taskReplan(task.id), 'Replanning...') },
            task.worktree ? { label: 'Retry tests', kind: 'primary', onClick: () => run(() => api.taskRetry(task.id), 'Retrying...') } : null,
          ].filter(Boolean),
        };
      }
      default:
        return null;
    }
  }

  const ICON = {
    plan: html`<path d="M3 3.5h10M3 8h10M3 12.5h6" />`,
    play: html`<path d="M5 3.5v9l7-4.5z" />`,
    review: html`<circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" />`,
    check: html`<path d="m3.5 8.5 3 3 6-7" />`,
    cross: html`<path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />`,
    alert: html`<path d="M8 4v5M8 11.5h.01" />`,
    question: html`<path d="M6 6a2 2 0 1 1 3 1.7c-.6.4-1 .8-1 1.5M8 11.5h.01" />`,
  };

  return html`
    <section class="next-bar tone-${bar.tone}" aria-label="Next step" aria-live="polite">
      <span class="next-bar-icon" aria-hidden="true">
        ${bar.spinner ? html`<span class="next-bar-spin"></span>` : html`<svg viewBox="0 0 16 16">${ICON[bar.icon] || ICON.plan}</svg>`}
      </span>
      <div class="next-bar-text">
        <b>${bar.title}</b>
        ${bar.detail ? html`<span>${bar.detail}</span>` : null}
      </div>
      ${(bar.actions || []).length
        ? html`<div class="next-bar-actions">
            ${bar.actions.map(
              (a) => html`<button
                key=${a.label}
                type="button"
                class="btn ${a.kind === 'primary' ? 'primary' : a.kind === 'danger' ? 'danger-outline' : 'secondary'}"
                disabled=${busy}
                onClick=${a.onClick}
              >
                ${a.label}
              </button>`
            )}
          </div>`
        : null}
    </section>
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

// The run's role as the step it was, for a list read down as a history.
const RAN_VERB = { planner: 'Planned', implementer: 'Implemented', tester: 'Tested', reviewer: 'Reviewed', repair: 'Repaired', chat: 'Question' };

function ExecuteTab({ task, runs, live, onGoTo, copy }) {
  const base = planBase(task);
  const list = runs || [];
  const spent = list.reduce((n, r) => n + (Number(r.cost) || 0), 0);
  const worked = list.reduce((n, r) => n + (Number(r.duration_ms) || 0), 0);
  const branch = task.branch || `ai-code/${task.id}`;
  return html`
    <div class="stack">
      <section class="card exec-tree" aria-label="Worktree">
        ${task.worktree
          ? html`<div class="exec-tree-row">
              <svg class="ss-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="12" r="1.5" /><path d="M5 5.5v5" /></svg>
              <span class="mono-sm">${task.branch || branch}</span>
              ${task.base_commit ? html`<span class="muted">from</span><span class="mono-sm" title=${task.base_commit}>${String(task.base_commit).slice(0, 7)}</span>` : null}
              <span class="muted" aria-hidden="true">·</span>
              <span class="mono-sm muted exec-tree-path" title=${task.worktree}>${shortDir(task.worktree)}</span>
              <button class="btn secondary sm" type="button" onClick=${() => copy(task.worktree)}>Copy path</button>
              ${TABS.includes('terminal') ? html`<button class="link-btn" type="button" onClick=${() => onGoTo('terminal')}>Open a terminal</button>` : null}
            </div>`
          : html`<div class="exec-tree-row muted">
              <svg class="ss-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="12" r="1.5" /><path d="M5 5.5v5" /></svg>
              <span>No worktree yet. Execution creates one on a new branch, <span class="mono-sm" title=${branch}>${branch}</span>.</span>
            </div>`}
        ${base
          ? html`<div class="exec-tree-row exec-tree-base">
              <span class="muted">Plan baseline</span>
              <span class="mono-sm">${String(base.head || '').slice(0, 12)}</span>
              <span class="muted">· ${base.dirty && base.dirty.length ? `${base.dirty.length} uncommitted file${base.dirty.length === 1 ? '' : 's'} when planned` : 'no uncommitted files when planned'}</span>
            </div>`
          : null}
      </section>

      ${base && base.conflicts && base.conflicts.length
        ? html`<div class="notice notice-warn">
            <b>Plan conflicts.</b> These files changed after the plan was written:${' '}${base.conflicts.map((c, i) => html`${i ? ', ' : ''}<span class="mono-sm">${c}</span>`)}.
          </div>`
        : null}

      <section class="card exec-runs" aria-label="What ran">
        <div class="exec-runs-head">
          <h2>What ran</h2>
          <span class="muted">${list.length} run${list.length === 1 ? '' : 's'}${spent ? ` · ${formatCost(spent)}` : ''}${worked ? ` · ${formatDuration(worked)} of work` : ''}</span>
        </div>
        ${list.length
          ? html`<ol class="exec-timeline">
              ${list.map((r) => {
                const tone = r.status === 'succeeded' ? 'good' : r.status === 'failed' ? 'bad' : r.status === 'running' ? 'info' : 'muted';
                const model = r.role === 'tester' ? null : [r.provider_id, r.model_id].filter(Boolean).join(' / ');
                const facts = [
                  r.role === 'tester' ? null : r.tokens ? `${formatTokens(r.tokens)} tokens` : null,
                  r.role === 'tester' ? null : r.cost ? formatCost(r.cost) : null,
                  r.duration_ms ? formatDuration(r.duration_ms) : null,
                ].filter(Boolean);
                return html`<li class="exec-step" key=${r.id}>
                  <span class="exec-dot ${tone}" aria-hidden="true"></span>
                  <b>${RAN_VERB[r.role] || r.role}</b>
                  <span class="muted exec-what">
                    ${r.status === 'failed' ? html`<span class="bad">Failed</span>${r.error ? html`: ${r.error}` : ''} · ` : r.status === 'running' ? html`<span class="info">Running</span> · ` : r.role === 'tester' && r.status === 'succeeded' ? html`<span class="good">Passed</span> · ` : r.status !== 'succeeded' ? html`${r.status} · ` : ''}
                    ${model ? html`<span class="mono-sm">${model}</span>` : null}${model && facts.length ? ' · ' : ''}${facts.join(' · ')}
                    ${r.status === 'failed' ? html` · <a class="link" href=${`#/runs/${r.id}`}>See the run</a>` : null}
                  </span>
                  <span class="muted exec-when"><${Time} at=${r.started_at} /></span>
                </li>`;
              })}
            </ol>`
          : html`<p class="muted">Nothing has run yet.</p>`}
      </section>
    </div>
  `;
}


// A role that ran more than once is numbered, and the number is the run's
// ordinal within its own role rather than its index in the list: two repairs
// read as "repair (1)" and "repair (2)" whatever else ran between them. Numbering
// by index would label the second repair "repair (5)" on a five-run task.
function roleLabels(runs) {
  const total = new Map();
  for (const r of runs) total.set(r.role, (total.get(r.role) || 0) + 1);
  const seen = new Map();
  return runs.map((r) => {
    const n = (seen.get(r.role) || 0) + 1;
    seen.set(r.role, n);
    return total.get(r.role) > 1 ? `${r.role} (${n})` : r.role;
  });
}

// Compute task-level aggregates from the runs list. `live` is the run in flight:
// its duration is not written to the row until the run closes, so its elapsed
// time is added here. Without that the wall clock grows while the active time
// stands still, and the difference is reported as waiting - during a run, which
// is the one thing it is not.
function taskStats(runs, live) {
  const now = Date.now();
  let totalCost = 0;
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let activeDuration = 0;
  let minStart = Infinity;
  let maxEnd = 0;
  let succeeded = 0;
  let failed = 0;
  let fallbacks = 0;

  for (const r of runs) {
    totalCost += Number(r.cost) || 0;
    totalTokens += Number(r.tokens) || 0;
    inputTokens += Number(r.input_tokens) || 0;
    outputTokens += Number(r.output_tokens) || 0;
    activeDuration += Number(r.duration_ms) || 0;

    // A run's end is its own, read the way the timeline reads it: the closed
    // row's timestamp, or its start plus what it measured. A row that never
    // closed contributes no span here - the run in flight is added below, from
    // its lease, where its real start is known.
    const start = r.started_at ? Date.parse(r.started_at) : now;
    const end = r.ended_at ? Date.parse(r.ended_at) : start + (Number(r.duration_ms) || 0);
    minStart = Math.min(minStart, start);
    maxEnd = Math.max(maxEnd, end);

    if (r.status === 'succeeded') succeeded += 1;
    else if (r.status === 'failed') failed += 1;
    if (r.fallback_from) fallbacks += 1;
  }

  // The run in flight, measured from its start to now. Its own row contributes
  // nothing above (duration_ms is still 0), which is exactly the gap this fills.
  if (live && live.startedAt) {
    const started = Date.parse(live.startedAt);
    if (!Number.isNaN(started)) {
      activeDuration += Math.max(0, now - started);
      minStart = Math.min(minStart, started);
      maxEnd = Math.max(maxEnd, now);
    }
  }

  const wallClockDuration = minStart === Infinity ? 0 : Math.max(0, maxEnd - minStart);
  const waitingDuration = Math.max(0, wallClockDuration - activeDuration);

  return {
    cost: totalCost,
    tokens: totalTokens,
    inputTokens,
    outputTokens,
    activeDuration,
    wallClockDuration,
    waitingDuration,
    succeeded,
    failed,
    fallbacks,
  };
}

function StatsTab({ runs, live }) {
  if (!runs || !runs.length) {
    return html`<${EmptyState} message="No runs yet." />`;
  }

  const stats = taskStats(runs, live);

  // One bar per run, so a repeated role needs its ordinal to tell the two apart.
  const labels = roleLabels(runs);
  const costBars = runs.map((r, i) => ({ label: labels[i], value: Number(r.cost) || 0 }));
  const tokenBars = runs.map((r, i) => ({ label: labels[i], value: Number(r.tokens) || 0 }));

  // Data table columns and rows
  const runColumns = [
    { key: 'role', label: 'Role', sortable: true },
    {
      key: 'provider_model',
      label: 'Provider / model',
      sortable: true,
      // One column over two fields, so it sorts on the rendered pair rather than
      // on a key no row carries.
      sortValue: (r) => `${r.provider_id || ''} / ${r.model_id || ''}`,
      render: (r) => `${r.provider_id || '—'} / ${r.model_id || '—'}`,
    },
    { key: 'status', label: 'Status', sortable: true, render: (r) => html`<${StatusBadge} status=${r.status} />` },
    {
      key: 'tokens',
      label: 'Tokens',
      sortable: true,
      render: (r) => formatTokens(r.tokens),
    },
    {
      key: 'cost',
      label: 'Cost',
      sortable: true,
      render: (r) => formatCost(r.cost),
    },
    {
      key: 'duration_ms',
      label: 'Duration',
      sortable: true,
      render: (r) => formatDuration(r.duration_ms),
    },
    {
      key: 'started_at',
      label: 'Started',
      sortable: true,
      render: (r) => html`<${Time} at=${r.started_at} />`,
    },
  ];

  const runNote = stats.waitingDuration > 0 ? `${formatDuration(stats.waitingDuration)} waiting` : 'No waiting';

  return html`
    <div class="stack">
      <div class="metric-grid">
        <div class="card metric-card">
          <div class="metric-label muted">Total cost</div>
          <div class="metric-value">${formatCost(stats.cost)}</div>
        </div>
        <div class="card metric-card">
          <div class="metric-label muted">Total tokens</div>
          <div class="metric-value">${Number(stats.tokens).toLocaleString()}</div>
          <div class="metric-note muted">${formatTokens(stats.inputTokens)} in, ${formatTokens(stats.outputTokens)} out</div>
        </div>
        <div class="card metric-card">
          <div class="metric-label muted">Active time</div>
          <div class="metric-value">${formatDuration(stats.activeDuration)}</div>
        </div>
        <div class="card metric-card">
          <div class="metric-label muted">Wall-clock time</div>
          <div class="metric-value">${formatDuration(stats.wallClockDuration)}</div>
          <div class="metric-note muted">${runNote}</div>
        </div>
        <div class="card metric-card">
          <div class="metric-label muted">Runs</div>
          <div class="metric-value">${runs.length}</div>
          <div class="metric-note muted">
            ${stats.succeeded} succeeded${stats.failed ? `, ${stats.failed} failed` : ''}${stats.fallbacks ? `, ${stats.fallbacks} fallback(s)` : ''}
          </div>
        </div>
      </div>

      <figure class="section card chart-card">
        <figcaption class="chart-head">
          <h2>Run timeline</h2>
        </figcaption>
        <${RunTimeline} runs=${runs} live=${live} />
      </figure>

      <figure class="section card chart-card">
        <figcaption class="chart-head">
          <h2>Cost per run</h2>
        </figcaption>
        <${BarChart}
          items=${costBars}
          title="Cost per run"
          ariaLabel=${`Cost per run: ${costBars.map((r) => `${r.label} ${formatCost(r.value)}`).join(', ') || 'no data'}.`}
          formatValue=${formatCost}
        />
      </figure>

      <figure class="section card chart-card">
        <figcaption class="chart-head">
          <h2>Tokens per run</h2>
        </figcaption>
        <${BarChart}
          items=${tokenBars}
          title="Tokens per run"
          ariaLabel=${`Tokens per run: ${tokenBars.map((r) => `${r.label} ${compactNumber(r.value)}`).join(', ') || 'no data'}.`}
          formatValue=${compactNumber}
        />
      </figure>

      <section class="section card">
        <h2>Runs</h2>
        <div class="table-scroll">
          <${DataTable} columns=${runColumns} rows=${runs} rowKey=${(r) => r.id} />
        </div>
      </section>
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
// Where each state sits on the way to a review, for the tab that has nothing to show
// yet. The step is the one the task is on; the text is what is happening in it; the
// tab is where the next move is made.
const BEFORE_REVIEW = {
  CREATED: { step: 0, text: 'Not planned yet', tab: 'plan', cta: 'Go to the plan' },
  PLANNING: { step: 0, text: 'Being planned', tab: 'plan', cta: 'Go to the plan' },
  AWAITING_APPROVAL: { step: 0, text: 'Waiting for your approval', tab: 'plan', cta: 'Go to the plan', note: 'Approve, refine or edit the plan.' },
  APPROVED: { step: 1, text: 'Approved, ready to run', tab: 'execute', cta: 'Go to execute', note: 'Start execution to carry out the plan.' },
  IMPLEMENTING: { step: 1, text: 'Running', tab: 'execute', cta: 'Watch it run' },
  TESTING: { step: 1, text: 'Testing', tab: 'execute', cta: 'Watch it run' },
};

const REVIEW_STEPS = [
  { label: 'Plan', about: 'A plan you approve before any code is written.' },
  { label: 'Execute', about: 'The plan is carried out in a worktree, then tested.' },
  { label: 'Review', about: 'The change is checked against the plan.' },
  { label: 'Port', about: 'You land the reviewed change on a branch.' },
];

function ReviewProgress({ state, onGoTo }) {
  const at = BEFORE_REVIEW[state];
  return html`
    <section class="card review-card" aria-label="Where this task is">
      <div class="review-head">
        <h2>Nothing to review yet</h2>
        <p class="muted">Review runs once the plan is approved and carried out. This task is at the ${REVIEW_STEPS[at.step].label.toLowerCase()} step.</p>
      </div>
      <ol class="review-steps">
        ${REVIEW_STEPS.map(
          (st, i) => html`
            <li class="review-step ${i < at.step ? 'done' : i === at.step ? 'current' : ''} ${i === 2 ? 'here' : ''}" key=${st.label} aria-current=${i === at.step ? 'step' : null}>
              <div class="review-step-mark"><span>${i < at.step ? '✓' : i + 1}</span>${i < REVIEW_STEPS.length - 1 ? html`<i></i>` : null}</div>
              <b>${st.label}${i === 2 ? html` <small>· this tab</small>` : null}</b>
              <span>${i === at.step ? at.text : st.about}</span>
            </li>
          `
        )}
      </ol>
      <div class="review-foot">
        <span class="muted">${at.note || 'Nothing to do here until it reaches review.'}</span>
        <button class="btn primary" type="button" onClick=${() => onGoTo?.(at.tab)}>${at.cta}</button>
      </div>
    </section>
  `;
}

// The files a unified diff touches, with what each gained and lost. Counted inside
// hunks only: a `---` or `+++` outside one is a file header, and inside one it is a
// deleted or added line that happens to start with dashes.
function diffFiles(diff) {
  const files = [];
  let cur = null;
  let inHunk = false;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/ b\/(.+)$/);
      cur = { path: m ? m[1] : line.slice(11), added: 0, removed: 0 };
      files.push(cur);
      inHunk = false;
    } else if (line.startsWith('@@')) inHunk = true;
    else if (!cur || !inHunk) continue;
    else if (line.startsWith('+')) cur.added++;
    else if (line.startsWith('-')) cur.removed++;
  }
  return files;
}

// The plan's top-level steps, counted the way it is written: numbered lines at the
// left margin. A plan written as prose has none, and says nothing about a count.
function planSteps(plan) {
  return String(plan || '').split('\n').filter((l) => /^\d+[.)]\s/.test(l)).length;
}

function FileRow({ f }) {
  const cut = f.path.lastIndexOf('/');
  return html`
    <li>
      <span class="review-file-mark ${f.fresh ? 'fresh' : ''}"></span>
      <span class="review-file-path">${cut >= 0 ? html`<span class="muted">${f.path.slice(0, cut + 1)}</span>` : null}${f.path.slice(cut + 1)}</span>
      ${f.added != null
        ? html`<span class="good">+${f.added}</span><span class="bad">−${f.removed}</span>`
        : f.fresh
          ? html`<span class="good review-new">new</span>`
          : null}
    </li>
  `;
}

// The review, before it has run. What the reviewer will read, what it will read it
// against, and who will read it - the three things a person decides "start it now"
// on - with the last attempt's failure on top when there was one.
function ReadyForReview({ task, runs, busy, run, onAsk, onGoTo }) {
  const [change, setChange] = useState(null);
  const [policy, setPolicy] = useState(null);
  const [showDiff, setShowDiff] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .taskDiff(task.id)
      .then((d) => alive && setChange(d))
      .catch(() => alive && setChange({ diff: '', files: [] }));
    api
      .routing()
      .then((r) => alive && setPolicy(r?.reviewer || {}))
      .catch(() => alive && setPolicy({}));
    return () => {
      alive = false;
    };
  }, [task.id]);

  const reviews = runs.filter((r) => r.role === 'reviewer');
  const last = reviews[reviews.length - 1] || null;
  const failed = last && last.status !== 'succeeded' && last.status !== 'running' ? last : null;
  const tests = [...runs].reverse().find((r) => r.role === 'tester') || null;
  const steps = planSteps(task.plan);

  // Counted from the diff, plus the files the diff cannot show: git's diff leaves out
  // what it has not been told about, so a new file is in the status list and not in
  // the diff - and a change whose only file is new would otherwise read as empty.
  const counted = change ? diffFiles(change.diff) : [];
  const seen = new Set(counted.map((f) => f.path));
  const extra = (change?.files || [])
    .map((line) => {
      const raw = String(line);
      // Status rows carry a two-letter code; a plain path list does not.
      const coded = /^[ MADRCU?!]{2} /.test(raw);
      return { path: (coded ? raw.slice(3) : raw).trim(), fresh: coded && raw.startsWith('??') };
    })
    .filter((f) => f.path && !seen.has(f.path))
    .map((f) => ({ path: f.path, added: null, removed: null, fresh: f.fresh }));
  const files = [...counted, ...extra];
  const added = counted.reduce((n, f) => n + f.added, 0);
  const removed = counted.reduce((n, f) => n + f.removed, 0);
  const strategy = policy?.strategy || 'quality';
  const preferred = policy?.preferred?.[0] || null;

  return html`
    <section class="card review-card" aria-label="Ready for review">
      <div class="review-head review-head-icon">
        <span class="review-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3M5 7l1.5 1.5L9.5 5.5" /></svg>
        </span>
        <div>
          <h2>Ready for review</h2>
          <p class="muted">The reviewer reads this change against the approved plan and returns a pass, a failure with findings to repair, or a question for you.</p>
        </div>
      </div>

      ${failed
        ? html`
            <div class="review-alert" role="alert">
              <div>
                <b>The last review did not finish</b>
                <span>${failed.model_id || 'The reviewer'} ${failed.status === 'cancelled' ? 'was cancelled' : 'failed'}${failed.error ? html`: ${failed.error}` : ''} · <${Time} at=${failed.ended_at || failed.started_at} />. The change is untouched. Run the review again to retry.</span>
              </div>
              <a class="link" href=${`#/runs/${failed.id}`}>See the run</a>
            </div>
          `
        : null}

      <div class="review-body">
        <div class="review-change">
          <div class="review-label">
            <h3>The change</h3>
            ${change
              ? html`<span class="muted">${files.length} file${files.length === 1 ? '' : 's'}${counted.length ? html` · <span class="good">+${added}</span> <span class="bad">−${removed}</span>` : null}</span>`
              : null}
          </div>
          ${!change
            ? html`<${SkeletonRows} count=${3} />`
            : files.length
              ? html`<ul class="review-files">${files.slice(0, 20).map((f) => html`<${FileRow} key=${f.path} f=${f} />`)}</ul>
                  ${files.length > 20 ? html`<span class="muted">and ${files.length - 20} more</span>` : null}`
              : html`<p class="muted">No change was found for this task. The reviewer will have nothing to read.</p>`}
          ${change?.diff
            ? html`
                <button class="link-btn review-toggle" type="button" aria-expanded=${showDiff} onClick=${() => setShowDiff((v) => !v)}>
                  ${showDiff ? 'Hide the change' : 'View the change'}
                </button>
                ${showDiff ? html`<${DiffViewer} diff=${change.diff} />` : null}
              `
            : null}
        </div>

        <dl class="review-facts">
          <div>
            <dt>Checked against</dt>
            <dd>The approved plan${steps ? ` · ${steps} step${steps === 1 ? '' : 's'}` : ''}</dd>
            <dd><button class="link-btn" type="button" onClick=${() => onGoTo?.('plan')}>Open the plan</button></dd>
          </div>
          <div>
            <dt>Reviewer</dt>
            <dd>${preferred ? html`<span class="mono-sm">${preferred}</span>` : 'Automatic'} <span class="muted">· ${strategy[0].toUpperCase() + strategy.slice(1)} strategy</span></dd>
            ${failed?.model_id ? html`<dd class="muted">Last attempt used ${failed.model_id}.</dd>` : null}
            <dd><a class="link" href="#/routing">Change in Routing</a></dd>
          </div>
          <div>
            <dt>Tests</dt>
            <dd class="review-tests ${tests ? (tests.status === 'succeeded' ? 'good' : tests.status === 'failed' ? 'bad' : '') : ''}">
              <span class="health ${tests?.status === 'succeeded' ? 'good' : tests?.status === 'failed' ? 'bad' : 'warn'}"></span>
              ${tests ? (tests.status === 'succeeded' ? 'Passed after execution' : tests.status === 'failed' ? 'Failed after execution' : `Test run ${tests.status}`) : 'No test run recorded'}
            </dd>
          </div>
        </dl>
      </div>

      <div class="review-foot">
        <span class="muted">${reviews.length ? `Attempt ${reviews.length + 1} of the review.` : 'Nothing leaves the worktree until the review passes and you port it.'}</span>
        <button class="btn secondary" type="button" disabled=${busy} onClick=${onAsk}>Ask about this change</button>

      </div>
    </section>
  `;
}

function PortTab({ task, branches, busy, run, onActions }) {
  const [chosen, setChosen] = useState(null);
  const [removeWorktree, setRemoveWorktree] = useState(false);
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

  // The bar above the tabs holds Preview and Port, since that is where every other
  // state's main action lives; this tab keeps what they act on: the destination and
  // whether the worktree goes with it. The registration is cleared on the way out so
  // the bar never offers a port against a view that is gone.
  const st0 = view?.state;
  const actionable0 = !!view && st0?.key !== 'landed' && st0?.key !== 'empty';
  useEffect(() => {
    if (!onActions) return undefined;
    onActions(
      view
        ? {
            actionable: actionable0,
            headline: st0?.headline || '',
            branch: view.branch,
            target,
            preview: () => port({ to: target, dryRun: true }),
            port: () => port({ to: target, clean: removeWorktree && !!view.worktree }),
          }
        : null
    );
  }, [view, target, removeWorktree, actionable0]);
  useEffect(() => () => onActions && onActions(null), []);

  if (error) return html`<div class="card"><p class="error-text">${error}</p></div>`;
  if (!view) return html`<${Spinner} message="Checking the changes..." />`;

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

  const copy = (v) => navigator.clipboard.writeText(v).then(() => showToast('Command copied.', 'success'), () => showToast(v));

  return html`
    <div class="stack">
      <section class="card port-verdict tone-${st.tone}" aria-label="Verdict">
        <div class="port-head">
          <span class="badge badge-${st.tone}">${st.badge}</span>
          <h2>${st.headline}</h2>
        </div>
        ${st.detail ? html`<p class="muted">${st.detail}</p>` : null}
        ${refs.length
          ? html`<div class="refs">${refs.map(
              (r) => html`<div class="ref" key=${r.sha}>
                <span class="muted">${r.label}</span>
                <code class="ref-sha">${r.short}</code>
                <span class="ref-subject">${r.subject}</span>
              </div>`
            )}</div>`
          : null}
        ${note ? html`<p class="port-result">${portReport(note)}</p>` : null}
      </section>

      <div class="port-grid">
        <section class="card port-dest" aria-label="Destination">
          <h3>Destination</h3>
          <${Select} label="Merge into" value=${target} disabled=${busy} onChange=${setChosen} options=${options} />
          ${view.alreadyPorted ? html`<p class="muted">Pick another branch to check it instead.</p>` : null}
          ${actionable && view.worktree
            ? html`<${Toggle} checked=${removeWorktree} disabled=${busy} onChange=${setRemoveWorktree} label="Delete the worktree after porting" />`
            : null}
          ${actionable
            ? html`<p class="muted port-tests-note">
                Tests aren't re-run after the merge. Run them on ${target} if you want to be sure.
              </p>`
            : html`<p class="muted">Nothing to do.</p>`}
        </section>

        ${steps.length
          ? html`<section class="card port-steps" aria-label="Next steps">
              <h3>Next steps</h3>
              <ol class="steps">
                ${steps.map(
                  (s, i) => html`<li key=${i}>
                    <span>${s.text}</span>
                    ${s.command
                      ? html`<div class="port-cmd">
                          <pre class="code-block">${s.command}</pre>
                          <button class="btn secondary sm" type="button" onClick=${() => copy(s.command)}>Copy</button>
                        </div>`
                      : null}
                  </li>`
                )}
              </ol>
            </section>`
          : null}
      </div>

      <section class="card port-details" aria-label="Details">
        <h3>Details</h3>
        <dl class="port-dl">
          ${dlRow('Worktree', worktreeText(view))}
          ${dlRow('Branch', view.branch)}
          ${dlRow('Destination', `${view.target} at ${String(view.targetTip || '').slice(0, 7)}`)}
          ${dlRow('Merge', conflicts.length ? `${conflicts.length} conflict(s)` : view.clean === null ? 'Unknown' : 'Clean')}
          ${blocked.length ? dlRow('Blocked by', blocked.join(', ')) : null}
          ${conflicts.length ? dlRow('Conflicts', conflicts.join(', ')) : null}
          ${view.premisesMoved?.length ? dlRow('Changed since planning', view.premisesMoved.join(', ')) : null}
        </dl>
      </section>

      <section class="card port-change" aria-label="The change">
        <h3>${changeLabel(view)}</h3>
        ${view.diff?.trim() ? html`<${DiffViewer} diff=${view.diff} nav=${true} storageKey=${`task:${task.id}`} untracked=${view.untracked} />` : html`<div class="muted">No change was found for this task.</div>`}
      </section>
    </div>
  `;
}

function dlRow(label, value) {
  if (value === undefined || value === null || value === '') return null;
  return html`<div class="port-dl-row" key=${label}><dt>${label}</dt><dd>${value}</dd></div>`;
}

// What the diff pane is showing, which is one of three things and they are not
// interchangeable: work the worktree is still holding, the commits the branch holds, or the
// change already in the destination. Leaving the label at "Change" is much of what made a
// landed port read as work still waiting to be ported.
//
// `branch` and `commit` name the same place - the branch - and differ only in whether the
// work arrived in one commit a port wrote or in the several an agent wrote, which is not a
// distinction the person reading the pane has any use for.
function changeLabel(view) {
  if (view.state?.key === 'landed') return `The change, as merged into ${view.target}`;
  if (view.from === 'worktree') return 'The change (not committed yet)';
  if (view.from === 'commit' || view.from === 'branch') return `The change on ${view.branch}`;
  return 'The change';
}

// Where the work is held, which is the worktree while it is there and the branch once it
// is not. A directory that has been removed is not the same as work that has been lost,
// and the difference is the one this screen exists to make.
function worktreeText(view) {
  if (view.worktree) return view.pending ? 'Has uncommitted changes' : 'Up to date';
  return view.committed ? 'Deleted (changes are on the branch)' : 'Deleted';
}

// What a port did, said from what it returned rather than from which button was
// pressed. The case that matters is the last one: the work is on the branch, the
// destination was left where it was, and the command to finish is the whole point -
// so it is named here rather than left to a payload the toast does not show.
function portReport(r) {
  if (r.dryRun) return 'Preview only. Nothing was written.';
  if (r.empty) return 'Nothing to port.';
  if (r.alreadyPorted) return `${r.target} already has these changes.`;
  if (r.landed) return `Merged into ${r.target}${r.cleaned ? ' and deleted the worktree' : ''}.`;
  return `Committed to ${r.branch}${r.cleaned ? ' and deleted the worktree' : ''}. Finish the merge with Next steps.`;
}

// A shell in one of the task's two directories: its worktree, and the checkout the
// branch is meant to land on. Both are things this workflow otherwise only reports on
// - landing a branch needs a real `git merge`, and working out why a run failed needs
// a claude session you can talk to - and neither fits a button.
//
// The tabs choose between them rather than showing both at once, because only one
// terminal can hold the keyboard, and a second one on screen is a pane that swallows
// whatever is typed into it.
function TerminalTab({ task, live, terminal }) {
  const [chosen, setChosen] = useState(null);
  const targets = terminal?.targets || [];
  // The choice, falling back to the first target that can actually be opened: a task
  // whose worktree has been removed would otherwise open on the one directory that
  // cannot run anything.
  const spec = targets.find((t) => t.id === chosen) || targets.find((t) => t.available) || null;

  if (!terminal?.enabled) {
    return html`<${EmptyState} message="The terminal is disabled on this server (AI_CODE_DISABLE_TERMINAL is set)." />`;
  }

  return html`
    <div class="stack">
      ${
        // Only the worktree, and only while a run holds the lease: an agent run never
        // writes the parent checkout, and there is no run to race when there is none.
        // A warning and not a refusal - watching a run is a reason to be in here, and
        // a read-only `git log` beside it is harmless.
        live && spec?.id === 'worktree'
          ? html`
              <div class="terminal-warn">
                <span>The ${live.role} is editing this worktree. Commands you run here may clash with it.</span>
              </div>
            `
          : null
      }

      <div class="tabs">
        ${targets.map(
          (t) => html`
            <button
              key=${t.id}
              class="tab ${spec?.id === t.id ? 'active' : ''}"
              disabled=${!t.available}
              title=${t.available ? '' : t.reason || ''}
              onClick=${() => setChosen(t.id)}
            >
              ${t.label}
            </button>
          `
        )}
      </div>
      ${spec?.dir ? html`<p class="muted terminal-cwd"><code>${spec.dir}</code></p>` : null}

      ${
        spec?.available
          ? // Keyed by target so switching remounts the emulator and its socket: the two
            // are different sessions on the server, and a reused emulator would keep the
            // other one's screen.
            html`<${TerminalPane} key=${spec.id} taskId=${task.id} target=${spec.id} />`
          : html`<p class="muted">${spec?.reason || 'No directory to open a shell in.'}</p>`
      }
    </div>
  `;
}

function ReviewTab({ task, runs, busy, run, live, navigate, onReopen, onGoTo }) {
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // The decision gate's own state: which option is picked and what has been typed.
  // Both survive the loads that follow a comment, because the tab is re-rendered
  // rather than remounted and the person is mid-answer.
  const [picked, setPicked] = useState(null);
  const [answer, setAnswer] = useState('');
  // REPAIRING is set by a FAIL verdict and stays set while the repair agent runs,
  // so the live run's role is what tells "repair needed" from "repair running".
  // `live` is the server's lease-backed answer, so a reload mid-repair sees it too.
  const repairing = live?.role === 'repair';
  if (task.state === 'REVIEWING' || repairing) {
    if (live || busy)
      return html`
        <div class="stack">
          <${Spinner} message=${repairing ? 'Repair in progress...' : 'Review in progress...'} />
          ${task.feedback ? html`<p class="muted">Repairing with your feedback: ${task.feedback}</p>` : null}
        </div>
      `;
    return html`<${ReadyForReview} task=${task} runs=${runs || []} busy=${busy || asking} run=${run} onAsk=${askQuestions} onGoTo=${onGoTo} />`;
  }
  const review = task.review || '';
  const kind = bodyKind(review);

  // The decision the review stopped on. A task can be in AWAITING_DECISION without a
  // readable one - the column is JSON, and a hand-edited database or a downgraded
  // verdict can leave it empty - so the text box below is offered either way, and a
  // repair by instruction alone is still possible.
  const open = task.state === 'AWAITING_DECISION' ? decisionView(task.decision) : null;

  // The two things a person has to say about a task that has passed its review and
  // has not been ported yet. One re-opens the loop - the text becomes the repair's
  // findings and the review after it checks the work against the same words - and
  // the other does not: a question asked with the task's plan and review in hand,
  // which is a chat scoped to this task rather than a message in this page.
  const completed = task.state === 'COMPLETE';

  async function askQuestions() {
    setAsking(true);
    try {
      const session = await api.createChatSession(task.project_id, null, task.id);
      navigate(`#/chat/${session.id}`);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setAsking(false);
    }
  }

  if (kind === 'empty' && !open) {
    return BEFORE_REVIEW[task.state]
      ? html`<${ReviewProgress} state=${task.state} onGoTo=${onGoTo} />`
      : html`<p class="muted">This task stopped before it was reviewed.</p>`;
  }

  const reviews = (runs || []).filter((r) => r.role === 'reviewer');
  const lastOk = [...reviews].reverse().find((r) => r.status === 'succeeded') || null;
  const verdict =
    task.state === 'COMPLETE'
      ? { tone: 'good', icon: html`<path d="m3.5 8.5 3 3 6-7" />`, title: 'Review passed' }
      : task.state === 'REPAIRING'
        ? { tone: 'warn', icon: html`<path d="M8 4v5M8 11.5h.01" />`, title: 'Review requested changes' }
        : task.state === 'AWAITING_DECISION'
          ? { tone: 'warn', icon: html`<path d="M6 6a2 2 0 1 1 3 1.7c-.6.4-1 .8-1 1.5M8 11.5h.01" />`, title: 'The review needs your decision' }
          : { tone: 'neutral', icon: html`<circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" />`, title: 'Review' };
  const nth = ['first', 'second', 'third', 'fourth', 'fifth'];

  const decision = open
    ? html`
        <div class="review-decision-grid">
          <section class="card review-question" aria-label="The reviewer's question">
            <span class="review-eyebrow warn">The reviewer needs a decision</span>
            <p class="review-question-text">${open.question}</p>
            <div class="review-options" role="radiogroup" aria-label="Options">
              ${open.options.map(
                (o, i) => html`
                  <button
                    type="button"
                    role="radio"
                    aria-checked=${picked === i ? 'true' : 'false'}
                    class="review-option ${picked === i ? 'on' : ''}"
                    disabled=${busy}
                    onClick=${() => setPicked(picked === i ? null : i)}
                  >
                    <span class="review-radio" aria-hidden="true"></span>
                    <span><b>${o.label}</b>${o.detail ? html`<span class="muted">${o.detail}</span>` : null}</span>
                  </button>
                `
              )}
            </div>
            ${open.recommendation ? html`<p class="muted review-rec">The reviewer recommends: ${open.recommendation}</p>` : null}
            <${TextArea}
              label="Your answer"
              value=${answer}
              onInput=${setAnswer}
              rows=${3}
              placeholder="Add anything the reviewer should weigh, or write the instruction yourself."
              loading=${busy}
            />
            <div class="review-foot review-foot-inset">
              <span class="muted">Ask sends your answer back for another round. Approve starts the repair.</span>
              <button
                class="btn secondary"
                disabled=${busy || !answer.trim()}
                onClick=${() =>
                  run(async () => {
                    const r = await api.taskDiscuss(task.id, answer.trim());
                    setAnswer('');
                    return r;
                  }, 'Comment sent — the reviewer will answer.')}
              >
                Ask reviewer
              </button>
              <button
                class="btn primary"
                disabled=${busy || (picked === null && !answer.trim())}
                onClick=${() =>
                  run(async () => {
                    const r = await api.taskResolve(task.id, { option: picked, text: answer.trim() });
                    setPicked(null);
                    setAnswer('');
                    onReopen();
                    return r;
                  }, 'Repair approved — running now.')}
              >
                Approve repair
              </button>
            </div>
          </section>
          ${open.thread.length
            ? html`<section class="card review-thread" aria-label="Discussion">
                <span class="review-eyebrow">Discussion · oldest first</span>
                ${open.thread.map(
                  (m, i) => html`<div class="review-msg ${m.from === 'user' ? 'mine' : ''}" key=${i}>
                    <span class="muted"><b>${m.from === 'user' ? 'You' : 'Reviewer'}</b>${m.verdict ? ` — ${m.verdict}` : ''}</span>
                    <${Markdown} text=${m.text} className="md review-md" />
                  </div>`
                )}
              </section>`
            : null}
        </div>
      `
    : null;

  return html`
    <div class="stack">
      ${decision}
      <section class="card review-card" aria-label="Review">
        <div class="review-head review-head-icon">
          <span class="review-icon tone-${verdict.tone}" aria-hidden="true"><svg viewBox="0 0 16 16">${verdict.icon}</svg></span>
          <div>
            <h2>${open ? 'The review' : verdict.title}</h2>
            ${lastOk
              ? html`<p class="muted">
                  <span class="mono-sm">${[lastOk.provider_id, lastOk.model_id].filter(Boolean).join(' / ')}</span> · <${Time} at=${lastOk.ended_at || lastOk.started_at} />
                  ${reviews.length > 1 ? ` · ${nth[reviews.indexOf(lastOk)] || `attempt ${reviews.indexOf(lastOk) + 1}`} attempt` : ''} · <a class="link" href=${`#/runs/${lastOk.id}`}>See the run</a>
                </p>`
              : null}
          </div>
        </div>
        <div class="review-findings">
          <h3 class="review-eyebrow">Findings</h3>
          ${kind === 'empty' ? html`<p class="muted">The reviewer left no written findings.</p>` : kind === 'diff' ? html`<${DiffViewer} diff=${review} />` : html`<${Markdown} text=${review} className="md review-md" />`}
          ${task.feedback && task.state !== 'REPAIRING' ? html`<p class="muted">Feedback waiting to be repaired: ${task.feedback}</p>` : null}
        </div>
        ${completed
          ? html`
              <button class="review-fold" type="button" aria-expanded=${feedbackOpen} onClick=${() => setFeedbackOpen((v) => !v)}>
                <svg class="ss-ic ${feedbackOpen ? 'open' : ''}" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
                <b>Not satisfied? Send feedback</b>
                <span class="muted">Reopens repair and review before the change is ported.</span>
              </button>
              ${feedbackOpen
                ? html`<div class="review-feedback">
                    <${TextArea}
                      label="What should change?"
                      value=${note}
                      onInput=${setNote}
                      rows=${3}
                      placeholder="What should change? The task goes back through repair and review."
                      loading=${busy}
                    />
                    <div class="row review-feedback-actions">
                      <button class="btn secondary" type="button" onClick=${() => setFeedbackOpen(false)}>Cancel</button>
                      <button
                        class="btn primary"
                        disabled=${busy || !note.trim()}
                        onClick=${() =>
                          run(async () => {
                            const r = await api.taskFeedback(task.id, note.trim());
                            setNote('');
                            setFeedbackOpen(false);
                            onReopen();
                            return r;
                          }, 'Feedback sent — repair started.')}
                      >
                        Send feedback
                      </button>
                    </div>
                  </div>`
                : null}
            `
          : null}
        <div class="review-foot">
          <span class="muted">Questions about the change go to a conversation scoped to this task.</span>
          <button class="btn secondary" type="button" disabled=${busy || asking} onClick=${askQuestions}>${asking ? 'Opening…' : 'Ask questions'}</button>
        </div>
      </section>
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
//
// Exported because the supervised-session view streams the same events into the same
// list, and it is the same problem there: a session turn emits one per tool call, and
// the page beside the list is a transcript of markdown.
export function createEventBuffer() {
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

// What each described kind is called on a row. The kinds come from describeEvent,
// shared with the CLI; these are only their labels here.
const KIND_LABEL = { run: 'Run', tool: 'Tool', said: 'Said', think: 'Thinking', out: 'Output', done: 'Done', error: 'Failed', limit: 'Warning' };
const STEP_KINDS = new Set(['run', 'tool', 'done', 'error', 'limit']);
const PROBLEM_KINDS = new Set(['error', 'limit']);
const ACTIVITY_FILTERS = [
  { value: 'all', label: 'Everything' },
  { value: 'steps', label: 'Steps' },
  { value: 'problems', label: 'Problems' },
];

// A path inside the task's worktree, said from the worktree's root. The absolute
// prefix is the same on every row and pushes the part that differs off the edge.
function relativeTo(root, text) {
  if (!root || !text) return text;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return text.split(prefix).join('');
}

function ActivityTab({ taskId, store, runs, root }) {
  const [events, setEvents] = useState(store.events);
  const [meta, setMeta] = useState(store.meta);
  const [older, setOlder] = useState([]);
  const [allLoaded, setAllLoaded] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  // Which groups are open, by run id. A group the person has not touched follows the
  // default below, so the run in progress stays open as it grows.
  const [openRuns, setOpenRuns] = useState({});
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

  // Scroll the box, not the page. scrollIntoView on a row inside it also scrolled
  // every ancestor, which pulled the whole page down to the tab on each batch.
  const toBottom = () => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  useEffect(() => {
    if (autoScroll) toBottom();
  }, [events, autoScroll, filter, query]);

  function onScroll() {
    const el = boxRef.current;
    if (!el) return;
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
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

  // Described once, then grouped by the run that wrote them, in the order the runs
  // appear in the stream. An event whose formatter returns nothing is dropped.
  const described = useMemo(() => {
    const out = [];
    for (const e of displayed) {
      const d = describeEvent(e);
      if (d) out.push({ e, kind: d.kind, text: relativeTo(root, d.text) });
    }
    return out;
  }, [displayed, root]);
  const problems = described.filter((x) => PROBLEM_KINDS.has(x.kind)).length;

  const q = query.trim().toLowerCase();
  const keep = (x) =>
    (filter === 'all' || (filter === 'steps' ? STEP_KINDS.has(x.kind) : PROBLEM_KINDS.has(x.kind))) &&
    (!q || x.text.toLowerCase().includes(q));

  const byId = new Map((runs || []).map((r) => [r.id, r]));
  const labels = roleLabels(runs || []);
  const labelOf = new Map((runs || []).map((r, i) => [r.id, labels[i]]));
  const groups = [];
  for (const x of described) {
    const id = x.e.run_id || 'none';
    let g = groups[groups.length - 1];
    if (!g || g.id !== id) {
      g = { id, rows: [], all: 0 };
      groups.push(g);
    }
    g.all++;
    if (keep(x)) g.rows.push(x);
  }
  const shown = groups.filter((g) => g.rows.length);
  const lastId = groups.length ? groups[groups.length - 1].id : null;
  const filtering = filter !== 'all' || !!q;
  const isOpen = (g) => {
    if (g.id in openRuns) return openRuns[g.id];
    const r = byId.get(g.id);
    return filtering || g.id === lastId || r?.status === 'failed' || r?.status === 'running';
  };
  const allOpen = shown.length > 0 && shown.every(isOpen);
  const setAll = (v) => setOpenRuns(Object.fromEntries(shown.map((g) => [g.id, v])));

  // Consecutive output lines are one console block rather than a row each: a test
  // suite reporting on itself reads as a transcript, not as forty events.
  function rowsOf(rows) {
    const out = [];
    for (const x of rows) {
      const prev = out[out.length - 1];
      if (x.kind === 'out' && prev?.console) prev.lines.push(x);
      else if (x.kind === 'out') out.push({ console: true, lines: [x], key: x.e.id });
      else out.push({ ...x, key: x.e.id });
    }
    return out.map((r) =>
      r.console
        ? html`<li class="act-console" key=${r.key}><pre>${r.lines.map((l) => l.text).join('\n')}</pre></li>`
        : html`<li class="act-row kind-${r.kind}" key=${r.key}>
            <span class="act-kind">${KIND_LABEL[r.kind] || r.kind}</span>
            <span class="act-text">${r.text}</span>
            <span class="act-time muted" title=${r.e.created_at || ''}>${clockOf(r.e.created_at)}</span>
          </li>`
    );
  }

  function head(g, open) {
    const r = byId.get(g.id);
    const status = r?.status || 'unknown';
    const tone = status === 'failed' ? 'bad' : status === 'running' ? 'live' : status === 'succeeded' ? 'good' : 'neutral';
    const bits = [
      r?.duration_ms ? formatDuration(r.duration_ms) : null,
      Number(r?.cost) ? formatCost(r.cost) : null,
      r?.started_at ? formatWhen(r.started_at) : null,
      filtering ? `${g.rows.length} of ${g.all}` : `${g.all} event${g.all === 1 ? '' : 's'}`,
    ].filter(Boolean);
    const name = r ? String(labelOf.get(g.id) || r.role) : '';
    const title = r ? `${name.charAt(0).toUpperCase()}${name.slice(1)}${status === 'failed' ? ' · did not finish' : status === 'running' ? ' · running' : ''}` : 'Other activity';
    return html`
      <button class="act-head" type="button" aria-expanded=${open} onClick=${() => setOpenRuns((m) => ({ ...m, [g.id]: !open }))}>
        <span class="act-dot tone-${tone}" aria-hidden="true">
          ${tone === 'live'
            ? html`<span class="next-bar-spin"></span>`
            : html`<svg viewBox="0 0 16 16">${tone === 'bad' ? html`<path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />` : tone === 'good' ? html`<path d="m3.5 8.5 3 3 6-7" />` : html`<circle cx="8" cy="8" r="2" />`}</svg>`}
        </span>
        <span class="act-head-text"><b>${title}</b><span class="muted">${bits.join(' · ')}</span></span>
        <svg class="ss-ic act-chev ${open ? 'open' : ''}" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
      </button>
    `;
  }

  return html`
    <div class="act">
      <div class="act-bar">
        <span class="seg act-seg" role="radiogroup" aria-label="Show">
          ${ACTIVITY_FILTERS.map(
            (f) => html`<button
              type="button"
              role="radio"
              key=${f.value}
              aria-checked=${filter === f.value ? 'true' : 'false'}
              class="seg-btn ${filter === f.value ? 'active' : ''}"
              onClick=${() => setFilter(f.value)}
            >
              ${f.label}${f.value === 'problems' && problems ? html`${' '}<span class="act-count">${problems}</span>` : null}
            </button>`
          )}
        </span>
        <input class="input act-search" type="search" placeholder="Filter events" aria-label="Filter events" value=${query} onInput=${(e) => setQuery(e.target.value)} />
        ${shown.length ? html`<button class="link-btn" type="button" onClick=${() => setAll(!allOpen)}>${allOpen ? 'Collapse all' : 'Expand all'}</button>` : null}
      </div>
      ${hidden > 0 || older.length
        ? html`<div class="act-notice">
            <span>${`Showing ${displayed.length.toLocaleString()} of ${total.toLocaleString()} events${hidden > 0 ? ` · ${hidden.toLocaleString()} not loaded` : ''}`}</span>
            ${canPageBack ? html`<button class="link-btn" type="button" onClick=${loadOlder}>Load ${MAX_EVENTS} older</button>` : null}
            ${olderBusy ? html`<span class="spinner"></span>` : null}
          </div>`
        : null}
      <div class="act-box" ref=${boxRef} onScroll=${onScroll}>
        ${!described.length
          ? html`<p class="muted act-empty">No events yet.</p>`
          : !shown.length
            ? html`<p class="muted act-empty">${filter === 'problems' && !q ? 'No problems — nothing failed or warned.' : 'Nothing matches.'}</p>`
            : shown.map((g) => {
                const open = isOpen(g);
                const r = byId.get(g.id);
                return html`<section class="act-group ${r?.status === 'failed' ? 'bad' : ''}" key=${g.id}>
                  ${head(g, open)}
                  ${open
                    ? html`<ol class="act-rows">${rowsOf(g.rows)}</ol>
                        ${r ? html`<a class="act-run-link" href=${`#/runs/${r.id}`}>See the run</a>` : null}`
                    : null}
                </section>`;
              })}
      </div>
      ${!autoScroll
        ? html`<button
            class="btn secondary jump-btn"
            type="button"
            onClick=${() => {
              setAutoScroll(true);
              toBottom();
            }}
          >
            New events ↓
          </button>`
        : null}
    </div>
  `;
}

function clockOf(iso) {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// The other attempts of this task's comparison, as a row of letters to switch
// between, and the way to the side-by-side view.
function AttemptStrip({ task, siblings }) {
  return html`
    <nav class="attempt-strip" aria-label="Attempts of this comparison">
      <span class="muted">Attempt</span>
      ${siblings.map(
        (x) => html`<a key=${x.id} href=${`#/tasks/${x.id}`} class="attempt-chip ${x.id === task.id ? 'current' : ''} ${x.pick === 'won' ? 'won' : ''}" aria-current=${x.id === task.id ? 'page' : undefined} title=${`Attempt ${x.label} · ${x.engine}${x.pick ? ` · ${x.pick}` : ''}`}>${x.label}</a>`
      )}
      <a class="link" href=${`#/compare/${task.attempt_group}`}>Compare side by side</a>
    </nav>
  `;
}

// What each state of a session task means to the person reading it.
const SESSION_TASK_COPY = {
  CREATED: 'Starting.',
  WORKING: 'Working on it.',
  TESTING: "Running the project's checks on what it changed.",
  WAITING: 'Waiting on you: it replied without changing anything.',
  COMPLETE: 'Ready to land: it changed files and the checks passed.',
  FAILED: 'Stopped: the checks still failed after its fixes, or the run failed.',
  CANCELLED: 'Closed.',
};

// A task run as one session: where it stands, its latest reply with a box to answer
// it, and the same Land, Terminal and Activity tabs a pipeline task has. The
// conversation itself - every turn, every step, approvals - is one click away.
function SessionTaskBody({ task, data, busy, run, buffer, tab, setTab }) {
  const [convo, setConvo] = useState(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!task.session_id) return;
    let cancelled = false;
    api
      .session(task.session_id)
      .then((d) => !cancelled && setConvo(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [task.session_id, task.state, task.updated_at]);
  useEffect(() => {
    if (!['land', 'terminal', 'activity'].includes(tab)) setTab('land');
  }, [tab, setTab]);

  const turns = convo?.turns || [];
  const last = [...turns].reverse().find((t) => t.answer || t.error);
  const cost = turns.reduce((n, t) => n + (t.cost || 0), 0);
  const model = task.model_id || [...turns].reverse().find((t) => t.model_id)?.model_id || 'Automatic';
  const tester = [...(data.runs || [])].reverse().find((r) => r.role === 'tester' && r.status !== 'running');
  const changes = data.changes;
  const working = task.state === 'WORKING' || task.state === 'TESTING';
  const closed = task.state === 'CANCELLED';
  const waiting = !!convo?.permission;

  async function send() {
    const text = reply.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await api.sendSessionMessage(task.session_id, text);
      setReply('');
      await run(async () => null);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setSending(false);
    }
  }

  return html`
    <section class="card session-task">
      <div class="session-task-status">
        ${working ? html`<${Spinner} />` : null}
        <span>${waiting ? 'Waiting on you: it needs an approval in the conversation.' : SESSION_TASK_COPY[task.state] || task.state}</span>
        <span class="session-task-actions">
          ${working ? html`<button class="btn secondary sm" type="button" disabled=${busy} onClick=${() => run(() => api.taskCancel(task.id), 'Stopped.')}>Stop</button>` : null}
          ${task.session_id ? html`<a class="btn ${waiting ? 'primary' : 'secondary'} sm" href=${`#/sessions/${task.session_id}`}>Open conversation</a>` : null}
        </span>
      </div>
      <dl class="session-task-facts">
        <div><dt>Model</dt><dd class="mono-sm">${model}</dd></div>
        <div><dt>Branch</dt><dd class="mono-sm">${task.branch || '—'}</dd></div>
        <div><dt>Changes</dt><dd>${changes && changes.files ? html`${changes.files} file${changes.files === 1 ? '' : 's'} <span class="good">+${changes.added}</span> <span class="bad">−${changes.removed}</span>` : 'None yet'}</dd></div>
        <div><dt>Checks</dt><dd>${tester ? html`<${StatusBadge} status=${tester.status === 'succeeded' ? 'passed' : tester.status} />` : html`<span class="muted">Not run yet</span>`}</dd></div>
        <div><dt>Spent</dt><dd class="mono-sm">${formatCost(cost)}</dd></div>
        <div><dt>Turns</dt><dd>${turns.length}</dd></div>
      </dl>
      ${last
        ? html`<div class="session-task-reply">
            <div class="muted session-task-reply-head">Latest reply</div>
            ${last.answer ? html`<${Markdown} text=${last.answer} className="md" />` : html`<p class="error-text">${last.error}</p>`}
          </div>`
        : null}
      ${closed
        ? null
        : html`<div class="session-task-composer">
            <${TextArea}
              label="Reply"
              value=${reply}
              onInput=${setReply}
              rows=${2}
              placeholder=${working ? 'It is working; you can reply when the turn ends.' : 'Answer it, or tell it what to change next'}
              disabled=${working || sending}
              onKeyDown=${(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button class="btn primary" type="button" disabled=${working || sending || !reply.trim()} onClick=${send}>${sending ? 'Sending…' : 'Send'}</button>
          </div>`}
    </section>

    <${Tabs}
      tabs=${[
        { id: 'land', label: 'Land' },
        { id: 'terminal', label: 'Terminal' },
        { id: 'activity', label: 'Checks log' },
      ]}
      value=${tab}
      onChange=${setTab}
      label="Task sections"
    />
    <${TabPanel} tabId=${tab}>
      ${tab === 'land' ? html`<${PortTab} task=${task} branches=${data.branches || []} busy=${busy} run=${run} onActions=${() => {}} />` : null}
      ${tab === 'terminal' ? html`<${TerminalTab} task=${task} live=${data.live} terminal=${data.terminal} />` : null}
      ${tab === 'activity' ? html`<${ActivityTab} taskId=${task.id} store=${buffer} runs=${data.runs} root=${task.worktree} />` : null}
    <//>
  `;
}
