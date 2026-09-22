import { html } from '../lib.mjs';

export function EmptyState({ message, actionLabel, onAction }) {
  return html`
    <div class="empty-state">
      <p class="muted">${message}</p>
      ${actionLabel ? html`<button class="btn" onClick=${onAction}>${actionLabel}</button>` : null}
    </div>
  `;
}
