import { html } from '../lib.mjs';

// Circuit-breaker indicator for a provider card.
//
// The three states reuse the existing palette - HEALTHY is good, DEGRADED is warn,
// OPEN is bad - so a breach reads the same colour as every other problem in the
// dashboard. The state name and the cooldown live in the tooltip rather than on
// the card, which keeps the card head to one line.
const LABELS = { HEALTHY: 'Healthy', DEGRADED: 'Degraded', OPEN: 'Circuit open' };

export function HealthDot({ health }) {
  if (!health) return null;
  const cls = health.state === 'OPEN' ? 'bad' : health.state === 'DEGRADED' ? 'warn' : 'good';
  const seconds = Math.ceil((health.cooldownRemainingMs || 0) / 1000);
  const label = LABELS[health.state] || health.state;
  const detail =
    cls === 'bad' && seconds > 0
      ? `${label} - retrying in ${seconds}s`
      : `${label}${health.failures ? ` - ${health.failures} recent failure${health.failures === 1 ? '' : 's'}` : ''}`;
  return html`<span class="health ${cls}" title=${detail} aria-label=${detail}></span>`;
}
