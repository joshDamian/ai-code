// The task list. Every task in the workspace, as a table you can sort and scan.
//
// The rows used to be cards: a title, a project id, a full locale timestamp and a
// badge, each one as tall as its own line breaks made it. A card earns its height
// when the content differs from row to row; here every row has the same five
// fields, and a table puts them in columns where the eye can compare one row to
// the next instead of reading each one as a paragraph.
import { html, useState, useEffect, useMemo, useRef } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { EmptyState } from '../components/empty-state.mjs';
import { SkeletonTable } from '../components/skeleton.mjs';
import { StatusBadge } from '../components/status-badge.mjs';
import { DataTable } from '../components/data-table.mjs';
import { Tabs } from '../components/tabs.mjs';
import { Time } from '../components/time.mjs';
import { TextArea, Select } from '../components/form.mjs';
import { TaskPicker } from '../components/task-picker.mjs';
import { shortId } from '../lib.mjs';

const TABS = [
  { id: 'all', label: 'All', states: null },
  { id: 'active', label: 'Active', states: ['PLANNING', 'AWAITING_APPROVAL', 'APPROVED', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'REPAIRING', 'AWAITING_DECISION'] },
  // A task waiting on a person, whichever question it is waiting on. Two states
  // rather than one, because the answers differ: a plan needs approving, a review
  // needs a choice.
  { id: 'awaiting', label: 'Awaiting', states: ['AWAITING_APPROVAL', 'AWAITING_DECISION'] },
  { id: 'complete', label: 'Complete', states: ['COMPLETE'] },
  { id: 'failed', label: 'Failed', states: ['FAILED'] },
  { id: 'cancelled', label: 'Cancelled', states: ['CANCELLED'] },
];

// `openForm` is a counter, not a flag. Every request to open the form increments
// it, so two requests in a row are two different values and both are honoured -
// which a boolean cannot do, and a boolean is what "open the form" usually is.
//
// The view consumes the request by calling `onFormOpened`, which resets the
// counter. Without that, the request would still be standing the next time this
// view mounted and the form would reopen for no reason.
export function Tasks({ navigate, openForm = 0, onFormOpened }) {
  const [tasks, setTasks] = useState(null);
  const [projects, setProjects] = useState([]);
  const [tab, setTab] = useState('all');
  const [showCancelled, setShowCancelled] = useState(false); // false = hide, the default
  const [query, setQuery] = useState('');
  // Empty means every project, which is the default the toolbar starts on.
  const [projectFilter, setProjectFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  // Optional. Chosen from the project's own tasks rather than pasted as an id:
  // the task a new one builds on is one you were reading a moment ago, and its
  // id is not what you remember about it.
  const [parentId, setParentId] = useState('');
  const [saving, setSaving] = useState(false);
  const descriptionRef = useRef(null);

  useEffect(() => {
    if (showForm) {
      descriptionRef.current?.focus();
    }
  }, [showForm]);

  // The header's New task button and the `n` shortcut both land here, wherever the
  // user was - including on this view, where the route does not change and only the
  // counter does.
  useEffect(() => {
    if (!openForm) return;
    setShowForm(true);
    if (onFormOpened) onFormOpened();
  }, [openForm, onFormOpened]);

  async function load() {
    try {
      const [t, p] = await Promise.all([api.tasks(), api.projects()]);
      setTasks(t);
      setProjects(p);
      setProjectId((cur) => cur || (p[0] && p[0].id) || '');
    } catch (e) {
      showToast(e.message, 'error');
      setTasks([]);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // The id a task row carries, resolved to the name a person recognises. A task
  // whose project row is gone keeps its id, so the row still names something.
  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  // Same for the parent column: the id is the link, the title is the label.
  const taskById = useMemo(() => new Map((tasks || []).map((t) => [t.id, t])), [tasks]);

  // The project filter narrows every tab, and the tab then chooses the states
  // inside it. It sits before the tab split so the counts and the rows below them
  // are counted from the same list - a count that ignored the project would count
  // tasks the tab is not showing.
  const scoped = useMemo(() => (tasks && projectFilter ? tasks.filter((t) => t.project_id === projectFilter) : tasks), [tasks, projectFilter]);

  // The All tab's count has to be the count of what the tab lists, so the toggle
  // moves the number with the rows. Only the All tab has `states: null`, so every
  // other tab's count is untouched by it.
  const counts = useMemo(() => {
    if (!scoped) return {};
    const c = {};
    for (const t of TABS) {
      c[t.id] = t.states
        ? scoped.filter((x) => t.states.includes(x.state)).length
        : scoped.filter((x) => showCancelled || x.state !== 'CANCELLED').length;
    }
    return c;
  }, [scoped, showCancelled]);

  // `states: null` is the All tab, the only list that mixes CANCELLED in - which is
  // why the toggle applies to it alone. Hidden by default: cancelled tasks already
  // have a tab of their own, so in the default view they are clutter.
  const filtered = useMemo(() => {
    if (!scoped) return [];
    const t = TABS.find((x) => x.id === tab);
    const base = t.states ? scoped.filter((x) => t.states.includes(x.state)) : showCancelled ? scoped : scoped.filter((x) => x.state !== 'CANCELLED');
    const q = query.trim().toLowerCase();
    // The tab is the filter of record; the query narrows what the tab already shows.
    if (!q) return base;
    return base.filter((x) => String(x.title || '').toLowerCase().includes(q));
  }, [scoped, tab, showCancelled, query]);

  // The candidates the picker may offer. Same project only: the server refuses a
  // cross-project parent, so listing one would be offering a dead end.
  const parentCandidates = useMemo(() => (tasks || []).filter((t) => t.project_id === projectId), [tasks, projectId]);

  async function submit(e) {
    e.preventDefault();
    if (!projectId || !title.trim()) {
      showToast('Project and title are required.', 'error');
      return;
    }
    setSaving(true);
    try {
      const t = await api.createTask(projectId, title.trim(), parentId.trim() || undefined);
      showToast('Task created.', 'success');
      setTitle('');
      setParentId('');
      setShowForm(false);
      await load();
      navigate(`#/tasks/${t.id}`);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!tasks) return html`<${SkeletonTable} rows=${6} cols=${5} />`;

  const columns = [
    {
      key: 'title',
      label: 'Task',
      sortable: true,
      // The title is the link, so a row is navigable by the keyboard, by
      // middle-click and by the browser's own context menu. The row-click handler
      // stays for the larger target a mouse expects; the link is what makes the
      // row reachable without one.
      render: (t) => html`<a href=${`#/tasks/${t.id}`} onClick=${(e) => e.stopPropagation()}>${t.title}</a>`,
    },
    {
      key: 'project_id',
      label: 'Project',
      sortable: true,
      sortValue: (t) => projectNames.get(t.project_id) || '',
      render: (t) => html`<span class="muted">${projectNames.get(t.project_id) || shortId(t.project_id)}</span>`,
    },
    { key: 'state', label: 'State', sortable: true, render: (t) => html`<${StatusBadge} status=${t.state} />` },
    {
      key: 'parent_id',
      label: 'Parent',
      sortable: true,
      sortValue: (t) => (t.parent_id ? taskById.get(t.parent_id)?.title || t.parent_id : ''),
      render: (t) =>
        t.parent_id
          ? html`<a class="muted" href=${`#/tasks/${t.parent_id}`} onClick=${(e) => e.stopPropagation()}>${taskById.get(t.parent_id)?.title || shortId(t.parent_id)}</a>`
          : html`<span class="muted">—</span>`,
    },
    // The column a person actually sorts by: what moved last. `created_at` answers
    // a question nobody asks about a task they are looking for now.
    { key: 'updated_at', label: 'Updated', sortable: true, render: (t) => html`<${Time} at=${t.updated_at} />` },
  ];

  const isFiltered = Boolean(query.trim() || projectFilter || tab !== 'all');

  return html`
    <div class="view-tasks">
      <div class="tasks-head">
        <div class="tasks-actions">
          <input
            class="input search-input"
            type="search"
            data-search
            placeholder="Search tasks…"
            value=${query}
            onInput=${(e) => setQuery(e.target.value)}
          />
          ${
            // A single project leaves the control nothing to filter, so it is not
            // rendered at all rather than shown with one option.
            projects.length > 1
              ? html`
                  <${Select}
                    label="Project"
                    value=${projectFilter}
                    onChange=${setProjectFilter}
                    options=${[{ value: '', label: 'All projects' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
                    inline
                  />
                `
              : null
          }
          <button class="btn primary tasks-new" onClick=${() => setShowForm(true)} aria-expanded=${showForm}>New task</button>
        </div>
        <div class="tasks-tabs">
          <${Tabs} tabs=${TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] || 0 }))} value=${tab} onChange=${setTab} label="Task state" />
          ${
            // Only the All tab mixes cancelled tasks in, so this is the only tab the
            // toggle has anything to do on.
            tab === 'all'
              ? html`<label class="switch"><input type="checkbox" checked=${showCancelled} onChange=${(e) => setShowCancelled(e.target.checked)} /> Show cancelled</label>`
              : null
          }
        </div>
      </div>

      ${
        showForm
          ? html`
              <div class="kbd-overlay confirm-overlay" onClick=${(e) => e.target === e.currentTarget && setShowForm(false)}>
                <form
                  class="card dialog dialog-wide"
                  onSubmit=${submit}
                  onKeyDown=${(e) => {
                    if (e.defaultPrevented) return;
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setShowForm(false);
                    }
                  }}
                >
                  <div class="inline-form-head">
                    <h2 class="dialog-title">New task</h2>
                    <button type="button" class="icon-btn" aria-label="Close" onClick=${() => setShowForm(false)}>✕</button>
                  </div>
                  <div class="inline-form-grid">
                    <${Select}
                      label="Project"
                      value=${projectId}
                      onChange=${setProjectId}
                      options=${projects.map((p) => ({ value: p.id, label: p.name }))}
                      loading=${saving}
                    />
                    <${TaskPicker}
                      label="Parent task (optional)"
                      tasks=${parentCandidates}
                      value=${parentId}
                      onInput=${setParentId}
                      placeholder="Search tasks by title — the task this one builds on"
                      loading=${saving}
                    />
                  </div>
                  <${TextArea}
                    inputRef=${descriptionRef}
                    label="Description"
                    value=${title}
                    onInput=${setTitle}
                    placeholder="Describe what the task should accomplish"
                    rows=${4}
                    loading=${saving}
                    autofocus
                    onKeyDown=${(e) => {
                      // Enter inserts a newline in a textarea, so submission needs a modifier.
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        submit(e);
                      }
                    }}
                  />
                  <div class="inline-form-foot">
                    <span class="muted">⌘↵ to create</span>
                    <button class="btn secondary" type="button" onClick=${() => setShowForm(false)}>Cancel</button>
                    <button class="btn primary" type="submit" disabled=${saving || !projects.length}>${saving ? 'Creating…' : 'Create task'}</button>
                  </div>
                  ${!projects.length ? html`<div class="muted">Add a project first.</div>` : null}
                </form>
              </div>
            `
          : null
      }

      ${
        filtered.length
          ? html`<div class="card">
              <${DataTable} columns=${columns} rows=${filtered} onRowClick=${(t) => navigate(`#/tasks/${t.id}`)} />
            </div>`
          : isFiltered
            ? html`<${EmptyState}
                title="No tasks match"
                message="No task matches this tab and filter."
                hint="Try another tab, or clear the search."
                actionLabel="Show all tasks"
                onAction=${() => {
                  setTab('all');
                  setQuery('');
                  setProjectFilter('');
                }}
              />`
            : html`<${EmptyState}
                title="No tasks yet"
                message="This workspace has no tasks."
                hint="A task is one unit of work: a description, a plan you approve, an implementation, and a review."
                actionLabel="New task"
                onAction=${() => setShowForm(true)}
              />`
      }
    </div>
  `;
}
