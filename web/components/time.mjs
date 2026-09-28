// A moment, in the words a person would use for it, with the machine's own answer
// one hover away.
//
// Every date on this dashboard used to be `toLocaleString()`, which prints
// "9/28/2026, 4:17:03 PM" - a string that is exact and unreadable. A list of them
// cannot be scanned, because the part that matters ("three minutes ago") is the
// part at the end and the part that is identical on every row is at the front.
//
// The `<time>` element carries both halves: `datetime` is the machine value, which
// is what a parser or an assistive technology wants, and `title` is the exact
// stamp, which is what a person wants when the relative form is not enough.
import { html } from '../lib.mjs';
import { formatWhen } from '../lib.mjs';

export function Time({ at, now }) {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return html`<span class="muted">—</span>`;
  const full = new Date(ms).toLocaleString();
  return html`<time class="time" datetime=${new Date(ms).toISOString()} title=${full}>${formatWhen(at, now)}</time>`;
}
