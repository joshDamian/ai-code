// The state of something, as a word a person reads and a tone they scan for.
//
// Two things this gets right that a single "warning" bucket did not. First, the
// state waits on a person or it does not: AWAITING_APPROVAL and AWAITING_DECISION
// are the only states where the pipeline has stopped and nothing moves until
// somebody answers, so they get their own tone rather than sharing the amber that
// also means "an agent is working". Second, `Disabled` is not a failure. It was
// rendered in the error tone, which put a switch that is off in the same colour as
// a task that broke.
import { html } from '../lib.mjs';
import { formatState } from '../lib.mjs';

// Waiting on a person. The pipeline is stopped rather than broken.
const INFO = new Set(['AWAITING_APPROVAL', 'AWAITING_DECISION', 'WAITING']);
// Work in flight. These get the pulsing dot, because the state is not a verdict -
// it is a placeholder for one that is coming.
const WORKING = new Set(['WORKING', 'PLANNING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'REPAIRING', 'running', 'CREATED', 'CONTEXT_READY', 'APPROVED']);
const GOOD = new Set(['COMPLETE', 'APPROVED', 'succeeded', 'ok', 'Enabled', 'good', 'HEALTHY']);
const BAD = new Set(['FAILED', 'failed', 'bad', 'error', 'OPEN']);

function toneOf(status) {
  if (INFO.has(status)) return 'info';
  if (GOOD.has(status)) return 'good';
  if (BAD.has(status)) return 'bad';
  if (WORKING.has(status)) return 'warn';
  return 'neutral';
}

export function StatusBadge({ status }) {
  if (status == null || status === '') return null;
  const tone = toneOf(status);
  const working = WORKING.has(status);
  // `title` stays the raw enum: the label is for reading, and the identifier is
  // what a person quotes when they ask about it or paste it into a bug report.
  return html`
    <span
      class="badge badge-${tone} ${working ? 'badge-working' : ''}"
      title=${String(status)}
    >${formatState(status)}</span>
  `;
}
