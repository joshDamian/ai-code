// A comparison: one task run several ways from the same commit, side by side. URL
// hash: #/compare/:group.
//
// Each attempt is an engine on a model. The page shows what each one did in the
// measures that decide between them - whether its checks passed, what it changed,
// what it cost, how long it ran, how often it needed you - and lets you open any of
// them, read its diff, and pick one. The pick lands nothing by itself: the winner
// is an ordinary task you land from its own page, and the others are put away.
//
// Blind by default until decided. Knowing which attempt is the expensive model is
// the easiest way to prefer it, so the engine and model are hidden behind the
// letters until you choose to show them or you pick.
import { html, useState, useEffect, useCallback, formatCost, formatDuration, recall, remember } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { StatusBadge } from '../components/status-badge.mjs';
import { Spinner } from '../components/spinner.mjs';
import { DiffViewer } from '../components/diff-viewer.mjs';
import { confirmAction } from '../components/confirm.mjs';
import { SkeletonRows } from '../components/skeleton.mjs';
import { Toggle } from '../components/form.mjs';

const REVEALED = 'ai-code:compare-revealed';
// States an attempt can still move out of on its own.
const MOVING = new Set(['CREATED', 'CONTEXT_READY', 'PLANNING', 'APPROVED', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'REPAIRING', 'WORKING']);
const ENGINE_LABEL = { pipeline: 'Pipeline', session: 'Session' };
// States where an attempt has stopped until you act, and what it is waiting for.
const NEEDS_YOU = {
  AWAITING_APPROVAL: 'Needs you: approve its plan →',
  AWAITING_DECISION: 'Needs you: its review asks a question →',
  WAITING: 'Needs you: it replied and is waiting →',
};

export function Compare({ group, navigate, onTitle }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [diffs, setDiffs] = useState({});
  const [revealed, setRevealed] = useState(() => {
    try {
      return !!(recall(REVEALED, {}) || {})[group];
    } catch {
      return false;
    }
  });

  const load = useCallback(async () => {
    try {
      const d = await api.attempts(group);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [group]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  useEffect(() => {
    if (onTitle) onTitle(data ? `Compare · ${data.title}` : 'Compare');
  }, [data, onTitle]);

  // Polled while anything can still change by itself; a comparison that is only
  // waiting on you has nothing new to fetch.
  const moving = !!data?.attempts?.some((a) => a.running || MOVING.has(a.state));
  useEffect(() => {
    const timer = setInterval(load, moving ? 2500 : 10000);
    return () => clearInterval(timer);
  }, [moving, load]);

  const decided = !!data?.attempts?.some((a) => a.pick === 'won');
  const show = revealed || decided;

  function reveal(on) {
    setRevealed(on);
    try {
      remember(REVEALED, { ...(recall(REVEALED, {}) || {}), [group]: on });
    } catch {
      /* a preference that cannot be saved is still applied for this visit */
    }
  }

  async function toggleDiff(a) {
    if (diffs[a.id]) {
      setDiffs((d) => ({ ...d, [a.id]: null }));
      return;
    }
    setDiffs((d) => ({ ...d, [a.id]: { loading: true } }));
    try {
      const r = await api.taskDiff(a.id);
      setDiffs((d) => ({ ...d, [a.id]: { text: r.diff || '' } }));
    } catch (e) {
      setDiffs((d) => ({ ...d, [a.id]: { error: e.message } }));
    }
  }

  async function pick(a) {
    const others = data.attempts.filter((x) => x.id !== a.id && x.state !== 'CANCELLED').map((x) => x.label);
    const ok = await confirmAction({
      title: `Pick attempt ${a.label}?`,
      body: `${others.length ? `Attempt${others.length === 1 ? '' : 's'} ${others.join(', ')} will be discarded: worktrees removed, conversations archived. ` : ''}Attempt ${a.label} stays as it is, and you land it from its own page. The pick is recorded on the scoreboard.`,
      confirmLabel: `Pick ${a.label}`,
      cancelLabel: 'Keep comparing',
    });
    if (!ok) return;
    setBusy(true);
    try {
      setData(await api.pickAttempt(group, a.id));
      showToast(`Attempt ${a.label} picked.`, 'success');
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function stop(a) {
    setBusy(true);
    try {
      await api.taskCancel(a.id);
      await load();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return html`<div class="card"><p class="error-text">${error}</p><a href="#/tasks" class="link">← Back to tasks</a></div>`;
  }
  if (!data) return html`<div class="view-compare"><${SkeletonRows} count=${4} /></div>`;

  const winner = data.attempts.find((a) => a.pick === 'won');

  return html`
    <div class="view-compare">
      <div class="compare-head">
        <div>
          <h1>${data.title}</h1>
          ${data.description && data.description !== data.title ? html`<p class="muted compare-desc">${data.description}</p>` : null}
          <p class="muted compare-sub">${data.attempts.length} attempts from the same commit${data.base_commit ? html` <span class="mono-sm">${data.base_commit.slice(0, 8)}</span>` : null}, each in its own worktree.</p>
        </div>
        ${decided
          ? null
          : html`<${Toggle} checked=${revealed} onChange=${reveal} label="Show engines and models" />`}
      </div>

      ${winner
        ? html`<div class="notice compare-decided">
            <span>Attempt <b>${winner.label}</b> picked${show ? ` (${ENGINE_LABEL[winner.engine]} · ${winner.model_name || 'Automatic'})` : ''}. The others were discarded.</span>
            <a class="btn primary sm" href=${`#/tasks/${winner.id}`}>Land it</a>
          </div>`
        : null}

      <div class="compare-grid" style=${`--cols:${data.attempts.length}`}>
        ${data.attempts.map(
          (a) => html`
            <article class="card compare-card ${a.pick === 'won' ? 'won' : ''} ${a.pick === 'lost' ? 'lost' : ''}" key=${a.id}>
              <header class="compare-card-head">
                <span class="attempt-chip big">${a.label}</span>
                <div class="compare-card-who">
                  ${show
                    ? html`<b>${ENGINE_LABEL[a.engine] || a.engine}</b><span class="muted mono-sm">${a.model_name || 'Automatic'}</span>`
                    : html`<b>Attempt ${a.label}</b><span class="muted">Hidden until you pick</span>`}
                </div>
                <${StatusBadge} status=${a.state} />
              </header>
              <dl class="compare-metrics">
                <div><dt>Checks</dt><dd>${a.checks ? html`<${StatusBadge} status=${a.checks} />` : html`<span class="muted">${a.running || MOVING.has(a.state) ? 'Not yet' : 'Not run'}</span>`}</dd></div>
                <div><dt>Changes</dt><dd>${a.changes ? (a.changes.files ? html`${a.changes.files} file${a.changes.files === 1 ? '' : 's'} <span class="good">+${a.changes.added}</span> <span class="bad">−${a.changes.removed}</span>` : 'None') : '—'}</dd></div>
                <div><dt>Spent</dt><dd class="mono-sm">${formatCost(a.cost)}</dd></div>
                <div><dt>Run time</dt><dd class="mono-sm">${a.active_ms ? formatDuration(a.active_ms) : '—'}</dd></div>
                <div><dt>Tool calls</dt><dd class="mono-sm">${a.tool_calls}</dd></div>
                <div title="How often you had to act: approvals and replies for a session, plan approvals and re-plans for a pipeline"><dt>Your inputs</dt><dd class="mono-sm">${a.interventions}</dd></div>
              </dl>
              ${a.running || MOVING.has(a.state) ? html`<p class="muted compare-working"><${Spinner} /> Working…</p>` : null}
              ${!a.running && NEEDS_YOU[a.state] ? html`<p class="compare-needs"><a class="link" href=${`#/tasks/${a.id}`}>${NEEDS_YOU[a.state]}</a></p>` : null}
              <div class="compare-actions">
                <a class="btn secondary sm" href=${`#/tasks/${a.id}`}>Open</a>
                ${a.changes?.files ? html`<button class="btn secondary sm" type="button" onClick=${() => toggleDiff(a)}>${diffs[a.id] ? 'Hide diff' : 'Diff'}</button>` : null}
                ${a.running ? html`<button class="btn secondary sm" type="button" disabled=${busy} onClick=${() => stop(a)}>Stop</button>` : null}
                ${decided || a.state === 'CANCELLED'
                  ? null
                  : html`<button class="btn primary sm" type="button" disabled=${busy || moving} title=${moving ? 'Wait for every attempt to stop running' : ''} onClick=${() => pick(a)}>Pick ${a.label}</button>`}
              </div>
              ${diffs[a.id]
                ? html`<div class="compare-diff">
                    ${diffs[a.id].loading ? html`<${Spinner} />` : diffs[a.id].error ? html`<p class="error-text">${diffs[a.id].error}</p>` : html`<${DiffViewer} diff=${diffs[a.id].text} />`}
                  </div>`
                : null}
            </article>
          `
        )}
      </div>
    </div>
  `;
}
