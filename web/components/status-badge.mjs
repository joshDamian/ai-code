import { html } from '../lib.mjs';

const GOOD = new Set(['COMPLETE', 'succeeded', 'ok', 'Enabled', 'good', 'APPROVED']);
const BAD = new Set(['FAILED', 'failed', 'Disabled', 'bad', 'error']);
const WARN = new Set(['AWAITING_APPROVAL', 'REPAIRING', 'PLANNING', 'REVIEWING', 'IMPLEMENTING', 'TESTING', 'warn', 'running']);

export function StatusBadge({ status }) {
  let cls = 'neutral';
  if (GOOD.has(status)) cls = 'good';
  else if (BAD.has(status)) cls = 'bad';
  else if (WARN.has(status)) cls = 'warn';
  return html`<span class="badge badge-${cls}">${status}</span>`;
}
