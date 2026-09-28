// The home screen, ordered by what it asks of you.
//
// It used to open with four counts. A count answers "how many" and a person
// arriving at this page is asking "what now" - and the two are different
// questions. So the page leads with the tasks that have stopped and cannot move
// until somebody answers, then the ones that are moving on their own, and the
// counts sit below both as context for them.
import { html, useState, useEffect, useMemo } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { EmptyState } from '../components/empty-state.mjs';
import { SkeletonCards, SkeletonRows } from '../components/skeleton.mjs';
import { StatusBadge } from '../components/status-badge.mjs';
import { HealthDot } from '../components/health-dot.mjs';
import { Time } from '../components/time.mjs';
import { Sparkline } from '../components/chart.mjs';
import { shortId } from '../lib.mjs';

// The in-flight half of the workflow in src/service.mjs. IMPLEMENTING is the
// real name for the state this set used to call EXECUTING, which does not exist.
const ACTIVE_STATES = new Set(['PLANNING', 'AWAITING_APPROVAL', 'APPROVED', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'REPAIRING', 'AWAITING_DECISION']);
// The states that are stopped, and the two different reasons. `waits` is what the
// task is waiting for, and it is also the label on the button that answers it -
// the reason this list exists is so that the button is one click from the page
// you land on.
const AWAITING = {
  AWAITING_APPROVAL: { label: 'Plan ready for approval', cta: 'Review plan' },
  AWAITING_DECISION: { label: 'Decision needed', cta: 'Answer' },
};

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

export function Overview({ navigate, onNewTask }) {
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

  // The project id on a task row is a UUID and the same one on most rows. The
  // name is what tells two rows apart.
  const projectNames = useMemo(() => new Map(((data && data.projects) || []).map((p) => [p.id, p.name])), [data]);
  const healthByProvider = useMemo(() => new Map(((data && data.health) || []).map((h) => [h.providerId, h])), [data]);

  if (loading && !data) {
    return html`
      <div class="view-overview">
        <section class="section"><h2>Needs your attention</h2><${SkeletonRows} count=${2} /></section>
        <${SkeletonCards} count=${4} />
        <section class="section"><h2>In progress</h2><${SkeletonRows} count=${4} /></section>
      </div>
    `;
  }
  if (!data) return html`<${EmptyState} message="Could not load overview." />`;

  const activeTasks = data.tasks.filter((t) => ACTIVE_STATES.has(t.state));
  const waiting = data.tasks.filter((t) => AWAITING[t.state]);
  const failed = data.tasks.filter((t) => t.state === 'FAILED');
  const inProgress = activeTasks.filter((t) => !AWAITING[t.state]);
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

  const attentionCount = waiting.length + failed.length;

  // A first run. Every section below would be empty and every count zero, and none of
  // that says what to do - so the page is the three steps to a first task instead.
  if (!data.projects.length) {
    const hasProvider = activeProviders.length > 0;
    return html`
      <div class="view-overview">
        <section class="card welcome">
          <div class="welcome-head">
            <h2>Welcome to AI Code</h2>
            <p class="muted">It plans, builds and reviews changes in your repositories, and asks you before anything lands. Three steps to the first one.</p>
          </div>
          <ol class="welcome-steps">
            <li class="welcome-step">
              <span class="welcome-num">1</span>
              <div><b>Add a project</b><span class="muted">A git repository the pipeline may work in, or an idea it should start from.</span></div>
              <a class="btn primary" href="#/projects/new">Add a project</a>
            </li>
            <li class="welcome-step ${hasProvider ? 'done' : ''}">
              <span class="welcome-num">${hasProvider ? '✓' : '2'}</span>
              <div>
                <b>Check a model provider</b>
                <span class="muted">${hasProvider ? `${activeProviders.length} enabled: ${activeProviders.map((p) => p.name).join(', ')}.` : 'No provider is enabled, so nothing can run yet.'}</span>
              </div>
              <a class="btn secondary" href="#/providers">Providers</a>
            </li>
            <li class="welcome-step pending">
              <span class="welcome-num">3</span>
              <div><b>Describe a task</b><span class="muted">One change you want. You approve its plan before any code is written.</span></div>
              <button class="btn secondary" type="button" disabled title="Add a project first" onClick=${onNewTask}>New task</button>
            </li>
          </ol>
        </section>
      </div>
    `;
  }

  return html`
    <div class="view-overview">
      <section class="section">
        <div class="section-head">
          <h2>Needs your attention</h2>
          ${attentionCount ? html`<span class="badge badge-info">${attentionCount}</span>` : null}
        </div>
        ${
          attentionCount
            ? html`
                <div class="list">
                  ${waiting.map(
                    (t) => html`
                      <div class="list-row attention" key=${t.id}>
                        <div class="list-row-main">
                          <a href=${`#/tasks/${t.id}`}><b>${t.title}</b></a>
                          <span class="muted">${projectNames.get(t.project_id) || shortId(t.project_id)} · ${AWAITING[t.state].label}</span>
                        </div>
                        <div class="list-row-side">
                          <${StatusBadge} status=${t.state} />
                          <a class="btn primary sm" href=${`#/tasks/${t.id}`}>${AWAITING[t.state].cta}</a>
                        </div>
                      </div>
                    `
                  )}
                  ${failed.map(
                    (t) => html`
                      <div class="list-row" key=${t.id}>
                        <div class="list-row-main">
                          <a href=${`#/tasks/${t.id}`}><b>${t.title}</b></a>
                          <span class="muted">${projectNames.get(t.project_id) || shortId(t.project_id)} · stopped on an error</span>
                        </div>
                        <div class="list-row-side">
                          <${StatusBadge} status=${t.state} />
                          <a class="btn secondary sm" href=${`#/tasks/${t.id}`}>Open</a>
                        </div>
                      </div>
                    `
                  )}
                </div>
              `
            : html`<${EmptyState} title="Nothing is waiting on you" message="No task needs a decision or a plan approval." />`
        }
      </section>

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
        <div class="section-head"><h2>In progress</h2></div>
        ${
          inProgress.length
            ? html`
                <div class="list">
                  ${inProgress.slice(0, 10).map(
                    (t) => html`
                      <div class="list-row" key=${t.id}>
                        <div class="list-row-main">
                          <a href=${`#/tasks/${t.id}`}><b>${t.title}</b></a>
                          <span class="muted">${projectNames.get(t.project_id) || shortId(t.project_id)} · updated <${Time} at=${t.updated_at} /></span>
                        </div>
                        <${StatusBadge} status=${t.state} />
                      </div>
                    `
                  )}
                </div>
              `
            : html`<${EmptyState} title="Nothing is running" message="No task is in flight right now." />`
        }
      </section>

      <section class="section">
        <div class="section-head"><h2>Providers</h2></div>
        ${
          data.providers.length
            ? html`
                <div class="list">
                  ${data.providers.map((p) => {
                    // Two different facts about a provider, and they were one column.
                    // The dot is the circuit breaker - is this provider answering -
                    // and the badge is the switch - has somebody turned it on.
                    const h = healthByProvider.get(p.id);
                    return html`
                      <div class="list-row" key=${p.id}>
                        <div class="list-row-main">
                          <b>${p.name}</b>
                          <span class="muted">${p.kind}${h && h.lastError && h.state !== 'HEALTHY' ? ` · ${h.lastError}` : ''}</span>
                        </div>
                        <div class="list-row-side">
                          <${HealthDot} health=${h} />
                          <${StatusBadge} status=${p.enabled ? 'Enabled' : 'Disabled'} />
                        </div>
                      </div>
                    `;
                  })}
                </div>
              `
            : html`<${EmptyState} message="No providers configured." />`
        }
      </section>
    </div>
  `;
}
