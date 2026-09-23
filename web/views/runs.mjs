import { html, useState, useEffect, useMemo } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { EmptyState } from '../components/empty-state.mjs';
import { SkeletonTable } from '../components/skeleton.mjs';
import { StatusBadge } from '../components/status-badge.mjs';
import { DataTable } from '../components/data-table.mjs';
import { Select } from '../components/form.mjs';

export function Runs() {
  const [runs, setRuns] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(null);

  async function load() {
    try {
      setRuns(await api.runs());
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  useEffect(() => {
    load();
  }, []);

  const statuses = useMemo(() => (runs ? [...new Set(runs.map((r) => r.status))] : []), [runs]);
  const roles = useMemo(() => (runs ? [...new Set(runs.map((r) => r.role))] : []), [runs]);

  const filtered = useMemo(() => {
    if (!runs) return [];
    const q = query.trim().toLowerCase();
    return runs.filter(
      (r) =>
        (!statusFilter || r.status === statusFilter) &&
        (!roleFilter || r.role === roleFilter) &&
        (!q || [r.role, r.provider_id, r.model_id].some((v) => String(v || '').toLowerCase().includes(q)))
    );
  }, [runs, statusFilter, roleFilter, query]);

  if (!runs) return html`<${SkeletonTable} rows=${8} cols=${6} />`;

  const columns = [
    { key: 'role', label: 'Role', sortable: true },
    { key: 'provider_id', label: 'Provider', sortable: true },
    { key: 'model_id', label: 'Model', sortable: true },
    { key: 'status', label: 'Status', sortable: true, render: (r) => html`<${StatusBadge} status=${r.status} />` },
    { key: 'tokens', label: 'Tokens', sortable: true, render: (r) => Number(r.tokens || 0).toLocaleString() },
    { key: 'cost', label: 'Cost', sortable: true, render: (r) => `$${Number(r.cost || 0).toFixed(6)}` },
    { key: 'duration_ms', label: 'Duration', sortable: true, render: (r) => (r.duration_ms ? `${Math.round(r.duration_ms / 1000)}s` : '—') },
    { key: 'fallback_from', label: 'Fallback', render: (r) => (r.fallback_from ? 'Yes' : '—') },
  ];

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
          ? html`
              <div class="card">
                <${DataTable} columns=${columns} rows=${filtered} onRowClick=${(r) => setExpanded((e) => (e === r.id ? null : r.id))} />
              </div>
              ${expanded ? html`<${RunDetail} run=${filtered.find((r) => r.id === expanded)} />` : null}
            `
          : html`<${EmptyState} message="No runs recorded yet." />`
      }
    </div>
  `;
}

function RunDetail({ run }) {
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

  return html`
    <div class="card">
      <h3>Run ${run.id}</h3>
      ${run.error ? html`<pre class="code-block error-text">${run.error}</pre>` : html`<div class="muted">No error recorded.</div>`}
      <div class="muted">${events ? `${events.length} event(s)` : 'Loading events…'}</div>
    </div>
  `;
}
