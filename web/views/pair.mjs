// Trading a one-time pairing code for this device's own access, and what a device that
// has none sees instead.
import { html, useState } from '../lib.mjs';
import { api } from '../api.mjs';

function guessName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Browser';
}

export function Pair({ code }) {
  const [name, setName] = useState(guessName());
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const pair = async () => {
    setBusy(true);
    try {
      await api.pair(code, name);
      location.replace('/#/');
      location.reload();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };
  return html`
    <div class="gate">
      <div class="card gate-card">
        <h1>Pair this device</h1>
        <p class="muted">It will be able to run Claude sessions on this server until you unpair it in Settings.</p>
        <label class="field"><span class="field-label">Name it</span><input class="input" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
        ${error ? html`<div class="notice notice-bad">${error}</div>` : null}
        <button class="btn" type="button" disabled=${busy || !name.trim()} onClick=${pair}>${busy ? 'Pairing…' : 'Pair'}</button>
      </div>
    </div>
  `;
}

export function Unpaired() {
  return html`
    <div class="gate">
      <div class="card gate-card">
        <h1>This device is not paired</h1>
        <p>On the machine running Bench, open Settings and choose <strong>Pair a device</strong>, or run <code>bench pair</code>. Then open the link it gives you here.</p>
      </div>
    </div>
  `;
}
