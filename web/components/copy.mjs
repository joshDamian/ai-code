// Copy to the clipboard, and say so. The clipboard API needs a secure context and a
// user gesture; every caller here is a click, so a refusal means the browser will not
// allow it at all, and the toast says that rather than pretending it worked. Unlike
// the copy of a task id, the text is not put in the toast instead: a response or a
// code block is too long to read back from one.
import { html, useState, useEffect } from '../lib.mjs';
import { showToast } from './toast.mjs';

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    showToast('This browser did not allow copying to the clipboard.', 'error');
    return false;
  }
}

// How long a button reads "Copied" before it goes back to "Copy".
export const COPIED_MS = 1500;

// The two-sheets glyph and the tick it turns into, as markup strings so the code
// block buttons, which are built outside Preact, draw the same icons as this one.
export const COPY_ICON = '<svg class="copy-ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>';
export const COPIED_ICON = '<svg class="copy-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';

export function CopyButton({ text, label = 'Copy', className = '' }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  return html`
    <button class="copy-btn ${className}" type="button" onClick=${async () => setCopied(await copyText(text))}>
      <span dangerouslySetInnerHTML=${{ __html: copied ? COPIED_ICON : COPY_ICON }} />
      <span aria-live="polite">${copied ? 'Copied' : label}</span>
    </button>
  `;
}
