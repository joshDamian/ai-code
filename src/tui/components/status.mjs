// Colored state badges shared across screens.
import React from 'react';
import { Text } from 'ink';
import { formatState, stateColor } from '../../format.mjs';

const e = React.createElement;

const COLOR = { good: 'green', bad: 'red', warn: 'yellow' };

function colorForRaw(raw, key) {
  if (raw === 'running') return 'cyan';
  if (raw === 'cancelled') return 'gray';
  return COLOR[key] || 'blue';
}

// Generic badge for a task/run state string, e.g. AWAITING_APPROVAL, succeeded.
export function StatusBadge({ state, label }) {
  const key = stateColor(state);
  const color = colorForRaw(state, key);
  const text = label || formatState(state);
  return e(Text, { color, bold: true }, `● ${text}`);
}

// Boolean enabled/disabled badge, used by Providers.
export function EnabledBadge({ enabled }) {
  return enabled
    ? e(Text, { color: 'green', bold: true }, '● enabled')
    : e(Text, { color: 'gray' }, '○ disabled');
}

// Circuit-breaker state for a provider. The three states carry the same meaning
// and the same colours as the web dashboard's dot, so the two read alike.
export function HealthBadge({ health }) {
  if (!health) return null;
  const seconds = Math.ceil((health.cooldownRemainingMs || 0) / 1000);
  const spec =
    {
      OPEN: { color: 'red', label: seconds > 0 ? `circuit open ${seconds}s` : 'circuit open' },
      DEGRADED: { color: 'yellow', label: 'degraded' },
      HEALTHY: { color: 'green', label: 'healthy' },
    }[health.state] || { color: 'gray', label: String(health.state).toLowerCase() };
  return e(Text, { color: spec.color, bold: health.state !== 'HEALTHY' }, `● ${spec.label}`);
}
