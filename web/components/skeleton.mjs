// First-paint placeholders. Three shapes cover the app's first loads - a list row,
// a table, and the metric cards - and each is sized from the same spacing scale as
// the real thing it stands in for, so the layout does not jump when data arrives.
import { html } from '../lib.mjs';

const range = (n) => Array.from({ length: n }, (_, i) => i);

export function SkeletonRows({ count = 6 }) {
  return html`
    <div class="skeleton-list" role="status" aria-label="Loading">
      ${range(count).map(
        (i) => html`
          <div class="skeleton-row" key=${i}>
            <div class="skeleton-lines">
              <span class="skeleton skeleton-line"></span>
              <span class="skeleton skeleton-line short"></span>
            </div>
            <span class="skeleton skeleton-badge"></span>
          </div>
        `
      )}
    </div>
  `;
}

export function SkeletonTable({ rows = 6, cols = 4 }) {
  return html`
    <div class="skeleton-table" role="status" aria-label="Loading">
      ${range(rows).map(
        (r) => html`
          <div class="skeleton-trow" key=${r}>
            ${range(cols).map((c) => html`<span class="skeleton skeleton-cell" key=${c}></span>`)}
          </div>
        `
      )}
    </div>
  `;
}

export function SkeletonCards({ count = 4 }) {
  return html`
    <div class="metric-grid" role="status" aria-label="Loading">
      ${range(count).map(
        (i) => html`
          <div class="card metric-card" key=${i}>
            <span class="skeleton skeleton-line short"></span>
            <span class="skeleton skeleton-value"></span>
          </div>
        `
      )}
    </div>
  `;
}
