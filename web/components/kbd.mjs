// Keyboard shortcut indicators and the shortcut legend.
//
// SHORTCUTS is the single source of truth: the legend renders from it, and
// app.mjs is the handler that implements it. Keys are an array so two-key
// sequences ("g" then "o") render as two keycaps.
import { html } from '../lib.mjs';

export const SHORTCUTS = [
  { keys: ['g', 'o'], label: 'Go to overview' },
  { keys: ['g', 't'], label: 'Go to tasks' },
  { keys: ['g', 'p'], label: 'Go to providers' },
  { keys: ['g', 'r'], label: 'Go to runs' },
  { keys: ['n'], label: 'New task (from the tasks view)' },
  { keys: ['/'], label: 'Focus search' },
  { keys: ['Esc'], label: 'Close dialog or clear search' },
  { keys: ['?'], label: 'Toggle this legend' },
];

// One keycap.
export function Kbd({ children }) {
  return html`<kbd class="kbd">${children}</kbd>`;
}

// Read-only keycaps for inline hints ("press ? for shortcuts").
export function KbdHint({ keys = [], label }) {
  return html`
    <span class="kbd-hint">
      ${keys.map((k) => html`<${Kbd} key=${k}>${k}<//>`)}
      ${label ? html`<span class="muted">${label}</span>` : null}
    </span>
  `;
}

export function ShortcutLegend({ open, onClose }) {
  if (!open) return null;
  return html`
    <div class="kbd-overlay" onClick=${onClose}>
      <div
        class="kbd-legend card"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick=${(e) => e.stopPropagation()}
      >
        <div class="kbd-legend-head">
          <h2>Keyboard shortcuts</h2>
          <button class="btn secondary" onClick=${onClose}>Close</button>
        </div>
        <ul class="kbd-list">
          ${SHORTCUTS.map(
            (s) => html`
              <li class="kbd-row" key=${s.label}>
                <span class="kbd-keys">${s.keys.map((k) => html`<${Kbd} key=${k}>${k}<//>`)}</span>
                <span class="kbd-row-label">${s.label}</span>
              </li>
            `
          )}
        </ul>
      </div>
    </div>
  `;
}
