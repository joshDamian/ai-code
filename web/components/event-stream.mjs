// Human-readable activity feed. One row per event that has something to say: the
// badge is the kind, the message is the fact, and the time is the clock.
import { html, describeEvent } from '../lib.mjs';

const COLOR = { error: 'bad', limit: 'warn', done: 'good' };
const colorFor = (kind) => COLOR[kind] || 'neutral';

// The stored timestamp is a 24-character ISO string. The clock time is the part a
// reader uses, and the full value stays in the title attribute for the rest.
function timeOf(iso) {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString();
}

export function EventStream({ events }) {
  if (!events || !events.length) {
    return html`<div class="muted">No events yet.</div>`;
  }
  // Rendering the stored `type` is what used to fill this feed with rows reading
  // "message". An event whose formatter returns nothing is dropped instead.
  const rows = [];
  events.forEach((e, i) => {
    const described = describeEvent(e);
    if (described) rows.push({ e, described, key: e.id || i });
  });
  if (!rows.length) {
    return html`<div class="muted">Nothing to show yet.</div>`;
  }
  return html`
    <div class="event-stream">
      ${rows.map(
        ({ e, described, key }) => html`
          <div class="event-row kind-${described.kind}" key=${key}>
            <span class="badge badge-${colorFor(described.kind)}">${described.kind}</span>
            <span class="event-msg">${described.text}</span>
            <span class="event-time muted" title=${e.created_at || ''}>${timeOf(e.created_at)}</span>
          </div>
        `
      )}
    </div>
  `;
}
