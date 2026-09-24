import { html, useState, useEffect } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { EmptyState } from '../components/empty-state.mjs';
import { SkeletonCards, SkeletonRows } from '../components/skeleton.mjs';
import { StatusBadge } from '../components/status-badge.mjs';
import { Sparkline } from '../components/chart.mjs';

// The in-flight half of the workflow in src/service.mjs. IMPLEMENTING is the
// real name for the state this set used to call EXECUTING, which does not exist.
const ACTIVE_STATES = new Set(['PLANNING', 'AWAITING_APPROVAL', 'APPROVED', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'REPAIRING']);

const DAY_MS = 86400000;

// The last seven UTC day keys, oldest first.
function lastSevenDays() {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = [];
  for (let i = 6; i >= 0; i -= 1) days.push(new Date(today - i * DAY_MS).toISOString().slice(0, 10));
  return days;
}

// How many of `rows` existed by the end of each day. Rows without a parseable
// created_at are skipped rather than counted as day zero.
function cumulativeByDay(rows, days, keep) {
  const stamps = rows
    .filter((r) => !keep || keep(r))
    .map((r) => Date.parse(r.created_at))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  return days.map((day) => {
    const end = Date.parse(`${day}T23:59:59.999Z`);
    let count = 0;
    while (count < stamps.length && stamps[count] <= end) count += 1;
    return count;
  });
}

function trendLabel(name, values) {
  return `${name}, last 7 days: ${values[0]} to ${values[values.length - 1]}.`;
}

export function Overview() {
  const [data, setData] = useState(null);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const d = await api.overview();
        if (!cancelled) setData(d);
      } catch (e) {
        if (!cancelled) showToast(e.message, 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const t = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // The 7-day trend behind the metric cards. Fetched once, not on the 3s
  // overview poll, and silently skipped if the usage endpoint is unavailable -
  // the cards still render, just without their trend.
  useEffect(() => {
    let cancelled = false;
    api.usage('7d')
      .then((u) => {
        if (!cancelled) setUsage(u);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading && !data) {
    return html`
      <div class="view-overview">
        <${SkeletonCards} count=${4} />
        <section class="section"><h2>Active Tasks</h2><${SkeletonRows} count=${4} /></section>
        <section class="section"><h2>Provider Health</h2><${SkeletonRows} count=${3} /></section>
      </div>
    `;
  }
  if (!data) return html`<${EmptyState} message="Could not load overview." />`;

  const activeTasks = data.tasks.filter((t) => ACTIVE_STATES.has(t.state));
  const activeProviders = data.providers.filter((p) => p.enabled);

  const days = lastSevenDays();
  const projectTrend = cumulativeByDay(data.projects, days);
  const taskTrend = cumulativeByDay(data.tasks, days, (t) => ACTIVE_STATES.has(t.state));
  const runByDay = {};
  for (const d of (usage && usage.by_day) || []) runByDay[d.day] = Number(d.runs) || 0;
  const runTrend = usage ? days.map((d) => runByDay[d] || 0) : null;

  // Providers have no created_at and enablement is mutable with no history, so
  // there is no series of "enabled providers". What is recorded is which
  // providers actually ran on a given day; the card's number stays the enabled
  // count and the trend is labelled for what it really is.
  const providerByDay = {};
  for (const d of (usage && usage.by_provider_day) || []) providerByDay[d.day] = Number(d.providers) || 0;
  const providerTrend = usage ? days.map((d) => providerByDay[d] || 0) : null;

  return html`
    <div class="view-overview">
      <div class="metric-grid">
        <div class="card metric-card">
          <div class="metric-label muted">Projects</div>
          <div class="metric-value">${data.projects.length}</div>
          <${Sparkline} values=${projectTrend} label=${trendLabel('Projects', projectTrend)} />
        </div>
        <div class="card metric-card">
          <div class="metric-label muted">Active Tasks</div>
          <div class="metric-value">${activeTasks.length}</div>
          <${Sparkline} values=${taskTrend} label=${trendLabel('Active tasks', taskTrend)} />
        </div>
        <div class="card metric-card">
          <div class="metric-label muted">Total Runs</div>
          <div class="metric-value">${data.runs.length}</div>
          ${runTrend ? html`<${Sparkline} values=${runTrend} label=${trendLabel('Runs', runTrend)} />` : null}
        </div>
        <div class="card metric-card">
          <div class="metric-label muted">Active Providers</div>
          <div class="metric-value">${activeProviders.length}</div>
          ${providerTrend ? html`<${Sparkline} values=${providerTrend} label=${trendLabel('Providers used', providerTrend)} />` : null}
        </div>
      </div>

      <section class="section">
        <h2>Active Tasks</h2>
        ${
          activeTasks.length
            ? html`
                <div class="list">
                  ${activeTasks.slice(0, 10).map(
                    (t) => html`
                      <div class="list-row" key=${t.id}>
                        <div class="list-row-main">
                          <b>${t.title}</b>
                          <span class="muted">${t.project_id}</span>
                        </div>
                        <div class="list-row-side">
                          <${StatusBadge} status=${t.state} />
                          <a href="#/tasks/${t.id}" class="link">Open</a>
                        </div>
                      </div>
                    `
                  )}
                </div>
              `
            : html`<${EmptyState} message="No active tasks." />`
        }
      </section>

      <section class="section">
        <h2>Provider Health</h2>
        ${
          data.providers.length
            ? html`
                <div class="list">
                  ${data.providers.map(
                    (p) => html`
                      <div class="list-row" key=${p.id}>
                        <div class="list-row-main">
                          <b>${p.name}</b>
                          <span class="muted">${p.kind}</span>
                        </div>
                        <${StatusBadge} status=${p.enabled ? 'Enabled' : 'Disabled'} />
                      </div>
                    `
                  )}
                </div>
              `
            : html`<${EmptyState} message="No providers configured." />`
        }
      </section>
    </div>
  `;
}
