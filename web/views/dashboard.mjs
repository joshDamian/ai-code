// What Bench is costing the machine: the memory and disk its own processes hold, and
// which conversation is holding them.
//
// Polled, not pushed. The server samples nothing while this page is closed, so opening
// it is what turns `ps` and `du` on, and closing it turns them off again - the point of
// a dashboard on a small machine is that looking at it is not itself the load.
//
// Observe only. Every row that belongs to a session is a link to that session, which is
// where stopping it lives; nothing on this page kills or cleans anything.
import { html, useEffect, useState, formatBytes, formatDuration } from '../lib.mjs';
import { api, useStore } from '../api.mjs';
import { Dot } from '../components/ui.mjs';

const POLL_MS = 4000;

/** A resource crossing a threshold is a status, so it takes a status colour - never the
 * colour alone, always beside its own number. @param {number} pct */
const tone = (pct) => (pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : 'good');

/** @param {number} used @param {number|null} total */
const pctOf = (used, total) => (total ? Math.min(100, Math.round((used / total) * 100)) : 0);

export function Dashboard() {
  const [m, setM] = useState(/** @type {import('../../src/contract.d.mts').Metrics|null} */ (null));
  const [err, setErr] = useState(/** @type {string|null} */ (null));
  const sessions = useStore((s) => s.sessions);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .metrics()
        .then((d) => {
          if (alive) {
            setM(d);
            setErr(null);
          }
        })
        .catch((e) => {
          if (alive) setErr(e.message);
        });
    tick();
    const timer = setInterval(tick, POLL_MS);
    // A phone that was asleep comes back to a stale reading; this is the moment to take
    // a fresh one rather than wait out the rest of the interval.
    const onVisible = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return html`
    <div class="page dashboard">
      <header class="page-header">
        <div>
          <h1>Dashboard</h1>
          ${m ? html`<div class="muted">${m.host.hostname} · up ${formatDuration(m.host.uptimeMs)} · ${m.host.cpus} cores</div>` : null}
        </div>
        ${m ? html`<span class="muted mono-sm" title="Refreshed every ${POLL_MS / 1000}s">${new Date(m.at).toLocaleTimeString()}</span>` : null}
      </header>
      ${err ? html`<div class="notice notice-bad">${err}</div>` : null}
      ${!m ? html`<div class="card empty-card"><p class="muted">Reading the machine…</p></div>` : html`<${Body} m=${m} sessions=${sessions} />`}
    </div>
  `;
}

/** @param {{m: import('../../src/contract.d.mts').Metrics, sessions: import('../../src/contract.d.mts').Session[]}} props */
function Body({ m, sessions }) {
  const memPct = pctOf(m.bench.memCurrent, m.machine.memTotal);
  const diskUsed = m.machine.diskTotal != null && m.machine.diskFree != null ? m.machine.diskTotal - m.machine.diskFree : null;
  const diskPct = diskUsed != null ? pctOf(diskUsed, m.machine.diskTotal) : 0;
  const claude = m.procs.filter((p) => p.kind === 'claude').length;
  const shells = m.procs.filter((p) => p.kind === 'terminal').length;
  const statusOf = (/** @type {string|null} */ id) => sessions.find((s) => s.id === id)?.status || 'idle';

  /** Where a row leads: the session that owns it, else its task, else its project. @param {import('../../src/contract.d.mts').MetricProcess} p */
  const hrefOf = (p) => {
    if (!p.projectId) return null;
    if (p.sessionId) return p.taskId ? `#/p/${p.projectId}/t/${p.taskId}/s/${p.sessionId}` : `#/p/${p.projectId}/s/${p.sessionId}`;
    if (p.taskId) return `#/p/${p.projectId}/t/${p.taskId}`;
    return `#/p/${p.projectId}`;
  };

  const row = (/** @type {import('../../src/contract.d.mts').MetricProcess} */ p) => {
    const href = hrefOf(p);
    const body = html`
      <div class="list-row-main">
        ${p.kind === 'claude' ? html`<${Dot} status=${statusOf(p.sessionId)} />` : html`<span class="dot"></span>`}
        <div>
          <div class="proc-name">${p.label}</div>
          <div class="proc-meta">
            <span class="kind">${p.kind === 'other' ? `${p.count} processes` : p.kind}</span>
            ${p.sub ? html`<span>${p.sub}</span>` : null}
            ${p.count > 1 && p.kind !== 'other' ? html`<span>${p.count} processes</span>` : null}
          </div>
        </div>
      </div>
      <div class="list-row-side proc-nums">
        <span class="proc-num">${formatBytes(p.rssKb * 1024)}</span>
        <span class="proc-num">${p.pcpu.toFixed(1)}%</span>
        <span class="proc-num muted">${p.etimeMs ? formatDuration(p.etimeMs) : '—'}</span>
        ${href ? html`<span class="link">open</span>` : null}
      </div>`;
    return href
      ? html`<a class="list-row proc-row" href=${href} key=${`${p.kind}:${p.sessionId || p.label}`}>${body}</a>`
      : html`<div class="list-row proc-row" key=${`${p.kind}:${p.label}`}>${body}</div>`;
  };

  return html`
    <div class="project-grid">
      <${Tile} label="Bench memory" value=${formatBytes(m.bench.memCurrent)} sub=${`of ${formatBytes(m.machine.memTotal)}`} pct=${memPct} tone=${tone(memPct)} foot=${m.bench.memPeak ? `peak ${formatBytes(m.bench.memPeak)} · ${m.bench.pids ?? m.bench.procs} pids` : `${m.bench.procs} processes`} />
      <${Tile} label="Bench processes" value=${String(m.bench.procs)} sub=${`${claude} session${claude === 1 ? '' : 's'} · ${shells} terminal${shells === 1 ? '' : 's'}`} />
      <${Tile} label="Disk free" value=${formatBytes(m.machine.diskFree)} sub=${`of ${formatBytes(m.machine.diskTotal)}`} pct=${diskPct} tone=${tone(diskPct)} foot=${diskUsed != null ? `${formatBytes(diskUsed)} used` : ''} />
      <${Tile} label="Load average" value=${(m.host.loadavg[0] ?? 0).toFixed(2)} sub=${`${(m.host.loadavg[1] ?? 0).toFixed(2)} · ${(m.host.loadavg[2] ?? 0).toFixed(2)}`} foot="1m · 5m · 15m" />
    </div>

    <section class="section">
      <div class="section-head">
        <h2>Memory &amp; CPU by process</h2>
        <span class="badge badge-neutral">${m.procs.length} row${m.procs.length === 1 ? '' : 's'}</span>
      </div>
      <div class="list">${m.procs.map(row)}</div>
      <p class="foot">
        ${m.bench.source === 'cgroup'
          ? 'Bench memory is read from the service’s cgroup, so it covers every Bench process together, including the pages they share. The rows below sum private memory only, and read lower.'
          : 'No cgroup here, so Bench memory is summed from the process tree below. Shared pages are counted once per process, so the total reads higher than the machine’s own accounting.'}
      </p>
    </section>

    <section class="section">
      <div class="section-head"><h2>Storage</h2></div>
      <div class="metric-row">
        <${Meter} pct=${diskPct} tone=${tone(diskPct)} label=${`${diskPct}% of the machine's disk is used`} big=${true} />
        <span class="muted">${diskUsed != null ? `${formatBytes(diskUsed)} used of ${formatBytes(m.machine.diskTotal)}` : 'Disk size unknown here'}</span>
      </div>
      <div class="list">
        ${m.storage.entries.map(
          (e) => html`<div class="list-row" key=${e.path}>
            <div class="list-row-main">
              <div>
                <div class="proc-name">${e.name}${e.note ? html` <span class="muted">${e.note}</span>` : null}</div>
                <div class="storage-path">${e.path}</div>
              </div>
            </div>
            <div class="list-row-side"><span class="mono-sm">${e.bytes == null ? 'measuring…' : formatBytes(e.bytes)}</span></div>
          </div>`
        )}
      </div>
    </section>
  `;
}

/** @param {{label:string, value:string, sub?:string, pct?:number|null, tone?:string, foot?:string}} p */
function Tile({ label, value, sub, pct = null, tone: t = '', foot = '' }) {
  return html`
    <div class="card metric">
      <span class="metric-label">${label}</span>
      <span class="metric-value">${value}</span>
      ${sub ? html`<span class="metric-sub">${sub}</span>` : null}
      ${pct != null ? html`<${Meter} pct=${pct} tone=${t} label=${`${label}: ${pct}%`} />` : null}
      ${foot ? html`<span class="metric-foot">${foot}</span>` : null}
    </div>
  `;
}

/** The fill carries the severity and the track is that same tone, lightened, so the state
 * reads across the whole bar. The number beside it is what makes it more than a colour.
 * @param {{pct:number, tone:string, label:string, big?:boolean}} p */
function Meter({ pct, tone: t, label, big = false }) {
  return html`<div class="meter ${t} ${big ? 'big' : ''}" role="img" aria-label=${label}><span style=${`width:${Math.max(pct, pct > 0 ? 2 : 0)}%`}></span></div>`;
}
