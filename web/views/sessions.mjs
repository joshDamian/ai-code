// Supervised sessions. URL hash: #/sessions (the list) or #/sessions/:id (one of them).
//
// A session is an agent working in the project's own checkout on instructions a
// person types, with every write and every command held at a permission prompt. So
// this view is two things at once, and the layout says which one matters at any
// moment: a conversation, which is the transcript and the composer, and a gate,
// which is the permission panel that takes over the top of the page when something
// is waiting to be approved.
//
// The gate is at the top because it is the only element here that is blocking
// something. An agent that has asked for permission has stopped, is holding a
// provider slot, and will be denied by the clock in two minutes; a banner under a
// long transcript is a banner nobody scrolls to.
import { html, useState, useEffect, useRef, useCallback, useMemo, formatCost } from '../lib.mjs';
import { api, sessionStreamUrl } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { StatusBadge } from '../components/status-badge.mjs';
import { TextArea, Select } from '../components/form.mjs';
import { Markdown } from '../components/markdown.mjs';
import { EventStream } from '../components/event-stream.mjs';
import { Time } from '../components/time.mjs';
import { createEventBuffer } from './task-detail.mjs';

// A turn the queue is still holding. Read from the job row rather than from a local
// flag, so a reload and a second tab see the same thing this one does.
const IN_FLIGHT = new Set(['queued', 'running']);

// Where the composer stops growing and starts scrolling instead, matching the chat
// composer's own cap.
const COMPOSER_MAX_PX = 200;

// How much of a file's new contents the permission panel shows. Enough to see what
// the edit does, short enough that the Allow button does not move off the screen -
// which is the whole failure mode of a confirmation dialog.
const PREVIEW_CHARS = 4000;

// What the person is being asked to approve, in the words they need to decide it.
// The tool name alone is not a decision: "Write" on its own is approved by anyone
// in a hurry, and `rm -rf` in the Bash branch is not.
//
// Server-side would be the wrong place for this even though the input is stored
// there: the panel is drawn from the request claude sent, and a summariser that ran
// at write time could not be changed without stranding every request recorded
// before it.
function permissionDetail(tool, input) {
  const i = input || {};
  if (tool === 'Bash') return { headline: i.command || '(a command with no text)', body: i.description || '' };
  if (i.file_path) {
    const body =
      typeof i.content === 'string' ? i.content : typeof i.new_string === 'string' ? i.new_string : typeof i.new_source === 'string' ? i.new_source : '';
    return { headline: i.file_path, body };
  }
  if (i.pattern) return { headline: `${i.pattern}${i.path ? `  in  ${i.path}` : ''}`, body: '' };
  if (i.url) return { headline: i.url, body: '' };
  // Anything else is shown as it arrived rather than guessed at. A tool this file
  // has not heard of is exactly the tool whose arguments a person should read.
  return { headline: tool, body: JSON.stringify(i, null, 2) };
}

// The turn's own ending, when it did not produce an answer. A run still in flight
// has no ending yet - the spinner under the transcript is what says so - and a run
// reported as "the turn running" beneath its own instruction is a transcript that
// accuses the agent of failing while it is working.
function turnFailureText(t) {
  if (!t.answer && (t.status === 'running' || t.status === 'queued')) return null;
  if (t.answer) return null;
  return t.error || `The turn ${t.status || 'did not finish'}.`;
}

// The activity list, and the only reader of the event stream. It subscribes to the
// buffer rather than being handed the page's state for the reason the buffer exists:
// a working turn emits an event per tool call, and committing each one to the page
// would redraw the transcript beside it - the markdown, the permission panel and
// the composer - once per event, for a list that is usually collapsed.
function Activity({ store }) {
  const [events, setEvents] = useState(store.events);
  useEffect(() => {
    const sync = () => setEvents(store.events);
    sync();
    return store.on(sync);
  }, [store]);
  return html`<${EventStream} events=${events} />`;
}

// Seconds left on the request, floored at zero. Derived on every tick from the
// request's own deadline rather than from a countdown started when the panel
// rendered, so a page opened ninety seconds into a two-minute window shows thirty
// and not two minutes.
function secondsLeft(permission, now) {
  if (!permission?.timeout_at) return 0;
  return Math.max(0, Math.round((Date.parse(permission.timeout_at) - now) / 1000));
}

export function Sessions({ id, navigate, onTitle }) {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [sessions, setSessions] = useState(null);
  const [detail, setDetail] = useState(null);
  const [turns, setTurns] = useState([]);
  const [permission, setPermission] = useState(null);
  const [working, setWorking] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [input, setInput] = useState('');
  // The name editor, closed until it is asked for. A session names itself from its
  // first instruction, and a person who meant something else by it fixes it here
  // rather than by starting a new session with a throwaway first turn.
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Bumped to re-read the list in place. Opening a session takes the list out of the
  // tree and remounts it on the way back, but a row's Stop or Archive happens while
  // the list is still the view.
  const [listTick, setListTick] = useState(0);
  // Ticks once a second while a request is pending, and not otherwise: a component
  // that re-renders every second for the whole life of a page is a page that never
  // settles, and the countdown is the only thing here that needs a clock.
  const [now, setNow] = useState(() => Date.now());
  const streamRef = useRef(null);
  const transcriptRef = useRef(null);
  const composerRef = useRef(null);
  // The stream's handlers are bound once per connection, so the state they read on a
  // tick - whether this connection has seen the session working - is held in a ref
  // rather than in the closure they were created in.
  const sawWorking = useRef(false);

  const session = detail?.session || null;

  // The live events, buffered rather than held in render state. One buffer per
  // session, because switching sessions is switching turns and a frame from the
  // previous one has no list to belong to.
  const events = useMemo(() => createEventBuffer(), [id]);

  // Pin the transcript to the newest turn, on the transcript itself rather than
  // with scrollIntoView on a sentinel: scrollIntoView moves every scrollable
  // ancestor, so the page scrolled under the reader too.
  const jumpedRef = useRef(false);
  useEffect(() => {
    jumpedRef.current = false;
  }, [id]);
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: jumpedRef.current ? 'smooth' : 'auto' });
    jumpedRef.current = true;
  }, [turns, working]);

  useEffect(() => {
    const ta = composerRef.current && composerRef.current.querySelector('textarea');
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, COMPOSER_MAX_PX)}px`;
  }, [input]);

  useEffect(() => {
    let cancelled = false;
    api
      .projects()
      .then((p) => {
        if (cancelled) return;
        setProjects(p);
        setProjectId((cur) => cur || (p[0] && p[0].id) || '');
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const closeStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }
    sawWorking.current = false;
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await api.session(id);
      setDetail(d);
      setTurns(d.turns || []);
      setPermission(d.permission || null);
      onTitle?.(d.session.name);
      // A turn that ended without an answer is the one failure the transcript cannot
      // show - the instruction is there and nothing follows it - so the job row is
      // what reports it.
      const last = (d.turns || [])[(d.turns || []).length - 1];
      setError(
        d.job && !IN_FLIGHT.has(d.job.state) && d.job.state !== 'succeeded' && last && last.status !== 'succeeded'
          ? d.job.error || `The turn ${d.job.state}.`
          : null
      );
      // A turn already in flight when the page opened - a reload mid-turn, or a
      // second tab - is watched from here, so it settles without the reader having
      // to do anything. The unanswered instruction is the other half of the test:
      // the job row settles a moment after the turn ends, and a stream opened in
      // that gap would be one watching a turn that is already over.
      if (d.job && IN_FLIGHT.has(d.job.state)) openStreamRef.current?.();
      else setWorking(false);
    } catch (e) {
      setError(e.message);
    }
  }, [id, onTitle]);

  const openStream = useCallback(() => {
    closeStream();
    const stream = new EventSource(sessionStreamUrl(id));
    streamRef.current = stream;
    sawWorking.current = false;
    const finish = () => {
      closeStream();
      setWorking(false);
    };
    stream.addEventListener('meta', (e) => {
      const frame = JSON.parse(e.data);
      if (frame.session) setDetail((d) => ({ ...(d || {}), session: frame.session }));
      if (frame.turns) setTurns(frame.turns);
    });
    // The agent's own events, rendered by the same formatter the task activity tab
    // uses. This is what makes the wait legible: a person watching a session work is
    // watching what it is reading and what it is asking for.
    stream.addEventListener('event', (e) => {
      events.push(JSON.parse(e.data));
    });
    stream.addEventListener('state', (e) => {
      const st = JSON.parse(e.data);
      if (st.session) setDetail((d) => ({ ...(d || {}), session: st.session }));
      setPermission(st.permission || null);
      if (st.working) {
        sawWorking.current = true;
        setWorking(true);
        return;
      }
      setWorking(false);
      // The turn this connection was opened for has settled. The transcript is read
      // back rather than assembled from the event frames: the answer, its cost and
      // the nudge are all written server-side when the run ends, and a client that
      // built its own would be a second opinion about what happened.
      if (sawWorking.current) {
        sawWorking.current = false;
        finish();
        load();
      }
    });
    // Fires when the server ends the stream as well as on a real failure, so it
    // reports nothing by itself - it falls back to the stored turn, which is what
    // says whether the run landed.
    stream.onerror = () => {
      finish();
      load();
    };
  }, [id, events, closeStream, load]);

  const openStreamRef = useRef(null);
  openStreamRef.current = openStream;

  useEffect(() => {
    if (id) return undefined;
    let cancelled = false;
    setSessions(null);
    (async () => {
      try {
        const list = await api.sessions(projectId);
        if (!cancelled) setSessions(list);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, projectId, listTick]);

  useEffect(() => {
    if (!id) return undefined;
    // The buffer is emptied by being replaced: `events` is a useMemo keyed on the
    // session, so the one this effect is entered with is the one this session owns.
    setShowActivity(false);
    // A name being edited belongs to the session it was started on. Left open across
    // a navigation, the box would save one session's name onto another.
    setRenaming(false);
    load();
    return closeStream;
  }, [id, load, closeStream]);

  useEffect(() => {
    if (!id) {
      setDetail(null);
      setTurns([]);
      setPermission(null);
      setWorking(false);
      setError(null);
      onTitle?.(null);
    }
  }, [id, onTitle]);

  // The clock, armed only while there is something counting down.
  useEffect(() => {
    if (!permission) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [permission]);

  const openSession = useCallback((sessionId) => navigate(`#/sessions/${sessionId}`), [navigate]);

  const refreshList = useCallback(() => setListTick((n) => n + 1), []);

  // A row's Stop, Resume or Archive, which acts on a session this view is not the
  // one showing. The button's own event is stopped before it gets here: the row
  // underneath is a link into the session, and archiving one should not also open it.
  const rowControl = useCallback(
    async (e, fn, label) => {
      e.stopPropagation();
      setBusy(true);
      try {
        await fn();
      } catch (err) {
        showToast(`${label}: ${err.message}`, 'error');
      } finally {
        setBusy(false);
        refreshList();
      }
    },
    [refreshList]
  );

  const createSession = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const s = await api.createSession(projectId, 'New session');
      openSession(s.id);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }, [projectId, openSession]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || working) return;
    setBusy(true);
    setError(null);
    try {
      await api.sendSessionMessage(id, text);
      setInput('');
      // Opened here rather than waiting for the reload below, so the composer locks
      // and the transcript shows the instruction the moment the server accepted it.
      setWorking(true);
      sawWorking.current = true;
      openStream();
      load();
    } catch (e) {
      // The instruction was refused - a turn already in flight is the usual reason -
      // so the text is left in the box to send again rather than dropped.
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }, [id, input, busy, working, openStream, load]);

  const onKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send]
  );

  const answer = useCallback(
    async (action) => {
      const req = permission;
      if (!req) return;
      setBusy(true);
      try {
        await api.answerSessionPermission(id, req.id, action);
        setPermission(null);
      } catch (e) {
        // A 409 is the countdown having fired first, which is a denial the agent has
        // already been told about. The panel goes away and the toast says why.
        showToast(e.message, 'error');
        setPermission(null);
      } finally {
        setBusy(false);
      }
    },
    [id, permission]
  );

  const control = useCallback(
    async (fn, label) => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        showToast(`${label}: ${e.message}`, 'error');
      } finally {
        setBusy(false);
        load();
      }
    },
    [load]
  );

  const draftTask = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api.draftSessionTask(id);
      showToast('Drafting the tasks this session implies…');
      navigate(`#/chat/${r.session.id}`);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }, [id, navigate]);

  const startRename = useCallback(() => {
    setNameDraft(session?.name || '');
    setRenaming(true);
  }, [session]);

  // Renamed to what the box holds, and the box is left open when the server refuses:
  // the name a person typed is theirs to fix, and closing the editor would have them
  // retype it. `control` is not used here for that reason - it reloads either way,
  // which is what a refused rename is not.
  const saveName = useCallback(async () => {
    const label = nameDraft.trim();
    if (!label) return;
    setBusy(true);
    try {
      await api.updateSession(id, { name: label });
      setRenaming(false);
      load();
    } catch (e) {
      showToast(`Rename: ${e.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }, [id, nameDraft, load]);

  // List view.
  if (!id) {
    const project = projects.find((p) => p.id === projectId);
    return html`
      <div class="chat-list">
        <div class="card">
          <div class="card-header">
            <h1>Supervised Sessions</h1>
            <button class="btn" onclick=${createSession} ?disabled=${busy || !projectId}>${busy ? 'Creating…' : 'New Session'}</button>
          </div>
          <div class="row">
            <${Select}
              label="Project"
              value=${projectId}
              onChange=${setProjectId}
              options=${projects.map((p) => ({ value: p.id, label: p.name }))}
            />
          </div>
          <p class="muted session-caveat">
            A session works in the project's own checkout, not a worktree, and every write and command it takes is sent here to be approved first.
          </p>
          ${error ? html`<div class="chat-error">${error}</div>` : ''}
          ${!projects.length
            ? html`<p class="muted">Add a project first.</p>`
            : sessions === null
              ? html`<div class="spinner"><${Spinner} /></div>`
              : sessions.length === 0
                ? html`<p class="muted">No sessions in ${project?.name || 'this project'} yet.</p>`
                : html`
                    <div class="sessions-list">
                      ${sessions.map(
                        (s) => html`
                          <div class="session-item" onclick=${() => openSession(s.id)}>
                            <div class="session-info">
                              <div class="session-title">
                                ${s.name} <${StatusBadge} status=${s.status} />
                              </div>
                              <div class="session-date">
                                <${Time} at=${s.updated_at} />${s.budget_tally ? ` · ${formatCost(s.budget_tally)}` : ''}${s.pending_run_id
                                  ? ' · working'
                                  : ''}
                              </div>
                            </div>
                            <div class="session-actions">
                              ${s.status === 'stopped' || s.status === 'archived'
                                ? html`<button
                                    class="btn secondary"
                                    onclick=${(e) => rowControl(e, () => api.resumeSession(s.id), 'Resume')}
                                    ?disabled=${busy}
                                  >
                                    Resume
                                  </button>`
                                : html`<button
                                    class="btn secondary"
                                    onclick=${(e) => rowControl(e, () => api.stopSession(s.id), 'Stop')}
                                    ?disabled=${busy}
                                  >
                                    Stop
                                  </button>`}
                              <button
                                class="btn secondary"
                                onclick=${(e) => rowControl(e, () => api.archiveSession(s.id), 'Archive')}
                                ?disabled=${busy || s.status === 'archived'}
                              >
                                Archive
                              </button>
                            </div>
                          </div>
                        `
                      )}
                    </div>
                  `}
        </div>
      </div>
    `;
  }

  // Detail view.
  const left = secondsLeft(permission, now);
  const detailOf = permission ? permissionDetail(permission.tool, permission.input) : null;
  const budget = detail?.budget || null;
  const nudge = detail?.nudge || null;
  const stopped = session?.status === 'stopped';
  const archived = session?.status === 'archived';

  return html`
    <div class="chat-conversation">
      <div class="card chat-card">
        <div class="card-header">
          ${renaming
            ? html`
                <input
                  class="input session-rename"
                  value=${nameDraft}
                  placeholder="Session name"
                  aria-label="Session name"
                  onInput=${(e) => setNameDraft(e.target.value)}
                  onKeyDown=${(e) => {
                    if (e.key === 'Enter') saveName();
                    if (e.key === 'Escape') setRenaming(false);
                  }}
                />
              `
            : html`
                <h1>
                  ${session?.name || 'Session'}
                  ${session ? html`<${StatusBadge} status=${session.status} />` : null}
                </h1>
              `}
          <div class="row session-controls">
            ${renaming
              ? html`
                  <button class="btn" onclick=${saveName} ?disabled=${busy || !nameDraft.trim()}>Save</button>
                  <button class="btn secondary" onclick=${() => setRenaming(false)} ?disabled=${busy}>Cancel</button>
                `
              : html`
                  ${nudge ? html`<button class="btn" onclick=${draftTask} ?disabled=${busy}>Draft as task</button>` : null}
                  <button class="btn secondary" onclick=${startRename} ?disabled=${busy || !session}>Rename</button>
                  ${stopped || archived
                    ? html`<button class="btn" onclick=${() => control(() => api.resumeSession(id), 'Resume')} ?disabled=${busy}>Resume</button>`
                    : html`<button class="btn secondary" onclick=${() => control(() => api.stopSession(id), 'Stop')} ?disabled=${busy}>Stop</button>`}
                  <button class="btn secondary" onclick=${() => control(() => api.archiveSession(id), 'Archive')} ?disabled=${busy}>Archive</button>
                  <button class="btn secondary" onclick=${() => navigate('#/sessions')}>Back</button>
                `}
          </div>
        </div>

        ${permission
          ? html`
              <div class="session-permission">
                <div class="session-permission-head">
                  <span class="badge badge-warn">needs approval</span>
                  <span class="session-permission-tool">${permission.tool}</span>
                  <span class="session-permission-clock ${left <= 20 ? 'urgent' : ''}">${left}s</span>
                </div>
                <div class="session-permission-path">${detailOf.headline}</div>
                ${detailOf.body ? html`<pre class="session-permission-body">${detailOf.body.slice(0, PREVIEW_CHARS)}</pre>` : ''}
                <div class="session-permission-foot">
                  <span class="muted">${permission.cwd || ''}</span>
                  <div class="row">
                    <button class="btn" onclick=${() => answer('allow')} ?disabled=${busy}>Allow</button>
                    <button class="btn secondary" onclick=${() => answer('deny')} ?disabled=${busy}>Deny</button>
                  </div>
                </div>
              </div>
            `
          : null}

        ${archived
          ? html`<div class="session-banner muted">This session is archived. Resume it to send another instruction.</div>`
          : stopped
            ? html`<div class="session-banner muted">This session is stopped. Resume it to send another instruction.</div>`
            : null}

        <div class="chat-transcript" ref=${transcriptRef}>
          ${turns.length === 0 && !working ? html`<p class="muted">Nothing yet. Type an instruction below and the agent will start working in the checkout.</p>` : ''}
          ${turns.map(
            (t) => html`
              <div class="chat-turn" data-role="user" key=${`${t.run_id}-q`}>
                <div class="chat-bubble"><div class="user-message">${t.instruction}</div></div>
              </div>
              ${t.answer
                ? html`
                    <div class="chat-turn" data-role="assistant" key=${`${t.run_id}-a`}>
                      <div class="chat-role">Session</div>
                      <div class="chat-bubble"><${Markdown} text=${t.answer} /></div>
                    </div>
                  `
                : turnFailureText(t)
                  ? html`
                      <div class="chat-turn" data-role="assistant" key=${`${t.run_id}-e`}>
                        <div class="chat-error">${turnFailureText(t)}</div>
                      </div>
                    `
                  : ''}
            `
          )}
          ${working ? html`<div class="chat-turn answering"><${Spinner} /> <span class="chat-live">working in the checkout…</span></div>` : ''}
          ${error ? html`<div class="chat-error">${error}</div>` : ''}
        </div>

        <div class="chat-composer" ref=${composerRef}>
          <${TextArea}
            value=${input}
            onInput=${setInput}
            onKeyDown=${onKeyDown}
            placeholder=${stopped || archived ? 'Resume this session to send an instruction…' : 'Tell the session what to do…'}
            rows=${1}
            ?disabled=${busy || working || stopped || archived}
          />
          <button
            class="btn"
            onclick=${send}
            ?disabled=${!input.trim() || busy || working || stopped || archived}
            title=${working ? 'Working…' : 'Send'}
            aria-label=${working ? 'Working…' : 'Send'}
          >↑</button>
        </div>
        <div class="chat-hint">Enter to send · Shift+Enter for a new line · every write and command is approved above</div>
      </div>

      <div class="card session-side">
        <div class="card-header">
          <h2>Activity</h2>
          <button class="btn secondary" onclick=${() => setShowActivity((v) => !v)}>${showActivity ? 'Hide' : 'Show'}</button>
        </div>
        ${budget
          ? html`
              <div class="session-budget">
                <div class="muted">Spent in this session</div>
                <div class="session-budget-figure">${formatCost(budget.spent)}${budget.runCap ? html` <span class="muted">of ${formatCost(budget.runCap)} per turn</span>` : ''}</div>
                ${budget.dailyCap
                  ? html`<div class="muted">Today across sessions: ${formatCost(budget.todaySpent)} of ${formatCost(budget.dailyCap)}</div>`
                  : null}
              </div>
            `
          : null}
        ${showActivity ? html`<${Activity} store=${events} />` : null}
      </div>
    </div>
  `;
}
