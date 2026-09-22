import { html, useState, useEffect } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { EmptyState } from '../components/empty-state.mjs';
import { StatusBadge } from '../components/status-badge.mjs';
import { HealthDot } from '../components/health-dot.mjs';

export function Providers() {
  const [data, setData] = useState(null);

  async function load() {
    try {
      setData(await api.providers());
    } catch (e) {
      showToast(e.message, 'error');
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (!data) return html`<${Spinner} message="Loading providers..." />`;
  if (!data.providers.length) return html`<${EmptyState} message="No providers configured." />`;

  // Keyed by provider id so a card can find its own breaker state without a
  // second lookup per render.
  const health = new Map((data.health || []).map((h) => [h.providerId, h]));

  return html`
    <div class="provider-grid">
      ${data.providers.map(
        (p) => html`
          <${ProviderCard}
            key=${p.id}
            provider=${p}
            health=${health.get(p.id)}
            models=${data.models.filter((m) => m.provider_id === p.id)}
            onChange=${load}
          />
        `
      )}
    </div>
  `;
}

function ProviderCard({ provider, models, health, onChange }) {
  const [expanded, setExpanded] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [enabled, setEnabled] = useState(provider.enabled);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving] = useState(false);

  async function saveEnabled() {
    setSaving(true);
    try {
      await api.updateProvider(provider.id, { enabled });
      showToast(`${provider.name} ${enabled ? 'enabled' : 'disabled'}.`, 'success');
      setConfiguring(false);
      onChange();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.testProvider(provider.id, models[0] && models[0].id);
      setTestResult({ ok: true, detail: JSON.stringify(r) });
      showToast('Connection test succeeded.', 'success');
    } catch (e) {
      setTestResult({ ok: false, detail: e.message });
      showToast('Connection test failed.', 'error');
    } finally {
      setTesting(false);
    }
  }

  return html`
    <div class="card provider-card">
      <div class="provider-card-head">
        <div>
          <b>${provider.name}</b>
          <div class="muted">${provider.kind}</div>
        </div>
        <div class="row">
          <${HealthDot} health=${health} />
          <${StatusBadge} status=${provider.enabled ? 'Enabled' : 'Disabled'} />
        </div>
      </div>

      <div class="row">
        <span class="muted">${models.length} model${models.length === 1 ? '' : 's'}</span>
        <button class="btn secondary" onClick=${() => setExpanded((e) => !e)}>${expanded ? 'Hide models' : 'Show models'}</button>
      </div>

      ${
        expanded
          ? html`
              <div class="model-list">
                ${
                  models.length
                    ? models.map((m) => html`<${ModelRow} key=${m.id} model=${m} onChange=${onChange} />`)
                    : html`<div class="muted">No models.</div>`
                }
              </div>
            `
          : null
      }

      ${
        configuring
          ? html`
              <div class="card inline-form">
                <label class="field">
                  <span class="field-label">Enabled</span>
                  <select class="input" value=${enabled ? 'true' : 'false'} onChange=${(e) => setEnabled(e.target.value === 'true')}>
                    <option value="true">Enabled</option>
                    <option value="false">Disabled</option>
                  </select>
                </label>
                <div class="row">
                  <button class="btn" disabled=${saving} onClick=${saveEnabled}>${saving ? 'Saving…' : 'Save'}</button>
                  <button
                    class="btn secondary"
                    onClick=${() => {
                      setEnabled(provider.enabled);
                      setConfiguring(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            `
          : html`
              <div class="row">
                <button class="btn secondary" onClick=${() => setConfiguring(true)}>Configure</button>
                <button class="btn secondary" disabled=${testing} onClick=${test}>${testing ? 'Testing…' : 'Test Connection'}</button>
              </div>
            `
      }

      ${testResult ? html`<div class="test-result ${testResult.ok ? 'good' : 'bad'}">${testResult.detail}</div>` : null}
    </div>
  `;
}

function ModelRow({ model, onChange }) {
  const [saving, setSaving] = useState(false);

  async function toggle() {
    setSaving(true);
    try {
      await api.updateModel(model.id, { enabled: !model.enabled });
      onChange();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  return html`
    <div class="model-row">
      <div>
        <b>${model.displayName || model.name}</b>
        <div class="muted">${model.id}</div>
        <div class="muted">${(model.capabilities || []).join(' · ')}</div>
        <div class="muted">
          ${[model.reasoning ? `${model.reasoning} reasoning` : null, model.toolUse === false ? 'no tools' : null, model.contextLength ? `${Math.round(model.contextLength / 1000)}k ctx` : null]
            .filter(Boolean)
            .join(' · ') || 'capabilities unknown'}
        </div>
        <div class="muted">
          ${model.input_cost_per_mtok != null ? `$${model.input_cost_per_mtok}/M in · $${model.output_cost_per_mtok}/M out` : 'no published price'}
        </div>
      </div>
      <button class="btn secondary" disabled=${saving} onClick=${toggle}>${model.enabled ? 'Disable' : 'Enable'}</button>
    </div>
  `;
}
