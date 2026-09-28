// Every model call the pipeline has made, as a table you can read down.
//
// The columns were the raw record: `provider_id`, `model_id`, `duration_ms`,
// `fallback_from`, and a cost printed to six decimals. None of those are wrong and
// none of them are what a person is looking for. The questions this view answers
// are "what has been spending money", "what is slow", and "what broke" - so the
// columns are the task the run belongs to, the provider by name, how long ago it
// started and how long it took.
import { html, useState, useEffect, useMemo } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { EmptyState } from '../components/empty-state.mjs';
import { SkeletonTable } from '../components/skeleton.mjs';
import { StatusBadge } from '../components/status-badge.mjs';
import { DataTable } from '../components/data-table.mjs';
import { Time } from '../components/time.mjs';
import { Select } from '../components/form.mjs';
import { formatCost, formatDuration, formatTokens, shortId } from '../lib.mjs';

// The run's own id is 36 characters of UUID and is the one identifier a person
// never quotes. It stays available in the drawer, where there is room for it.
const EMPTY = { runs: [], tasks: [], providers: [] };

export function Runs() {
  const [data, setData] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);

  async function load() {
    try {
      // The run rows carry a task id and a provider id, and neither is a name. The
      // table is unreadable without both lists, so they arrive together rather than
      // as three renders of "…".
      const [runs, tasks, providers] = await Promise.all([api.runs(), api.tasks(), api.providers()]);
      setData({ runs, tasks, providers });
    } catch (e) {
      showToast(e.message, 'error');
      setData(EMPTY);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const { runs, tasks, providers } = data || EMPTY;
  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const providerName = useMemo(() => new Map(providers.map((p) => [p.id, p.name || p.id])), [providers]);

  const statuses = useMemo(() => [...new Set(runs.map((r) => r.status))], [runs]);
  const roles = useMemo(() => [...new Set(runs.map((r) => r.role))], [runs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter(
      (r) =>
        (!statusFilter || r.status === statusFilter) &&
        (!roleFilter || r.role === roleFilter) &&
        // The search covers what the table shows - the task title and the provider
        // name - because a filter that cannot find a row you can see is a bug to
        // everyone who meets it.
        (!q ||
          [
            r.role,
            r.provider_id,
            providerName.get(r.provider_id),
            r.model_id,
            taskById.get(r.task_id)?.title,
            taskById.get(r.task_id)?.id,
          ].some((v) => String(v || '').toLowerCase().includes(q)))
    );
  }, [runs, statusFilter, roleFilter, query, providerName, taskById]);

  if (!data) return html`<${SkeletonTable} rows=${8} cols=${6} />`;

  const columns = [
    {
      key: 'task_id',
      label: 'Task',
      sortable: true,
      sortValue: (r) => taskById.get(r.task_id)?.title || '',
      render: (r) => {
        const t = taskById.get(r.task_id);
        if (!t) return html`<span class="muted">—</span>`;
        return html`<a href="#/tasks/${t.id}" onClick=${(e) => e.stopPropagation()}>${t.title || shortId(t.id)}</a>`;
      },
    },
    { key: 'role', label: 'Role', sortable: true, render: (r) => html`<span class="badge badge-neutral">${r.role}</span>` },
    {
      key: 'provider_id',
      label: 'Provider',
      sortable: true,
      sortValue: (r) => providerName.get(r.provider_id) || r.provider_id,
      render: (r) => html`
        <div class="stack">
          <span>${providerName.get(r.provider_id) || r.provider_id}</span>
          <span class="muted mono-sm">${r.model_id}</span>
        </div>
      `,
    },
    { key: 'status', label: 'Status', sortable: true, render: (r) => html`<${StatusBadge} status=${r.status} />` },
    { key: 'started_at', label: 'Started', sortable: true, render: (r) => html`<${Time} at=${r.started_at} />` },
    { key: 'duration_ms', label: 'Duration', sortable: true, render: (r) => formatDuration(r.duration_ms) },
    { key: 'tokens', label: 'Tokens', sortable: true, render: (r) => formatTokens(r.tokens) },
    {
      key: 'cost',
      label: 'Cost',
      sortable: true,
      // Six decimals was the storage format. A run that cost a third of a cent
      // reads as "$0.0033" and a run that cost nothing reads as "$0.00", which is
      // the difference between "cheap" and "free" - and the one number here that
      // anybody is actually adding up.
      render: (r) => formatCost(r.cost),
    },
  ];

  // Two different empty screens. "Nothing has run" is a fact about the pipeline;
  // "nothing matches this filter" is a fact about the filter, and the fix for it is
  // to clear the filter rather than to go and run something.
  const isFiltered = Boolean(query.trim() || statusFilter || roleFilter);

  return html`
    <div class="view-runs">
      <div class="view-toolbar">
        <div class="row">
          <${Select} label="Status" value=${statusFilter} onChange=${setStatusFilter} options=${[{ value: '', label: 'All' }, ...statuses.map((s) => ({ value: s, label: s }))]} />
          <${Select} label="Role" value=${roleFilter} onChange=${setRoleFilter} options=${[{ value: '', label: 'All' }, ...roles.map((s) => ({ value: s, label: s }))]} />
        </div>
        <input
          class="input search-input"
          type="search"
          data-search
          placeholder="Search runs…"
          value=${query}
          onInput=${(e) => setQuery(e.target.value)}
        />
      </div>
      ${
        filtered.length
          ? html`<div class="card">
              <${DataTable} columns=${columns} rows=${filtered} onRowClick=${(r) => setSelected(r)} />
            </div>`
          : isFiltered
            ? html`<${EmptyState}
                title="No runs match"
                message="No run matches the current filters."
                hint="Clear the search or the status filter to see the rest."
                actionLabel="Clear filters"
                onAction=${() => {
                  setQuery('');
                  setStatusFilter('');
                  setRoleFilter('');
                }}
              />`
            : html`<${EmptyState}
                title="No runs yet"
                message="No model call has been recorded."
                hint="Runs appear here as soon as a task reaches planning."
              />`
      }
      ${selected ? html`<${RunDrawer} run=${selected} task=${taskById.get(selected.task_id)} providerName=${providerName.get(selected.provider_id)} onClose=${() => setSelected(null)} />` : null}
    </div>
  `;
}

// The row is a summary and the drawer is the record. Everything the table has no
// room for - the full ids, the error text, the run's place in its task - lives
// here, one click away and without leaving the list.
function RunDrawer({ run, task, providerName, onClose }) {
  const [events, setEvents] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .runEvents(run.id)
      .then((e) => {
        if (!cancelled) setEvents(e);
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [run.id]);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return html`
    <div class="drawer-scrim" onClick=${onClose}>
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="Run detail" onClick=${(e) => e.stopPropagation()}>
        <div class="drawer-head">
          <div class="stack">
            <h2 class="drawer-title">${run.role} run</h2>
            ${task ? html`<a href="#/tasks/${task.id}">${task.title || shortId(task.id)}</a>` : null}
          </div>
          <button class="btn ghost sm" type="button" aria-label="Close" onClick=${onClose}>✕</button>
        </div>
        <div class="drawer-body">
          <div class="row">
            <${StatusBadge} status=${run.status} />
            <span class="muted">Started <${Time} at=${run.started_at} /></span>
            <span class="muted">${formatDuration(run.duration_ms)}</span>
          </div>

          <div class="kv-grid">
            <span class="muted">Run</span><span class="mono-sm">${run.id}</span>
            <span class="muted">Provider</span><span>${providerName || run.provider_id}</span>
            <span class="muted">Model</span><span class="mono-sm">${run.model_id}</span>
            <span class="muted">Tokens</span><span>${formatTokens(run.tokens)}</span>
            <span class="muted">Cost</span><span>${formatCost(run.cost)}</span>
            ${run.fallback_from ? html`<span class="muted">Fallback from</span><span class="mono-sm">${run.fallback_from}</span>` : null}
          </div>

          ${run.error
            ? html`<div class="stack"><span class="field-label">Error</span><pre class="code-block error-text">${run.error}</pre></div>`
            : null}

          <div class="muted">${events ? `${events.length} event${events.length === 1 ? '' : 's'}` : 'Loading events…'}</div>
        </div>
      </aside>
    </div>
  `;
}
