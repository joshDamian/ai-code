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

export function Settings() {
  const [doctor, setDoctor] = useState(null);
  const [running, setRunning] = useState(false);
  const [automations, setAutomations] = useState(null);
  // Read once at mount rather than on every render: the value lives in localStorage,
  // which is not reactive, so a re-read would only ever confirm what this already has.
  const [paired] = useState(() => !!getToken());

  useEffect(() => {
    api.automations().then(setAutomations).catch((e) => showToast(e.message, 'error'));
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
