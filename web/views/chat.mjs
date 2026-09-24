// Direct chat view. URL hash: #/chat (the conversations) or #/chat/:id (one of them).
import { html, useState, useEffect, useRef, useCallback } from '../lib.mjs';
import { api, chatStreamUrl } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { TextArea, Select } from '../components/form.mjs';
import { Markdown } from '../components/markdown.mjs';

// A turn the queue is still holding. Read from the job row rather than from a local
// flag, so a reload and a second tab see the same thing this one does.
const IN_FLIGHT = new Set(['queued', 'running']);

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

export function Chat({ id, navigate, onTitle }) {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [sessions, setSessions] = useState(null);
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
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
    const ta = composerRef.current && composerRef.current.querySelector('textarea');
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
  }, []);

  // One message from the server, keyed by its id. The stream replays the transcript
  // from the client's cursor, so the same message can arrive twice - which is an
  // update, not a second row.
  const putMessage = useCallback((msg) => {
    setMessages((m) => (m.some((x) => x.id === msg.id) ? m.map((x) => (x.id === msg.id ? msg : x)) : [...m, msg]));
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await api.chatSession(id);
      setSession(d.session);
      setMessages(d.messages || []);
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
  }, [id, onTitle]);

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
    if (id) return undefined;
    let cancelled = false;
    // The list on screen belongs to the project that was selected: cleared before
    // the fetch, so a moment of loading is shown rather than another project's
    // conversations read as this one's.
    setSessions(null);
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
  }, [id, projectId]);

  useEffect(() => {
    if (!id) return undefined;
    load();
    return closeStream;
  }, [id, load, closeStream]);

  useEffect(() => {
    if (!id) {
      setSession(null);
      setMessages([]);
      setError(null);
      // The stream is closed on the way out of a conversation, but nothing else
      // clears the flag it was running under - so Back mid-answer used to leave the
      // list's composer disabled behind it.
      setStreaming(false);
      onTitle?.(null);
    }
  }, [id, onTitle]);

  const openSession = useCallback((sessionId) => navigate(`#/chat/${sessionId}`), [navigate]);

  const createSession = useCallback(async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      const s = await api.createChatSession(projectId);
      openSession(s.id);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }, [projectId, openSession]);

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

  // List view.
  if (!id) {
    const project = projects.find((p) => p.id === projectId);
    return html`
      <div class="chat-list">
        <div class="card">
          <div class="card-header">
            <h1>Direct Chat</h1>
            <button class="btn" onclick=${createSession} ?disabled=${busy || !projectId}>
              ${busy ? 'Creating…' : 'New Chat'}
            </button>
          </div>
          <div class="row">
            <${Select}
              label="Project"
              value=${projectId}
              onChange=${setProjectId}
              options=${projects.map((p) => ({ value: p.id, label: p.name }))}
            />
          </div>
          ${error ? html`<div class="chat-error">${error}</div>` : ''}
          ${!projects.length
            ? html`<p class="muted">Add a project first.</p>`
            : sessions === null
              ? html`<div class="spinner"><${Spinner} /></div>`
              : sessions.length === 0
                ? html`<p class="muted">No chats in ${project?.name || 'this project'} yet. Ask a question to start one.</p>`
                : html`
                    <div class="sessions-list">
                      ${sessions.map(
                        (s) => html`
                          <div class="session-item" onclick=${() => openSession(s.id)}>
                            <div class="session-title">${s.title}</div>
                            <div class="session-date">${new Date(s.updated_at).toLocaleString()}</div>
                          </div>
                        `
                      )}
                    </div>
                  `}
        </div>
      </div>
    `;
  }

  // Conversation view.
  return html`
    <div class="chat-conversation">
      <div class="card chat-card">
        <div class="card-header">
          <h1>${session?.title || 'Chat'}</h1>
          <button class="btn secondary" onclick=${() => navigate('#/chat')}>Back</button>
        </div>

        <div class="chat-transcript" ref=${transcriptRef}>
          ${messages.map(
            (msg) => html`
              <div class="chat-turn" data-role=${msg.role}>
                ${msg.role === 'assistant' ? html`<div class="chat-role">Assistant</div>` : null}
                <div class="chat-bubble">
                  ${msg.role === 'assistant'
                    ? html`<${Markdown} text=${msg.content} />`
                    : html`<div class="user-message">${msg.content}</div>`}
                </div>
              </div>
            `
          )}
          ${streaming ? html`<div class="chat-turn answering"><${Spinner} /> <span class="chat-live">reading the project…</span></div>` : ''}
          ${error ? html`<div class="chat-error">${error}</div>` : ''}
        </div>

        <div class="chat-composer" ref=${composerRef}>
          <${TextArea}
            value=${input}
            onInput=${setInput}
            onKeyDown=${onKeyDown}
            placeholder="Ask a question about this project…"
            rows=${1}
            ?disabled=${busy || streaming}
          />
          <button
            class="btn"
            onclick=${sendMessage}
            ?disabled=${!input.trim() || busy || streaming}
            title=${streaming ? 'Answering…' : 'Send'}
            aria-label=${streaming ? 'Answering…' : 'Send'}
          >↑</button>
        </div>
        <div class="chat-hint">Enter to send · Shift+Enter for a new line</div>
      </div>
    </div>
  `;
}
