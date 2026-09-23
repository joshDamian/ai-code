// Command palette: one keyboard-first list over navigation targets, the actions
// that live in a view, and the tasks worked on most recently.
//
// The overlay chrome is the shortcut legend's (components/kbd.mjs) so the two
// dialogs stack, dim and dismiss identically. app.mjs owns Escape from a
// window-level handler, so this component never sees, or consumes, that key.
import { html, Fragment, useState, useEffect, useRef, useMemo } from '../lib.mjs';
import { api } from '../api.mjs';

// Mirrors the nav in components/layout.mjs. Hint is the hash target without its
// leading `#`, which is also what makes the row readable at a glance.
const NAV = [
  { label: 'Overview', href: '#/overview' },
  { label: 'Projects', href: '#/projects' },
  { label: 'Tasks', href: '#/tasks' },
  { label: 'Providers', href: '#/providers' },
  { label: 'Routing', href: '#/routing' },
  { label: 'Runs', href: '#/runs' },
  { label: 'Usage', href: '#/usage' },
  { label: 'Settings', href: '#/settings' },
];

export function CommandPalette({ open, onClose, navigate, onNewTask }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState(null);

  // The recent-task list is fetched on the first open and kept: it is a
  // convenience group, and a list one task stale reads better than a dialog that
  // re-fetches, and flashes, every time it is summoned.
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
  }, [open]);

  useEffect(() => {
    if (!open || loadedRef.current) return;
    let cancelled = false;
    api.tasks()
      .then((tasks) => {
        // `cancelled` covers close-while-in-flight: a response that lands after the
        // palette shut must not mark the cache loaded and squat on stale data.
        if (cancelled) return;
        loadedRef.current = true;
        // listTasks orders by updated_at DESC, so the head is the recent five.
        setRecent((tasks || []).slice(0, 5));
      })
      // Swallowed deliberately: no Recent group is a fine outcome, an error toast
      // over a palette the user just opened is not.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Flat list plus the headings it was bucketed from, so `active` stays a single
  // index. Commands are built in group order and Map preserves insertion order,
  // which is what holds Go to / Actions / Recent tasks in their fixed slots.
  // Items are built inside the memo so the per-row index is never shared.
  const { groups, flat } = useMemo(() => {
    const commands = [
      ...NAV.map((n) => ({ group: 'Go to', kind: 'nav', key: n.href, label: n.label, hint: n.href.slice(1), href: n.href })),
      { group: 'Actions', kind: 'new-task', key: 'new-task', label: 'New task' },
      ...(recent || []).map((t) => ({
        group: 'Recent tasks',
        kind: 'nav',
        key: `#/tasks/${t.id}`,
        label: t.title,
        hint: t.state,
        href: `#/tasks/${t.id}`,
      })),
    ];

    const q = query.trim().toLowerCase();
    const buckets = new Map();
    for (const c of commands) {
      if (q && !c.label.toLowerCase().includes(q)) continue;
      if (!buckets.has(c.group)) buckets.set(c.group, []);
      buckets.get(c.group).push(c);
    }

    const flat = [];
    const groups = [];
    for (const [label, items] of buckets) {
      groups.push({ label, items });
      for (const item of items) {
        item.i = flat.length;
        flat.push(item);
      }
    }
    return { groups, flat };
  }, [query, recent]);

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
        <input
          class="cmd-input"
          type="text"
          placeholder="Type a command or search…"
          value=${query}
          autoFocus=${true}
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
                          ${html`<span class="cmd-item-label">${item.label}</span>`}
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
