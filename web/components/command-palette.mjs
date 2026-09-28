// Command palette: one keyboard-first list over navigation targets, the actions
// that live in a view, and everything a person might be looking for by name -
// tasks, projects, conversations and sessions. With no query it offers the tasks
// worked on most recently; with one it searches all of them.
//
// The overlay chrome is the shortcut legend's (components/kbd.mjs) so the two
// dialogs stack, dim and dismiss identically. app.mjs owns Escape from a
// window-level handler, so this component never sees, or consumes, that key.
import { html, Fragment, useState, useEffect, useRef, useMemo, fuzzy } from '../lib.mjs';
import { api } from '../api.mjs';

// Mirrors the nav in components/layout.mjs. Hint is the hash target without its
// leading `#`, which is also what makes the row readable at a glance.
const NAV = [
  { label: 'Overview', href: '#/overview' },
  { label: 'Projects', href: '#/projects' },
  { label: 'Tasks', href: '#/tasks' },
  { label: 'Chat', href: '#/chat' },
  { label: 'Sessions', href: '#/sessions' },
  { label: 'Providers', href: '#/providers' },
  { label: 'Routing', href: '#/routing' },
  { label: 'Runs', href: '#/runs' },
  { label: 'Usage', href: '#/usage' },
  { label: 'Settings', href: '#/settings' },
];

export function CommandPalette({ open, onClose, navigate, onNewTask }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // What can be searched by name. Re-read on every open, but the last reading stays
  // on screen while the new one is in flight, so the palette never opens empty and
  // never flashes - and a task created a minute ago is findable.
  const [index, setIndex] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Each list on its own: a failure in one leaves that group out rather than the
    // whole palette empty, and an error toast over a palette the user just opened
    // is worse than a group that is missing.
    const safe = (p) => p.catch(() => []);
    Promise.all([safe(api.tasks()), safe(api.projects()), safe(api.chatSessions()), safe(api.sessions())]).then(([tasks, projects, chats, sessions]) => {
      if (!cancelled) setIndex({ tasks: tasks || [], projects: projects || [], chats: chats || [], sessions: sessions || [] });
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Flat list plus the headings it was bucketed from, so `active` stays a single
  // index. Commands are built in group order and Map preserves insertion order,
  // which is what holds Go to / Actions / Recent tasks in their fixed slots.
  // Items are built inside the memo so the per-row index is never shared.
  const { groups, flat } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const { tasks = [], projects = [], chats = [], sessions = [] } = index || {};
    const projectName = new Map(projects.map((p) => [p.id, p.name]));
    const stateLabel = (s) => String(s || '').toLowerCase().replace(/_/g, ' ');
    const commands = [
      ...NAV.map((n) => ({ group: 'Go to', kind: 'nav', key: n.href, label: n.label, hint: n.href.slice(1), href: n.href })),
      { group: 'Actions', kind: 'new-task', key: 'new-task', label: 'New task' },
      { group: 'Actions', kind: 'nav', key: 'new-session', label: 'New session', href: '#/sessions/new' },
      { group: 'Actions', kind: 'nav', key: 'new-chat', label: 'New chat', href: '#/chat/new' },
      // listTasks orders by updated_at DESC, so with no query the head is the recent
      // five; with one, every task is a candidate.
      ...(q ? tasks : tasks.slice(0, 5)).map((t) => ({
        group: q ? 'Tasks' : 'Recent tasks',
        kind: 'nav',
        key: `#/tasks/${t.id}`,
        label: t.title,
        hint: stateLabel(t.state),
        href: `#/tasks/${t.id}`,
      })),
      ...(q
        ? [
            ...projects.map((p) => ({ group: 'Projects', kind: 'nav', key: `#/project/${p.id}`, label: p.name, hint: 'project', href: `#/project/${p.id}` })),
            ...chats.map((c) => ({ group: 'Conversations', kind: 'nav', key: `#/chat/${c.id}`, label: c.title, hint: projectName.get(c.project_id) || 'chat', href: `#/chat/${c.id}` })),
            ...sessions.map((x) => ({ group: 'Sessions', kind: 'nav', key: `#/sessions/${x.id}`, label: x.name, hint: stateLabel(x.status), href: `#/sessions/${x.id}` })),
          ]
        : []),
    ];
    // How many rows a searched group may hold. A query that matches forty tasks is a
    // query to refine, not forty rows to scroll past on the way to Projects.
    const CAP = { Tasks: 8, Projects: 5, Conversations: 5, Sessions: 5 };
    const buckets = new Map();
    for (const c of commands) {
      const m = q ? fuzzy(c.label, q) : { score: 0, hits: [] };
      if (!m) continue;
      c.score = m.score;
      c.hits = m.hits;
      if (!buckets.has(c.group)) buckets.set(c.group, []);
      buckets.get(c.group).push(c);
    }

    const flat = [];
    const groups = [];
    for (const [label, items] of buckets) {
      // Best match first. sort is stable, so equal scores keep the order the
      // commands were declared in, and the groups themselves never reorder.
      if (q) items.sort((a, b) => b.score - a.score);
      if (CAP[label]) items.splice(CAP[label]);
      groups.push({ label, items });
      for (const item of items) {
        item.i = flat.length;
        flat.push(item);
      }
    }
    return { groups, flat };
  }, [query, index]);

  // The label as nodes, with the characters the query matched tinted. A fuzzy
  // hit is not self-evident - "ovw" landing on Overview looks arbitrary
  // otherwise - so the row shows its work.
  function labelOf(item) {
    if (!item.hits || !item.hits.length) return item.label;
    const parts = [];
    let at = 0;
    for (const i of item.hits) {
      if (i > at) parts.push(item.label.slice(at, i));
      parts.push(html`<mark class="cmd-hit" key=${i}>${item.label[i]}</mark>`);
      at = i + 1;
    }
    if (at < item.label.length) parts.push(item.label.slice(at));
    return parts;
  }

  // Close before acting, not after: New task hands focus to a form in the tasks
  // view, and a still-mounted overlay would take it straight back.
  function choose(item) {
    onClose();
    if (item.kind === 'new-task') onNewTask();
    else navigate(item.href);
  }

  function onKeyDown(e) {
    const n = flat.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (n ? (i + 1) % n : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (n ? (i - 1 + n) % n : 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(n ? n - 1 : 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = flat[active];
      if (item) choose(item);
    }
    // Escape is absent on purpose: app.mjs closes the palette from its window-level
    // handler. Consuming it here would mean stopPropagation, which is the worse deal.
  }

  // Below the hooks, not above them: an early return before them would change the
  // hook count between renders, and Preact reads hooks by position, not by name.
  if (!open) return null;

  return html`
    <div class="kbd-overlay" onClick=${onClose}>
      <div
        class="card cmd"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick=${(e) => e.stopPropagation()}
      >
        <!-- Preact does not apply the autoFocus attribute to a dynamically mounted input, so focus is applied explicitly when the dialog opens. -->
        <input
          class="cmd-input"
          type="text"
          placeholder="Type a command or search…"
          value=${query}
          ref=${inputRef}
          onInput=${(e) => {
            setQuery(e.target.value);
            // The old index pointed into a list that no longer exists.
            setActive(0);
          }}
          onKeyDown=${onKeyDown}
        />
        <ul class="cmd-list">
          ${groups.length === 0
            ? html`<li class="cmd-empty muted">No matching commands.</li>`
            : groups.map(
                (g) => html`
                  <${Fragment} key=${g.label}>
                    <li class="cmd-group" key=${g.label}>${g.label}</li>
                    ${g.items.map(
                      (item) => html`
                        <li
                          class="cmd-item ${item.i === active ? 'active' : ''}"
                          key=${item.key}
                          onClick=${() => choose(item)}
                          onMouseEnter=${() => setActive(item.i)}
                        >
                          ${html`<span class="cmd-item-label">${labelOf(item)}</span>`}
                          ${item.hint ? html`<span class="cmd-item-hint">${item.hint}</span>` : null}
                        </li>
                      `
                    )}
                  <//>
                `
              )}
        </ul>
        <div class="cmd-foot">
          <span>↑↓ to navigate</span>
          <span>↵ to select</span>
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  `;
}
