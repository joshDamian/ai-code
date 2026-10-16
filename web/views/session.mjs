// A Claude session: its transcript, what it is waiting on, and the box to talk to it.
import { html, useEffect, useMemo, useRef, useState, recall, remember, isTouch, shortDir, formatCost, formatDuration } from '../lib.mjs';
import { api, useStore, watchSession, outboxCount } from '../api.mjs';
import { Markdown } from '../components/markdown.mjs';
import { slashMatches } from '../format.mjs';
import { MoreMenu } from '../components/menu.mjs';
import { CopyButton } from '../components/copy.mjs';
import { showToast } from '../components/toast.mjs';
import { confirmAction } from '../components/confirm.mjs';
import { TerminalPane } from '../components/terminal.mjs';
import { FilesContext, useSessionFiles, useViewer, FileViewer, FileButtons, FileThumb } from '../components/files.mjs';
import { StatusBadge, ModelPicker, ModePicker, EffortPicker, MODES, Dialog, Sheet, Icon } from '../components/ui.mjs';

const toast = (e) => showToast(e.message || String(e), 'error');

// The transcript as it was when it was last read, kept per session so reopening one - the
// common case on a phone, where a session is left and returned to all day - draws its
// history at once instead of an empty pane and a spinner. Bounded to the tail: that is
// what a person comes back to, and a whole conversation of tool output is more than the
// small storage a browser grants will hold. The fetch replaces it either way.
const eventsKey = (id) => `bench:events:${id}`;
const EVENTS_CACHED = 150;

// The shell can sit beside the conversation instead of over it. Whether it docks is one
// choice for every session; whether it is open is per session, so going back to one
// brings its shell back with it. The dock's width is the person's, within limits the
// stylesheet keeps (it never takes the chat below a readable column).
const DOCK_KEY = 'bench:terminal:docked';
const DOCK_WIDTH_KEY = 'bench:terminal:dock-width';
const dockOpenKey = (id) => `bench:terminal:open:${id}`;
const DOCK_MIN = 320;
const DOCK_DEFAULT = 520;
// Where docking stops making sense: below this the two columns are each too narrow to
// use, and the phone layout begins, so the terminal is a modal there whatever was chosen.
const DOCK_MEDIA = '(min-width: 1000px)';

function useMedia(query) {
  const get = () => typeof matchMedia === 'function' && matchMedia(query).matches;
  const [on, setOn] = useState(get);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const mq = matchMedia(query);
    const change = () => setOn(mq.matches);
    mq.addEventListener('change', change);
    return () => mq.removeEventListener('change', change);
  }, [query]);
  return on;
}

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
  const [suggestion, setSuggestion] = useState('');
  // The slash commands the composer suggests. Asked for on open, so a session that has
  // never run has them too, and replaced when the session's Claude Code says they changed.
  const [commands, setCommands] = useState([]);
  const [more, setMore] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [docked, setDocked] = useState(() => recall(DOCK_KEY, false));
  const [shell, setShellState] = useState(() => docked && recall(dockOpenKey(sessionId), false));
  const [dockWidth, setDockWidth] = useState(() => recall(DOCK_WIDTH_KEY, DOCK_DEFAULT));
  const canDock = useMedia(DOCK_MEDIA);
  const setShell = (open) => {
    setShellState(open);
    remember(dockOpenKey(sessionId), open && docked ? true : null);
  };
  const dock = (on) => {
    setDocked(on);
    remember(DOCK_KEY, on || null);
    remember(dockOpenKey(sessionId), on && shell ? true : null);
  };
  const sectionRef = useRef(null);
  const [sheet, setSheet] = useState(false);
  // The reader is at the bottom (following) or has scrolled up to read. `pinned` is what
  // the auto-scroll follows; `showJump` is the tap-to-catch-up button, offered only when
  // the reader is away from the bottom and something new has landed.
  const scroller = useRef(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const files = useSessionFiles(sessionId, events);
  const [viewing, view, closeViewer] = useViewer();
  const filesCtx = useMemo(() => ({ sessionId, files, view }), [sessionId, files]);

  const load = () =>
    api
      .session(sessionId)
      .then((r) => {
        setLoaded(r);
        if (r.commands?.length) setCommands(r.commands);
        setEvents(r.events);
        setMore(r.events.length >= 400);
        setStream({ text: '', thinking: '' });
        remember(eventsKey(sessionId), r.events.slice(-EVENTS_CACHED));
      })
      .catch(toast);

  useEffect(() => {
    setLoaded(null);
    setEvents(recall(eventsKey(sessionId), []));
    setSuggestion('');
    setCommands([]);
    pinned.current = true;
    load();
    api.sessionCommands(sessionId).then(setCommands).catch(() => {});
    // Streaming text is gathered and drawn at most once a frame: re-rendering the
    // Markdown for every few characters is what made a long reply crawl on a phone.
    let pending = { text: '', thinking: '' };
    let frame = 0;
    const flush = () => {
      frame = 0;
      const add = pending;
      pending = { text: '', thinking: '' };
      if (add.text || add.thinking) setStream((st) => ({ text: st.text + add.text, thinking: st.thinking + add.thinking }));
    };
    const drop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      pending = { text: '', thinking: '' };
    };
    const off = watchSession(sessionId, (m) => {
      if (m.type === 'suggestion') setSuggestion(m.text);
      else if (m.type === 'commands') setCommands(m.commands);
      else if (m.type === 'event') {
        // A new turn makes the last prediction stale.
        if (m.event.kind === 'user' || m.event.kind === 'assistant') setSuggestion('');
        setEvents((list) => (list.some((e) => e.id === m.event.id) ? list : [...list, m.event]));
        if (m.event.kind === 'assistant' || m.event.kind === 'result' || m.event.kind === 'error') {
          drop();
          setStream({ text: '', thinking: '' });
        }
      } else if (m.type === 'delta') {
        if (m.thinking) pending.thinking += m.text;
        else pending.text += m.text;
        // A hidden tab gets no animation frames; it is drawn when it is looked at.
        if (!frame) frame = requestAnimationFrame(flush);
      }
    });
    const again = () => {
      drop();
      load();
    };
    window.addEventListener('bench:reconnected', again);
    return () => {
      off();
      drop();
      window.removeEventListener('bench:reconnected', again);
    };
  }, [sessionId]);

  // Follows the bottom while the reader is there; leaves them alone when they scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (pinned.current) el.scrollTop = el.scrollHeight;
    // Something arrived while the reader was up in the history: offer a way back down
    // rather than yanking the page out from under them.
    else setShowJump(true);
  }, [events, stream, approvals.length]);

  const toBottom = () => {
    const el = scroller.current;
    pinned.current = true;
    setShowJump(false);
    if (el) el.scrollTop = el.scrollHeight;
  };

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

  // Model, effort, mode and the way out, as one chip on a phone: four controls in the
  // header is a row of narrow selects a thumb cannot hit, and the conversation is what
  // the screen is for. The chip names what the session runs as and opens a sheet.
  const provider = providers.find((p) => p.id === s.provider_id);
  const model = provider?.models?.find((m) => m.id === s.model_id);
  const modelName = model ? model.display_name || model.name : provider?.name || 'Model';
  const modeName = MODES.find((m) => m.value === s.permission_mode)?.label || s.permission_mode;
  const setMode = (mode) => api.updateSession(s.id, { mode }).catch(toast);
  const inDock = shell && docked && canDock;
  const shellTitle = `Terminal · ${s.cwd}`;
  const items = [
    inDock ? { label: 'Close the terminal', onSelect: () => setShell(false) } : { label: 'Terminal in this folder', onSelect: () => setShell(true) },
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
  ];

  // The first approval, and whether it is one a single tap can settle. A plan and a
  // question need the card that shows them; a permission prompt does not.
  const first = approvals[0];
  const quickAnswer = first && first.tool !== 'ExitPlanMode' && first.tool !== 'AskUserQuestion';
  const review = () => document.getElementById(`approval-${first.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Quick replies, offered only when the turn has settled and nothing is being asked:
  // the four things a person types most often after Claude stops.
  const showQuick = !running && !approvals.length && events[events.length - 1]?.kind === 'result';
  // The model's own guess at the next prompt comes first, when it sent one.
  const QUICK = [...new Set([suggestion, 'Continue', 'Run the tests', 'Commit it', 'Explain the change'].filter(Boolean))].slice(0, 5);

  return html`
    <section class="session ${inDock ? 'docked' : ''}" ref=${sectionRef}>
      <div class="session-main">
        <header class="session-head">
          <div class="session-title">
            <button class="title-btn" type="button" title="Rename" onClick=${rename}>${s.title}</button>
            <${StatusBadge} status=${s.status} />
            ${s.cost ? html`<span class="muted mono-sm hide-touch" title="Estimated spend">${formatCost(s.cost)}</span>` : null}
          </div>
          <div class="session-controls">
            <${ModelPicker} compact providers=${providers} value=${{ providerId: s.provider_id, modelId: s.model_id }} onChange=${(v) => api.updateSession(s.id, v).catch(toast)} />
            <${EffortPicker} compact value=${s.effort} onChange=${(effort) => api.updateSession(s.id, { effort }).catch(toast)} />
            <${ModePicker} compact value=${s.permission_mode} onChange=${setMode} />
            <button class="btn sm ghost" type="button" title=${inDock ? 'Close the terminal' : `Terminal in ${s.cwd}`} aria-pressed=${docked && canDock ? String(inDock) : undefined} onClick=${() => setShell(!inDock)}><${Icon} name="terminal" size=${14} /> Terminal</button>
            <${MoreMenu} items=${items} />
          </div>
          <button class="session-chip" type="button" onClick=${() => setSheet(true)} aria-haspopup="dialog">
            <span class="session-chip-model">${modelName}</span>
            <span class="session-chip-mode">${modeName}</span>
            <${Icon} name="chevron" size=${14} />
          </button>
        </header>
        <div
          class="transcript"
          ref=${scroller}
          onScroll=${(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            pinned.current = atBottom;
            setShowJump((v) => (atBottom ? false : v));
          }}
        >
          ${more ? html`<button class="btn sm ghost earlier" type="button" onClick=${earlier}>Load earlier</button>` : null}
          ${events.length === 0 && loaded ? html`<div class="transcript-empty muted">Say what you want done. Claude works in <code>${s.cwd}</code>.</div>` : null}
          <${FilesContext.Provider} value=${filesCtx}><${Transcript} events=${events} /><//>
          ${stream.thinking && !stream.text ? html`<div class="msg-thinking live"><span class="muted">Thinking…</span></div>` : null}
          ${stream.text ? html`<div class="msg assistant streaming"><${Markdown} text=${stream.text} /></div>` : null}
          ${s.status === 'running' && !stream.text ? html`<div class="working"><span class="dot dot-running"></span> Working…</div>` : null}
          ${s.status === 'error' && s.error ? html`<div class="notice notice-bad">${s.error}</div>` : null}
          ${approvals.map((a) => html`<div id=${`approval-${a.id}`} key=${a.id}><${ApprovalCard} approval=${a} /></div>`)}
          ${showJump ? html`<button class="jump-btn" type="button" onClick=${toBottom}><${Icon} name="down" size=${14} /> New reply</button>` : null}
        </div>
        ${approvals.length
          ? html`<div class="pending-bar">
              <button class="pending-main" type="button" onClick=${review}>
                <span class="dot dot-waiting"></span>
                <span class="pending-text">${approvals.length > 1 ? `${approvals.length} waiting on you` : first.title || `Claude needs you`}</span>
              </button>
              ${quickAnswer
                ? html`<button class="btn sm" type="button" onClick=${() => api.answer(first.id, { allow: true }).catch(toast)}>Allow</button>
                    <button class="btn sm secondary" type="button" onClick=${() => api.answer(first.id, { allow: false, message: '' }).catch(toast)}>Deny</button>`
                : html`<button class="btn sm secondary" type="button" onClick=${review}>Review</button>`}
            </div>`
          : null}
        ${s.archived_at
          ? html`<div class="composer archived muted">
              ${taskState && taskState !== 'active'
                ? html`<span>This task is ${taskState}. Its sessions are kept as a record.</span>`
                : html`<span>Archived. <button class="link-btn" type="button" onClick=${() => api.archiveSession(s.id, false).catch(toast)}>Unarchive</button> to continue.</span>`}
            </div>`
          : html`<${Composer} session=${s} commands=${commands} quick=${showQuick ? QUICK : null} />`}
      </div>
      ${inDock
        ? html`<${DockSplit} width=${dockWidth} container=${sectionRef} onChange=${setDockWidth} onDone=${(w) => remember(DOCK_WIDTH_KEY, w)} />
            <aside class="term-dock" style=${{ width: `${dockWidth}px` }} aria-label="Terminal">
              <div class="term-dock-head">
                <span class="term-dock-title mono-sm" title=${s.cwd}>Terminal · ${shortDir(s.cwd)}</span>
                <button class="btn sm ghost icon-only" type="button" title="Undock into a window" aria-label="Undock into a window" onClick=${() => dock(false)}><${Icon} name="popout" size=${14} /></button>
                <button class="btn sm ghost icon-only" type="button" title="Close the terminal" aria-label="Close the terminal" onClick=${() => setShell(false)}><${Icon} name="x" size=${14} /></button>
              </div>
              <div class="term-dock-body"><${TerminalPane} query=${{ session: s.id, shell: 1 }} /></div>
            </aside>`
        : null}
      ${viewing ? html`<${FileViewer} sessionId=${s.id} file=${viewing} onClose=${closeViewer} />` : null}
      ${sheet
        ? html`<${Sheet} title="Session settings" onClose=${() => setSheet(false)}>
            <label class="field"><span class="field-label">Model</span><${ModelPicker} providers=${providers} value=${{ providerId: s.provider_id, modelId: s.model_id }} onChange=${(v) => api.updateSession(s.id, v).catch(toast)} /></label>
            <label class="field"><span class="field-label">Effort</span><${EffortPicker} value=${s.effort} onChange=${(effort) => api.updateSession(s.id, { effort }).catch(toast)} /></label>
            <label class="field"><span class="field-label">Permissions</span><${ModePicker} value=${s.permission_mode} onChange=${setMode} /></label>
            <div class="sheet-actions">
              ${items.map(
                (it) => html`<button class="btn ${it.danger ? 'danger' : 'secondary'}" type="button" disabled=${it.disabled} key=${it.label} onClick=${() => { setSheet(false); it.onSelect(); }}>${it.label}</button>`
              )}
            </div>
          <//>`
        : null}
      ${shell && !inDock
        ? html`<${Dialog}
            wide
            title=${shellTitle}
            onClose=${() => setShell(false)}
            tools=${canDock ? html`<button class="btn sm ghost" type="button" title="Dock beside the chat" onClick=${() => dock(true)}><${Icon} name="dock" size=${14} /> Dock</button>` : null}
          >
            <div class="terminal-dialog"><${TerminalPane} query=${{ session: s.id, shell: 1 }} /></div>
          <//>`
        : null}
      ${terminal
        ? html`<${Dialog} wide title="claude --resume" onClose=${() => setTerminal(false)}>
            <p class="muted">The same conversation in Claude Code's own interface. Close this before sending from the composer again.</p>
            <div class="terminal-dialog"><${TerminalPane} query=${{ session: s.id }} /></div>
          <//>`
        : null}
    </section>
  `;
}

/**
 * The edge between the chat and a docked terminal: drag it, or focus it and use the
 * arrow keys. A double click puts it back. The width is clamped here against the
 * section, and again by the stylesheet, so a window made narrower later cannot squeeze
 * the chat out.
 */
function DockSplit({ width, container, onChange, onDone }) {
  const clamp = (w) => {
    const room = container.current?.clientWidth || window.innerWidth;
    return Math.round(Math.max(DOCK_MIN, Math.min(w, room - CHAT_MIN)));
  };
  const down = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const right = container.current?.getBoundingClientRect().right ?? window.innerWidth;
    let last = width;
    const move = (ev) => {
      last = clamp(right - ev.clientX);
      onChange(last);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      onDone(last);
    };
    el.classList.add('dragging');
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const key = (e) => {
    const step = e.shiftKey ? 96 : 32;
    const w = e.key === 'ArrowLeft' ? width + step : e.key === 'ArrowRight' ? width - step : null;
    if (w === null) return;
    e.preventDefault();
    const next = clamp(w);
    onChange(next);
    onDone(next);
  };
  const reset = () => {
    const next = clamp(DOCK_DEFAULT);
    onChange(next);
    onDone(null);
  };
  return html`<div
    class="dock-split"
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize the terminal"
    aria-valuenow=${width}
    aria-valuemin=${DOCK_MIN}
    tabindex="0"
    title="Drag to resize · double-click to reset"
    onPointerDown=${down}
    onKeyDown=${key}
    onDblClick=${reset}
  ></div>`;
}
// The narrowest the conversation is let get beside a docked terminal. Matches the
// stylesheet's max-width on .term-dock.
const CHAT_MIN = 420;

// -- the transcript ------------------------------------------------------------------------

function Transcript({ events }) {
  // A tool call and its result are stored as two events; the call is drawn with its result.
  const results = useMemo(() => {
    const m = new Map();
    for (const e of events) if (e.kind === 'tool_result') for (const r of e.data.results) m.set(r.tool_use_id, r);
    return m;
  }, [events]);
  // What each turn said, keyed by its result event: the top-level assistant text since
  // the person's last message, which is what a Copy button at the turn's end copies.
  // Tool calls and subagents' text are left out; the reply is what Claude told you.
  const replies = useMemo(() => {
    const m = new Map();
    let parts = [];
    for (const e of events) {
      if (e.kind === 'user') {
        parts = [];
      } else if (e.kind === 'assistant' && !e.data.parent) {
        for (const b of e.data.content || []) {
          if (b.type === 'text' && b.text.trim()) parts.push(b.text.trim());
        }
      } else if (e.kind === 'result') {
        m.set(e.id, parts.join('\n\n'));
        parts = [];
      }
    }
    return m;
  }, [events]);
  return events.map((e) => html`<${Entry} key=${e.id} event=${e} results=${results} reply=${replies.get(e.id)} />`);
}

function Entry({ event: e, results, reply }) {
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
        <${TurnContent} content=${d.content || []} results=${results} />
      </div>
    `;
  }
  if (e.kind === 'result') {
    return html`<div class="turn-end ${d.is_error ? 'bad' : ''}">
      ${reply ? html`<${CopyButton} text=${reply} label="Copy" className="turn-copy" />` : null}
      <span>${d.is_error ? (d.subtype === 'error_during_execution' ? 'Stopped' : `Failed${d.text ? `: ${d.text}` : ''}`) : 'Done'}${d.duration_ms ? ` · ${formatDuration(d.duration_ms)}` : ''}</span>
    </div>`;
  }
  if (e.kind === 'init') return html`<div class="sys-line">Claude Code ${d.version || ''} · ${d.model} · ${MODES.find((m) => m.value === d.permissionMode)?.label || d.permissionMode}</div>`;
  if (e.kind === 'notice') return html`<div class="sys-line">${d.text}</div>`;
  if (e.kind === 'log') return html`<div class="sys-line log-line" title=${`Evidence: ${d.evidence}`}>Logged: ${d.decision}</div>`;
  // The loop's own line. What it sends the session is a user message, right below; this
  // says what the loop is doing and why, where a person reading back can see it.
  if (e.kind === 'loop') return html`<div class="sys-line loop-line">${d.text}</div>`;
  if (e.kind === 'check') {
    const head = d.ok ? 'Check passed' : d.timedOut ? 'Check timed out' : `Check failed (exit ${d.code ?? '?'})`;
    return html`<details class="tool check-run ${d.ok ? '' : 'failed'}">
      <summary class="tool-head"><span class="badge ${d.ok ? 'badge-good' : 'badge-bad'}">${head}</span><code class="tool-name" title=${d.command}>${d.command}</code><span class="muted">${Math.max(1, Math.round(d.ms / 1000))}s</span></summary>
      <pre class="check-output">${d.output || '(no output)'}</pre>
    </details>`;
  }
  if (e.kind === 'error') return html`<div class="notice notice-bad">${d.message}</div>`;
  return null;
}

/**
 * One assistant message's blocks, with runs of tool calls gathered into a single
 * collapsed step. A turn that runs six commands and edits three files is nine rows of
 * chrome between two paragraphs of prose; the prose is what the person is reading, and
 * the steps are what they open when they want them.
 */
function TurnContent({ content, results }) {
  const out = [];
  let run = [];
  const flush = (key) => {
    if (run.length) out.push(html`<${ToolRun} key=${`run-${key}`} calls=${run} results=${results} />`);
    run = [];
  };
  content.forEach((b, i) => {
    if (b.type === 'tool_use') {
      run.push(b);
      return;
    }
    flush(i);
    if (b.type === 'text') {
      if (b.text.trim()) out.push(html`<${Markdown} key=${i} text=${b.text} />`);
    } else if (b.type === 'thinking') {
      out.push(html`<details key=${i} class="msg-thinking"><summary>Thinking</summary><${Markdown} text=${b.thinking} /></details>`);
    }
  });
  flush('end');
  return out;
}

/** A run of tool calls as one line: what it did, how much of it, and whether it broke. */
function ToolRun({ calls, results }) {
  const [open, setOpen] = useState(calls.length === 1);
  // One call is not a run; showing it collapsed would hide a lone command behind a
  // summary that says less than the command does.
  if (calls.length === 1) return html`<${ToolCall} call=${calls[0]} result=${results.get(calls[0].id)} />`;
  const failed = calls.filter((c) => results.get(c.id)?.is_error).length;
  const cmds = calls.filter((c) => c.name === 'Bash').length;
  const edits = calls.filter((c) => ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(c.name)).length;
  const parts = [`${calls.length} steps`];
  if (cmds) parts.push(`${cmds} command${cmds === 1 ? '' : 's'}`);
  if (edits) parts.push(`${edits} edit${edits === 1 ? '' : 's'}`);
  if (failed) parts.push(`${failed} error${failed === 1 ? '' : 's'}`);
  return html`
    <div class="tool-group">
      <button class="tool-group-head" type="button" onClick=${() => setOpen((v) => !v)} aria-expanded=${open}>
        <span class="tool-chev">${open ? '▾' : '▸'}</span>
        <span class="tool-group-label">${parts.join(' · ')}</span>
        ${failed ? html`<span class="tool-flag">error</span>` : null}
      </button>
      ${open ? html`<div class="tool-group-body">${calls.map((c) => html`<${ToolCall} key=${c.id} call=${c} result=${results.get(c.id)} />`)}</div>` : null}
    </div>
  `;
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
      // Bench's own tools read as what they do: "Bench: run check", not mcp__bench__run_check.
      head = call.name.startsWith('mcp__bench__') ? html`Bench: ${call.name.slice(12).replace(/_/g, ' ')}` : html`${call.name}`;
      detail = open && Object.keys(i).length ? html`<pre class="tool-out">${JSON.stringify(i, null, 2)}</pre>` : null;
  }
  const out = resultText(result);
  // A Write that made an artifact gets View and Download beside its header - which is a
  // button, so they cannot go inside it - and an image shows itself. A Write to source,
  // and every Read and Edit, is work on the project, not something to hand over.
  const target = call.name === 'Write' && i.file_path && result && !failed ? String(i.file_path) : null;
  return html`
    <div class="tool ${failed ? 'failed' : ''} ${result ? '' : 'pending'}">
      <div class="tool-row">
        <button class="tool-head" type="button" onClick=${() => setOpen((v) => !v)} aria-expanded=${open}>
          <span class="tool-chev">${open ? '▾' : '▸'}</span>
          <span class="tool-name">${head}</span>
          ${!result ? html`<span class="dot dot-running"></span>` : failed ? html`<span class="tool-flag">error</span>` : null}
        </button>
        ${target ? html`<${FileButtons} token=${target} />` : null}
      </div>
      ${target ? html`<${FileThumb} token=${target} />` : null}
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
  // A bench tool's input as labelled fields; one with none (run check) needs no preview.
  if (tool.startsWith('mcp__bench__')) {
    const fields = Object.entries(i).filter(([, v]) => v !== undefined && v !== '');
    return fields.length ? html`<dl class="bench-input">${fields.map(([k, v]) => html`<dt>${k.replace(/_/g, ' ')}</dt><dd>${String(v).slice(0, 4000)}</dd>`)}</dl>` : null;
  }
  return html`<pre class="tool-out">${JSON.stringify(i, null, 2).slice(0, 4000)}</pre>`;
}

// -- the composer --------------------------------------------------------------------------

// Images up to this size go to Claude inline, as the API takes them. Anything else,
// a bigger image included, is uploaded to the server as it is attached, as raw bytes,
// for Claude to read: an APK or an archive is never held in memory as base64.
const INLINE_IMAGE = 5 * 1024 * 1024;
const MAX_FILE = 300 * 1024 * 1024;
const INLINE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

export function fileSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** An image small enough to go inline, read as base64. */
function readImage(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const [head, data] = String(r.result).split(',');
      const media_type = /data:([^;]+)/.exec(head)?.[1] || file.type;
      resolve({ media_type, data, url: r.result });
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

let attachSeq = 0;

function Composer({ session: s, commands, quick }) {
  const key = `bench:draft:${s.id}`;
  const [text, setText] = useState(() => recall(key, ''));
  // Each attachment: {key, name, size, inline, url?, media_type, data?} for an inline
  // image; {key, name, size, upload: {file, type}|null, progress, ctrl} for a file.
  const [items, setItems] = useState([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  // What is typed while the line is down is kept by the outbox rather than lost; the
  // count is shown here so a message that did not go says so instead of looking sent.
  const [queued, setQueued] = useState(() => outboxCount(s.id));
  const box = useRef(null);
  const file = useRef(null);
  const running = s.status === 'running' || s.status === 'waiting';
  useEffect(() => {
    const on = () => setQueued(outboxCount(s.id));
    window.addEventListener('bench:outbox', on);
    return () => window.removeEventListener('bench:outbox', on);
  }, [s.id]);

  // Dictation, where the browser has it. Typing a paragraph on a phone is the slowest
  // thing in this app; speaking it is not. Progressive: the button is absent where the
  // API is. What is heard is appended to whatever is already typed, so it composes with
  // the box rather than replacing it.
  const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
  const rec = useRef(null);
  const [listening, setListening] = useState(false);
  const dictate = () => {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const r = new SR();
    const start = text;
    r.lang = navigator.language || 'en-US';
    r.interimResults = false;
    r.continuous = false;
    r.onresult = (e) => {
      let said = '';
      for (let i = 0; i < e.results.length; i++) said += e.results[i][0].transcript;
      const sep = start && !/\s$/.test(start) ? ' ' : '';
      setText(start + sep + said.trim());
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  };

  useEffect(() => {
    setText(recall(key, ''));
    setItems((list) => {
      for (const it of list) it.ctrl?.abort();
      return [];
    });
  }, [s.id]);
  useEffect(() => remember(key, text || null), [text]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const slash = slashMatches(commands, text);
  const [pick, setPick] = useState(0);
  const menu = useRef(null);
  useEffect(() => setPick(0), [text]);
  useEffect(() => menu.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' }), [pick]);
  const choose = (/** @type {{name:string}} */ c) => {
    setText(`/${c.name} `);
    box.current?.focus();
  };
  const uploading = items.some((it) => !it.inline && !it.upload);
  const empty = !text.trim() && !items.length;

  const send = async () => {
    if (sending || uploading || empty) return;
    setSending(true);
    try {
      const r = await api.send(
        s.id,
        text,
        items.filter((it) => it.inline).map(({ media_type, data }) => ({ media_type, data })),
        items.filter((it) => !it.inline).map((it) => it.upload)
      );
      setText('');
      setItems([]);
      // Cleared as though sent, because it will be: the outbox holds it and the count
      // above the box is what says it has not reached the server yet.
      if (r?.queued) showToast('Queued — it sends when the connection is back', 'info');
    } catch (e) {
      toast(e);
    } finally {
      setSending(false);
      if (!isTouch()) box.current?.focus();
    }
  };

  const patchItem = (k, patch) => setItems((list) => list.map((it) => (it.key === k ? { ...it, ...patch } : it)));
  const remove = (it) => {
    it.ctrl?.abort();
    setItems((list) => list.filter((x) => x.key !== it.key));
  };

  // One file, from the moment it is handed over. The read is started here, synchronously,
  // for every file before any of them is awaited: a File from the clipboard or a drag is
  // a reference the browser may stop honouring once the event is over, so a read queued
  // behind another file's `await` can be the one that fails. Resolves to null when the
  // file is attached, else the error that stopped it.
  const attachOne = (f) => {
    const k = ++attachSeq;
    const name = f.name || 'pasted';
    if (f.size > MAX_FILE) return Promise.resolve(new Error(`${name} is over ${MAX_FILE / 1024 / 1024} MB`));
    // Items are kept in the order the files arrived, whichever read finishes first.
    const add = (item) => setItems((list) => [...list, item].sort((a, b) => a.key - b.key));
    if (INLINE_TYPES.test(f.type) && f.size <= INLINE_IMAGE) {
      return readImage(f).then(
        (im) => {
          add({ key: k, name, size: f.size, inline: true, ...im });
          return null;
        },
        (e) => e
      );
    }
    const ctrl = new AbortController();
    add({ key: k, name, size: f.size, inline: false, upload: null, progress: 0, ctrl });
    api
      .upload(s.id, f, { signal: ctrl.signal, onProgress: (p) => patchItem(k, { progress: p }) })
      .then((up) => patchItem(k, { upload: { file: up.file, type: up.type }, progress: 1, ctrl: null }))
      .catch((e) => {
        setItems((list) => list.filter((x) => x.key !== k));
        if (!e.aborted) toast(e);
      });
    return Promise.resolve(null);
  };

  // A paste or a drop from another app. What is on the clipboard is whatever that app
  // chose to put there, and one copy can carry several entries for the same picture: a
  // file reference into the app's own folder, which this browser may have no right to
  // open, and the image itself. So an entry that cannot be read is not an error while
  // another can; it is only said out loud when nothing could be attached, and then the
  // Clipboard API, which hands over the image data rather than a file reference, gets
  // one try before the person is told to attach it another way.
  const attachExternal = async (files) => {
    const results = await Promise.all(files.map(attachOne));
    const failed = results.filter(Boolean);
    if (failed.length < files.length) {
      for (const e of failed) console.warn('bench: skipped an entry it could not read:', e);
      return;
    }
    if (failed.every((e) => e.name === 'NotReadableError') && navigator.clipboard?.read) {
      try {
        const got = [];
        for (const item of await navigator.clipboard.read()) {
          const type = item.types.find((t) => INLINE_TYPES.test(t));
          if (type) got.push(new File([await item.getType(type)], `pasted.${type.split('/')[1]}`, { type }));
        }
        if (got.length) {
          await Promise.all(got.map(attachOne));
          return;
        }
      } catch (e) {
        console.warn('bench: the clipboard would not hand over the image either:', e);
      }
    }
    toast(
      failed.every((e) => e.name === 'NotReadableError')
        ? new Error("That app didn't let the browser read what it copied. Save the image, then attach it with the paperclip, or share it to your browser.")
        : failed[0]
    );
  };

  // The file picker is the person choosing files this browser can already see, so a
  // failure there is a real error and is reported as one, per file.
  const attach = async (files) => {
    for (const e of (await Promise.all(files.map(attachOne))).filter(Boolean)) toast(e);
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
        attachExternal([...e.dataTransfer.files]);
      }}
    >
      ${slash.length
        ? html`<div class="slash" role="listbox" ref=${menu}>
            ${slash.map(
              (c, i) => html`<button type="button" role="option" aria-selected=${i === pick} class="slash-item ${i === pick ? 'active' : ''}" key=${c.name} onMouseDown=${(e) => e.preventDefault()} onClick=${() => choose(c)} title=${c.description}>
                <code>/${c.name}</code>${c.argumentHint ? html`<span class="slash-hint">${c.argumentHint}</span>` : null}<span class="slash-desc">${c.description}</span>
              </button>`
            )}
          </div>`
        : null}
      ${quick && !text.trim() && !items.length
        ? html`<div class="quick-replies">${quick.map((q) => html`<button class="quick-chip" type="button" key=${q} onClick=${() => setText(q)}>${q}</button>`)}</div>`
        : null}
      ${queued ? html`<div class="queued-note"><span class="dot dot-waiting"></span>${queued} message${queued === 1 ? '' : 's'} waiting for the connection</div>` : null}
      <div class="composer-box">
        ${items.length
          ? html`<div class="thumbs">
              ${items.map(
                (it) => html`<div key=${it.key} class="thumb ${it.inline ? '' : 'file'} ${!it.inline && !it.upload ? 'uploading' : ''}" title=${`${it.name}, ${fileSize(it.size)}`}>
                  ${it.inline
                    ? html`<img src=${it.url} alt=${it.name} />`
                    : html`<span class="thumb-name">${it.name}</span>
                        <span class="muted">${it.upload ? fileSize(it.size) : `Uploading ${Math.round((it.progress || 0) * 100)}%`}</span>
                        ${it.upload ? null : html`<span class="thumb-bar" style=${`width:${Math.round((it.progress || 0) * 100)}%`}></span>`}`}
                  <button type="button" aria-label=${`Remove ${it.name}`} onClick=${() => remove(it)}>×</button>
                </div>`
              )}
            </div>`
          : null}
        <textarea
          ref=${box}
          class="composer-input"
          rows="1"
          enterkeyhint=${isTouch() ? 'enter' : 'send'}
          placeholder=${running ? 'Queue a follow-up…' : 'Message Claude…'}
          value=${text}
          onInput=${(e) => setText(e.target.value)}
          onPaste=${(e) => {
            // `files` and `items` can disagree about what is on the clipboard, so both
            // are read, and an entry present in each is attached once.
            const files = [...(e.clipboardData?.files || [])];
            for (const it of e.clipboardData?.items || []) {
              const f = it.kind === 'file' ? it.getAsFile() : null;
              if (f && !files.some((x) => x.name === f.name && x.size === f.size && x.type === f.type)) files.push(f);
            }
            if (files.length) {
              e.preventDefault();
              attachExternal(files);
            }
          }}
          onKeyDown=${(e) => {
            // With the command menu open, arrows move through it and Tab takes the one
            // marked. Enter takes it too, unless what is typed is already a whole command.
            if (slash.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : slash.length - 1)) % slash.length);
            } else if (slash.length && e.key === 'Tab' && !e.shiftKey) {
              e.preventDefault();
              choose(slash[pick]);
            } else if (slash.length && e.key === 'Enter' && !e.shiftKey && !e.isComposing && !slash.some((c) => `/${c.name}` === text.trim())) {
              e.preventDefault();
              choose(slash[pick]);
            } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch()) {
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
        <div class="composer-bar">
          <input ref=${file} type="file" multiple hidden onChange=${(e) => {
            attach([...e.target.files]);
            e.target.value = '';
          }} />
          <button class="btn ghost icon-only" type="button" aria-label="Attach files" title="Attach images, PDFs, APKs or any file (or drop them here)" onClick=${() => file.current?.click()}><${Icon} name="attach" /></button>
          <button class="mode-chip" type="button" onClick=${cycleMode} title="Permission mode (Shift+Tab)">${MODES.find((m) => m.value === s.permission_mode)?.label}</button>
          <span class="composer-hint muted hide-touch">Enter to send · Shift+Enter new line${running ? ' · Esc to stop' : ''}</span>
          <span class="composer-gap"></span>
          ${SR ? html`<button class="btn ghost icon-only ${listening ? 'listening' : ''}" type="button" aria-label=${listening ? 'Stop dictation' : 'Dictate'} title="Dictate" onClick=${dictate}><${Icon} name="mic" /></button>` : null}
          ${running ? html`<button class="btn danger icon-only" type="button" aria-label="Stop" title="Stop (Esc)" onClick=${() => api.interrupt(s.id).catch(toast)}><${Icon} name="stop" /></button>` : null}
          <button class="btn icon-only send-btn" type="button" aria-label="Send" title=${uploading ? 'Waiting for uploads to finish' : 'Send'} disabled=${sending || uploading || empty} onClick=${send}><${Icon} name="send" /></button>
        </div>
      </div>
    </div>
  `;
}
