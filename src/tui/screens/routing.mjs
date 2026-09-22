// Routing: per-role policy display. Read-only — edit via CLI or dashboard.
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';

const e = React.createElement;

const ROLES = [
  { id: 'planner', label: 'Planner' },
  { id: 'implementer', label: 'Implementer' },
  { id: 'reviewer', label: 'Reviewer' },
  { id: 'repair', label: 'Repair' },
];

function describeModels(list) {
  if (!list || !list.length) return 'auto (routed by score)';
  return list.join(', ');
}

export function RoutingScreen({ api, isActive, onError, setFooter }) {
  const [policies, setPolicies] = useState(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    api.routing().then(setPolicies).catch((err) => onError?.(err.message));
  }, []);

  useEffect(() => {
    setFooter?.([['j/k', 'move'], ['—', 'read-only: edit via CLI or dashboard']]);
  }, []);

  useInput(
    (input, key) => {
      if (input === 'j' || key.downArrow) setSelected((i) => Math.min(i + 1, ROLES.length - 1));
      if (input === 'k' || key.upArrow) setSelected((i) => Math.max(i - 1, 0));
    },
    { isActive },
  );

  if (!policies) return e(Text, { color: 'gray' }, 'Loading routing policy…');

  return e(
    Box,
    { flexDirection: 'column' },
    e(Text, { color: 'gray' }, 'Read-only. Edit with `ai-code routing set <file>` or the web dashboard.'),
    e(Box, { height: 1 }),
    ...ROLES.map((role, i) => {
      const p = policies[role.id] || {};
      const isSel = i === selected;
      return e(
        Box,
        { key: role.id, flexDirection: 'column', borderStyle: 'round', borderColor: isSel ? 'blue' : 'gray', paddingX: 1, marginBottom: 1 },
        e(Text, { bold: true, color: isSel ? 'blue' : 'white' }, `${isSel ? '› ' : '  '}${role.label}`),
        e(Text, { color: 'gray' }, `  strategy: ${p.strategy || 'balanced'}    effort: ${p.effort || 'medium'}    timeout: ${p.timeout || 600}s`),
        e(Text, { color: 'gray' }, `  preferred: ${describeModels(p.preferred)}`),
        e(Text, { color: 'gray' }, `  fallback:  ${describeModels(p.fallback)}`),
        e(Text, { color: 'gray' }, `  weights:   quality=${p.quality ?? 1} speed=${p.speed ?? 0} cost=${p.cost ?? 0}`),
      );
    }),
  );
}
