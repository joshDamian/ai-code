import { html, useState, useEffect } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { StatusBadge } from '../components/status-badge.mjs';
import { getToken, setToken, clearToken, onLocalhost } from '../auth.mjs';

// The pairing screen. A phone arrives carrying the machine's Tailscale name, which the
// server does not exempt, so its first request is a 401 and this is what it lands on.
// Desktop never reaches it: its own Host is loopback and no call from this machine is
// ever refused for the want of a token.
export function TokenGate() {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    const value = draft.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    setToken(value);
    try {
      // Proving the token against a real call before reloading is what keeps a
      // mistyped one from landing back on this screen with nothing said about why.
      await api.overview();
      // A reload rather than a state change: the streams that carry the token in a
      // query string - the notification EventSource, and any task stream already
      // open - are constructed once and cannot be handed a new one.
      location.reload();
    } catch (err) {
      clearToken();
      setError(err.status === 401 ? 'That token was not accepted.' : err.message);
      setBusy(false);
    }
  }

  return html`
    <div class="token-gate">
      <form class="card token-card" onSubmit=${submit}>
        <div class="logo-title">AI CODE</div>
        <div class="logo-sub muted">Mission Control</div>
        <p class="token-hint">
          This device is not on the server's own machine, so it needs the API token. The server printed one at
          startup, after the line beginning <code>API token:</code>.
        </p>
        <input
          class="input"
          type="password"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="Paste the token"
          value=${draft}
          onInput=${(e) => setDraft(e.target.value)}
        />
        ${error ? html`<div class="token-error">${error}</div>` : null}
        <button class="btn primary" type="submit" disabled=${busy || !draft.trim()}>${busy ? 'Checking…' : 'Pair this device'}</button>
      </form>
    </div>
  `;
}

// Uptime in the units a person reads it in. formatDuration is built for runs, whose
// scale is seconds and minutes; a dashboard the user has not restarted since the week
// before reads as "10080m" through it.
function uptime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function Settings() {
  const [doctor, setDoctor] = useState(null);
  const [running, setRunning] = useState(false);
  const [automations, setAutomations] = useState(null);
  const [server, setServer] = useState(null);
  // Stop is two steps and no modal: there is no confirmation dialog anywhere in this
  // app, and one button that changes its own label is the whole pattern it has.
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Read once at mount rather than on every render: the value lives in localStorage,
  // which is not reactive, so a re-read would only ever confirm what this already has.
  const [paired] = useState(() => !!getToken());

  useEffect(() => {
    api.automations().then(setAutomations).catch((e) => showToast(e.message, 'error'));
    // The status itself is what the card is for, so a failure to read it leaves the
    // card empty rather than throwing a toast about a page that is about to be
    // replaced by the stopped panel anyway.
    api.serverStatus().then(setServer).catch(() => setServer(null));
  }, []);

  async function runDoctor() {
    setRunning(true);
    try {
      setDoctor(await api.doctor());
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setRunning(false);
    }
  }

  // Stop, and then watch for the process to actually go. The call answers 202 before
  // the server closes, so the card cannot use the reply as the confirmation - what
  // confirms it is the next request failing, which is also what tells the app to swap
  // in the stopped panel. Polling here rather than leaving it to the overview's own
  // three-second tick is what makes the panel appear while the user is still looking
  // at the button they pressed.
  async function stopServer() {
    setStopping(true);
    try {
      await api.serverShutdown();
      showToast('Server stopping…');
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 400));
        try {
          await api.serverStatus();
        } catch {
          return; // Gone, and the connectivity event has already said so.
        }
      }
      setStopping(false);
      showToast('The server did not stop.', 'error');
    } catch (e) {
      setStopping(false);
      setConfirmStop(false);
      showToast(e.message, 'error');
    }
  }

  async function toggleAutomation(a) {
    try {
      await api.updateAutomation(a.id, { enabled: !a.enabled });
      setAutomations((list) => list.map((x) => (x.id === a.id ? { ...x, enabled: !a.enabled } : x)));
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  // Forgetting the token does not unpair the browser from push: the subscription
  // belongs to the push service and is addressed by endpoint, not by this token. It is
  // left alone deliberately - revoking push is a decision about the server's stored
  // subscriptions, and the server is where that belongs.
  function forget() {
    clearToken();
    location.reload();
  }

  function passed(v) {
    if (typeof v === 'boolean') return v;
    if (v && typeof v === 'object' && 'ok' in v) return !!v.ok;
    return true;
  }

  return html`
    <div class="view-settings">
      <div class="card">
        <div class="provider-card-head">
          <h2>Doctor</h2>
          <button class="btn" disabled=${running} onClick=${runDoctor}>${running ? 'Running…' : 'Run Doctor'}</button>
        </div>
        ${running ? html`<${Spinner} message="Running diagnostics..." />` : null}
        ${
          doctor
            ? html`
                <div class="list">
                  ${Object.entries(doctor).map(
                    ([k, v]) => html`
                      <div class="list-row" key=${k}>
                        <span>${k}</span>
                        <${StatusBadge} status=${passed(v) ? 'ok' : 'FAILED'} />
                      </div>
                    `
                  )}
                </div>
              `
            : html`<div class="muted">Run Doctor to inspect environment and credentials.</div>`
        }
      </div>

      <div class="card section">
        <div class="provider-card-head">
          <h2>Server</h2>
          ${
            !server
              ? null
              : stopping
              ? html`<button class="btn" disabled>Stopping…</button>`
              : confirmStop
              ? html`
                  <div class="row">
                    <button class="btn secondary" onClick=${() => setConfirmStop(false)}>Cancel</button>
                    <button class="btn danger" onClick=${stopServer}>Confirm stop</button>
                  </div>
                `
              : html`<button class="btn" onClick=${() => setConfirmStop(true)}>Stop server</button>`
          }
        </div>
        ${
          server
            ? html`
                <p class="muted">
                  Stopping ends this process: queued jobs are cancelled, runs in flight are aborted, and open terminals
                  are closed. Nothing restarts it unless a supervisor is holding this port, or it is started again by
                  hand.
                </p>
                <div class="kv-grid">
                  <span class="muted">Status</span>
                  <span><${StatusBadge} status="ok" /> running</span>
                  <span class="muted">Port</span>
                  <code>${server.port ?? '—'}</code>
                  <span class="muted">PID</span>
                  <code>${server.pid}</code>
                  <span class="muted">Host</span>
                  <code>${server.host}</code>
                  <span class="muted">Root</span>
                  <code>${server.root}</code>
                  <span class="muted">Uptime</span>
                  <code>${uptime(server.uptimeMs)}</code>
                  <span class="muted">Jobs</span>
                  <code>${server.jobs.running} running · ${server.jobs.queued} queued</code>
                </div>
              `
            : html`<div class="muted">The server's own status is not available from this page.</div>`
        }
      </div>

      <div class="card section">
        <h2>Automations</h2>
        ${
          automations === null
            ? html`<${Spinner} />`
            : automations.length
            ? html`
                <div class="list">
                  ${automations.map(
                    (a) => html`
                      <div class="list-row" key=${a.id}>
                        <div class="list-row-main">
                          <b>${a.name}</b>
                          <span class="muted">${a.trigger} → ${a.action}</span>
                        </div>
                        <button class="btn secondary" onClick=${() => toggleAutomation(a)}>${a.enabled ? 'Disable' : 'Enable'}</button>
                      </div>
                    `
                  )}
                </div>
              `
            : html`<div class="muted">No automation definitions.</div>`
        }
      </div>

      <div class="card section">
        <h2>Phone access</h2>
        ${onLocalhost() && !paired
          ? html`<div class="muted">
              This browser is on the server's own machine, which needs no token. To use a phone, run
              <code>tailscale serve https / http://127.0.0.1:4317</code> on this machine, open the
              <code>.ts.net</code> address it prints, and paste the token the server logged at startup.
            </div>`
          : html`
              <div class="list-row">
                <div class="list-row-main">
                  <b>Paired</b>
                  <span class="muted">This browser carries an API token. Reload after forgetting to pair again.</span>
                </div>
                <button class="btn secondary" onClick=${forget}>Forget token</button>
              </div>
            `}
      </div>
    </div>
  `;
}
