// A Claude session: its transcript, what it is waiting on, and the box to talk to it.
import { html, useEffect, useMemo, useRef, useState, recall, remember, isTouch, formatCost, formatDuration } from '../lib.mjs';
import { api, useStore, watchSession } from '../api.mjs';
import { Markdown } from '../components/markdown.mjs';
import { MoreMenu } from '../components/menu.mjs';
import { showToast } from '../components/toast.mjs';
import { confirmAction } from '../components/confirm.mjs';
import { TerminalPane } from '../components/terminal.mjs';
import { StatusBadge, ModelPicker, ModePicker, MODES, Dialog, Icon } from '../components/ui.mjs';

const toast = (e) => showToast(e.message || String(e), 'error');

export function SessionPane({ sessionId, onArchived }) {
  const live = useStore((s) => s.sessions.find((x) => x.id === sessionId));
  const providers = useStore((s) => s.providers);
  const approvals = useStore((s) => s.approvals.filter((a) => a.session_id === sessionId));
  const [loaded, setLoaded] = useState(null);
  // An archived session is not in the live list, so the copy read on open stands in.
  const session = live || (loaded?.session?.id === sessionId ? loaded.session : null);
  const taskState = useStore((st) => (session?.task_id ? st.tasks.find((t) => t.id === session.task_id)?.state : null));
  const [events, setEvents] = useState([]);
  const [stream, setStream] = useState({ text: '', thinking: '' });
  const [more, setMore] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const scroller = useRef(null);
  const pinned = useRef(true);

  const load = () =>
    api
      .session(sessionId)
      .then((r) => {
        setLoaded(r);
        setEvents(r.events);
        setMore(r.events.length >= 400);
        setStream({ text: '', thinking: '' });
      })
      .catch(toast);

  useEffect(() => {
    setLoaded(null);
    setEvents([]);
    pinned.current = true;
    load();
    const off = watchSession(sessionId, (m) => {
      if (m.type === 'event') {
        setEvents((list) => (list.some((e) => e.id === m.event.id) ? list : [...list, m.event]));
        if (m.event.kind === 'assistant' || m.event.kind === 'result' || m.event.kind === 'error') setStream({ text: '', thinking: '' });
      } else if (m.type === 'delta') {
        setStream((s) => (m.thinking ? { ...s, thinking: s.thinking + m.text } : { ...s, text: s.text + m.text }));
      }
    });
    const again = () => load();
    window.addEventListener('ai-code:reconnected', again);
    return () => {
      off();
      window.removeEventListener('ai-code:reconnected', again);
    };
  }, [sessionId]);

  // Follows the bottom while the reader is there; leaves them alone when they scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [events, stream, approvals.length]);

  const earlier = async () => {
    const before = events[0]?.id;
    if (!before) return;
    const older = await api.events(sessionId, before).catch(toast);
    if (!older) return;
    setMore(older.length >= 400);
    const el = scroller.current;
    const from = el ? el.scrollHeight - el.scrollTop : 0;
    pinned.current = false;
    setEvents((list) => [...older, ...list]);
    requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight - from));
  };

  if (session) base = session.cwd;
  if (!session) return html`<div class="pane-empty muted">${loaded === null ? 'Loading…' : 'This session is gone.'}</div>`;
  const s = session;
  const running = s.status === 'running' || s.status === 'waiting';

  const rename = async () => {
    const title = prompt('Rename session', s.title);
    if (title && title.trim() !== s.title) api.updateSession(s.id, { title }).catch(toast);
  };

  return html`
    <section class="session">
      <header class="session-head">
        <div class="session-title">
          <button class="title-btn" type="button" title="Rename" onClick=${rename}>${s.title}</button>
          <${StatusBadge} status=${s.status} />
          ${s.cost ? html`<span class="muted mono-sm" title="Estimated spend">${formatCost(s.cost)}</span>` : null}
        </div>
        <div class="session-controls">
          <${ModelPicker} compact providers=${providers} value=${{ providerId: s.provider_id, modelId: s.model_id }} onChange=${(v) => api.updateSession(s.id, v).catch(toast)} />
          <${ModePicker} compact value=${s.permission_mode} onChange=${(mode) => api.updateSession(s.id, { mode }).catch(toast)} />
          <${MoreMenu}
            items=${[
              { label: 'Open in terminal (claude --resume)', disabled: !s.claude_session_id || running, onSelect: () => setTerminal(true) },
              { label: 'Rename', onSelect: rename },
              s.archived_at
                ? { label: 'Unarchive', onSelect: () => api.archiveSession(s.id, false).catch(toast) }
                : { label: 'Archive', onSelect: () => api.archiveSession(s.id).then(() => onArchived?.()).catch(toast) },
              {
                label: 'Delete',
                danger: true,
                onSelect: async () => {
                  if (await confirmAction({ title: 'Delete this session?', body: 'Its transcript here is removed. Files it changed stay as they are.', confirmLabel: 'Delete', tone: 'danger' })) api.deleteSession(s.id).then(() => onArchived?.()).catch(toast);
                },
              },
            ]}
          />
        </div>
      </header>
      <div
        class="transcript"
        ref=${scroller}
        onScroll=${(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        ${more ? html`<button class="btn sm ghost earlier" type="button" onClick=${earlier}>Load earlier</button>` : null}
        ${events.length === 0 && loaded ? html`<div class="transcript-empty muted">Say what you want done. Claude works in <code>${s.cwd}</code>.</div>` : null}
        <${Transcript} events=${events} />
        ${stream.thinking && !stream.text ? html`<div class="msg-thinking live"><span class="muted">Thinking…</span></div>` : null}
        ${stream.text ? html`<div class="msg assistant streaming"><${Markdown} text=${stream.text} /></div>` : null}
        ${s.status === 'running' && !stream.text ? html`<div class="working"><span class="dot dot-running"></span> Working…</div>` : null}
        ${s.status === 'error' && s.error ? html`<div class="notice notice-bad">${s.error}</div>` : null}
        ${approvals.map((a) => html`<${ApprovalCard} key=${a.id} approval=${a} />`)}
      </div>
      ${s.archived_at
        ? html`<div class="composer archived muted">
            ${taskState && taskState !== 'active'
              ? html`<span>This task is ${taskState}. Its sessions are kept as a record.</span>`
              : html`<span>Archived. <button class="link-btn" type="button" onClick=${() => api.archiveSession(s.id, false).catch(toast)}>Unarchive</button> to continue.</span>`}
          </div>`
        : html`<${Composer} session=${s} commands=${loaded?.commands || []} />`}
      ${terminal
        ? html`<${Dialog} wide title="claude --resume" onClose=${() => setTerminal(false)}>
            <p class="muted">The same conversation in Claude Code's own interface. Close this before sending from the composer again.</p>
            <div class="terminal-dialog"><${TerminalPane} query=${{ session: s.id }} /></div>
          <//>`
        : null}
    </section>
  `;
}

// -- the transcript ------------------------------------------------------------------------

function Transcript({ events }) {
  // A tool call and its result are stored as two events; the call is drawn with its result.
  const results = useMemo(() => {
    const m = new Map();
    for (const e of events) if (e.kind === 'tool_result') for (const r of e.data.results) m.set(r.tool_use_id, r);
    return m;
  }, [events]);
  return events.map((e) => html`<${Entry} key=${e.id} event=${e} results=${results} />`);
}

function Entry({ event: e, results }) {
  const d = e.data;
  if (e.kind === 'user') {
    return html`<div class="msg user"><div class="bubble">
      ${d.images || d.files?.length
        ? html`<div class="attached">
            ${d.images ? html`<span class="file-chip">${d.images} image${d.images === 1 ? '' : 's'}</span>` : null}
            ${(d.files || []).map((f) => html`<span class="file-chip" title=${`${f.type || 'file'}, ${fileSize(f.size)}`}>${f.name}</span>`)}
          </div>`
        : null}
      ${d.text ? html`<${Markdown} text=${d.text} />` : null}
    </div></div>`;
  }
  if (e.kind === 'assistant') {
    const sub = !!d.parent;
    return html`
      <div class="msg assistant ${sub ? 'subagent' : ''}">
        ${d.error ? html`<div class="notice notice-bad">API error: ${d.error}</div>` : null}
        ${(d.content || []).map((b, i) => {
          if (b.type === 'text') return b.text.trim() ? html`<${Markdown} key=${i} text=${b.text} />` : null;
          if (b.type === 'thinking') return html`<details key=${i} class="msg-thinking"><summary>Thinking</summary><${Markdown} text=${b.thinking} /></details>`;
          if (b.type === 'tool_use') return html`<${ToolCall} key=${b.id} call=${b} result=${results.get(b.id)} />`;
          return null;
        })}
      </div>
    `;
  }
  if (e.kind === 'result') {
    return html`<div class="turn-end ${d.is_error ? 'bad' : ''}">${d.is_error ? (d.subtype === 'error_during_execution' ? 'Stopped' : `Failed${d.text ? `: ${d.text}` : ''}`) : 'Done'}${d.duration_ms ? ` · ${formatDuration(d.duration_ms)}` : ''}</div>`;
  }
  if (e.kind === 'init') return html`<div class="sys-line">Claude Code ${d.version || ''} · ${d.model} · ${MODES.find((m) => m.value === d.permissionMode)?.label || d.permissionMode}</div>`;
  if (e.kind === 'notice') return html`<div class="sys-line">${d.text}</div>`;
  if (e.kind === 'error') return html`<div class="notice notice-bad">${d.message}</div>`;
  return null;
}

/** The text of a tool result, whatever shape it came in. */
function resultText(r) {
  if (!r) return '';
  if (typeof r.content === 'string') return r.content;
  if (Array.isArray(r.content)) return r.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
  return JSON.stringify(r.content, null, 2);
}

// Paths are shown relative to the session's directory, which every tool call shares.
let base = '';
const rel = (p) => {
  const s = String(p || '');
  return base && s.startsWith(`${base}/`) ? s.slice(base.length + 1) : s;
};

function ToolCall({ call, result }) {
  const i = call.input || {};
  const [open, setOpen] = useState(false);
  const failed = result?.is_error;
  let head = call.name;
  let detail = null;
  switch (call.name) {
    case 'Bash':
      head = html`<code>$ ${i.command}</code>`;
      detail = i.description ? html`<span class="muted">${i.description}</span>` : null;
      break;
    case 'Edit':
    case 'MultiEdit': {
      const edits = call.name === 'MultiEdit' ? i.edits || [] : [i];
      head = html`Edit <code>${rel(i.file_path)}</code>`;
      detail = html`<pre class="mini-diff">${edits.map((ed) => [
        ...String(ed.old_string ?? '').split('\n').map((l) => html`<span class="diff-del">-${l}\n</span>`),
        ...String(ed.new_string ?? '').split('\n').map((l) => html`<span class="diff-add">+${l}\n</span>`),
      ])}</pre>`;
      break;
    }
    case 'Write':
      head = html`Write <code>${rel(i.file_path)}</code>`;
      detail = open ? html`<pre class="tool-out">${i.content}</pre>` : null;
      break;
    case 'Read':
      head = html`Read <code>${rel(i.file_path)}</code>`;
      break;
    case 'Glob':
    case 'Grep':
      head = html`${call.name} <code>${i.pattern}</code>${i.path ? html` in <code>${rel(i.path)}</code>` : null}`;
      break;
    case 'TodoWrite':
      head = 'Todos';
      detail = html`<ul class="todos">${(i.todos || []).map((t) => html`<li class=${t.status}>${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'} ${t.content}</li>`)}</ul>`;
      break;
    case 'Task':
    case 'Agent':
      head = html`Subagent: ${i.description || i.subagent_type || ''}`;
      break;
    case 'WebFetch':
      head = html`Fetch <code>${i.url}</code>`;
      break;
    case 'WebSearch':
      head = html`Search <code>${i.query}</code>`;
      break;
    default:
      head = html`${call.name}`;
      detail = open ? html`<pre class="tool-out">${JSON.stringify(i, null, 2)}</pre>` : null;
  }
  const out = resultText(result);
  return html`
    <div class="tool ${failed ? 'failed' : ''} ${result ? '' : 'pending'}">
      <button class="tool-head" type="button" onClick=${() => setOpen((v) => !v)} aria-expanded=${open}>
        <span class="tool-chev">${open ? '▾' : '▸'}</span>
        <span class="tool-name">${head}</span>
        ${!result ? html`<span class="dot dot-running"></span>` : failed ? html`<span class="tool-flag">error</span>` : null}
      </button>
      ${detail}
      ${open && out ? html`<pre class="tool-out ${failed ? 'bad' : ''}">${out}</pre>` : null}
      ${!open && failed && out ? html`<pre class="tool-out bad">${out.slice(0, 600)}</pre>` : null}
    </div>
  `;
}

// -- approvals -----------------------------------------------------------------------------

export function ApprovalCard({ approval: a, showSession }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [answers, setAnswers] = useState({});
  const answer = (body) => {
    setBusy(true);
    api.answer(a.id, body).catch((e) => {
      setBusy(false);
      toast(e);
    });
  };
  const i = a.input || {};

  if (a.tool === 'ExitPlanMode') {
    return html`
      <div class="approval plan">
        <div class="approval-head">Claude has a plan${showSession}</div>
        <div class="approval-body"><${Markdown} text=${i.plan || ''} /></div>
        <div class="approval-actions">
          <button class="btn" disabled=${busy} type="button" onClick=${() => answer({ allow: true, mode: 'acceptEdits' })}>Approve, accept edits</button>
          <button class="btn secondary" disabled=${busy} type="button" onClick=${() => answer({ allow: true, mode: 'default' })}>Approve, ask before edits</button>
        </div>
        <div class="approval-deny">
          <input class="input" placeholder="What should change?" value=${note} onInput=${(e) => setNote(e.target.value)} />
          <button class="btn secondary" disabled=${busy} type="button" onClick=${() => answer({ allow: false, message: note || 'Keep planning.' })}>Keep planning</button>
        </div>
      </div>
    `;
  }

  if (a.tool === 'AskUserQuestion') {
    const qs = i.questions || [];
    const done = qs.every((q) => answers[q.question]);
    return html`
      <div class="approval question">
        <div class="approval-head">Claude is asking${showSession}</div>
        ${qs.map(
          (q) => html`
            <div class="question-block">
              <div class="question-text">${q.question}</div>
              <div class="choices">
                ${(q.options || []).map((o) => {
                  const picked = q.multiSelect ? (answers[q.question] || '').split(', ').includes(o.label) : answers[q.question] === o.label;
                  return html`<button
                    type="button"
                    class="choice ${picked ? 'picked' : ''}"
                    title=${o.description || ''}
                    onClick=${() =>
                      setAnswers((s) => {
                        if (!q.multiSelect) return { ...s, [q.question]: o.label };
                        const cur = new Set((s[q.question] || '').split(', ').filter(Boolean));
                        cur.has(o.label) ? cur.delete(o.label) : cur.add(o.label);
                        return { ...s, [q.question]: [...cur].join(', ') };
                      })}
                  >
                    <strong>${o.label}</strong>${o.description ? html`<span class="muted">${o.description}</span>` : null}
                  </button>`;
                })}
                <input class="input" placeholder="Or type an answer" value=${(q.options || []).some((o) => o.label === answers[q.question]) ? '' : answers[q.question] || ''} onInput=${(e) => setAnswers((s) => ({ ...s, [q.question]: e.target.value }))} />
              </div>
            </div>
          `
        )}
        <div class="approval-actions">
          <button class="btn" disabled=${busy || !done} type="button" onClick=${() => answer({ allow: true, answers })}>Answer</button>
          <button class="btn ghost" disabled=${busy} type="button" onClick=${() => answer({ allow: false, message: 'The user declined to answer.' })}>Skip</button>
        </div>
      </div>
    `;
  }

  return html`
    <div class="approval">
      <div class="approval-head">${a.title || `Claude wants to use ${a.tool}`}${showSession}</div>
      ${a.reason ? html`<div class="muted approval-reason">${a.reason}</div>` : null}
      <${ApprovalPreview} tool=${a.tool} input=${i} />
      <div class="approval-actions">
        <button class="btn" disabled=${busy} type="button" onClick=${() => answer({ allow: true })}>Allow</button>
        <button class="btn secondary" disabled=${busy} type="button" onClick=${() => answer({ allow: true, always: true })} title="Don't ask again for this in this session">Always allow</button>
        <button class="btn danger" disabled=${busy} type="button" onClick=${() => answer({ allow: false, message: note })}>Deny</button>
      </div>
      <input class="input approval-note" placeholder="Optional: tell Claude why, or what to do instead" value=${note} onInput=${(e) => setNote(e.target.value)} />
    </div>
  `;
}

function ApprovalPreview({ tool, input: i }) {
  if (tool === 'Bash') return html`<pre class="tool-out">$ ${i.command}</pre>`;
  if (tool === 'Edit' || tool === 'MultiEdit') return html`<${ToolCall} call=${{ name: tool, input: i }} result=${{ content: '' }} />`;
  if (tool === 'Write') return html`<div><code>${rel(i.file_path)}</code><pre class="tool-out">${String(i.content || '').slice(0, 4000)}</pre></div>`;
  return html`<pre class="tool-out">${JSON.stringify(i, null, 2).slice(0, 4000)}</pre>`;
}

// -- the composer --------------------------------------------------------------------------

// Images up to this size go to Claude inline, as the API takes them. Anything else,
// a bigger image included, is saved on the server for Claude to read.
const INLINE_IMAGE = 5 * 1024 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const INLINE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

export function fileSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_FILE) return reject(new Error(`${file.name} is over 20 MB`));
    const r = new FileReader();
    r.onload = () => {
      const [head, data] = String(r.result).split(',');
      const media_type = /data:([^;]+)/.exec(head)?.[1] || file.type || 'application/octet-stream';
      const inline = INLINE_TYPES.test(media_type) && file.size <= INLINE_IMAGE;
      resolve({ media_type, data, name: file.name || 'pasted', size: file.size, inline, url: inline ? r.result : null });
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function Composer({ session: s, commands }) {
  const key = `ai-code:draft:${s.id}`;
  const [text, setText] = useState(() => recall(key, ''));
  const [images, setImages] = useState([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const box = useRef(null);
  const file = useRef(null);
  const running = s.status === 'running' || s.status === 'waiting';

  useEffect(() => {
    setText(recall(key, ''));
    setImages([]);
  }, [s.id]);
  useEffect(() => remember(key, text || null), [text]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  const slash = text.startsWith('/') && !text.includes(' ') ? commands.filter((c) => c.startsWith(text.slice(1))).slice(0, 8) : [];

  const send = async () => {
    if (sending || (!text.trim() && !images.length)) return;
    setSending(true);
    try {
      await api.send(
        s.id,
        text,
        images.filter((f) => f.inline).map(({ media_type, data }) => ({ media_type, data })),
        images.filter((f) => !f.inline).map(({ name, media_type, data }) => ({ name, media_type, data }))
      );
      setText('');
      setImages([]);
    } catch (e) {
      toast(e);
    } finally {
      setSending(false);
      box.current?.focus();
    }
  };

  const attach = async (files) => {
    for (const f of files) {
      try {
        const read = await readFile(f);
        setImages((list) => [...list, read]);
      } catch (e) {
        toast(e);
      }
    }
  };

  const cycleMode = () => {
    const order = ['default', 'acceptEdits', 'plan'];
    const next = order[(order.indexOf(s.permission_mode) + 1) % order.length];
    api.updateSession(s.id, { mode: next }).catch(toast);
  };

  return html`
    <div
      class="composer ${dragging ? 'dragging' : ''}"
      onDragOver=${(e) => {
        if ([...(e.dataTransfer?.types || [])].includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave=${() => setDragging(false)}
      onDrop=${(e) => {
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        setDragging(false);
        attach([...e.dataTransfer.files]);
      }}
    >
      ${slash.length ? html`<div class="slash">${slash.map((c) => html`<button type="button" onClick=${() => setText(`/${c} `)}>/${c}</button>`)}</div>` : null}
      ${images.length
        ? html`<div class="thumbs">
            ${images.map(
              (im, n) => html`<div class="thumb ${im.inline ? '' : 'file'}" title=${`${im.name}, ${fileSize(im.size)}`}>
                ${im.inline ? html`<img src=${im.url} alt=${im.name} />` : html`<span class="thumb-name">${im.name}</span><span class="muted">${fileSize(im.size)}</span>`}
                <button type="button" aria-label=${`Remove ${im.name}`} onClick=${() => setImages((l) => l.filter((_, j) => j !== n))}>×</button>
              </div>`
            )}
          </div>`
        : null}
      <div class="composer-row">
        <textarea
          ref=${box}
          class="input composer-input"
          rows="1"
          placeholder=${running ? 'Queue a follow-up…' : 'Message Claude…'}
          value=${text}
          onInput=${(e) => setText(e.target.value)}
          onPaste=${(e) => {
            const files = [...(e.clipboardData?.files || [])];
            if (files.length) {
              e.preventDefault();
              attach(files);
            }
          }}
          onKeyDown=${(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch()) {
              e.preventDefault();
              send();
            } else if (e.key === 'Tab' && e.shiftKey) {
              e.preventDefault();
              cycleMode();
            } else if (e.key === 'Escape' && running) {
              e.preventDefault();
              api.interrupt(s.id).catch(toast);
            }
          }}
        />
        <input ref=${file} type="file" multiple hidden onChange=${(e) => attach([...e.target.files])} />
        <button class="btn ghost icon-only" type="button" aria-label="Attach files" title="Attach images, PDFs or any file (or drop them here)" onClick=${() => file.current?.click()}><${Icon} name="attach" /></button>
        ${running ? html`<button class="btn danger icon-only" type="button" aria-label="Stop" title="Stop (Esc)" onClick=${() => api.interrupt(s.id).catch(toast)}><${Icon} name="stop" /></button>` : null}
        <button class="btn icon-only" type="button" aria-label="Send" disabled=${sending || (!text.trim() && !images.length)} onClick=${send}><${Icon} name="send" /></button>
      </div>
      <div class="composer-foot muted">
        <button class="link-btn" type="button" onClick=${cycleMode} title="Shift+Tab">${MODES.find((m) => m.value === s.permission_mode)?.label}</button>
        <span class="hide-touch"> · Enter to send, Shift+Enter for a new line, Esc to stop</span>
      </div>
    </div>
  `;
}
