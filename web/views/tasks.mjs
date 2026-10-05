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
import { TextArea, Select, Toggle } from '../components/form.mjs';
import { TaskPicker } from '../components/task-picker.mjs';
import { shortId } from '../lib.mjs';

// How a task runs. A pipeline is planned, approved, implemented, tested and
// reviewed by separate agents; a session is one agent doing all of it in its own
// worktree, in a conversation you can join. Compare runs the same task several ways
// side by side and lets you pick the result.
const ENGINE_OPTIONS = [
  { value: 'pipeline', label: 'Pipeline' },
  { value: 'session', label: 'Session' },
  { value: 'compare', label: 'Compare' },
];
const ENGINE_HINTS = {
  pipeline: 'Planned, approved by you, implemented, tested and reviewed by separate agents.',
  session: 'One agent works on it end to end in its own worktree. You can join the conversation at any point.',
  compare: 'Runs the task several ways from the same commit. You compare the results and land the one you prefer.',
};
const MAX_VARIANTS = 4;

const TABS = [
  { id: 'all', label: 'All', states: null },
  { id: 'active', label: 'Active', states: ['PLANNING', 'AWAITING_APPROVAL', 'APPROVED', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'REPAIRING', 'AWAITING_DECISION', 'WORKING', 'WAITING'] },
  // A task waiting on a person, whichever question it is waiting on. Two states
  // rather than one, because the answers differ: a plan needs approving, a review
  // needs a choice.
  { id: 'awaiting', label: 'Awaiting', states: ['AWAITING_APPROVAL', 'AWAITING_DECISION', 'WAITING'] },
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
  const [engine, setEngine] = useState('pipeline');
  const [modelId, setModelId] = useState('');
  const [planFirst, setPlanFirst] = useState(false);
  // A comparison's attempts, each an engine on a model ('' is Automatic).
  const [variants, setVariants] = useState([
    { engine: 'pipeline', modelId: '' },
    { engine: 'session', modelId: '' },
  ]);
  const [models, setModels] = useState([]);
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
      const [t, p, prov] = await Promise.all([api.tasks(), api.projects(), api.providers().catch(() => null)]);
      setTasks(t);
      setProjects(p);
      // The models a task can be pinned to: enabled, on an enabled provider, and able
      // to write code - the one capability every engine needs.
      if (prov) {
        const on = new Set((prov.providers || []).filter((x) => x.enabled).map((x) => x.id));
        setModels((prov.models || []).filter((m) => m.enabled !== false && on.has(m.provider_id) && (m.capabilities || []).includes('coding')));
      }
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
      const opts =
        engine === 'compare'
          ? { variants: variants.map((v) => ({ engine: v.engine, modelId: v.modelId || null })), planFirst }
          : { engine, modelId: modelId || null, planFirst: engine === 'session' && planFirst };
      const made = await api.createTask(projectId, title.trim(), parentId.trim() || undefined, opts);
      showToast(engine === 'compare' ? `Started ${variants.length} attempts.` : 'Task created.', 'success');
      setTitle('');
      setParentId('');
      setShowForm(false);
      await load();
      navigate(made.group ? `#/compare/${made.group}` : `#/tasks/${made.id}`);
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
      render: (t) => html`<a href=${`#/tasks/${t.id}`} onClick=${(e) => e.stopPropagation()}>${t.title}</a>${t.attempt_group
        ? html` <a class="attempt-chip ${t.pick === 'won' ? 'won' : ''}" href=${`#/compare/${t.attempt_group}`} title="One attempt of a comparison. Open the comparison." onClick=${(e) => e.stopPropagation()}>${t.attempt_label}</a>`
        : t.engine === 'session'
          ? html` <span class="engine-chip" title="Runs as one session">session</span>`
          : null}`,
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
  // Loaded, and nothing to put a task in. Tasks and projects arrive in one read, so a
  // loaded task list is also a loaded project list.
  const noProjects = tasks !== null && !projects.length;

  return html`
    <div class="view-tasks">
      <div class="tasks-head">
        <div class="tasks-actions">
          <input
            class="input search-input"
            type="search"
            data-search
            aria-label="Search tasks"
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
                    ariaLabel="Project"
                    value=${projectFilter}
                    onChange=${setProjectFilter}
                    options=${[{ value: '', label: 'All projects' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
                    inline
                  />
                `
              : null
          }
        </div>
        <div class="tasks-tabs">
          <${Tabs} tabs=${TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] || 0 }))} value=${tab} onChange=${setTab} label="Task state" />
          ${
            // Only the All tab mixes cancelled tasks in, so this is the only tab the
            // toggle has anything to do on.
            tab === 'all'
              ? html`<${Toggle} checked=${showCancelled} onChange=${setShowCancelled} label="Show cancelled" />`
              : null
          }
        </div>
      </div>

      ${
        showForm
          ? html`
              <div class="kbd-overlay confirm-overlay" onClick=${(e) => e.target === e.currentTarget && setShowForm(false)}>
                <form
                  class="card dialog dialog-wide inline-form"
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
                  ${noProjects
                    ? html`
                        <p class="muted dialog-body">A task is a change to a project’s code, so it needs a project to belong to. Add one, then come back to describe the task.</p>
                        <div class="inline-form-foot">
                          <button class="btn secondary" type="button" onClick=${() => setShowForm(false)}>Cancel</button>
                          <a class="btn primary" href="#/projects/new" onClick=${() => setShowForm(false)}>Add a project</a>
                        </div>
                      `
                    : html`
                  <${Select}
                    label="Project"
                    value=${projectId}
                    onChange=${setProjectId}
                    options=${projects.map((p) => ({ value: p.id, label: p.name }))}
                    loading=${saving}
                  />
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
                  <${TaskPicker}
                    label="Parent task (optional)"
                    tasks=${parentCandidates}
                    value=${parentId}
                    onInput=${setParentId}
                    placeholder="Search tasks by title — the task this one builds on"
                    loading=${saving}
                  />
                  <div class="field">
                    <span class="field-label" id="engine-label">Run as</span>
                    <div class="seg" role="group" aria-labelledby="engine-label">
                      ${ENGINE_OPTIONS.map((o) => html`<button type="button" key=${o.value} class="seg-btn ${engine === o.value ? 'active' : ''}" aria-pressed=${engine === o.value} onClick=${() => setEngine(o.value)}>${o.label}</button>`)}
                    </div>
                    <span class="muted field-hint">${ENGINE_HINTS[engine]}</span>
                  </div>
                  ${engine === 'compare'
                    ? html`<${VariantRows} variants=${variants} setVariants=${setVariants} models=${models} disabled=${saving} />`
                    : html`<${Select}
                        label="Model"
                        value=${modelId}
                        onChange=${setModelId}
                        options=${[{ value: '', label: 'Automatic (routing decides)' }, ...models.map((m) => ({ value: m.id, label: m.display_name || m.name }))]}
                        loading=${saving}
                      />`}
                  ${engine === 'session' || (engine === 'compare' && variants.some((v) => v.engine === 'session'))
                    ? html`<${Toggle} checked=${planFirst} onChange=${setPlanFirst} label="Plan first: wait for my OK before it edits anything" />`
                    : null}
                  <div class="inline-form-foot">
                    <span class="muted">⌘↵ to create</span>
                    <button class="btn secondary" type="button" onClick=${() => setShowForm(false)}>Cancel</button>
                    <button class="btn primary" type="submit" disabled=${saving || !projects.length}>${saving ? 'Creating…' : engine === 'compare' ? `Start ${variants.length} attempts` : 'Create task'}</button>
                  </div>
                    `}
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
            : noProjects
              ? html`<${EmptyState}
                  title="Add a project first"
                  message="Add a project before creating tasks."
                  hint="Add a repository by path, or describe an idea and AI Code will draft one."
                  actionLabel="Add a project"
                  onAction=${() => navigate('#/projects/new')}
                />`
              : html`<${EmptyState}
                  title="No tasks yet"
                  message="This workspace has no tasks."
                  hint="Each task is planned, approved by you, implemented and reviewed."
                  actionLabel="New task"
                  onAction=${() => setShowForm(true)}
                />`
      }
    </div>
  `;
}

// A comparison's attempts, one row each: the engine and the model. Two to four rows,
// because a comparison of one is a task and more than four is a wall nobody reads.
function VariantRows({ variants, setVariants, models, disabled }) {
  const set = (i, patch) => setVariants((vs) => vs.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const modelOptions = [{ value: '', label: 'Automatic' }, ...models.map((m) => ({ value: m.id, label: m.display_name || m.name }))];
  return html`
    <div class="field variant-rows">
      <span class="field-label">Attempts</span>
      ${variants.map(
        (v, i) => html`
          <div class="variant-row" key=${i}>
            <span class="attempt-chip">${'ABCD'[i]}</span>
            <${Select} inline size="sm" ariaLabel=${`Attempt ${'ABCD'[i]} engine`} value=${v.engine} onChange=${(x) => set(i, { engine: x })} options=${ENGINE_OPTIONS.filter((o) => o.value !== 'compare')} disabled=${disabled} />
            <${Select} inline size="sm" ariaLabel=${`Attempt ${'ABCD'[i]} model`} value=${v.modelId} onChange=${(x) => set(i, { modelId: x })} options=${modelOptions} disabled=${disabled} />
            ${variants.length > 2
              ? html`<button type="button" class="icon-btn" aria-label=${`Remove attempt ${'ABCD'[i]}`} disabled=${disabled} onClick=${() => setVariants((vs) => vs.filter((_, j) => j !== i))}>✕</button>`
              : null}
          </div>
        `
      )}
      ${variants.length < MAX_VARIANTS
        ? html`<button type="button" class="link-btn variant-add" disabled=${disabled} onClick=${() => setVariants((vs) => [...vs, { engine: 'session', modelId: '' }])}>+ Add an attempt</button>`
        : null}
    </div>
  `;
}
