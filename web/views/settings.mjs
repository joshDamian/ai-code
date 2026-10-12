// Providers, defaults, devices, notifications and the server's health.
import { html, useEffect, useState, formatCost } from '../lib.mjs';
import { api, useStore, refresh } from '../api.mjs';
import { showToast } from '../components/toast.mjs';
import { confirmAction } from '../components/confirm.mjs';
import { Toggle } from '../components/form.mjs';
import { Time } from '../components/time.mjs';
import { ModelPicker, ModePicker } from '../components/ui.mjs';

const toast = (e) => showToast(e.message || String(e), 'error');

export function Settings() {
  return html`
    <div class="page settings">
      <header class="page-header"><h1>Settings</h1></header>
      <${Defaults} />
      <${Providers} />
      <${Devices} />
      <${Notifications} />
      <${Usage} />
      <${Doctor} />
    </div>
  `;
}

function Defaults() {
  const providers = useStore((s) => s.providers);
  const d = useStore((s) => s.defaults);
  const save = (b) => api.setDefaults(b).then(refresh).catch(toast);
  return html`
    <section class="section card">
      <h2>New sessions start with</h2>
      <div class="field"><span class="field-label">Model</span><${ModelPicker} providers=${providers} value=${{ providerId: d.providerId, modelId: d.modelId }} onChange=${(v) => save(v)} /></div>
      <div class="field"><span class="field-label">Permissions</span><${ModePicker} value=${d.mode} onChange=${(mode) => save({ mode })} /></div>
      <p class="muted">Sessions load the project's <code>.claude/</code> settings and CLAUDE.md, and your own <code>~/.claude/CLAUDE.md</code>. Your user <code>settings.json</code> is not loaded, so its <code>env</code> cannot redirect a provider.</p>
    </section>
  `;
}

function Providers() {
  const providers = useStore((s) => s.providers);
  const [testing, setTesting] = useState(null);
  const [open, setOpen] = useState(null);
  const test = async (p) => {
    setTesting(p.id);
    const r = await api.testProvider(p.id, null).catch((e) => ({ ok: false, error: e.message }));
    setTesting(null);
    showToast(r.ok ? `${p.name}: OK in ${(r.ms / 1000).toFixed(1)}s` : `${p.name}: ${r.error}`, r.ok ? 'success' : 'error');
  };
  return html`
    <section class="section card">
      <h2>Providers</h2>
      <p class="muted">Where a session's API calls go. A hosted provider reads its key from the server's environment.</p>
      <div class="list">
        ${providers.map(
          (p) => html`
            <div class="list-row provider-row" key=${p.id}>
              <div class="list-row-main">
                <${Toggle} hideLabel label=${`Enable ${p.name}`} checked=${p.enabled} onChange=${(on) => api.updateProvider(p.id, { enabled: on }).then(refresh).catch(toast)} />
                <div>
                  <strong>${p.name}</strong>
                  <div class="muted">${p.ready ? `${p.models.filter((m) => m.enabled).length} models` : p.reason}</div>
                </div>
              </div>
              <div class="list-row-side">
                <button class="btn sm secondary" type="button" disabled=${!p.ready || testing === p.id} onClick=${() => test(p)}>${testing === p.id ? 'Testing…' : 'Test'}</button>
                <button class="btn sm ghost" type="button" onClick=${() => setOpen(open === p.id ? null : p.id)}>${open === p.id ? 'Hide models' : 'Models'}</button>
              </div>
            </div>
            ${open === p.id
              ? html`<div class="models">
                  ${p.models.map(
                    (m) => html`<label class="model-row" key=${m.id}>
                      <input type="checkbox" checked=${m.enabled} onChange=${(e) => api.updateModel(m.id, { enabled: e.target.checked }).then(refresh).catch(toast)} />
                      <span>${m.display_name || m.name}</span>
                      <span class="muted mono-sm">${m.input_cost_per_mtok != null ? `$${m.input_cost_per_mtok} / $${m.output_cost_per_mtok} per M` : ''}</span>
                    </label>`
                  )}
                </div>`
              : null}
          `
        )}
      </div>
    </section>
  `;
}

function Devices() {
  const me = useStore((s) => s.me);
  const [devices, setDevices] = useState([]);
  const [pairing, setPairing] = useState(null);
  const load = () => api.devices().then(setDevices).catch(toast);
  useEffect(() => {
    load();
  }, []);
  return html`
    <section class="section card">
      <h2>Devices</h2>
      <p class="muted">This machine's own browser needs no pairing. Any other device pairs once with a one-time link, reached over your tailnet (<code>ai-code share</code>).</p>
      ${devices.length
        ? html`<div class="list">
            ${devices.map(
              (d) => html`<div class="list-row" key=${d.id}>
                <div class="list-row-main"><strong>${d.name}</strong>${me?.device?.id === d.id ? html` <span class="badge badge-info">this device</span>` : null}</div>
                <div class="list-row-side">
                  <span class="muted">seen ${d.last_seen_at ? html`<${Time} at=${d.last_seen_at} />` : 'never'}</span>
                  <button class="btn sm danger" type="button" onClick=${async () => (await confirmAction({ title: `Unpair ${d.name}?`, confirmLabel: 'Unpair', tone: 'danger' })) && api.revokeDevice(d.id).then(load).catch(toast)}>Unpair</button>
                </div>
              </div>`
            )}
          </div>`
        : null}
      <div class="row">
        <button class="btn" type="button" onClick=${() => api.pairing().then(setPairing).catch(toast)}>Pair a device</button>
      </div>
      ${pairing
        ? html`<div class="pairing">
            ${pairing.qr ? html`<div class="qr" dangerouslySetInnerHTML=${{ __html: pairing.qr }}></div>` : null}
            <div class="stack">
              ${pairing.urls.length
                ? pairing.urls.map((u) => html`<code class="pair-url">${u}</code>`)
                : html`<p>No address for other devices is known. On the server run <code>ai-code share</code>, or set <code>AI_CODE_PUBLIC_URL</code>, then pair again. Code: <code>${pairing.code}</code></p>`}
              <p class="muted">Open it on the other device within 10 minutes. It works once.</p>
            </div>
          </div>`
        : null}
    </section>
  `;
}

function urlBase64ToUint8Array(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function Notifications() {
  const key = useStore((s) => s.push);
  const [sub, setSub] = useState(undefined);
  const supported = 'serviceWorker' in navigator && 'PushManager' in window;
  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then(setSub).catch(() => setSub(null));
  }, []);
  const enable = async () => {
    try {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for this site');
      const reg = await navigator.serviceWorker.ready;
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
      await api.pushSubscribe(s.toJSON());
      setSub(s);
      showToast('Notifications on', 'success');
    } catch (e) {
      toast(e);
    }
  };
  const disable = async () => {
    await api.pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => {});
    setSub(null);
  };
  return html`
    <section class="section card">
      <h2>Notifications</h2>
      <p class="muted">A push to this device when Claude needs an approval or finishes a turn.</p>
      ${!supported || !key
        ? html`<p class="muted">Not available here. Push needs HTTPS (the tailnet address) and, on iOS, the app added to the home screen.</p>`
        : sub
          ? html`<button class="btn secondary" type="button" onClick=${disable}>Turn off on this device</button>`
          : html`<button class="btn" type="button" disabled=${sub === undefined} onClick=${enable}>Turn on for this device</button>`}
    </section>
  `;
}

function Usage() {
  const projects = useStore((s) => s.projects);
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api.usage().then(setRows).catch(() => setRows([]));
  }, []);
  if (!rows?.length) return null;
  const by = new Map();
  for (const r of rows) by.set(r.project_id, (by.get(r.project_id) || 0) + r.cost);
  return html`
    <section class="section card">
      <h2>Spend</h2>
      <p class="muted">Estimates from Claude Code, at each model's published price. A subscription is not billed per token.</p>
      <div class="list">${[...by].map(([pid, cost]) => html`<div class="list-row"><span>${projects.find((p) => p.id === pid)?.name || 'Removed project'}</span><span class="mono-sm">${formatCost(cost)}</span></div>`)}</div>
    </section>
  `;
}

function Doctor() {
  const [checks, setChecks] = useState(null);
  const [server, setServer] = useState(null);
  useEffect(() => {
    api.doctor().then((r) => setChecks(r.checks)).catch(toast);
    api.status().then(setServer).catch(() => {});
  }, []);
  return html`
    <section class="section card">
      <h2>Diagnostics</h2>
      ${checks
        ? html`<div class="checks">${checks.map((c) => html`<div class="check-row"><span class=${c.ok ? 'good' : c.optional ? 'muted' : 'bad'}>${c.ok ? '✓' : c.optional ? '–' : '✗'}</span><strong>${c.name}</strong><span class="muted">${c.detail}</span></div>`)}</div>`
        : html`<span class="muted">Checking…</span>`}
      ${server ? html`<p class="muted mono-sm">ai-code ${server.version} · pid ${server.pid} · data in ${server.root}</p>` : null}
    </section>
  `;
}
