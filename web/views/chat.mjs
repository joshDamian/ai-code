// Direct chat view. URL hash: #/chat (the conversations) or #/chat/:id (one of them).
import { html, useState, useEffect, useRef, useCallback, shortDir } from '../lib.mjs';
import { api, chatStreamUrl } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { Select } from '../components/form.mjs';
import { Markdown } from '../components/markdown.mjs';
import { Time } from '../components/time.mjs';
import { MemoryPanel } from './project.mjs';
import { NoProject } from '../components/empty-state.mjs';

// A turn the queue is still holding. Read from the job row rather than from a local
// flag, so a reload and a second tab see the same thing this one does.
const IN_FLIGHT = new Set(['queued', 'running']);

// Whether the conversation's project has something for the reader to decide. Intake,
// the proposals pass and spec inference answer in a chat turn, and their drafts land
// on the project - so the approval surface is rendered under the transcript that
// explains what is being approved. Any other conversation in the same project gets a
// one-line pointer instead: the drafts are the project's, not that conversation's.
function toDecide(project) {
  if (!project) return false;
  // The intake's first spec: approving it is also what creates the folder and the
  // repository, so it is offered even before any draft exists.
  if (project.idea && !project.spec) return true;
  return !!project.spec_draft || (project.drafts || []).length > 0;
}

const NOTHING_DRAFTED = { specPass: false, draftIds: [] };

// The pointer's words: what is waiting, counted.
function waitingText(project) {
  const n = (project.drafts || []).length;
  const bits = [];
  if (project.idea && !project.spec) bits.push('The first spec is waiting');
  else if (project.spec_draft) bits.push('A spec change is waiting');
  if (n) bits.push(`${n} drafted task${n === 1 ? '' : 's'} waiting`);
  return bits.join(' · ');
}

// Where the composer stops growing and starts scrolling instead. The same number
// the stylesheet caps the textarea at, because the two have to agree.
const COMPOSER_MAX_PX = 200;

// A turn that ended without an answer is the one failure the transcript cannot
// show: the question is there and nothing follows it. The job row is what says the
// turn is over and why, so it is the only thing that can report it.
function turnFailure(job, messages) {
  if (!job || IN_FLIGHT.has(job.state) || job.state === 'succeeded') return null;
  const last = messages[messages.length - 1];
  if (!last || last.role === 'assistant') return null;
  return job.error || `The answer ${job.state}.`;
}

export function Chat({ id: routeId, navigate, onTitle }) {
  // `#/chat/new` is the question box on its own, which is how a phone reaches it: the
  // list and the box do not fit side by side there.
  const isNew = routeId === 'new';
  const id = isNew ? null : routeId;
  const [projects, setProjects] = useState([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [sessions, setSessions] = useState(null);
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  // The conversation's project, read for the approval panel below the transcript.
  // Null in a conversation with nothing to decide, which is most of them.
  const [project, setProject] = useState(null);
  // What this conversation drafted, as the server reports it: whether a spec pass
  // ran here, and the ids of the waiting drafts its passes wrote.
  const [drafted, setDrafted] = useState(NOTHING_DRAFTED);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('');
  const [listTick, setListTick] = useState(0);
  const streamRef = useRef(null);
  const transcriptRef = useRef(null);
  const composerRef = useRef(null);
  // The stream's handlers are bound once per connection, so they read the transcript
  // through a ref rather than through the closure they were created in.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Pin the transcript to the newest turn. The scroll is done on the transcript
  // itself rather than with scrollIntoView on a sentinel at its end: scrollIntoView
  // moves every scrollable ancestor, so the page scrolled under the reader too.
  //
  // Opening a conversation jumps; only a message arriving while it is open animates.
  // A smooth scroll from the top of a long transcript is a page that appears to be
  // scrolling itself while the reader waits for it.
  const jumpedRef = useRef(false);
  useEffect(() => {
    jumpedRef.current = false;
  }, [id]);
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: jumpedRef.current ? 'smooth' : 'auto' });
    jumpedRef.current = true;
  }, [messages, streaming]);

  // The composer grows with what has been typed, up to the point where it scrolls
  // instead. TextArea is a generic field and renders its own <label>, so the height
  // is set on the textarea the chat shell owns rather than by the component.
  useEffect(() => {
    const ta = composerRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, COMPOSER_MAX_PX)}px`;
  }, [input]);

  // A conversation belongs to a project, and a session cannot be created without
  // one - so the projects are loaded here rather than handed in from the route.
  // The first is selected so the New Chat button is usable on arrival.
  useEffect(() => {
    let cancelled = false;
    api
      .projects()
      .then((p) => {
        if (cancelled) return;
        setProjects(p);
        setProjectsLoaded(true);
        setProjectId((cur) => cur || (p[0] && p[0].id) || '');
      })
      .catch((e) => {
        if (cancelled) return;
        setProjectsLoaded(true);
        setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const closeStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }
  }, []);

  // One message from the server, keyed by its id. The stream replays the transcript
  // from the client's cursor, so the same message can arrive twice - which is an
  // update, not a second row.
  const putMessage = useCallback((msg) => {
    setMessages((m) => (m.some((x) => x.id === msg.id) ? m.map((x) => (x.id === msg.id ? msg : x)) : [...m, msg]));
  }, []);

  // Read separately from the transcript and never awaited by it. The panel is an
  // addition to a conversation, not a prerequisite for one: a project that has gone
  // missing, or a fetch that fails, leaves the chat exactly as it renders today.
  const loadProject = useCallback(async (projectId) => {
    if (!projectId) {
      setProject(null);
      return;
    }
    try {
      setProject(await api.project(projectId));
    } catch {
      setProject(null);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await api.chatSession(id);
      setSession(d.session);
      setMessages(d.messages || []);
      setDrafted({ specPass: !!d.specPass, draftIds: d.draftIds || [] });
      loadProject(d.session.project_id);
      onTitle?.(d.session.title);
      setError(turnFailure(d.job, d.messages || []));
      // A turn already in flight when the page opened - a reload mid-answer, or a
      // second tab - is watched from here, so the answer arrives without the user
      // having to ask again. The unanswered question is the other half of the test:
      // the job row settles a moment after the answer is stored, and a stream opened
      // in that gap would be one watching a turn that is already over.
      //
      // Both directions of the answer are authoritative. The component instance
      // survives a navigation between the two chat routes, so `streaming` outlives
      // the conversation it was set for: leaving a turn mid-answer and opening
      // another one used to leave that composer disabled and reading "Answering…"
      // until the page was reloaded. Only a job that is genuinely in flight, with
      // its question still unanswered, may hold it.
      const last = (d.messages || [])[(d.messages || []).length - 1];
      const inFlight = d.job && IN_FLIGHT.has(d.job.state) && last?.role === 'user';
      if (inFlight) openStreamRef.current?.();
      else setStreaming(false);
    } catch (e) {
      setError(e.message);
    }
  }, [id, onTitle, loadProject]);

  const openStream = useCallback(() => {
    closeStream();
    const stream = new EventSource(chatStreamUrl(id));
    streamRef.current = stream;
    // Whether this connection has seen the turn it was opened for. The stream ends
    // on `answering` going false, and a resting session reports false from the
    // first tick - ending there would be a stream that never saw anything.
    let sawAnswering = false;
    const finish = () => {
      closeStream();
      setStreaming(false);
    };
    stream.addEventListener('meta', (e) => {
      const frame = JSON.parse(e.data);
      if (frame.session) setSession(frame.session);
      for (const m of frame.messages || []) putMessage(m);
    });
    stream.addEventListener('message', (e) => {
      const frame = JSON.parse(e.data);
      if (frame.role) putMessage(frame);
    });
    stream.addEventListener('state', (e) => {
      const st = JSON.parse(e.data);
      if (st.session) setSession(st.session);
      if (st.answering) {
        sawAnswering = true;
        setStreaming(true);
        return;
      }
      if (!sawAnswering) return;
      finish();
      setListTick((n) => n + 1);
      setError(turnFailure(st.job, messagesRef.current));
      // The title is derived from the first question and the answer is stored as its
      // own message, so the settled transcript is read back rather than assembled.
      load();
    });
    // Fires on the server ending the stream as well as on a real failure, so it
    // reports nothing by itself - it falls back to the stored turn, which is what
    // says whether an answer landed.
    stream.onerror = () => {
      finish();
      load();
    };
  }, [id, closeStream, putMessage, load]);

  // The loader runs before openStream is defined, and both are recreated when the
  // conversation changes: the ref is how the first reads the second without the
  // effect below depending on every callback it would otherwise have to.
  const openStreamRef = useRef(null);
  openStreamRef.current = openStream;

  useEffect(() => {
    if (!projectId) return undefined;
    let cancelled = false;
    // The list on screen belongs to the project that was selected: cleared before
    // the fetch, so a moment of loading is shown rather than another project's
    // conversations read as this one's.
    (async () => {
      try {
        const list = await api.chatSessions(projectId);
        if (!cancelled) setSessions(list);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, listTick]);

  // The list follows the open conversation's project, so a link into a chat in
  // another project shows that project's conversations beside it.
  useEffect(() => {
    if (session?.project_id) setProjectId(session.project_id);
  }, [session?.project_id]);

  useEffect(() => {
    if (!id) return undefined;
    load();
    return closeStream;
  }, [id, load, closeStream]);

  useEffect(() => {
    if (!id) {
      setSession(null);
      setMessages([]);
      setProject(null);
      setDrafted(NOTHING_DRAFTED);
      setError(null);
      // The stream is closed on the way out of a conversation, but nothing else
      // clears the flag it was running under - so Back mid-answer used to leave the
      // list's composer disabled behind it.
      setStreaming(false);
      onTitle?.(isNew ? 'New chat' : null);
    }
  }, [id, isNew, onTitle]);

  const openSession = useCallback((sessionId) => navigate(`#/chat/${sessionId}`), [navigate]);

  // A conversation is made by its first question: created and asked in one step, so
  // the list never holds an empty "New chat" nobody asked anything in.
  const startChat = useCallback(async () => {
    const text = input.trim();
    if (!projectId || !text || busy) return;
    setBusy(true);
    try {
      const s = await api.createChatSession(projectId);
      await api.sendChatMessage(s.id, text);
      setInput('');
      setListTick((n) => n + 1);
      openSession(s.id);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }, [projectId, input, busy, openSession]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || streaming) return;
    setBusy(true);
    setError(null);
    try {
      // The stored question, not an optimistic copy of it: the reply carries the row
      // the server wrote, so the stream's replay of it is an update rather than a
      // second bubble. Nothing is rendered that was not persisted.
      const { message } = await api.sendChatMessage(id, text);
      setInput('');
      putMessage(message);
      openStream();
    } catch (e) {
      // The question was refused - a turn already in flight is the usual reason - so
      // the text is left in the box to send again rather than dropped.
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }, [id, input, busy, streaming, putMessage, openStream]);

  // Enter sends; Shift+Enter is a newline. The composer is a textarea and a question
  // is usually one line, so the modifier belongs on the rare case rather than on the
  // common one.
  const onKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  const list = html`
    <aside class="ss-list" aria-label="Conversations">
      <div class="ss-list-head">
        <div class="ss-list-title">
          ${projects.length > 1
            ? html`<${Select} className="ss-project" ariaLabel="Project" value=${projectId} onChange=${setProjectId} options=${projects.map((p) => ({ value: p.id, label: p.name }))} />`
            : html`<span class="ss-project-name">${projects[0]?.name || ''}</span>`}
          <button class="btn primary sm ss-new" type="button" onClick=${() => navigate('#/chat/new')} disabled=${!projectId} aria-label="New chat">
            <svg class="ss-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg><span>New</span>
          </button>
        </div>
        <label class="ss-filter">
          <svg class="ss-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
          <input type="search" placeholder="Filter" aria-label="Filter conversations" value=${filter} onInput=${(e) => setFilter(e.target.value)} />
        </label>
      </div>
      <div class="ss-list-body">
        ${!projectsLoaded
          ? html`<div class="ss-list-empty"><${Spinner} /></div>`
          : !projects.length
          ? html`<p class="ss-list-empty muted">No projects yet.</p>`
          : sessions === null
            ? html`<div class="ss-list-empty"><${Spinner} /></div>`
            : !sessions.length
              ? html`<p class="ss-list-empty muted">No conversations in this project yet.</p>`
              : html`
                  <div class="ss-group">
                    ${sessions
                      .filter((s) => !filter.trim() || s.title.toLowerCase().includes(filter.trim().toLowerCase()))
                      .map(
                        (s) => html`
                          <a class="ss-row ${s.id === id ? 'active' : ''}" key=${s.id} href=${`#/chat/${s.id}`} aria-current=${s.id === id ? 'page' : null}>
                            <svg class="ss-ic chat-row-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h10v7H7l-3 3v-3H3z" /></svg>
                            <span class="ss-row-main">
                              <span class="ss-row-top">
                                <span class="ss-row-name">${s.title}</span>
                                <span class="ss-row-when"><${Time} at=${s.updated_at} /></span>
                              </span>
                            </span>
                          </a>
                        `
                      )}
                  </div>
                `}
      </div>
    </aside>
  `;

  // No conversation open: the list, and a question box beside it. Asking is the one
  // thing to do from here that is not opening a conversation, so it is not a button
  // that makes an empty one first.
  if (!id) {
    const project = projects.find((p) => p.id === projectId);
    return html`
      <div class="ss-shell ${isNew ? 'ss-shell-new' : 'ss-shell-index'} chat-shell">
        ${list}
        <div class="ss-new-pane">
          ${projectsLoaded && !projects.length
            ? html`<div class="ss-new-inner"><${NoProject} what="A conversation reads a project’s code to answer, so it needs a project to read." /></div>`
            : html`<div class="ss-new-inner">
            ${isNew ? html`<a class="ss-back" href="#/chat"><svg class="ss-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="m10 3-5 5 5 5" /></svg> Conversations</a>` : null}
            <div class="ss-new-head">
              <span class="muted">A conversation about <strong>${project?.name || '—'}</strong>${project ? html` · <span class="ss-mono" title=${project.path}>${shortDir(project.path)}</span>` : null}</span>
              <h2>What do you want to know?</h2>
            </div>
            <div class="ss-new-box">
              <textarea
                rows="4"
                aria-label="Question"
                placeholder="e.g. Where is the retry policy for provider calls, and what does it do on a 429?"
                value=${input}
                disabled=${busy || !projectId}
                onInput=${(e) => setInput(e.target.value)}
                onKeyDown=${(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    startChat();
                  }
                }}
              ></textarea>
              <div class="ss-new-bar">
                <span class="muted chat-note">Read-only: the agent reads the project and answers. Nothing is changed.</span>
                <span class="ss-new-spacer"></span>
                <span class="ss-mono muted ss-kbd-hint">⌘↵</span>
                <button class="btn primary" type="button" onClick=${startChat} disabled=${busy || !input.trim() || !projectId}>${busy ? 'Asking…' : 'Ask'}</button>
              </div>
            </div>
            ${error ? html`<div class="ss-failure">${error}</div>` : null}
          </div>`}
        </div>
      </div>
    `;
  }

  // Conversation view.
  return html`
    <div class="ss-shell ss-shell-index chat-shell chat-open">
      ${list}
      <main class="ss-conv" aria-label=${session?.title || 'Chat'}>
        <header class="ss-conv-head">
          <a class="btn secondary ss-icon-btn ss-back-btn" href="#/chat" aria-label="Back to conversations">
            <svg class="ss-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="m10 3-5 5 5 5" /></svg>
          </a>
          <div class="ss-conv-title">
            <div class="ss-title-row"><h2>${session?.title || 'Chat'}</h2></div>
            <div class="ss-meta">
              ${session ? html`<span>${projects.find((p) => p.id === session.project_id)?.name || ''}</span><span aria-hidden="true">·</span>` : null}
              <span>${messages.filter((m) => m.role === 'user').length} question${messages.filter((m) => m.role === 'user').length === 1 ? '' : 's'}</span>
              <span aria-hidden="true">·</span>
              <span>Read-only</span>
            </div>
          </div>
        </header>

        <div class="ss-transcript" ref=${transcriptRef}>
          ${messages.map((msg) =>
            msg.role === 'assistant'
              ? html`<div class="ss-answer" key=${msg.id}><${Markdown} text=${msg.content} className="md ss-md" /></div>`
              : html`<div class="ss-said" key=${msg.id}>${msg.content}</div>`
          )}
          ${streaming ? html`<div class="ss-live"><${Spinner} /> <span>Reading the project…</span></div>` : null}
          ${error ? html`<div class="ss-failure">${error}</div>` : null}
          ${(() => {
            if (!toDecide(project)) return null;
            const own = new Set(drafted.draftIds);
            const mine = (project.drafts || []).filter((d) => own.has(d.id));
            if (drafted.specPass || mine.length)
              return html`<div class="chat-decide">
                <${MemoryPanel}
                  project=${project}
                  navigate=${navigate}
                  onReload=${() => loadProject(project.id)}
                  showSpec=${drafted.specPass}
                  draftIds=${drafted.draftIds}
                />
              </div>`;
            return html`<div class="chat-waiting">
              <span>${waitingText(project)}</span>
              <a class="link" href=${`#/project/${project.id}`}>Review on the project page</a>
            </div>`;
          })()}
        </div>

        <div class="ss-dock">
          <div class="ss-composer ${busy || streaming ? 'locked' : ''}">
            <textarea
              ref=${composerRef}
              rows="1"
              aria-label="Question"
              placeholder=${streaming ? 'Answering…' : 'Ask a follow-up…'}
              value=${input}
              disabled=${busy || streaming}
              onInput=${(e) => setInput(e.target.value)}
              onKeyDown=${onKeyDown}
            ></textarea>
            <button class="ss-send" type="button" aria-label=${streaming ? 'Answering…' : 'Send'} onClick=${sendMessage} disabled=${!input.trim() || busy || streaming}>
              <svg class="ss-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M4 7l4-4 4 4" /></svg>
            </button>
          </div>
          <div class="ss-hint">Enter to send · Shift+Enter for a new line</div>
        </div>
      </main>
    </div>
  `;
}
