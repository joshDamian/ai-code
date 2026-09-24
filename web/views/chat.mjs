// Direct chat view. URL hash: #/chat or #/chat/:id
import { html, useState, useEffect, useRef, useCallback, Fragment } from '../lib.mjs';
import { api, chatStreamUrl } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { TextArea } from '../components/form.mjs';
import { Markdown } from '../components/markdown.mjs';

export function Chat({ id, navigate, projectId, onTitle }) {
  const [sessions, setSessions] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [streaming, setStreaming] = useState(false);
  const [session, setSession] = useState(null);
  const messagesEndRef = useRef(null);

  // Auto-scroll to bottom when messages change.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Load sessions list or a specific chat.
  useEffect(() => {
    const load = async () => {
      try {
        if (id) {
          const s = await api.chatSession(id);
          setSession(s.session);
          setMessages(s.messages || []);
          onTitle?.(s.session.title);
        } else {
          const list = await api.chatSessions(projectId);
          setSessions(list);
          onTitle?.(null);
        }
        setError(null);
      } catch (e) {
        setError(e.message);
      }
    };
    load();
  }, [id, projectId, onTitle]);

  const openSession = useCallback((sessionId) => {
    navigate(`#/chat/${sessionId}`);
  }, [navigate]);

  const createSession = useCallback(async () => {
    try {
      setBusy(true);
      const s = await api.createChatSession(projectId, 'New chat');
      openSession(s.id);
    } catch (e) {
      showToast(`Failed to create chat: ${e.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }, [projectId, openSession]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || busy || streaming) return;

    const text = input.trim();
    setInput('');
    setBusy(true);
    setStreaming(true);

    try {
      // Add user message optimistically.
      const userMsg = { id: `temp-${Date.now()}`, role: 'user', content: text };
      setMessages((m) => [...m, userMsg]);

      // Queue the message and get the response job.
      const result = await api.sendChatMessage(id, text);

      // Open the stream to get the answer.
      const stream = new EventSource(chatStreamUrl(id));
      let assistantMsg = null;

      stream.addEventListener('message', (e) => {
        const frame = JSON.parse(e.data);
        if (frame.type === 'message') {
          const msg = frame.data;
          if (msg.role === 'assistant') {
            assistantMsg = msg;
            setMessages((m) => [...m, msg]);
          }
        }
      });

      stream.addEventListener('state', (e) => {
        const state = JSON.parse(e.data);
        if (!state.answering) {
          stream.close();
          setStreaming(false);
          if (assistantMsg) {
            // Update the session title if this was the first question.
            const reload = async () => {
              try {
                const s = await api.chatSession(id);
                setSession(s.session);
              } catch (e) {
                console.error('Failed to reload session:', e);
              }
            };
            reload();
          }
        }
      });

      stream.onerror = () => {
        stream.close();
        setStreaming(false);
        showToast('Stream error', 'error');
      };
    } catch (e) {
      showToast(`Failed to send: ${e.message}`, 'error');
      setStreaming(false);
    } finally {
      setBusy(false);
    }
  }, [id, input, busy, streaming]);

  // Handle Cmd/Ctrl+Enter to send.
  const onKeyDown = useCallback((e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    }
  }, [sendMessage]);

  // List view.
  if (!id) {
    return html`
      <div class="chat-list">
        <div class="card">
          <div class="card-header">
            <h1>Direct Chat</h1>
            <button onclick=${createSession} ?disabled=${busy || !projectId}>
              ${busy ? 'Creating…' : 'New Chat'}
            </button>
          </div>
          ${error ? html`<div class="error-box">${error}</div>` : ''}
          ${sessions === null
            ? html`<div class="spinner"><${Spinner} /></div>`
            : sessions.length === 0
              ? html`<p>No chats yet. Create one to get started.</p>`
              : html`
                  <div class="sessions-list">
                    ${sessions.map((s) => html`
                      <div class="session-item" onclick=${() => openSession(s.id)}>
                        <div class="session-title">${s.title}</div>
                        <div class="session-date">${new Date(s.updated_at).toLocaleString()}</div>
                      </div>
                    `)}
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
          ${session ? html`<button onclick=${() => navigate('#/chat')} class="back-btn">Back</button>` : ''}
        </div>

        <div class="chat-transcript">
          ${error ? html`<div class="error-box">${error}</div>` : ''}
          ${messages.map((msg) => html`
            <div class="chat-turn" data-role=${msg.role}>
              <div class="chat-bubble">
                ${msg.role === 'assistant'
                  ? html`<${Markdown} text=${msg.content} />`
                  : html`<div class="user-message">${msg.content}</div>`}
              </div>
            </div>
          `)}
          ${streaming ? html`<div class="chat-turn answering"><div class="chat-bubble"><${Spinner} /></div></div>` : ''}
          <div ref=${messagesEndRef} />
        </div>

        <div class="chat-composer">
          <${TextArea}
            value=${input}
            oninput=${(e) => setInput(e.target.value)}
            onkeydown=${onKeyDown}
            placeholder="Ask a question about this project..."
            ?disabled=${busy || streaming}
          />
          <button onclick=${sendMessage} ?disabled=${!input.trim() || busy || streaming}>
            ${streaming ? 'Answering…' : busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  `;
}
