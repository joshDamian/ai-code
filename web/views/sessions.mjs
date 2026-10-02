// Conversations. URL hash: #/sessions (the list, and a new conversation beside it),
// #/sessions/new (a new one on its own), or #/sessions/:id (one of them). The route
// keeps its old name so links into sessions written before conversations still open.
//
// A conversation is read-only or can edit, and the person switches it in the header
// without starting over. Read-only answers from the repo and AI Code's own records
// and asks for nothing; editing works in the project's own checkout with every write
// and every command held at a permission prompt, and one conversation per project
// may do it at a time. Both are one row type on the server - a session with a mode -
// so the history a turn reads is the whole conversation whichever mode wrote it.
//
// Chats from before conversations had modes are listed below them and open in the
// chat view. The conversations the drafting passes open are hidden unless asked for.
//
// The view is a workspace rather than a page: the conversations down the left,
// grouped by what each one needs from you; the open one in the middle; and what it
// has cost and changed on the right. Switching is one click, and a conversation
// that is waiting on you says so in the list without being opened.
//
// The approval is docked to the composer rather than laid over the top of the page.
// It is the one element here that is blocking something - an agent that has asked
// has stopped, is holding a provider slot, and will be denied by the clock - and the
// composer is where a person's eyes already are. On a phone it is a bottom sheet,
// for the same reason: it is where the thumb is.
import { html, useState, useEffect, useRef, useCallback, useMemo, formatCost, formatDuration, diffLines, unifiedDiff, sessionSteps, shortDir, gitImpact, recall, remember } from '../lib.mjs';
import { api, sessionStreamUrl } from '../api.mjs';
import { withToken } from '../auth.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { Markdown } from '../components/markdown.mjs';
import { EventStream } from '../components/event-stream.mjs';
import { Time } from '../components/time.mjs';
import { Select } from '../components/form.mjs';
import { NoProject } from '../components/empty-state.mjs';
import { confirmAction } from '../components/confirm.mjs';
import { createEventBuffer } from './task-detail.mjs';

// What this view remembers between visits, per browser (see `recall` in lib.mjs):
// the project last chosen, how the list was filtered, and text typed and not sent,
// per conversation and for the new one. Where the person was is remembered by the
// app shell, which owns the route.
const MEMORY = {
  project: 'ai-code:conversations:project',
  list: 'ai-code:conversations:list',
  unsent: 'ai-code:conversations:unsent',
};
// Unsent text is kept for this many conversations, newest first: enough to cover the
// ones a person has open, few enough that the record never grows without end.
const UNSENT_KEPT = 20;
const readUnsent = (id) => (recall(MEMORY.unsent, {}) || {})[id]?.text || '';
function writeUnsent(id, text) {
  const all = recall(MEMORY.unsent, {}) || {};
  delete all[id];
  if (text.trim()) all[id] = { text, at: Date.now() };
  const kept = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, UNSENT_KEPT);
  remember(MEMORY.unsent, Object.fromEntries(kept));
}

// A turn the queue is still holding. Read from the job row rather than from a local
// flag, so a reload and a second tab see the same thing this one does.
const IN_FLIGHT = new Set(['queued', 'running']);

// Where the composer stops growing and starts scrolling instead.
const COMPOSER_MAX_PX = 200;

// What one message may carry, matching the server's ATTACHMENT_LIMITS so a file
// that would be refused is refused here, before it is read into memory and sent.
const ATTACH = { files: 10, bytes: 10 * 1024 * 1024, total: 25 * 1024 * 1024 };
const isImage = (type) => /^image\/(png|jpe?g|gif|webp)$/.test(type || '');
const isVideo = (type) => /^video\/(mp4|webm)$/.test(type || '');
const isAudio = (type) => /^audio\/(mpeg|wav|ogg|mp4)$/.test(type || '');
const formatBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

const readAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error(`Could not read ${file.name}`));
    r.readAsDataURL(file);
  });

// The files waiting to go with the next message. Read into data URLs as they are
// added, so the preview and the request body are the same bytes, and checked against
// the limits as they arrive rather than when the person presses send.
function useAttachments() {
  const [files, setFiles] = useState([]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const add = useCallback(async (list) => {
    const incoming = [...(list || [])].filter((f) => f && f.size !== undefined);
    if (!incoming.length) return;
    const current = filesRef.current;
    let total = current.reduce((n, f) => n + f.size, 0);
    const accepted = [];
    for (const f of incoming) {
      if (current.length + accepted.length >= ATTACH.files) {
        showToast(`At most ${ATTACH.files} files per message`, 'error');
        break;
      }
      if (!f.size) {
        showToast(`${f.name || 'That file'} is empty`, 'error');
        continue;
      }
      if (f.size > ATTACH.bytes) {
        showToast(`${f.name} is larger than ${formatBytes(ATTACH.bytes)}`, 'error');
        continue;
      }
      if (total + f.size > ATTACH.total) {
        showToast(`Attachments can total at most ${formatBytes(ATTACH.total)}`, 'error');
        break;
      }
      total += f.size;
      accepted.push(f);
    }
    try {
      const read = await Promise.all(
        accepted.map(async (f, i) => ({
          key: `${Date.now()}-${i}-${f.name}`,
          // A pasted screenshot arrives as "image.png" every time; the time keeps two apart.
          name: f.name && f.name !== 'image.png' ? f.name : `pasted-${new Date().toISOString().replace(/[:.]/g, '-')}${i ? `-${i}` : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`,
          type: f.type || 'application/octet-stream',
          size: f.size,
          data: await readAsDataUrl(f),
        }))
      );
      setFiles((prev) => [...prev, ...read].slice(0, ATTACH.files));
    } catch (e) {
      showToast(e.message, 'error');
    }
  }, []);
  const remove = useCallback((key) => setFiles((prev) => prev.filter((f) => f.key !== key)), []);
  const clear = useCallback(() => setFiles([]), []);
  // Images pasted into the box become attachments; text pastes as text.
  const onPaste = useCallback(
    (e) => {
      const pasted = [...(e.clipboardData?.files || [])];
      if (!pasted.length) return;
      e.preventDefault();
      add(pasted);
    },
    [add]
  );
  return { files, add, remove, clear, onPaste };
}

// The paperclip and the hidden file input it opens.
function AttachButton({ onFiles, disabled }) {
  const ref = useRef(null);
  return html`
    <button class="ss-attach" type="button" aria-label="Attach files" title="Attach files or images" disabled=${disabled} onClick=${() => ref.current?.click()}>
      ${icon(ICONS.clip)}
    </button>
    <input
      ref=${ref}
      type="file"
      multiple
      hidden
      onChange=${(e) => {
        onFiles(e.target.files);
        e.target.value = '';
      }}
    />
  `;
}

// The files waiting to be sent, above the box, each removable.
function AttachTray({ files, onRemove, disabled }) {
  if (!files.length) return null;
  return html`
    <div class="ss-attach-tray">
      ${files.map(
        (f) => html`
          <div class="ss-chip" key=${f.key} title=${`${f.name} · ${formatBytes(f.size)}`}>
            ${isImage(f.type) ? html`<img src=${f.data} alt="" />` : html`<span class="ss-chip-ext">${(f.name.split('.').pop() || 'file').slice(0, 4)}</span>`}
            <span class="ss-chip-name">${f.name}</span>
            <button type="button" aria-label=${`Remove ${f.name}`} disabled=${disabled} onClick=${() => onRemove(f.key)}>${icon(ICONS.cross)}</button>
          </div>
        `
      )}
    </div>
  `;
}

// One file in the transcript: an image, a player, or a chip that downloads it.
function FileItem({ f, src }) {
  if (src && isImage(f.type)) return html`<a href=${src} target="_blank" rel="noopener" title=${f.caption || f.name}><img src=${src} alt=${f.caption || f.name} loading="lazy" /></a>`;
  if (src && isVideo(f.type)) return html`<video src=${src} controls preload="metadata" title=${f.caption || f.name}></video>`;
  if (src && isAudio(f.type)) return html`<audio src=${src} controls preload="metadata" title=${f.caption || f.name}></audio>`;
  return html`<a class="ss-chip" href=${src || undefined} target="_blank" rel="noopener" download=${f.name} title=${`${f.name}${f.size ? ` · ${formatBytes(f.size)}` : ''}`}>
    <span class="ss-chip-ext">${(f.name.split('.').pop() || 'file').slice(0, 4)}</span><span class="ss-chip-name">${f.name}</span>
  </a>`;
}

// The files a sent message carried, under its text. A stored turn links each one to
// the server's copy; the turn just sent shows the previews it was sent with.
function SentFiles({ files, sessionId, runId }) {
  if (!files?.length) return null;
  return html`
    <div class="ss-said-files">
      ${files.map((f) => html`<${FileItem} key=${f.name} f=${f} src=${f.data || (sessionId && runId ? withToken(api.sessionAttachmentUrl(sessionId, runId, f.name)) : null)} />`)}
    </div>
  `;
}

// What the agent shared back with its share_file tool, under its reply, each with
// the caption it gave.
function SharedFiles({ files, sessionId, runId }) {
  if (!files?.length || !sessionId || !runId) return null;
  return html`
    <div class="ss-shared-files">
      ${files.map(
        (f) => html`
          <figure key=${f.name}>
            <${FileItem} f=${f} src=${withToken(api.sessionAttachmentUrl(sessionId, runId, f.name, 'outputs'))} />
            ${f.caption ? html`<figcaption>${f.caption}</figcaption>` : null}
          </figure>
        `
      )}
    </div>
  `;
}

// The whole composer accepts a dropped file, and says so while one is over it.
function useDropTarget(add, disabled) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const has = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  return {
    over,
    props: {
      onDragEnter: (e) => {
        if (disabled || !has(e)) return;
        e.preventDefault();
        depth.current++;
        setOver(true);
      },
      onDragOver: (e) => {
        if (disabled || !has(e)) return;
        e.preventDefault();
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      },
      onDrop: (e) => {
        if (disabled || !has(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        add(e.dataTransfer.files);
      },
    },
  };
}

// How much of a file's new contents the approval shows. Enough to see what the edit
// does, short enough that the Allow button does not move off the screen - which is
// the whole failure mode of a confirmation dialog.
const PREVIEW_CHARS = 4000;

// The verb a person would use for a tool call. The tool's own name is the fallback,
// with an MCP server's prefix taken off it: `mcp__github__create_issue` is a
// `create_issue` to anyone reading the step.
const VERBS = {
  Read: 'Read',
  Edit: 'Edit',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit',
  Write: 'Write',
  Bash: 'Run',
  Grep: 'Search',
  Glob: 'Find',
  LS: 'List',
  WebFetch: 'Fetch',
  WebSearch: 'Search web',
  Task: 'Delegate',
  TodoWrite: 'Plan',
  draft_task: 'Draft task',
};
const verbOf = (tool) => {
  const name = String(tool || 'tool').replace(/^mcp__[^_]+__/, '');
  return VERBS[tool] || VERBS[name] || name;
};

const WRITES = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);

const icon = (path, cls = '') => html`<svg class="ss-ic ${cls}" viewBox="0 0 16 16" aria-hidden="true">${path}</svg>`;
const ICONS = {
  plus: html`<path d="M8 3v10M3 8h10" />`,
  search: html`<circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" />`,
  chevron: html`<path d="m6 4 4 4-4 4" />`,
  back: html`<path d="m10 3-5 5 5 5" />`,
  more: html`<circle cx="4" cy="8" r=".9" /><circle cx="8" cy="8" r=".9" /><circle cx="12" cy="8" r=".9" />`,
  stop: html`<rect x="4.5" y="4.5" width="7" height="7" rx="1.5" />`,
  send: html`<path d="M8 13V3M4 7l4-4 4 4" />`,
  check: html`<path d="m3.5 8.5 3 3 6-7" />`,
  cross: html`<path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />`,
  branch: html`<circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="12" r="1.5" /><path d="M5 5.5v5" />`,
  shield: html`<path d="M8 2 3 4v4c0 3 2.2 5 5 6 2.8-1 5-3 5-6V4z" /><path d="m6 8 1.5 1.5L10.5 6.5" />`,
  clock: html`<circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" />`,
  task: html`<rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="m5.5 8 1.8 1.8L10.5 6" />`,
  panel: html`<rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M10 3v10" />`,
  clip: html`<path d="M13 7.5 8.2 12.3a3 3 0 0 1-4.3-4.2l5-5a2 2 0 0 1 2.9 2.8l-5 5a1 1 0 0 1-1.4-1.4l4.6-4.6" />`,
};

// What the person is being asked to approve, in the words they need to decide it.
// The tool name alone is not a decision: "Write" on its own is approved by anyone in
// a hurry, and `rm -rf` in the Bash branch is not.
//
// Server-side would be the wrong place for this even though the input is stored
// there: the panel is drawn from the request claude sent, and a summariser that ran
// at write time could not be changed without stranding every request recorded
// before it.
function approvalOf(tool, input, root) {
  const i = { ...(input || {}) };
  if (i.file_path) i.file_path = relTo(root, i.file_path);
  if (tool === 'Bash') {
    // git and gh run like any other command, but the panel says what they reach:
    // this checkout's history, or something off this machine. See gitImpact.
    const git = gitImpact(i.command);
    const title = !git ? 'Run a command' : git.level === 'remote' ? 'Run a command that reaches beyond this machine' : git.level === 'local' ? 'Run a git command that changes this checkout' : 'Run a read-only git command';
    return { title, allow: 'Allow command', command: i.command || '(a command with no text)', note: i.description || '', git };
  }
  if (i.file_path && WRITES.has(tool)) {
    let diff = '';
    if (tool === 'Write') diff = unifiedDiff('', String(i.content || '').slice(0, PREVIEW_CHARS), { label: i.file_path, context: 0 });
    else if (tool === 'MultiEdit' && Array.isArray(i.edits)) diff = i.edits.map((e) => unifiedDiff(e.old_string, e.new_string, { label: i.file_path, context: 2 })).join('\n');
    else if (typeof i.old_string === 'string' || typeof i.new_string === 'string') diff = unifiedDiff(i.old_string, i.new_string, { label: i.file_path, context: 2 });
    else if (typeof i.new_source === 'string') diff = unifiedDiff('', i.new_source.slice(0, PREVIEW_CHARS), { label: i.file_path, context: 0 });
    const rows = diffLines(diff).filter((l) => l.cls === 'diff-add' || l.cls === 'diff-del' || l.cls === 'diff-ctx' || l.cls === 'diff-hunk');
    const added = rows.filter((l) => l.cls === 'diff-add').length;
    const removed = rows.filter((l) => l.cls === 'diff-del').length;
    return { title: tool === 'Write' ? 'Write' : 'Edit', file: i.file_path, allow: tool === 'Write' ? 'Allow write' : 'Allow edit', rows, added, removed };
  }
  // A proposed task is read as the task, not as JSON: the title is the decision, and
  // approving it here only puts it in the queue, which the note says.
  if (verbOf(tool) === 'Draft task') {
    return { title: `Draft a task: ${i.title || '(untitled)'}`, allow: 'Allow draft', note: `${i.description || ''}\n\nIt lands in the project's approval queue; it becomes a task only when you approve it there.`.trim() };
  }
  if (i.file_path) return { title: verbOf(tool), file: i.file_path, allow: 'Allow' };
  if (i.url) return { title: verbOf(tool), command: i.url, allow: 'Allow' };
  // Anything else is shown as it arrived rather than guessed at. A tool this file has
  // not heard of is exactly the tool whose arguments a person should read.
  return { title: verbOf(tool), allow: 'Allow', raw: JSON.stringify(i, null, 2) };
}

// A path as the project knows it. The agent's tools take absolute paths, and the
// project's own prefix is the same on every one of them - noise on every row it
// appears in, and the part that pushes the file's name out of a narrow column.
function relTo(root, p) {
  const s = String(p || '');
  if (!root) return s;
  const base = root.endsWith('/') ? root : `${root}/`;
  if (s === root || s === base) return '.';
  return s.startsWith(base) ? s.slice(base.length) : s;
}

// The file's name with its folder dimmed, which is how a path is read: the name is
// what tells two rows apart.
function Path({ path }) {
  const p = String(path || '');
  const cut = p.lastIndexOf('/');
  if (cut < 0) return html`<span class="ss-mono">${p}</span>`;
  return html`<span class="ss-mono ss-path"><span class="ss-path-dir">${p.slice(0, cut + 1)}</span>${p.slice(cut + 1)}</span>`;
}

// Seconds left on the request, floored at zero. Derived on every tick from the
// request's own deadline rather than from a countdown started when the panel
// rendered, so a page opened ninety seconds into a two-minute window shows thirty.
function secondsLeft(timeoutAt, now) {
  if (!timeoutAt) return 0;
  return Math.max(0, Math.round((Date.parse(timeoutAt) - now) / 1000));
}
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// The countdown drawn as the share of the window that is left. A number alone says
// how long; the ring says how much of it is gone, which is the part that tells a
// person whether to read the diff or to hurry.
function Ring({ left, total, size = 34 }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? Math.min(1, left / total) : 0;
  return html`
    <svg class="ss-ring ${left <= 20 ? 'urgent' : ''}" viewBox="0 0 36 36" width=${size} height=${size} aria-hidden="true">
      <circle cx="18" cy="18" r=${r} class="ss-ring-track" />
      <circle cx="18" cy="18" r=${r} class="ss-ring-fill" stroke-dasharray=${c} stroke-dashoffset=${c * (1 - frac)} transform="rotate(-90 18 18)" />
    </svg>
  `;
}

// Which group a session sits in. The order of the groups is the order a person
// deals with them: what is blocked on them, what is moving, what is resting.
function groupOf(s) {
  if (s.status === 'stopped' || s.status === 'archived') return 'closed';
  if (s.pending) return 'needs';
  if (s.pending_run_id) return 'working';
  return 'idle';
}

function rowLine(s, root) {
  if (s.pending?.git && s.pending.git.level !== 'read') return html`<span class=${s.pending.git.level === 'remote' || s.pending.git.destructive ? 'bad' : ''}>${s.pending.git.label}?</span>`;
  if (s.pending) return html`Wants to ${verbOf(s.pending.tool).toLowerCase()} <${Path} path=${relTo(root, s.pending.target)} />`;
  if (s.pending_run_id) return s.activity ? html`${verbOf(s.activity.tool)} <${Path} path=${relTo(root, s.activity.target)} />` : 'Working…';
  if (s.status === 'archived') return 'Archived';
  if (s.status === 'stopped') return s.preview || 'Stopped';
  return s.preview || (s.turn_count ? 'No reply' : 'No instructions yet');
}

// A row is a link into the session with its own controls beside it. Stop and Archive
// are here and not only inside the session, because stopping something that is
// working should not require opening the thing that is working.
function SessionRow({ s, active, now, root, onControl }) {
  const g = groupOf(s);
  const closed = s.status === 'stopped' || s.status === 'archived';
  return html`
    <div class="ss-row-wrap">
    <a class="ss-row ${active ? 'active' : ''} ss-row-${g}" href=${`#/sessions/${s.id}`} aria-current=${active ? 'page' : null}>
      <span class="ss-dot ss-dot-${g}" aria-hidden="true"></span>
      <span class="ss-row-main">
        <span class="ss-row-top">
          <span class="ss-row-name">${s.name}</span>
          ${s.mode === 'edit' && g !== 'closed' ? html`<span class="ss-mode-tag" title="This conversation can edit the checkout">Can edit</span>` : null}
          ${g === 'needs'
            ? html`<span class="ss-row-clock">${clock(secondsLeft(s.pending.timeout_at, now))}</span>`
            : g === 'working'
              ? html`<span class="ss-row-when">now</span>`
              : html`<span class="ss-row-when"><${Time} at=${s.updated_at} now=${now} />${s.budget_tally ? ` · ${formatCost(s.budget_tally)}` : ''}</span>`}
        </span>
        <span class="ss-row-line">${rowLine(s, root)}</span>
      </span>
    </a>
    ${onControl
      ? html`<div class="ss-row-menu">
          <${MoreMenu}
            label=${`Actions for ${s.name}`}
            items=${[
              closed
                ? { label: 'Resume', onSelect: () => onControl(() => api.resumeSession(s.id), 'Resume') }
                : { label: s.pending_run_id ? 'Stop the run' : 'Stop session', onSelect: () => onControl(() => api.stopSession(s.id), 'Stop') },
              s.status !== 'archived' ? { label: 'Archive', danger: true, onSelect: () => onControl(() => api.archiveSession(s.id), 'Archive') } : null,
            ]}
          />
        </div>`
      : null}
    </div>
  `;
}

const GROUPS = [
  { id: 'needs', label: 'Needs you' },
  { id: 'working', label: 'Working' },
  { id: 'idle', label: 'Idle' },
];

// Only an editing conversation is tagged in the list. Read-only is the default and
// the safe case; the tag marks the one that can change the checkout.
const MODE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'read', label: 'Read-only' },
  { value: 'edit', label: 'Can edit' },
];

// A chat from before conversations had modes. It opens in the chat view, which is
// where its messages are stored.
function ChatRow({ c, now }) {
  return html`
    <div class="ss-row-wrap">
      <a class="ss-row ss-row-idle ${c.system ? 'ss-row-system' : ''}" href=${`#/chat/${c.id}`}>
        <span class="ss-dot ss-dot-idle" aria-hidden="true"></span>
        <span class="ss-row-main">
          <span class="ss-row-top">
            <span class="ss-row-name">${c.title}</span>
            <span class="ss-row-when"><${Time} at=${c.updated_at} now=${now} /></span>
          </span>
          <span class="ss-row-line">${c.system ? 'Opened by a drafting pass' : 'Chat'}</span>
        </span>
      </a>
    </div>
  `;
}

function SessionList({ sessions, chats, projects, projectsLoaded, projectId, onProject, activeId, spend, now, onNew, creating, onControl }) {
  const root = projects.find((p) => p.id === projectId)?.path || '';
  const saved = useMemo(() => recall(MEMORY.list, {}) || {}, []);
  const [query, setQuery] = useState(saved.query || '');
  const [mode, setMode] = useState(MODE_FILTERS.some((f) => f.value === saved.mode) ? saved.mode : 'all');
  const [showClosed, setShowClosed] = useState(!!saved.showClosed);
  const [showChats, setShowChats] = useState(!!saved.showChats);
  const [showSystem, setShowSystem] = useState(!!saved.showSystem);
  useEffect(() => {
    remember(MEMORY.list, { query, mode, showClosed, showChats, showSystem });
  }, [query, mode, showClosed, showChats, showSystem]);
  const q = query.trim().toLowerCase();
  const shown = (sessions || []).filter((s) => (mode === 'all' || s.mode === mode) && (!q || s.name.toLowerCase().includes(q) || (s.preview || '').toLowerCase().includes(q)));
  const by = (g) => shown.filter((s) => groupOf(s) === g);
  const closed = by('closed');
  // Older chats are read-only, so a Can edit filter leaves them out.
  const chatRows = mode === 'edit' ? [] : (chats || []).filter((c) => (showSystem || !c.system) && (!q || c.title.toLowerCase().includes(q)));
  const systemCount = (chats || []).filter((c) => c.system).length;
  return html`
    <aside class="ss-list" aria-label="Conversations">
      <div class="ss-list-head">
        <div class="ss-list-title">
          ${projects.length > 1
            ? html`<${Select} className="ss-project" ariaLabel="Project" value=${projectId} onChange=${onProject} options=${projects.map((p) => ({ value: p.id, label: p.name }))} />`
            : html`<span class="ss-project-name">${projects[0]?.name || ''}</span>`}
          <button class="btn primary sm ss-new" type="button" onClick=${onNew} disabled=${creating || !projectId} aria-label="New conversation">
            ${icon(ICONS.plus)}<span>New</span>
          </button>
        </div>
        <div class="ss-list-tools">
          <label class="ss-filter">
            ${icon(ICONS.search)}
            <input type="search" placeholder="Filter" aria-label="Filter conversations" value=${query} onInput=${(e) => setQuery(e.target.value)} />
          </label>
        </div>
        <div class="seg ss-mode-filter" role="group" aria-label="Show">
          ${MODE_FILTERS.map((f) => html`<button type="button" key=${f.value} class="seg-btn ${mode === f.value ? 'active' : ''}" aria-pressed=${mode === f.value} onClick=${() => setMode(f.value)}>${f.label}</button>`)}
        </div>
      </div>
      <div class="ss-list-body">
        ${projectsLoaded && !projects.length
          ? html`<p class="ss-list-empty muted">No projects yet.</p>`
          : sessions === null
            ? html`<div class="ss-list-empty"><${Spinner} /></div>`
            : !sessions.length && !(chats || []).length
              ? html`<p class="ss-list-empty muted">No conversations in this project yet.</p>`
              : html`
                  ${GROUPS.map(({ id: g, label }) => {
                    const rows = by(g);
                    if (!rows.length) return null;
                    return html`
                      <div class="ss-group" key=${g}>
                        <div class="ss-group-label ss-group-${g}">${label} · ${rows.length}</div>
                        ${rows.map((s) => html`<${SessionRow} key=${s.id} s=${s} active=${s.id === activeId} now=${now} root=${root} onControl=${onControl} />`)}
                      </div>
                    `;
                  })}
                  ${closed.length
                    ? html`
                        <button class="ss-closed-toggle" type="button" aria-expanded=${showClosed} onClick=${() => setShowClosed((v) => !v)}>
                          ${icon(ICONS.chevron, showClosed ? 'open' : '')} Stopped and archived · ${closed.length}
                        </button>
                        ${showClosed ? closed.map((s) => html`<${SessionRow} key=${s.id} s=${s} active=${s.id === activeId} now=${now} root=${root} onControl=${onControl} />`) : null}
                      `
                    : null}
                  ${chatRows.length
                    ? html`
                        <button class="ss-closed-toggle" type="button" aria-expanded=${showChats} onClick=${() => setShowChats((v) => !v)}>
                          ${icon(ICONS.chevron, showChats ? 'open' : '')} Earlier chats · ${chatRows.length}
                        </button>
                        ${showChats ? chatRows.map((c) => html`<${ChatRow} key=${c.id} c=${c} now=${now} />`) : null}
                      `
                    : null}
                  ${systemCount && mode !== 'edit'
                    ? html`<button class="ss-system-toggle" type="button" aria-pressed=${showSystem} onClick=${() => {
                        setShowSystem((v) => !v);
                        setShowChats(true);
                      }}>${showSystem ? 'Hide' : 'Show'} conversations opened by drafting passes (${systemCount})</button>`
                    : null}
                  ${q && !shown.length && !chatRows.length ? html`<p class="ss-list-empty muted">Nothing matches “${query}”.</p>` : null}
                `}
      </div>
      ${spend
        ? html`
            <div class="ss-list-foot">
              <div class="ss-meter-row"><span>Today, all conversations</span><span class="ss-mono">${formatCost(spend.todaySpent)}${spend.dailyCap ? html` <span class="muted">/ ${formatCost(spend.dailyCap)}</span>` : null}</span></div>
              ${spend.dailyCap ? html`<${Meter} value=${spend.todaySpent} max=${spend.dailyCap} />` : null}
            </div>
          `
        : null}
    </aside>
  `;
}

function Meter({ value, max }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return html`<div class="ss-meter" role="meter" aria-valuenow=${value} aria-valuemin="0" aria-valuemax=${max}><span class=${pct >= 90 ? 'hot' : ''} style=${`width:${pct}%`}></span></div>`;
}

// A turn's steps, as a trace hung off the left edge of the answer. Collapsed to one
// line once the turn has settled - the answer is what a person came back for, and the
// steps are how they check it - and open while it runs, because then the steps are
// the only thing happening.
function Steps({ steps, waitingOn, root }) {
  if (!steps.length) return null;
  return html`
    <ol class="ss-steps">
      ${steps.map((st, i) => {
        const waiting = waitingOn && i === steps.length - 1;
        const state = waiting ? 'waiting' : st.status;
        return html`
          <li class="ss-step ss-step-${state.replace(' ', '-')}" key=${i}>
            <span class="ss-step-verb">${verbOf(st.tool)}</span>
            <span class="ss-step-target">${st.target ? html`<${Path} path=${relTo(root, st.target)} />` : null}</span>
            ${waiting
              ? html`<span class="ss-step-note">waiting for approval</span>`
              : st.status !== 'done'
                ? html`<span class="ss-step-note" title=${st.error || ''}>${st.status}</span>`
                : null}
          </li>
        `;
      })}
    </ol>
  `;
}

// The turn in flight, reading the event buffer rather than the page's state. A
// working turn emits an event per tool call, and committing each one to the page
// would redraw the transcript beside it - the markdown, the approval and the
// composer - once per event.
function LiveSteps({ store, waiting, root, editing }) {
  const [events, setEvents] = useState(store.events);
  useEffect(() => {
    const sync = () => setEvents(store.events);
    sync();
    return store.on(sync);
  }, [store]);
  const steps = useMemo(() => sessionSteps(events), [events]);
  return html`
    <div class="ss-answer">
      <${Steps} steps=${steps} waitingOn=${waiting} root=${root} />
      ${waiting ? null : html`<div class="ss-live"><${Spinner} /> <span>${steps.length ? (editing ? 'Working in the checkout…' : 'Reading…') : 'Starting…'}</span></div>`}
    </div>
  `;
}

function EventLog({ store }) {
  const [events, setEvents] = useState(store.events);
  useEffect(() => {
    const sync = () => setEvents(store.events);
    sync();
    return store.on(sync);
  }, [store]);
  return html`<${EventStream} events=${events} />`;
}

function Turn({ t, live, root, sessionId, children }) {
  const [open, setOpen] = useState(false);
  // A run row that is still running is not a failure. The stream reports the turn
  // settled a moment before the re-read transcript arrives, and in that gap the last
  // turn is still the unanswered, running row the stream's first frame carried.
  const unsettled = t.status === 'running' || t.status === 'queued';
  const failure = !t.answer && !live && !unsettled ? t.error || `The turn ${t.status || 'did not finish'}.` : null;
  const took = t.ended_at && t.at ? Date.parse(t.ended_at) - Date.parse(t.at) : 0;
  const steps = t.steps || [];
  const summary = [steps.length ? `${steps.length} step${steps.length === 1 ? '' : 's'}` : 'No steps', took > 0 ? formatDuration(took) : null, t.cost ? formatCost(t.cost) : null]
    .filter(Boolean)
    .join(' · ');
  return html`
    <div class="ss-turn">
      ${t.instruction ? html`<div class="ss-said">${t.instruction}</div>` : null}
      <${SentFiles} files=${t.attachments} sessionId=${sessionId} runId=${t.run_id} />
      ${live
        ? children
        : html`
            <div class="ss-answer">
              <button class="ss-summary" type="button" aria-expanded=${open} onClick=${() => setOpen((v) => !v)} disabled=${!steps.length}>
                ${failure ? icon(ICONS.cross, 'bad') : unsettled ? html`<${Spinner} />` : icon(ICONS.check, 'good')}
                <span>${summary}</span>
                ${steps.length ? icon(ICONS.chevron, open ? 'open' : '') : null}
              </button>
              ${open ? html`<${Steps} steps=${steps} root=${root} />` : null}
              ${t.answer ? html`<${Markdown} text=${t.answer} className="md ss-md" />` : null}
              <${SharedFiles} files=${t.outputs} sessionId=${sessionId} runId=${t.run_id} />
              ${failure ? html`<div class="ss-failure">${failure}</div>` : null}
            </div>
          `}
    </div>
  `;
}

// Where the conversation changed mode, between the turns either side of the switch.
// Drawn from the turns' own roles rather than from a stored event, so it marks the
// mode a turn actually ran in, not the moment someone clicked.
const roleOfMode = (mode) => (mode === 'edit' ? 'session' : 'chat');
function ModeDivider({ role }) {
  const edit = role === 'session';
  return html`<div class="ss-divider ${edit ? 'ss-divider-edit' : 'ss-divider-read'}" role="separator">${edit ? 'Switched to Can edit' : 'Switched to Read-only'}</div>`;
}

// A task this conversation proposed, still waiting in the project's queue. Approve
// and Drop are the queue's own actions, so deciding here and on the project page is
// one decision, not two.
function DraftCard({ draft, busy, onApprove, onDrop }) {
  return html`
    <section class="ss-draft" aria-label="Drafted task">
      <div class="ss-draft-head">
        ${icon(ICONS.task)}
        <b>${draft.title}</b>
        <span class="badge badge-info">Waiting for approval</span>
      </div>
      ${draft.description && draft.description !== draft.title ? html`<p>${draft.description}</p>` : null}
      <div class="ss-draft-actions">
        <button class="btn primary sm" type="button" onClick=${onApprove} disabled=${busy}>Approve</button>
        <button class="btn secondary sm" type="button" onClick=${onDrop} disabled=${busy}>Drop</button>
        <span class="muted">The same queue as the project page.</span>
      </div>
    </section>
  `;
}

// Each git or gh step of the command, with how far it reaches. The words are the
// classifier's; the panel only adds the scope, so a reader sees "Leaves this machine"
// before the label that says what leaves.
const GIT_SCOPE = { read: 'Reads only', local: 'This checkout', remote: 'Leaves this machine' };
function GitImpact({ impact }) {
  return html`
    <ul class="ss-git ss-git-${impact.level}" aria-label="What this git command does">
      ${impact.items.map(
        (x, i) => html`
          <li key=${i} class=${`ss-git-${x.level}`}>
            <span class="ss-git-scope">${GIT_SCOPE[x.level]}</span>
            <span>${x.label}</span>
            ${x.destructive ? html`<span class="ss-git-warn">Can't be undone from here</span>` : null}
          </li>
        `
      )}
    </ul>
  `;
}

export function Approval({ permission, now, busy, onAnswer, root }) {
  const a = approvalOf(permission.tool, permission.input, root);
  const cwd = permission.cwd ? relTo(root, permission.cwd) : '';
  const left = secondsLeft(permission.timeout_at, now);
  const total = Math.max(1, Math.round((Date.parse(permission.timeout_at) - Date.parse(permission.created_at)) / 1000));
  return html`
    <section class="ss-approval" aria-label="Approval needed" aria-live="polite">
      <div class="ss-approval-grab" aria-hidden="true"></div>
      <div class="ss-approval-head">
        <${Ring} left=${left} total=${total} />
        <div class="ss-approval-what">
          <div class="ss-approval-title">${a.title} ${a.file ? html`<${Path} path=${a.file} />` : null}</div>
          <div class="ss-approval-sub">
            Denied automatically in <span class="ss-mono ss-approval-left">${clock(left)}</span>
            ${cwd && cwd !== '.' ? html` · in <span class="ss-mono">${cwd}</span>` : null}
          </div>
        </div>
        ${a.rows ? html`<span class="ss-mono ss-approval-count"><span class="good">+${a.added}</span> <span class="bad">−${a.removed}</span></span>` : null}
      </div>
      ${a.command ? html`<pre class="ss-approval-cmd"><span class="muted">$ </span>${a.command}</pre>` : null}
      ${a.git ? html`<${GitImpact} impact=${a.git} />` : null}
      ${a.note ? html`<p class="ss-approval-note">${a.note}</p>` : null}
      ${a.rows && a.rows.length
        ? html`
            <div class="ss-diff">
              ${a.rows.map(
                (l, i) => html`
                  <div class="ss-diff-line ${l.cls}" key=${i}>
                    <span class="ss-diff-no">${l.cls === 'diff-hunk' ? '' : l.cls === 'diff-add' ? '+' : l.cls === 'diff-del' ? '−' : l.new || l.old}</span>
                    <span class="ss-diff-text">${l.cls === 'diff-hunk' ? '⋯' : l.text.slice(1) || ' '}</span>
                  </div>
                `
              )}
            </div>
          `
        : null}
      ${a.raw ? html`<pre class="ss-approval-cmd">${a.raw}</pre>` : null}
      <div class="ss-approval-foot">
        <span class="muted">Nothing happens until you allow it.</span>
        <button class="btn secondary" type="button" onClick=${() => onAnswer('deny')} disabled=${busy}>Deny</button>
        <button class="btn ss-allow ${a.git?.destructive || a.git?.level === 'remote' ? 'ss-allow-hot' : ''}" type="button" onClick=${() => onAnswer('allow')} disabled=${busy}>${a.allow}</button>
      </div>
    </section>
  `;
}

// The session's other actions. A menu rather than a row of buttons: Rename, Archive
// and the rest are occasional, and four of them in a header were what squeezed a
// session's name down to one word a line on a phone.
function MoreMenu({ items, label = 'More actions' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  return html`
    <div
      class="ss-menu-wrap"
      ref=${ref}
      onKeyDown=${(e) => {
        if (e.key === 'Escape' && open) {
          e.preventDefault();
          setOpen(false);
        }
      }}
    >
      <button class="btn secondary ss-icon-btn" type="button" aria-label=${label} aria-haspopup="menu" aria-expanded=${open} onClick=${() => setOpen((v) => !v)}>
        ${icon(ICONS.more)}
      </button>
      ${open
        ? html`
            <div class="ss-menu" role="menu">
              ${items.filter(Boolean).map(
                (it) => html`
                  <button
                    role="menuitem"
                    type="button"
                    class=${it.danger ? 'danger' : ''}
                    disabled=${it.disabled}
                    onClick=${() => {
                      setOpen(false);
                      it.onSelect();
                    }}
                  >
                    ${it.label}
                  </button>
                `
              )}
            </div>
          `
        : null}
    </div>
  `;
}

function Rail({ detail, turns, project, events, open, onClose, busy, onDraft, onDismiss }) {
  const [showLog, setShowLog] = useState(false);
  const budget = detail?.budget || null;
  const changes = detail?.changes || [];
  const nudge = detail?.nudge || null;
  const history = detail?.history || [];
  const lastTurn = turns[turns.length - 1];
  const model = [...turns].reverse().find((t) => t.model_id)?.model_id || detail?.session?.model_id || 'Automatic';
  const tally = {
    allowed: history.filter((h) => h.status === 'allowed').length,
    denied: history.filter((h) => h.status === 'denied').length,
    timeout: history.filter((h) => h.status === 'timeout').length,
  };
  return html`
    <aside class="ss-rail ${open ? 'open' : ''}" aria-label="Conversation details">
      <div class="ss-rail-head">
        <h3>Details</h3>
        <button class="btn secondary ss-icon-btn" type="button" aria-label="Close details" onClick=${onClose}>${icon(ICONS.cross)}</button>
      </div>
      ${budget
        ? html`
            <section class="ss-rail-sec">
              <h3 class="ss-eyebrow">Spend</h3>
              <div class="ss-spend"><span class="ss-mono ss-spend-figure">${formatCost(budget.spent)}</span><span class="muted">this conversation</span></div>
              ${budget.runCap
                ? html`
                    <div class="ss-meter-row"><span>Last turn</span><span class="ss-mono">${formatCost(lastTurn?.cost || 0)} <span class="muted">/ ${formatCost(budget.runCap)}</span></span></div>
                    <${Meter} value=${lastTurn?.cost || 0} max=${budget.runCap} />
                  `
                : null}
              ${budget.dailyCap
                ? html`
                    <div class="ss-meter-row"><span>Today, all conversations</span><span class="ss-mono">${formatCost(budget.todaySpent)} <span class="muted">/ ${formatCost(budget.dailyCap)}</span></span></div>
                    <${Meter} value=${budget.todaySpent} max=${budget.dailyCap} />
                  `
                : null}
            </section>
          `
        : null}

      <section class="ss-rail-sec">
        <div class="ss-rail-sec-head"><h3 class="ss-eyebrow">Uncommitted in checkout</h3><span class="muted">${changes.length ? `${changes.length} file${changes.length === 1 ? '' : 's'}` : ''}</span></div>
        ${changes.length
          ? html`
              <ul class="ss-files">
                ${changes.slice(0, 12).map(
                  (c) => html`
                    <li key=${c.path} title=${c.path}>
                      <span class="ss-file-mark ss-file-${c.status}" aria-label=${c.status}></span>
                      <${Path} path=${c.path} />
                      ${c.status === 'new'
                        ? html`<span class="ss-file-tag">new</span>`
                        : c.added != null
                          ? html`<span class="ss-mono ss-file-n"><span class="good">+${c.added}</span> <span class="bad">−${c.removed}</span></span>`
                          : null}
                    </li>
                  `
                )}
                ${changes.length > 12 ? html`<li class="muted">and ${changes.length - 12} more</li>` : null}
              </ul>
            `
          : html`<p class="muted ss-rail-empty">The checkout is clean.</p>`}
      </section>

      ${nudge
        ? html`
            <section class="ss-nudge">
              <div class="ss-nudge-head">${icon(ICONS.task)}<h3>This is starting to look like a task</h3></div>
              <p>Changes here go straight into your project. A task works in its own worktree and gets reviewed.</p>
              <div class="ss-nudge-actions">
                <button class="btn primary sm" type="button" onClick=${onDraft} disabled=${busy}>Draft as task</button>
                <button class="btn secondary sm" type="button" onClick=${onDismiss} disabled=${busy}>Not now</button>
              </div>
            </section>
          `
        : null}

      <section class="ss-rail-sec ss-facts">
        <div><span>Started</span><span>${detail?.session ? html`<${Time} at=${detail.session.created_at} />` : '—'}</span></div>
        <div><span>Model</span><span class="ss-mono">${model}</span></div>
        ${project ? html`<div><span>Directory</span><span class="ss-mono ss-fact-path" title=${project.path}>${shortDir(project.path)}</span></div>` : null}
        <div>
          <span>Approvals</span>
          <span>${tally.allowed} allowed · ${tally.denied} denied${tally.timeout ? ` · ${tally.timeout} timed out` : ''}</span>
        </div>
      </section>

      <section class="ss-rail-sec">
        <button class="ss-closed-toggle" type="button" aria-expanded=${showLog} onClick=${() => setShowLog((v) => !v)}>
          ${icon(ICONS.chevron, showLog ? 'open' : '')} Event log
        </button>
        ${showLog ? html`<div class="ss-log"><${EventLog} store=${events} /></div>` : null}
      </section>
    </aside>
  `;
}

// A new session starts from what it should do. The old flow made an empty session
// called "New session" and opened it, which is a row in the list before there is
// anything to say about it; this one creates the session with its first instruction,
// which is also what names it.
function NewSession({ projects, projectsLoaded, projectId, onProject, models, onStarted, navigate }) {
  const [text, setText] = useState(() => readUnsent('new'));
  useEffect(() => {
    writeUnsent('new', text);
  }, [text]);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const attach = useAttachments();
  const drop = useDropTarget(attach.add, busy || !projectId);
  const project = projects.find((p) => p.id === projectId);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const start = async () => {
    const instruction = text.trim();
    if ((!instruction && !attach.files.length) || !projectId || busy) return;
    setBusy(true);
    try {
      const [providerId, modelId] = model ? model.split('::') : [null, null];
      const s = await api.createSession(projectId, 'New session', { providerId, modelId, mode: 'read' });
      await api.sendSessionMessage(s.id, instruction, attach.files.map(({ name, type, data }) => ({ name, type, data })));
      writeUnsent('new', '');
      attach.clear();
      onStarted(s.id);
    } catch (e) {
      showToast(e.message, 'error');
      setBusy(false);
    }
  };
  if (projectsLoaded && !projects.length) {
    return html`
      <div class="ss-new-pane">
        <div class="ss-new-inner">
          <${NoProject} what="Conversations belong to a project. Add one first." />
        </div>
      </div>
    `;
  }

  return html`
    <div class="ss-new-pane">
      <div class="ss-new-inner">
        ${navigate ? html`<a class="ss-back" href="#/sessions">${icon(ICONS.back)} Conversations</a>` : null}
        <div class="ss-new-head">
          <span class="muted">
            New conversation in
            ${projects.length > 1
              ? html` <${Select} inline size="sm" className="ss-inline-select" ariaLabel="Project" value=${projectId} onChange=${onProject} options=${projects.map((p) => ({ value: p.id, label: p.name }))} />`
              : html` <strong>${project?.name || '—'}</strong>`}
            ${project ? html` · <span class="ss-mono" title=${project.path}>${shortDir(project.path)}</span>` : null}
          </span>
          <h2>What do you want to know or change?</h2>
        </div>
        <div class="ss-new-box ${drop.over ? 'dropping' : ''}" ...${drop.props}>
          <${AttachTray} files=${attach.files} onRemove=${attach.remove} disabled=${busy} />
          <textarea
            ref=${ref}
            rows="4"
            aria-label="First message"
            placeholder="e.g. Why did the last failed task fail? Paste or drop screenshots and files here."
            value=${text}
            disabled=${busy || !projectId}
            onPaste=${attach.onPaste}
            onInput=${(e) => setText(e.target.value)}
            onKeyDown=${(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                start();
              }
            }}
          ></textarea>
          <div class="ss-new-bar">
            ${models.length
              ? html`<${Select}
                  inline
                  size="sm"
                  className="ss-model"
                  ariaLabel="Model"
                  value=${model}
                  onChange=${setModel}
                  options=${[{ value: '', label: 'Automatic model' }, ...models.map((m) => ({ value: `${m.provider_id}::${m.id}`, label: m.name || m.id }))]}
                />`
              : null}
            <${AttachButton} onFiles=${attach.add} disabled=${busy || !projectId} />
            <span class="ss-new-spacer"></span>
            <span class="ss-mono muted ss-kbd-hint">⌘↵</span>
            <button class="btn primary" type="button" onClick=${start} disabled=${busy || (!text.trim() && !attach.files.length) || !projectId}>${busy ? 'Starting…' : 'Start'}</button>
          </div>
        </div>
        <div class="ss-facts-grid">
          <div>${icon(ICONS.search, 'accent')}<b>Starts read-only</b><span>It reads the code and AI Code's own records: tasks, runs, spend. Nothing changes.</span></div>
          <div>${icon(ICONS.shield, 'warn')}<b>Switch to Can edit for changes</b><span>Then it works in your checkout, and every write and command waits for you.</span></div>
          <div>${icon(ICONS.task)}<b>Bigger work becomes a task</b><span>It can draft one into the project's queue; you approve it there or here.</span></div>
        </div>
        <p class="muted ss-new-alt">Want a branch, a review and a commit? <a class="link" href="#/tasks">Create a task instead</a></p>
      </div>
    </div>
  `;
}

export function Sessions({ id, navigate, onTitle }) {
  const isNew = id === 'new';
  const sessionId = id && !isNew ? id : null;
  const [projects, setProjects] = useState([]);
  // Whether the projects have been read. With none there is no project to list
  // sessions for, and without this the list could not tell "none" from "not yet".
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [models, setModels] = useState([]);
  const [sessions, setSessions] = useState(null);
  const [chats, setChats] = useState([]);
  const [spend, setSpend] = useState(null);
  const [detail, setDetail] = useState(null);
  const [turns, setTurns] = useState([]);
  const [permission, setPermission] = useState(null);
  const [working, setWorking] = useState(false);
  // The instruction just sent, shown under the transcript until the stored turn that
  // carries it arrives - a queued turn has no run row yet, so it is not in `turns`.
  const [sent, setSent] = useState('');
  // The files that went with it, as their previews, for the same window.
  const [sentFiles, setSentFiles] = useState([]);
  const [input, setInput] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [railOpen, setRailOpen] = useState(false);
  const [listTick, setListTick] = useState(0);
  // One clock for the countdowns and the list's relative times. A second is the
  // countdown's resolution; the relative times are the same clock read coarsely.
  const [now, setNow] = useState(() => Date.now());
  const streamRef = useRef(null);
  const transcriptRef = useRef(null);
  const composerRef = useRef(null);
  const sawWorking = useRef(false);
  const renameRef = useRef(null);
  const attach = useAttachments();
  // Switching conversations leaves the files behind with the box they were added to.
  const clearAttachments = attach.clear;
  useEffect(() => clearAttachments(), [sessionId, clearAttachments]);

  // The name box opens with the name selected, so typing replaces it and an arrow
  // key keeps it - the two things a person renaming something wants.
  useEffect(() => {
    if (renaming) renameRef.current?.select();
  }, [renaming]);

  const session = detail?.session || null;
  const composerDrop = useDropTarget(attach.add, busy || working || !!permission || session?.status === 'stopped' || session?.status === 'archived');
  const events = useMemo(() => createEventBuffer(), [sessionId]);
  const project = projects.find((p) => p.id === (session?.project_id || projectId)) || null;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Pin the transcript to the newest turn, on the transcript itself rather than with
  // scrollIntoView on a sentinel: scrollIntoView moves every scrollable ancestor.
  const jumpedRef = useRef(false);
  useEffect(() => {
    jumpedRef.current = false;
  }, [sessionId]);
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: jumpedRef.current ? 'smooth' : 'auto' });
    jumpedRef.current = true;
  }, [turns, working, permission?.id]);

  useEffect(() => {
    const ta = composerRef.current;
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
        setProjectsLoaded(true);
        // The project chosen last time, while it still exists; otherwise the first.
        const last = recall(MEMORY.project, '');
        setProjectId((cur) => cur || (p.some((x) => x.id === last) ? last : (p[0] && p[0].id) || ''));
      })
      .catch((e) => {
        if (cancelled) return;
        setProjectsLoaded(true);
        setError(e.message);
      });
    api
      .providers()
      .then(({ providers, models: all }) => {
        if (cancelled) return;
        const on = new Set(providers.filter((p) => p.enabled).map((p) => p.id));
        setModels((all || []).filter((m) => m.enabled && on.has(m.provider_id)));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // The list follows the open session's project, so a link into a session in another
  // project shows that project's sessions beside it.
  useEffect(() => {
    if (session?.project_id) setProjectId(session.project_id);
  }, [session?.project_id]);

  useEffect(() => {
    if (projectId) remember(MEMORY.project, projectId);
  }, [projectId]);

  const refreshList = useCallback(() => setListTick((n) => n + 1), []);

  // The list is re-read on a slow poll while anything in it is moving, so a session
  // that starts waiting on you in the background says so without a reload.
  useEffect(() => {
    if (!projectId) return undefined;
    let cancelled = false;
    const read = async () => {
      try {
        const [list, s, c] = await Promise.all([api.sessions(projectId), api.sessionSpend().catch(() => null), api.chatSessions(projectId).catch(() => [])]);
        if (cancelled) return;
        setSessions(list);
        setSpend(s);
        setChats(c || []);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    };
    read();
    const t = setInterval(read, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [projectId, listTick]);

  const closeStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }
    sawWorking.current = false;
  }, []);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      const [d, p] = await Promise.all([api.session(sessionId), api.projects().catch(() => null)]);
      // The projects carry the drafts, and a turn may just have proposed one.
      if (p) setProjects(p);
      setDetail(d);
      setTurns(d.turns || []);
      setPermission(d.permission || null);
      onTitle?.(d.session.name);
      // A turn that ended without an answer is the one failure the transcript cannot
      // show from the turns alone when its run never started, so the job row reports it.
      const last = (d.turns || [])[(d.turns || []).length - 1];
      setError(
        d.job && !IN_FLIGHT.has(d.job.state) && d.job.state !== 'succeeded' && (!last || last.status !== 'succeeded') && !last?.error
          ? d.job.error || `The turn ${d.job.state}.`
          : null
      );
      if (d.job && IN_FLIGHT.has(d.job.state)) openStreamRef.current?.();
      else {
        setWorking(false);
        setSent('');
      }
    } catch (e) {
      // A conversation that no longer exists - the remembered one, deleted since -
      // is not an error to sit on: back to the list, which the shell then remembers.
      if (/not found/i.test(e.message)) {
        writeUnsent(sessionId, '');
        navigate('#/sessions');
        return;
      }
      setError(e.message);
    }
  }, [sessionId, onTitle, navigate]);

  const openStream = useCallback(() => {
    closeStream();
    const stream = new EventSource(sessionStreamUrl(sessionId));
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
      // back rather than assembled from the event frames: the answer, its cost and the
      // nudge are all written server-side when the run ends.
      if (sawWorking.current) {
        sawWorking.current = false;
        finish();
        load();
        refreshList();
      }
    });
    stream.onerror = () => {
      finish();
      load();
    };
  }, [sessionId, events, closeStream, load, refreshList]);

  const openStreamRef = useRef(null);
  openStreamRef.current = openStream;

  useEffect(() => {
    setDetail(null);
    setTurns([]);
    setPermission(null);
    setWorking(false);
    setSent('');
    setError(null);
    setRenaming(false);
    setRailOpen(false);
    // What was typed here and not sent, restored with the conversation.
    setInput(sessionId ? readUnsent(sessionId) : '');
    if (!sessionId) {
      onTitle?.(isNew ? 'New conversation' : null);
      return undefined;
    }
    load();
    return closeStream;
  }, [sessionId, isNew, load, closeStream, onTitle]);

  const guarded = useCallback(
    async (fn, label, after) => {
      setBusy(true);
      try {
        await fn();
        after?.();
      } catch (e) {
        showToast(`${label}: ${e.message}`, 'error');
      } finally {
        setBusy(false);
        load();
        refreshList();
      }
    },
    [load, refreshList]
  );

  const send = useCallback(async () => {
    const text = input.trim();
    const files = attach.files;
    if ((!text && !files.length) || busy || working) return;
    setBusy(true);
    setError(null);
    try {
      await api.sendSessionMessage(sessionId, text, files.map(({ name, type, data }) => ({ name, type, data })));
      setInput('');
      writeUnsent(sessionId, '');
      attach.clear();
      setSent(text || 'Take a look at the attached files.');
      setSentFiles(files);
      setWorking(true);
      sawWorking.current = true;
      openStream();
      load();
      refreshList();
    } catch (e) {
      // Refused - a turn already in flight is the usual reason - so the text stays in
      // the box to send again rather than being dropped.
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }, [sessionId, input, attach.files, attach.clear, busy, working, openStream, load, refreshList]);

  const answer = useCallback(
    async (action) => {
      const req = permission;
      if (!req) return;
      setBusy(true);
      try {
        await api.answerSessionPermission(sessionId, req.id, action);
        setPermission(null);
      } catch (e) {
        // A 409 is the countdown having fired first, which is a denial the agent has
        // already been told about. The panel goes away and the toast says why.
        showToast(e.message, 'error');
        setPermission(null);
      } finally {
        setBusy(false);
        refreshList();
      }
    },
    [sessionId, permission, refreshList]
  );

  const draftTask = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api.draftSessionTask(sessionId);
      showToast('Drafting the tasks this session implies…');
      navigate(`#/chat/${r.session.id}`);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }, [sessionId, navigate]);

  // Up to editing asks first, because it changes what the next turn may do to the
  // checkout; back to read-only does not, because it only takes abilities away.
  const switchMode = useCallback(
    async (mode) => {
      if (!session || session.mode === mode) return;
      if (mode === 'edit') {
        const ok = await confirmAction({
          title: 'Allow this conversation to edit?',
          body: `Its next turns work in ${project ? project.name : 'the project'}'s own checkout, not a copy. Every write and command waits for your approval, git and gh included: the approval says when a command changes history or reaches GitHub. Spend counts against the conversations budget, and no other conversation can edit this project until this one goes back to read-only.`,
          confirmLabel: 'Allow edits',
          cancelLabel: 'Stay read-only',
        });
        if (!ok) return;
      }
      await guarded(() => api.updateSession(sessionId, { mode }), 'Switch mode');
    },
    [session, project, sessionId, guarded]
  );

  const decideDraft = useCallback(
    async (draft, approve) => {
      if (!project) return;
      setBusy(true);
      try {
        if (approve) {
          const r = await api.approveDraft(project.id, draft.id);
          showToast(`Task created: ${r.task?.title || draft.title}`);
        } else {
          await api.dropDraft(project.id, draft.id);
        }
      } catch (e) {
        showToast(e.message, 'error');
      } finally {
        setBusy(false);
        load();
      }
    },
    [project, load]
  );

  // Renamed to what the box holds, and the box is left open when the server refuses:
  // the name a person typed is theirs to fix, and closing the editor would have them
  // retype it.
  const saveName = useCallback(async () => {
    const label = nameDraft.trim();
    if (!label) return;
    setBusy(true);
    try {
      await api.updateSession(sessionId, { name: label });
      setRenaming(false);
      load();
      refreshList();
    } catch (e) {
      showToast(`Rename: ${e.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }, [sessionId, nameDraft, load, refreshList]);

  const list = html`
    <${SessionList}
      sessions=${sessions}
      chats=${chats}
      projects=${projects}
      projectsLoaded=${projectsLoaded}
      projectId=${projectId}
      onProject=${(v) => {
        setProjectId(v);
        setSessions(null);
        setChats([]);
        // A conversation from another project stays open no longer: it is the place
        // the shell remembers, and on the way back it would pull the list back to
        // its own project through the effect that follows the open conversation.
        if (session && session.project_id !== v) navigate('#/sessions');
      }}
      activeId=${sessionId}
      spend=${spend}
      now=${now}
      creating=${busy}
      onNew=${() => navigate('#/sessions/new')}
      onControl=${(fn, label) => guarded(fn, label)}
    />
  `;

  // No session open: the list, and on a wide screen a new session beside it - the
  // one thing to do from here that is not opening a session.
  if (!sessionId) {
    return html`
      <div class="ss-shell ${isNew ? 'ss-shell-new' : 'ss-shell-index'}">
        ${list}
        <${NewSession}
          projects=${projects}
          projectsLoaded=${projectsLoaded}
          projectId=${projectId}
          onProject=${setProjectId}
          models=${models}
          navigate=${isNew ? navigate : null}
          onStarted=${(sid) => {
            refreshList();
            navigate(`#/sessions/${sid}`);
          }}
        />
      </div>
    `;
  }

  const stopped = session?.status === 'stopped';
  const archived = session?.status === 'archived';
  const closed = stopped || archived;
  const lastTurn = turns[turns.length - 1];
  // The turn in flight, whether or not its run row exists yet. A queued turn has no
  // row, so its instruction is the one this page sent; a running one has a row with
  // no answer, and its steps come from the stream.
  const pendingRun = session?.pending_run_id || null;
  const liveInTurns = working && lastTurn && lastTurn.run_id === pendingRun;
  const settledTurns = liveInTurns ? turns.slice(0, -1) : turns;
  const liveInstruction = liveInTurns ? lastTurn.instruction : sent;
  // The stored row's files once it exists, the local previews until then.
  const liveFiles = liveInTurns && lastTurn.attachments?.length ? lastTurn.attachments : sentFiles;
  const composerLocked = busy || working || closed || !!permission;
  const statusPill = permission
    ? { cls: 'needs', label: 'Waiting on you' }
    : working
      ? { cls: 'working', label: 'Working' }
      : archived
        ? { cls: 'closed', label: 'Archived' }
        : stopped
          ? { cls: 'closed', label: 'Stopped' }
          : { cls: 'idle', label: 'Idle' };
  const editing = session?.mode === 'edit';
  // Who holds the checkout, when it is not this conversation. Read from the list,
  // which is polled, so a switch in another tab shows here within a few seconds.
  const holder = !editing ? (sessions || []).find((x) => x.id !== sessionId && x.mode === 'edit' && x.status !== 'stopped' && x.status !== 'archived') || null : null;
  const drafts = (project?.drafts || []).filter((d) => d.session_id === sessionId);
  const placeholder = permission
    ? 'Paused on the approval above.'
    : working
      ? 'Working… send the next message when it replies.'
      : closed
        ? 'Resume this conversation to send a message.'
        : editing
          ? 'Tell it what to change. Each write asks you first.'
          : 'Ask about the code, tasks, runs or spend…';

  return html`
    <div class="ss-shell ss-shell-open ${railOpen ? 'rail-open' : ''}">
      ${list}
      <main class="ss-conv" aria-label=${session?.name || 'Conversation'}>
        <header class="ss-conv-head">
          ${renaming ? null : html`<a class="btn secondary ss-icon-btn ss-back-btn" href="#/sessions" aria-label="Back to conversations">${icon(ICONS.back)}</a>`}
          <div class="ss-conv-title">
            ${renaming
              ? html`
                  <div class="ss-rename">
                    <input
                      class="input"
                      value=${nameDraft}
                      aria-label="Conversation name"
                      ref=${renameRef}
                      onInput=${(e) => setNameDraft(e.target.value)}
                      onKeyDown=${(e) => {
                        if (e.key === 'Enter') saveName();
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          setRenaming(false);
                        }
                      }}
                    />
                    <button class="btn primary sm" type="button" onClick=${saveName} disabled=${busy || !nameDraft.trim()}>Save</button>
                    <button class="btn secondary sm" type="button" onClick=${() => setRenaming(false)} disabled=${busy}>Cancel</button>
                  </div>
                `
              : html`
                  <div class="ss-title-row">
                    <h2>${session?.name || 'Conversation'}</h2>
                    ${session && statusPill.cls !== 'idle' ? html`<span class="ss-pill ss-pill-${statusPill.cls}"><span></span>${statusPill.label}</span>` : null}
                  </div>
                  <div class="ss-meta">
                    ${project ? html`<span>${project.name}</span><span aria-hidden="true">·</span>` : null}
                    ${editing
                      ? html`<span class="ss-meta-branch">${icon(ICONS.branch)} edits the checkout</span>`
                      : html`<span class="ss-meta-branch">${icon(ICONS.search)} changes nothing</span>`}
                    <span aria-hidden="true">·</span>
                    <span>${turns.length} turn${turns.length === 1 ? '' : 's'}</span>
                    ${detail?.budget?.spent ? html`<span aria-hidden="true">·</span><span class="ss-mono">${formatCost(detail.budget.spent)}</span>` : null}
                  </div>
                `}
          </div>
          ${renaming
            ? null
            : working
            ? html`<button class="btn secondary sm ss-stop" type="button" onClick=${() => guarded(() => api.stopSession(sessionId), 'Stop')} disabled=${busy}>${icon(ICONS.stop)} Stop</button>`
            : closed
              ? html`<button class="btn primary sm" type="button" onClick=${() => guarded(() => api.resumeSession(sessionId), 'Resume')} disabled=${busy}>Resume</button>`
              : null}
          ${renaming || !session
            ? null
            : html`<div class="seg ss-mode" role="group" aria-label="Mode">
                <button type="button" class="seg-btn ${!editing ? 'active ss-mode-read' : ''}" aria-pressed=${!editing} onClick=${() => switchMode('read')} disabled=${busy || working}>Read-only</button>
                <button
                  type="button"
                  class="seg-btn ${editing ? 'active ss-mode-edit' : ''}"
                  aria-pressed=${editing}
                  title=${holder ? `"${holder.name}" can already edit this project` : ''}
                  onClick=${() => switchMode('edit')}
                  disabled=${busy || working || !!holder || closed}
                >Can edit</button>
              </div>`}
          ${renaming
            ? null
            : html`<button class="btn secondary ss-icon-btn ss-rail-btn" type="button" aria-label="Conversation details" aria-expanded=${railOpen} onClick=${() => setRailOpen((v) => !v)}>
                ${icon(ICONS.panel)}
              </button>`}
          ${renaming ? null : html`<${MoreMenu}
            items=${[
              { label: 'Rename', disabled: !session, onSelect: () => {
                  setNameDraft(session?.name || '');
                  setRenaming(true);
                } },
              detail?.nudge ? { label: 'Draft as task', onSelect: draftTask } : null,
              !working && !closed ? { label: 'Stop conversation', onSelect: () => guarded(() => api.stopSession(sessionId), 'Stop') } : null,
              !archived ? { label: 'Archive', danger: true, onSelect: () => guarded(() => api.archiveSession(sessionId), 'Archive') } : null,
            ]}
          />`}
        </header>
        ${holder
          ? html`<div class="ss-lock" role="status">
              Can edit is unavailable: <a class="link" href=${`#/sessions/${holder.id}`}>${holder.name}</a> can already edit ${project ? project.name : 'this project'}. Switch it to read-only to free the checkout.
            </div>`
          : null}

        <div class="ss-transcript" ref=${transcriptRef}>
          ${detail === null
            ? html`<div class="ss-list-empty"><${Spinner} /></div>`
            : !settledTurns.length && !working
              ? html`<div class="ss-empty">
                  <b>Nothing yet</b>
                  <span class="muted">${editing
                    ? 'Tell it what to change below. It works in the checkout, and you approve every write and command.'
                    : 'Ask anything below. It reads the code and AI Code\'s records and changes nothing.'}</span>
                </div>`
              : null}
          ${settledTurns.map((t, i) => {
            const prev = settledTurns[i - 1];
            const switched = prev && prev.role && t.role && prev.role !== t.role;
            return html`${switched ? html`<${ModeDivider} key=${`m${t.run_id}`} role=${t.role} />` : null}<${Turn} key=${t.run_id} t=${t} root=${project?.path} sessionId=${sessionId} />`;
          })}
          ${working || (permission && pendingRun)
            ? html`
                ${settledTurns.length && settledTurns[settledTurns.length - 1].role && settledTurns[settledTurns.length - 1].role !== roleOfMode(session?.mode)
                  ? html`<${ModeDivider} role=${roleOfMode(session?.mode)} />`
                  : null}
                <${Turn} key="live" t=${{ instruction: liveInstruction, attachments: liveFiles, run_id: liveInTurns ? lastTurn.run_id : null }} sessionId=${sessionId} live>
                  <${LiveSteps} store=${events} waiting=${!!permission} root=${project?.path} editing=${editing} />
                </${Turn}>
              `
            : null}
          ${drafts.map((d) => html`<${DraftCard} key=${d.id} draft=${d} busy=${busy} onApprove=${() => decideDraft(d, true)} onDrop=${() => decideDraft(d, false)} />`)}
          ${error ? html`<div class="ss-failure">${error}</div>` : null}
        </div>

        <div class="ss-dock">
          ${permission ? html`<div class="ss-scrim" aria-hidden="true"></div><${Approval} permission=${permission} now=${now} busy=${busy} onAnswer=${answer} root=${project?.path} />` : null}
          <${AttachTray} files=${attach.files} onRemove=${attach.remove} disabled=${composerLocked} />
          <div class="ss-composer ${permission || working || closed ? 'locked' : ''} ${composerDrop.over ? 'dropping' : ''}" ...${composerDrop.props}>
            <${AttachButton} onFiles=${attach.add} disabled=${composerLocked} />
            <textarea
              ref=${composerRef}
              rows="1"
              aria-label="Instruction"
              placeholder=${placeholder}
              value=${input}
              disabled=${composerLocked}
              onPaste=${attach.onPaste}
              onInput=${(e) => {
                setInput(e.target.value);
                writeUnsent(sessionId, e.target.value);
              }}
              onKeyDown=${(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            ></textarea>
            <button class="ss-send" type="button" aria-label="Send" onClick=${send} disabled=${(!input.trim() && !attach.files.length) || composerLocked}>
              ${icon(ICONS.send)}
            </button>
          </div>
          <div class="ss-hint">Enter to send · Shift+Enter for a new line · Drop or paste files</div>
        </div>
      </main>
      ${railOpen ? html`<div class="ss-rail-scrim" aria-hidden="true" onClick=${() => setRailOpen(false)}></div>` : null}
      <${Rail}
        detail=${detail}
        turns=${turns}
        project=${project}
        events=${events}
        open=${railOpen}
        onClose=${() => setRailOpen(false)}
        busy=${busy}
        onDraft=${draftTask}
        onDismiss=${() => guarded(() => api.dismissSessionNudge(sessionId), 'Dismiss')}
      />
    </div>
  `;
}
