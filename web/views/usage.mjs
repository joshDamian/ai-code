import { html, useState, useEffect, useMemo } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { EmptyState } from '../components/empty-state.mjs';
import { StatusBadge } from '../components/status-badge.mjs';
import { DataTable } from '../components/data-table.mjs';
import { BarChart, StackedBarChart, seriesSlots, compactNumber, formatCost } from '../components/chart.mjs';

const PERIODS = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
];

const DAY_MS = 86400000;

function dayLabel(day) {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function Usage() {
  const [period, setPeriod] = useState('7d');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showProviderTable, setShowProviderTable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.usage(period)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) showToast(e.message, 'error');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period]);

  const totals = (data && data.totals) || {};
  const byRole = (data && data.by_role) || [];
  const byProvider = (data && data.by_provider) || [];
  const topRuns = (data && data.top_runs) || [];

  const roleBars = useMemo(
    () => byRole.map((r) => ({ label: r.role, value: Number(r.tokens) || 0 })),
    [byRole]
  );

  // by_provider carries the display name; run rows only carry provider_id.
  const providerNames = useMemo(() => {
    const m = {};
    for (const p of byProvider) m[p.provider_id] = p.provider || p.provider_id;
    return m;
  }, [byProvider]);

  // cost_by_provider is long format - one row per (day, provider) that had runs.
  // Pivot it to one segment list per day. Slots are assigned from the sorted
  // provider ids, so a provider keeps its hue as the period changes; the tail
  // past the last slot folds into "Other" rather than getting a generated hue.
  const costByProvider = (data && data.cost_by_provider) || [];
  const costStack = useMemo(() => {
    const { series, keyOf } = seriesSlots(
      costByProvider.map((r) => (r && r.provider_id) || 'unknown'),
      (id) => providerNames[id] || id
    );
    const byDay = new Map();
    for (const r of costByProvider) {
      if (!r || !r.day) continue;
      const id = r.provider_id || 'unknown';
      const key = keyOf.get(id) || id;
      let day = byDay.get(r.day);
      if (!day) {
        day = new Map();
        byDay.set(r.day, day);
      }
      const seg = day.get(key) || { key, value: 0, runs: 0 };
      seg.value += Number(r.cost) || 0;
      seg.runs += Number(r.runs) || 0;
      day.set(key, seg);
    }
    // A day or a provider is absent when it had no runs, which is a zero, not a
    // gap - so every day carries the full series list and the renderer draws
    // only the segments that are actually above zero.
    const rows = [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([day, m]) => {
        const segments = series.map((s) => m.get(s.key) || { key: s.key, value: 0, runs: 0 });
        return { key: day, label: dayLabel(day), total: segments.reduce((t, s) => t + s.value, 0), segments };
      });
    return { series, rows };
  }, [costByProvider, providerNames]);

  const providerColumns = [
    { key: 'provider', label: 'Provider', sortable: true, sortValue: (r) => r.provider || r.provider_id },
    { key: 'runs', label: 'Runs', sortable: true, render: (r) => Number(r.runs || 0).toLocaleString() },
    { key: 'tokens', label: 'Tokens', sortable: true, render: (r) => Number(r.tokens || 0).toLocaleString() },
    { key: 'cost', label: 'Cost', sortable: true, render: (r) => `$${Number(r.cost || 0).toFixed(6)}` },
    { key: 'failed', label: 'Failed', sortable: true, render: (r) => (r.failed ? html`<span class="error-text">${r.failed}</span>` : '—') },
  ];

  const runColumns = [
    { key: 'role', label: 'Role', sortable: true },
    { key: 'provider_id', label: 'Provider', sortable: true, render: (r) => providerNames[r.provider_id] || r.provider_id || '—' },
    { key: 'model_id', label: 'Model', sortable: true, render: (r) => r.model_id || '—' },
    { key: 'status', label: 'Status', sortable: true, render: (r) => (r.status ? html`<${StatusBadge} status=${r.status} />` : '—') },
    { key: 'tokens', label: 'Tokens', sortable: true, render: (r) => Number(r.tokens || 0).toLocaleString() },
    { key: 'cost', label: 'Cost', sortable: true, render: (r) => `$${Number(r.cost || 0).toFixed(6)}` },
    { key: 'duration_ms', label: 'Duration', sortable: true, render: (r) => (r.duration_ms ? `${Math.round(r.duration_ms / 1000)}s` : '—') },
    {
      key: 'task_id',
      label: 'Task',
      render: (r) => (r.task_id ? html`<a class="link" href="#/tasks/${r.task_id}">${r.task_id}</a>` : '—'),
    },
  ];

  const succeeded = Number(totals.succeeded || 0);
  const failed = Number(totals.failed || 0);

  // Prompt cost is the tier's whole point, so it is shown against what the models
  // generated rather than on its own: a context figure with no denominator says
  // nothing about whether the budget is doing anything.
  const contextTokens = Number(totals.context_tokens || 0);
  const outputTokens = Number(totals.tokens || 0);
  const spent = contextTokens + outputTokens;
  const ratio = spent > 0 ? `${Math.round((contextTokens / spent) * 100)}% of ${spent.toLocaleString()} sent` : '—';
  const finished = succeeded + failed;

  if (loading && !data) return html`<${Spinner} message="Loading usage..." />`;
  if (!data) return html`<${EmptyState} message="Could not load usage." />`;

  return html`
    <div class="view-usage ${loading ? 'is-refetching' : ''}">
      <div class="view-toolbar">
        <div class="seg" role="group" aria-label="Usage period">
          ${PERIODS.map(
            (p) => html`
              <button
                key=${p.value}
                class="seg-btn ${period === p.value ? 'active' : ''}"
                aria-pressed=${period === p.value}
                onClick=${() => setPeriod(p.value)}
              >
                ${p.label}
              </button>
            `
          )}
        </div>
        <span class="muted">
          ${data.since ? `Since ${new Date(data.since).toLocaleString()}` : 'All time'}
        </span>
      </div>

      <div class="metric-grid">
        <div class="card metric-card">
          <div class="metric-label muted">Total Cost</div>
          <div class="metric-value">$${Number(totals.cost || 0).toFixed(4)}</div>
        </div>
        <div class="card metric-card">
          <div class="metric-label muted">Total Tokens</div>
          <div class="metric-value">${Number(totals.tokens || 0).toLocaleString()}</div>
        </div>
        <div class="card metric-card">
          <div class="metric-label muted">Context Tokens</div>
          <div class="metric-value">${Number(totals.context_tokens || 0).toLocaleString()}</div>
          <div class="metric-note muted">${ratio}</div>
        </div>
        <div class="card metric-card">
          <div class="metric-label muted">Runs</div>
          <div class="metric-value">${Number(totals.runs || 0).toLocaleString()}</div>
          <div class="metric-note muted">${finished ? `${succeeded} succeeded · ${failed} failed` : '—'}</div>
        </div>
        <div class="card metric-card">
          <div class="metric-label muted">Fallbacks</div>
          <div class="metric-value">${Number(totals.fallbacks || 0).toLocaleString()}</div>
        </div>
      </div>

      <figure class="section card chart-card">
        <figcaption class="chart-head">
          <h2>Cost by provider over time</h2>
          <button class="btn secondary chart-toggle" onClick=${() => setShowProviderTable((v) => !v)}>
            ${showProviderTable ? 'Chart' : 'Table'}
          </button>
        </figcaption>
        ${showProviderTable
          ? html`
              <div class="table-scroll">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>Day</th>
                      ${costStack.series.map((s) => html`<th key=${s.key}>${s.label}</th>`)}
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${costStack.rows.map(
                      (r) => html`
                        <tr key=${r.key}>
                          <td>${r.key}</td>
                          ${r.segments.map((s) => html`<td key=${s.key}>$${s.value.toFixed(6)}</td>`)}
                          <td>$${r.total.toFixed(6)}</td>
                        </tr>
                      `
                    )}
                  </tbody>
                </table>
              </div>
            `
          : html`
              <${StackedBarChart}
                rows=${costStack.rows}
                series=${costStack.series}
                title="Cost per day by provider"
                ariaLabel=${`Cost per day split by provider over ${period}. ${costStack.rows.length} day(s), ${costStack.series.length} series. Total ${formatCost(totals.cost)}.`}
                formatValue=${formatCost}
                zeroNote="Every run in this period priced at $0 - no pricing is configured for these models. Hover or focus a day for its per-provider breakdown."
              />
            `}
      </figure>

      <figure class="section card chart-card">
        <figcaption class="chart-head">
          <h2>Tokens by role</h2>
        </figcaption>
        <${BarChart}
          items=${roleBars}
          title="Tokens by role"
          ariaLabel=${`Tokens by role: ${roleBars.map((r) => `${r.label} ${compactNumber(r.value)}`).join(', ') || 'no data'}.`}
          formatValue=${compactNumber}
        />
      </figure>

      <section class="section card">
        <h2>Top 5 most expensive runs</h2>
        ${
          topRuns.length
            ? html`<div class="table-scroll"><${DataTable} columns=${runColumns} rows=${topRuns} /></div>`
            : html`<${EmptyState} message="No runs in this period." />`
        }
      </section>

      <section class="section card">
        <h2>By provider</h2>
        ${
          byProvider.length
            ? html`<div class="table-scroll"><${DataTable} columns=${providerColumns} rows=${byProvider} rowKey=${(r) => r.provider_id} /></div>`
            : html`<${EmptyState} message="No provider activity in this period." />`
        }
      </section>
    </div>
  `;
}
