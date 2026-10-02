import { html, useState, useEffect, shortDir } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { StatusBadge } from '../components/status-badge.mjs';
import { Toggle } from '../components/form.mjs';
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
        <div class="logo-title">AI Code</div>
        <div class="logo-sub muted">Mission control</div>
        <p class="token-hint">
          Enter the API token to connect from this device. The server prints it at startup, after
          <code>API token:</code>.
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

// One group of settings: what it is for, and its controls. At module level so it is
// the same component on every render - defined inside Settings it would be a new type
// each time, and Preact would rebuild its contents on every keystroke.
function Section({ title, about, children }) {
  return html`
    <section class="settings-section">
      <div class="settings-about">
        <h2>${title}</h2>
        <p>${about}</p>
      </div>
      <div class="card settings-body">${children}</div>
    </section>
  `;
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
      <${Section} title="Server" about="The server behind this dashboard and its running jobs.">
        ${
          server
            ? html`
                <div class="settings-status">
                  <span class="health good"></span>
                  <b>Running</b>
                  <span class="muted">for ${uptime(server.uptimeMs)} · ${server.jobs.running} job${server.jobs.running === 1 ? '' : 's'} running, ${server.jobs.queued} queued</span>
                </div>
                <dl class="facts">
                  <dt>Address</dt><dd class="mono-sm">${server.host}:${server.port ?? '—'}</dd>
                  <dt>Process</dt><dd class="mono-sm">${server.pid}</dd>
                  <dt>Data root</dt><dd class="mono-sm" title=${server.root}>${shortDir(server.root)}</dd>
                </dl>
                ${
                  server.supervisorPort != null && server.port != null && server.supervisorPort !== server.port
                    ? html`
                        <div class="notice notice-warn">
                          Auto-restart won't work: the supervisor watches port <code>${server.supervisorPort}</code>, but the server runs on <code>${server.port}</code>.
                          Fix it with${' '}<code>AI_CODE_SUPERVISOR_PORT=${server.port} ./bin/install-ai-code --supervisor</code>.
                        </div>`
                    : null
                }
                <div class="danger-zone">
                  <div>
                    <b>Stop the server</b>
                    <p class="muted">Queued jobs are cancelled, runs in flight are aborted and open terminals close. Nothing restarts it unless a supervisor holds this port.</p>
                  </div>
                  ${
                    stopping
                      ? html`<button class="btn danger-outline" disabled>Stopping…</button>`
                      : confirmStop
                        ? html`
                            <div class="row">
                              <button class="btn secondary" onClick=${() => setConfirmStop(false)}>Cancel</button>
                              <button class="btn danger" onClick=${stopServer}>Stop now</button>
                            </div>
                          `
                        : html`<button class="btn danger-outline" onClick=${() => setConfirmStop(true)}>Stop server</button>`
                  }
                </div>
              `
            : html`<p class="muted">The server's own status is not available from this page.</p>`
        }
      </${Section}>

      <${Section} title="Diagnostics" about="Checks git, provider credentials and the tools each agent needs.">
        <div class="settings-row">
          <span class="muted">${doctor ? `${Object.values(doctor).filter(passed).length} of ${Object.keys(doctor).length} checks passed` : 'Not run in this session.'}</span>
          <button class="btn secondary" disabled=${running} onClick=${runDoctor}>${running ? 'Checking…' : doctor ? 'Run again' : 'Run checks'}</button>
        </div>
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
            : null
        }
      </${Section}>

      <${Section} title="Automations" about="Actions that run automatically.">
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
                            <span class="muted">When ${a.trigger} → ${a.action}</span>
                          </div>
                          <${Toggle} checked=${!!a.enabled} onChange=${() => toggleAutomation(a)} label=${a.enabled ? 'On' : 'Off'} />
                        </div>
                      `
                    )}
                  </div>
                `
              : html`<p class="muted">No automations are defined.</p>`
        }
      </${Section}>

      <${Section} title="Phone access" about="Use the dashboard from a phone over Tailscale.">
        ${onLocalhost() && !paired
          ? html`
              <ol class="steps-list">
                <li>On this machine, run${' '}<code>tailscale serve https / http://127.0.0.1:${server?.port ?? 4317}</code>.</li>
                <li>Open the${' '}<code>.ts.net</code>${' '}address it prints on your phone.</li>
                <li>Paste the API token the server printed at startup.</li>
              </ol>
              <p class="muted">This browser is on the server's own machine, so it needs no token.</p>
            `
          : html`
              <div class="settings-row">
                <div class="list-row-main">
                  <b>Paired</b>
                  <span class="muted">This browser carries an API token. Forget it to pair again.</span>
                </div>
                <button class="btn secondary" onClick=${forget}>Forget token</button>
              </div>
            `}
      </${Section}>
    </div>
  `;
}
