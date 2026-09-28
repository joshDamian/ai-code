// What a screen says when it has nothing to show.
//
// `message` alone answers "why is this empty" and stops there, which leaves a
// person on a blank page with no way forward. `title` names the state, `hint`
// says what would change it, and `action` is the way to change it - so an empty
// screen is a place with a next step rather than a dead end.
//
// Every prop past `message` is optional, because most callers only have a
// sentence to give and a half-filled empty state still beats a blank one.
import { html } from '../lib.mjs';

export function EmptyState({ message, title, hint, icon, actionLabel, onAction }) {
  return html`
    <div class="empty-state">
      ${icon ? html`<div class="empty-icon">${icon}</div>` : null}
      ${title ? html`<p class="empty-title">${title}</p>` : null}
      <p class="muted">${message}</p>
      ${hint ? html`<p class="empty-hint muted">${hint}</p>` : null}
      ${actionLabel ? html`<button class="btn primary" onClick=${onAction}>${actionLabel}</button>` : null}
    </div>
  `;
}
