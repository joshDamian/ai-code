// Diff viewer: monospace, line numbers, +/- highlighting, in two views.
//
// Unified is the default: it is what a reviewer reads and what the port assessment is
// written about. Split puts the old and the new version of a line beside each other,
// which is what makes a rewrite legible as a rewrite rather than as a deletion
// followed by an unrelated addition.
//
// Both come from src/format.mjs, which the browser is served rather than a copy of -
// so what decides whether a line is content, and which two lines sit opposite each
// other, is the same code here as everywhere else, and it has a test that needs no DOM.
import { html, useState, diffLines, diffSides } from '../lib.mjs';

export function DiffViewer({ diff }) {
  const [split, setSplit] = useState(false);
  if (!diff) return null;
  return html`
    <div class="diff-frame">
      <div class="diff-modes">
        <button class="btn secondary ${split ? '' : 'on'}" onClick=${() => setSplit(false)}>Unified</button>
        <button class="btn secondary ${split ? 'on' : ''}" onClick=${() => setSplit(true)}>Split</button>
      </div>
      ${split ? html`<${SplitDiff} diff=${diff} />` : html`<${UnifiedDiff} diff=${diff} />`}
    </div>
  `;
}

function UnifiedDiff({ diff }) {
  return html`
    <div class="diff-viewer">
      ${diffLines(diff).map(
        (l, i) => html`
          <div class="diff-line ${l.cls}" key=${i}>
            <span class="diff-lineno">${l.old}</span>
            <span class="diff-lineno">${l.new}</span>
            <span class="diff-text">${l.text || ' '}</span>
          </div>
        `
      )}
    </div>
  `;
}

function SplitDiff({ diff }) {
  return html`
    <div class="diff-viewer diff-split">
      ${diffSides(diff).map((r, i) =>
        r.kind === 'span'
          ? html`<div class="diff-line ${r.line.cls} diff-span" key=${i}>
              <span class="diff-text">${r.line.text || ' '}</span>
            </div>`
          : html`<div class="diff-row" key=${i}>
              <${Cell} cell=${r.left} />
              <${Cell} cell=${r.right} />
            </div>`
      )}
    </div>
  `;
}

// One side of one line, or the empty half of a row whose other side ran longer. The
// gap is rendered rather than left out, because the two columns still have to line up
// under the rows above and below it.
function Cell({ cell }) {
  return html`
    <div class="diff-cell ${cell ? cell.cls : 'diff-blank'}">
      <span class="diff-lineno">${cell ? cell.no : ''}</span>
      <span class="diff-text">${cell ? cell.text || ' ' : ''}</span>
    </div>
  `;
}
