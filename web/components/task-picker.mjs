// Searchable parent-task picker: a combobox over the tasks a parent may be.
//
// The id used to be the interface, and an id is not something a person has in
// hand - the task a new one builds on is usually one they were just reading, or
// one whose title they remember and whose id they would have to go and look up.
// So the field takes a title and shows the title back. An id pasted in is still
// an answer, matched by prefix, because that is what a person arriving from
// another screen has.
//
// The list reuses the command palette's classes, and its `fuzzy`, so the two
// pickers read as one control in two places rather than as two lookalikes that
// drift apart.
import { html, useState, useMemo, useRef, fuzzy } from '../lib.mjs';

// The id as a glanceable handle rather than as the subject of the row. Eight
// characters is what a task's own header prints.
const shortId = (id) => String(id).slice(0, 8);

export function TaskPicker({ label, tasks, value, onInput, placeholder, loading, excludeId }) {
  // `open` is a focus state, not a value: the input holds the query while the
  // list is showing and the selection while it is not, so the two can never be
  // read as one another.
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  const selected = (tasks || []).find((t) => t.id === value) || null;

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = [];
    for (const t of tasks || []) {
      // A task is not its own parent; the server refuses it too, so offering it
      // would only be a dead end.
      if (t.id === excludeId) continue;
      if (!q) {
        rows.push({ task: t, score: 0, hits: null });
        continue;
      }
      const m = fuzzy(t.title || '', q);
      if (m) {
        rows.push({ task: t, score: m.score, hits: m.hits });
      } else if (t.id.toLowerCase().startsWith(q)) {
        // Ranked below every title hit: a title is what the field asks for, and
        // an id that happens to start with those letters is the accident.
        rows.push({ task: t, score: -1, hits: null });
      }
    }
    // Newest first, which is the order the caller's list arrived in (listTasks
    // orders by updated_at DESC). sort is stable, so equal scores keep it.
    if (q) rows.sort((a, b) => b.score - a.score);
    // The clear row rides at the top of the same flat list, so the arrow keys
    // and the highlight need no second index to keep in step.
    return [{ none: true }, ...rows];
  }, [tasks, query, excludeId]);

  // The filter can shrink the list under the highlight - a task list that
  // arrives late, or a keystroke - so the index is clamped where it is read
  // rather than trusted.
  const at = Math.min(active, items.length - 1);
  const shown = open ? query : selected ? `${selected.title} · ${shortId(selected.id)}` : '';

  function choose(item) {
    onInput(item.none ? '' : item.task.id);
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  }

  function onKeyDown(e) {
    const n = items.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (n ? (i + 1) % n : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (n ? (i - 1 + n) % n : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[at];
      if (item) choose(item);
    } else if (e.key === 'Escape') {
      // Marked handled so the app-level handler leaves it alone. Its own answer to
      // Escape is to clear the focused field, which here would throw away a
      // selection the user never asked to throw away.
      e.preventDefault();
      setQuery('');
      setOpen(false);
      inputRef.current?.blur();
    }
  }

  // The title as nodes, with the characters the query matched tinted, the way the
  // palette draws its rows. A fuzzy hit is not self-evident without it.
  function labelOf(item) {
    const title = item.task.title || item.task.id;
    if (!item.hits || !item.hits.length) return title;
    const parts = [];
    let from = 0;
    for (const i of item.hits) {
      if (i > from) parts.push(title.slice(from, i));
      parts.push(html`<mark class="cmd-hit" key=${i}>${title[i]}</mark>`);
      from = i + 1;
    }
    if (from < title.length) parts.push(title.slice(from));
    return parts;
  }

  return html`
    <div class="field task-picker">
      ${label ? html`<span class="field-label">${label}</span>` : null}
      <div class="task-picker-wrap">
        <input
          type="text"
          class="input"
          role="combobox"
          aria-expanded=${open ? 'true' : 'false'}
          aria-autocomplete="list"
          value=${shown}
          placeholder=${placeholder || ''}
          disabled=${loading}
          ref=${inputRef}
          onFocus=${() => {
            setOpen(true);
            setQuery('');
            setActive(0);
          }}
          onBlur=${() => {
            setOpen(false);
            setQuery('');
          }}
          onInput=${(e) => {
            // Typing narrows the list; it never changes the selection. The value
            // only moves when a row is chosen, so a half-typed word cannot leave
            // the field pointing at the task it happens to spell.
            setOpen(true);
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown=${onKeyDown}
        />
        ${value
          ? html`<button
              type="button"
              class="task-picker-clear"
              aria-label="Clear parent task"
              disabled=${loading}
              onMouseDown=${(e) => {
                e.preventDefault();
                choose({ none: true });
              }}
            >✕</button>`
          : null}
      </div>
      ${open
        ? html`
            <ul class="cmd-list" role="listbox" aria-label="Parent task">
              ${items.map(
                (item, i) => html`
                  <li
                    class="cmd-item ${i === at ? 'active' : ''}"
                    key=${item.none ? 'none' : item.task.id}
                    role="option"
                    aria-selected=${i === at ? 'true' : 'false'}
                    onMouseDown=${(e) => {
                      // preventDefault keeps focus in the input, so blur cannot
                      // fire between the press and the release and swallow the click.
                      e.preventDefault();
                      choose(item);
                    }}
                    onMouseEnter=${() => setActive(i)}
                  >
                    ${item.none
                      ? html`<span class="cmd-item-label">No parent</span>`
                      : html`
                          <span class="cmd-item-label">${labelOf(item)}</span>
                          <span class="cmd-item-hint">${item.task.state}</span>
                        `}
                  </li>
                `
              )}
              ${items.length === 1 ? html`<li class="cmd-empty muted">No matching tasks.</li>` : null}
            </ul>
          `
        : null}
    </div>
  `;
}
