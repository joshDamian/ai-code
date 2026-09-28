// Supervised sessions. URL hash: #/sessions (the list, and a new session beside it),
// #/sessions/new (a new session on its own), or #/sessions/:id (one of them).
//
// A session is an agent working in the project's own checkout on instructions a
// person types, with every write and every command held at a permission prompt. So
// the view is a workspace rather than a page: the sessions down the left, grouped by
// what each one needs from you; the open session in the middle; and what it has
// cost and changed on the right. Switching sessions is one click, and a session
// that is waiting on you says so in the list without being opened.
//
// The approval is docked to the composer rather than laid over the top of the page.
// It is the one element here that is blocking something - an agent that has asked
// has stopped, is holding a provider slot, and will be denied by the clock - and the
// composer is where a person's eyes already are. On a phone it is a bottom sheet,
// for the same reason: it is where the thumb is.
import { html, useState, useEffect, useRef, useCallback, useMemo, formatCost, formatDuration, diffLines, unifiedDiff, sessionSteps, shortDir } from '../lib.mjs';
import { api, sessionStreamUrl } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { Markdown } from '../components/markdown.mjs';
import { EventStream } from '../components/event-stream.mjs';
import { Time } from '../components/time.mjs';
import { Select } from '../components/form.mjs';
import { NoProject } from '../components/empty-state.mjs';
import { createEventBuffer } from './task-detail.mjs';

// A turn the queue is still holding. Read from the job row rather than from a local
// flag, so a reload and a second tab see the same thing this one does.
const IN_FLIGHT = new Set(['queued', 'running']);

// Where the composer stops growing and starts scrolling instead.
const COMPOSER_MAX_PX = 200;

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
};
const verbOf = (tool) => VERBS[tool] || String(tool || 'tool').replace(/^mcp__[^_]+__/, '');

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
    return { title: 'Run a command', allow: 'Allow command', command: i.command || '(a command with no text)', note: i.description || '' };
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

function SessionList({ sessions, projects, projectsLoaded, projectId, onProject, activeId, spend, now, onNew, creating, onControl }) {
  const root = projects.find((p) => p.id === projectId)?.path || '';
  const [query, setQuery] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const q = query.trim().toLowerCase();
  const shown = (sessions || []).filter((s) => !q || s.name.toLowerCase().includes(q) || (s.preview || '').toLowerCase().includes(q));
  const by = (g) => shown.filter((s) => groupOf(s) === g);
  const closed = by('closed');
  return html`
    <aside class="ss-list" aria-label="Sessions">
      <div class="ss-list-head">
        <div class="ss-list-title">
          ${projects.length > 1
            ? html`<${Select} className="ss-project" ariaLabel="Project" value=${projectId} onChange=${onProject} options=${projects.map((p) => ({ value: p.id, label: p.name }))} />`
            : html`<span class="ss-project-name">${projects[0]?.name || ''}</span>`}
          <button class="btn primary sm ss-new" type="button" onClick=${onNew} disabled=${creating || !projectId} aria-label="New session">
            ${icon(ICONS.plus)}<span>New</span>
          </button>
        </div>
        <div class="ss-list-tools">
          <label class="ss-filter">
            ${icon(ICONS.search)}
            <input type="search" placeholder="Filter" aria-label="Filter sessions" value=${query} onInput=${(e) => setQuery(e.target.value)} />
          </label>
        </div>
      </div>
      <div class="ss-list-body">
        ${projectsLoaded && !projects.length
          ? html`<p class="ss-list-empty muted">No projects yet.</p>`
          : sessions === null
            ? html`<div class="ss-list-empty"><${Spinner} /></div>`
            : !sessions.length
              ? html`<p class="ss-list-empty muted">No sessions in this project yet.</p>`
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
                  ${q && !shown.length ? html`<p class="ss-list-empty muted">Nothing matches “${query}”.</p>` : null}
                `}
      </div>
      ${spend
        ? html`
            <div class="ss-list-foot">
              <div class="ss-meter-row"><span>Today, all sessions</span><span class="ss-mono">${formatCost(spend.todaySpent)}${spend.dailyCap ? html` <span class="muted">/ ${formatCost(spend.dailyCap)}</span>` : null}</span></div>
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
function LiveSteps({ store, waiting, root }) {
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
      ${waiting ? null : html`<div class="ss-live"><${Spinner} /> <span>${steps.length ? 'Working in the checkout…' : 'Starting…'}</span></div>`}
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

function Turn({ t, live, root, children }) {
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
              ${failure ? html`<div class="ss-failure">${failure}</div>` : null}
            </div>
          `}
    </div>
  `;
}

function Approval({ permission, now, busy, onAnswer, root }) {
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
        <button class="btn ss-allow" type="button" onClick=${() => onAnswer('allow')} disabled=${busy}>${a.allow}</button>
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
    <aside class="ss-rail ${open ? 'open' : ''}" aria-label="Session details">
      <div class="ss-rail-head">
        <h3>Details</h3>
        <button class="btn secondary ss-icon-btn" type="button" aria-label="Close details" onClick=${onClose}>${icon(ICONS.cross)}</button>
      </div>
      ${budget
        ? html`
            <section class="ss-rail-sec">
              <h3 class="ss-eyebrow">Spend</h3>
              <div class="ss-spend"><span class="ss-mono ss-spend-figure">${formatCost(budget.spent)}</span><span class="muted">this session</span></div>
              ${budget.runCap
                ? html`
                    <div class="ss-meter-row"><span>Last turn</span><span class="ss-mono">${formatCost(lastTurn?.cost || 0)} <span class="muted">/ ${formatCost(budget.runCap)}</span></span></div>
                    <${Meter} value=${lastTurn?.cost || 0} max=${budget.runCap} />
                  `
                : null}
              ${budget.dailyCap
                ? html`
                    <div class="ss-meter-row"><span>Today, all sessions</span><span class="ss-mono">${formatCost(budget.todaySpent)} <span class="muted">/ ${formatCost(budget.dailyCap)}</span></span></div>
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
              <p>Changes here land straight in your checkout. A task gets its own worktree, a review and a commit.</p>
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
  const [text, setText] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const project = projects.find((p) => p.id === projectId);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const start = async () => {
    const instruction = text.trim();
    if (!instruction || !projectId || busy) return;
    setBusy(true);
    try {
      const [providerId, modelId] = model ? model.split('::') : [null, null];
      const s = await api.createSession(projectId, 'New session', { providerId, modelId });
      await api.sendSessionMessage(s.id, instruction);
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
          <${NoProject} what="A session works in a project’s own checkout, so it needs a project to work in." />
        </div>
      </div>
    `;
  }

  return html`
    <div class="ss-new-pane">
      <div class="ss-new-inner">
        ${navigate ? html`<a class="ss-back" href="#/sessions">${icon(ICONS.back)} Sessions</a>` : null}
        <div class="ss-new-head">
          <span class="muted">
            New session in
            ${projects.length > 1
              ? html` <${Select} inline size="sm" className="ss-inline-select" ariaLabel="Project" value=${projectId} onChange=${onProject} options=${projects.map((p) => ({ value: p.id, label: p.name }))} />`
              : html` <strong>${project?.name || '—'}</strong>`}
            ${project ? html` · <span class="ss-mono" title=${project.path}>${shortDir(project.path)}</span>` : null}
          </span>
          <h2>What should the agent work on?</h2>
        </div>
        <div class="ss-new-box">
          <textarea
            ref=${ref}
            rows="4"
            aria-label="First instruction"
            placeholder="e.g. Find why the upload test is flaky and fix it"
            value=${text}
            disabled=${busy || !projectId}
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
            <span class="ss-new-spacer"></span>
            <span class="ss-mono muted ss-kbd-hint">⌘↵</span>
            <button class="btn primary" type="button" onClick=${start} disabled=${busy || !text.trim() || !projectId}>${busy ? 'Starting…' : 'Start session'}</button>
          </div>
        </div>
        <div class="ss-facts-grid">
          <div>${icon(ICONS.branch, 'accent')}<b>Your own checkout</b><span>No worktree. Approved changes land in the project directly.</span></div>
          <div>${icon(ICONS.shield, 'warn')}<b>You approve each change</b><span>Reading is free. Every write and command waits for you.</span></div>
          <div>${icon(ICONS.clock)}<b>Silence means no</b><span>A request left unanswered is denied, and the agent carries on.</span></div>
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
  const [spend, setSpend] = useState(null);
  const [detail, setDetail] = useState(null);
  const [turns, setTurns] = useState([]);
  const [permission, setPermission] = useState(null);
  const [working, setWorking] = useState(false);
  // The instruction just sent, shown under the transcript until the stored turn that
  // carries it arrives - a queued turn has no run row yet, so it is not in `turns`.
  const [sent, setSent] = useState('');
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

  // The name box opens with the name selected, so typing replaces it and an arrow
  // key keeps it - the two things a person renaming something wants.
  useEffect(() => {
    if (renaming) renameRef.current?.select();
  }, [renaming]);

  const session = detail?.session || null;
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
        setProjectId((cur) => cur || (p[0] && p[0].id) || '');
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

  const refreshList = useCallback(() => setListTick((n) => n + 1), []);

  // The list is re-read on a slow poll while anything in it is moving, so a session
  // that starts waiting on you in the background says so without a reload.
  useEffect(() => {
    if (!projectId) return undefined;
    let cancelled = false;
    const read = async () => {
      try {
        const [list, s] = await Promise.all([api.sessions(projectId), api.sessionSpend().catch(() => null)]);
        if (cancelled) return;
        setSessions(list);
        setSpend(s);
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
      const d = await api.session(sessionId);
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
      setError(e.message);
    }
  }, [sessionId, onTitle]);

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
    if (!sessionId) {
      onTitle?.(isNew ? 'New session' : null);
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
    if (!text || busy || working) return;
    setBusy(true);
    setError(null);
    try {
      await api.sendSessionMessage(sessionId, text);
      setInput('');
      setSent(text);
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
  }, [sessionId, input, busy, working, openStream, load, refreshList]);

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
      projects=${projects}
      projectsLoaded=${projectsLoaded}
      projectId=${projectId}
      onProject=${(v) => {
        setProjectId(v);
        setSessions(null);
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
  const statusPill = permission
    ? { cls: 'needs', label: 'Waiting on you' }
    : working
      ? { cls: 'working', label: 'Working' }
      : archived
        ? { cls: 'closed', label: 'Archived' }
        : stopped
          ? { cls: 'closed', label: 'Stopped' }
          : { cls: 'idle', label: 'Idle' };
  const placeholder = permission
    ? 'The session is paused on the approval above.'
    : working
      ? 'Working… send the next instruction when it replies.'
      : closed
        ? 'Resume this session to send an instruction.'
        : turns.length
          ? 'Tell the session what to do next…'
          : 'Tell the session what to do…';

  return html`
    <div class="ss-shell ss-shell-open ${railOpen ? 'rail-open' : ''}">
      ${list}
      <main class="ss-conv" aria-label=${session?.name || 'Session'}>
        <header class="ss-conv-head">
          ${renaming ? null : html`<a class="btn secondary ss-icon-btn ss-back-btn" href="#/sessions" aria-label="Back to sessions">${icon(ICONS.back)}</a>`}
          <div class="ss-conv-title">
            ${renaming
              ? html`
                  <div class="ss-rename">
                    <input
                      class="input"
                      value=${nameDraft}
                      aria-label="Session name"
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
                    <h2>${session?.name || 'Session'}</h2>
                    ${session ? html`<span class="ss-pill ss-pill-${statusPill.cls}"><span></span>${statusPill.label}</span>` : null}
                  </div>
                  <div class="ss-meta">
                    ${project ? html`<span>${project.name}</span><span aria-hidden="true">·</span>` : null}
                    <span class="ss-meta-branch">${icon(ICONS.branch)} own checkout</span>
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
          ${renaming
            ? null
            : html`<button class="btn secondary ss-icon-btn ss-rail-btn" type="button" aria-label="Session details" aria-expanded=${railOpen} onClick=${() => setRailOpen((v) => !v)}>
                ${icon(ICONS.panel)}
              </button>`}
          ${renaming ? null : html`<${MoreMenu}
            items=${[
              { label: 'Rename', disabled: !session, onSelect: () => {
                  setNameDraft(session?.name || '');
                  setRenaming(true);
                } },
              detail?.nudge ? { label: 'Draft as task', onSelect: draftTask } : null,
              !working && !closed ? { label: 'Stop session', onSelect: () => guarded(() => api.stopSession(sessionId), 'Stop') } : null,
              !archived ? { label: 'Archive', danger: true, onSelect: () => guarded(() => api.archiveSession(sessionId), 'Archive') } : null,
            ]}
          />`}
        </header>

        <div class="ss-transcript" ref=${transcriptRef}>
          ${detail === null
            ? html`<div class="ss-list-empty"><${Spinner} /></div>`
            : !settledTurns.length && !working
              ? html`<div class="ss-empty">
                  <b>Nothing yet</b>
                  <span class="muted">Type an instruction below and the agent starts working in the checkout. You approve every write and command.</span>
                </div>`
              : null}
          ${settledTurns.map((t) => html`<${Turn} key=${t.run_id} t=${t} root=${project?.path} />`)}
          ${working || (permission && pendingRun)
            ? html`
                <${Turn} key="live" t=${{ instruction: liveInstruction }} live>
                  <${LiveSteps} store=${events} waiting=${!!permission} root=${project?.path} />
                </${Turn}>
              `
            : null}
          ${error ? html`<div class="ss-failure">${error}</div>` : null}
        </div>

        <div class="ss-dock">
          ${permission ? html`<div class="ss-scrim" aria-hidden="true"></div><${Approval} permission=${permission} now=${now} busy=${busy} onAnswer=${answer} root=${project?.path} />` : null}
          <div class="ss-composer ${permission || working || closed ? 'locked' : ''}">
            <textarea
              ref=${composerRef}
              rows="1"
              aria-label="Instruction"
              placeholder=${placeholder}
              value=${input}
              disabled=${busy || working || closed || !!permission}
              onInput=${(e) => setInput(e.target.value)}
              onKeyDown=${(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            ></textarea>
            <button class="ss-send" type="button" aria-label="Send" onClick=${send} disabled=${!input.trim() || busy || working || closed || !!permission}>
              ${icon(ICONS.send)}
            </button>
          </div>
          <div class="ss-hint">Enter to send · Shift+Enter for a new line</div>
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
