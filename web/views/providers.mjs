import { html, useState, useEffect } from '../lib.mjs';
import { api } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { Spinner } from '../components/spinner.mjs';
import { EmptyState } from '../components/empty-state.mjs';
import { Toggle } from '../components/form.mjs';

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
  const on = data.providers.filter((p) => p.enabled).length;

  return html`
    <div class="stack">
      <div class="view-toolbar">
        <p class="view-lead">${on} of ${data.providers.length} provider${data.providers.length === 1 ? '' : 's'} enabled · ${(() => {
          // A model on a disabled provider is one the router cannot reach, however it is set.
          const live = new Set(data.providers.filter((p) => p.enabled).map((p) => p.id));
          const n = data.models.filter((m) => m.enabled && live.has(m.provider_id)).length;
          return `${n} model${n === 1 ? '' : 's'} the router may pick from.`;
        })()}</p>
      </div>
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

const HEALTH = { HEALTHY: ['good', 'Healthy'], DEGRADED: ['warn', 'Degraded'], OPEN: ['bad', 'Circuit open'] };

function ProviderCard({ provider, models, health, onChange }) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [saving, setSaving] = useState(false);

  async function setEnabled(enabled) {
    setSaving(true);
    try {
      await api.updateProvider(provider.id, { enabled });
      showToast(`${provider.name} ${enabled ? 'enabled' : 'disabled'}.`, 'success');
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
      // The first *enabled* model rather than the first row: a disabled model is one
      // the router will not reach, and it may be disabled precisely because the
      // provider stopped serving it - so testing it reports a failure that says
      // nothing about the provider. The same rule the server falls back on.
      const target = models.find((m) => m.enabled) || models[0];
      const r = await api.testProvider(provider.id, target && target.id);
      // A failed test is a 200 carrying {ok:false}, not a rejection, so the result has
      // to be read rather than caught - which is how this toasted success on failure.
      setTestResult({ ok: r.ok, detail: r.ok ? (r.cleared ? `Connected. The circuit was ${r.cleared} and is now cleared.` : 'Connected.') : r.error });
      if (!r.ok) return;
      // The health reading renders from the parent's data and nothing here reloads it,
      // so a cleared circuit would otherwise read as open until the next navigation.
      if (r.cleared) onChange();
    } catch (e) {
      setTestResult({ ok: false, detail: e.message });
    } finally {
      setTesting(false);
    }
  }

  const [tone, label] = health ? HEALTH[health.state] || ['good', health.state] : [null, null];
  const seconds = Math.ceil((health?.cooldownRemainingMs || 0) / 1000);

  return html`
    <section class="card provider-card ${provider.enabled ? '' : 'off'}">
      <div class="provider-card-head">
        <div class="provider-card-title">
          <h2>${provider.name}</h2>
          <div class="provider-card-meta">
            <span class="mono-sm">${provider.kind}</span>
            ${health
              ? html`<span aria-hidden="true">·</span><span class="provider-health ${tone}"><span class="health ${tone}"></span>${label}${
                  tone === 'bad' && seconds > 0 ? ` · retrying in ${seconds}s` : health.failures ? ` · ${health.failures} recent failure${health.failures === 1 ? '' : 's'}` : ''
                }</span>`
              : null}
          </div>
        </div>
        <button class="btn secondary sm" type="button" disabled=${testing || !provider.enabled} onClick=${test}>${testing ? 'Testing…' : 'Test connection'}</button>
        <${Toggle} checked=${!!provider.enabled} disabled=${saving} onChange=${setEnabled} label=${provider.enabled ? 'Enabled' : 'Disabled'} />
      </div>

      ${testResult ? html`<div class="test-result ${testResult.ok ? 'good' : 'bad'}">${testResult.detail}</div>` : null}

      ${
        models.length
          ? html`
              <div class="table-wrap">
                <table class="model-table">
                  <thead>
                    <tr><th>Model</th><th>Context</th><th>Price per 1M tokens</th><th>Capabilities</th><th class="num">On</th></tr>
                  </thead>
                  <tbody>
                    ${models.map((m) => html`<${ModelRow} key=${m.id} model=${m} onChange=${onChange} disabled=${!provider.enabled} />`)}
                  </tbody>
                </table>
              </div>
            `
          : html`<p class="muted">This provider lists no models.</p>`
      }
    </section>
  `;
}

function ModelRow({ model, onChange, disabled }) {
  const [saving, setSaving] = useState(false);

  async function toggle(enabled) {
    setSaving(true);
    try {
      await api.updateModel(model.id, { enabled });
      onChange();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  const caps = [
    ...(model.capabilities || []),
    model.reasoning ? `${model.reasoning} reasoning` : null,
    model.toolUse === false ? 'no tools' : null,
  ].filter(Boolean);
  const ctx = model.contextLength || model.context_length;

  return html`
    <tr class=${model.enabled ? '' : 'off'}>
      <td>
        <div class="model-name">${model.displayName || model.name}</div>
        <div class="mono-sm muted">${model.id}</div>
      </td>
      <td>${ctx ? `${Math.round(ctx / 1000)}k` : html`<span class="muted">—</span>`}</td>
      <td>
        ${model.input_cost_per_mtok != null
          ? html`<span class="mono-sm">$${model.input_cost_per_mtok}</span> <span class="muted">in</span> · <span class="mono-sm">$${model.output_cost_per_mtok}</span> <span class="muted">out</span>`
          : html`<span class="muted">Not published</span>`}
      </td>
      <td>${caps.length ? html`<div class="chips">${caps.map((c) => html`<span class="chip" key=${c}>${c}</span>`)}</div>` : html`<span class="muted">Unknown</span>`}</td>
      <td class="num"><${Toggle} checked=${!!model.enabled} disabled=${saving || disabled} onChange=${toggle} label=${`Use ${model.displayName || model.name}`} hideLabel /></td>
    </tr>
  `;
}
