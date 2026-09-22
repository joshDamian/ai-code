// Model output rendered as markdown. This is the only file in the dashboard that
// turns untrusted text into HTML, so the sanitiser lives here and nowhere else -
// every other component goes through htm and gets escaping for free.
import { html } from '../lib.mjs';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// A link in a plan points at the outside world. Following it in the dashboard's
// own tab navigates away from a task mid-review with no way back, and rel=noopener
// drops the window.opener handle it would otherwise hand the destination.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// `marked` passes raw HTML through, which is the point of the sanitiser rather
// than a mode to enable: the allow-list is DOMPurify's, and USE_PROFILES keeps it
// to HTML so SVG and MathML are not reachable from a plan.
export function Markdown({ text, className = 'md' }) {
  if (!text) return null;
  const clean = DOMPurify.sanitize(marked.parse(text), { USE_PROFILES: { html: true } });
  return html`<div class=${className} dangerouslySetInnerHTML=${{ __html: clean }} />`;
}
