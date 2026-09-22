import { html } from '../lib.mjs';

export function Spinner({ message }) {
  return html`
    <div class="spinner-wrap">
      <span class="spinner"></span>
      ${message ? html`<span class="spinner-msg muted">${message}</span>` : null}
    </div>
  `;
}
