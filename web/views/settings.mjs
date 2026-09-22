import { html, useState, useEffect } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { StatusBadge } from '../components/status-badge.mjs';

export function Settings() {
  const [doctor, setDoctor] = useState(null);
  const [running, setRunning] = useState(false);
  const [automations, setAutomations] = useState(null);

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
    </div>
  `;
}
