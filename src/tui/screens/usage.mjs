// Usage: cost/token aggregates and by-provider breakdown.
// Aggregation happens server-side (GET /api/usage) instead of over the full run
// list, so the screen costs one small response no matter how long the history is.
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { SimpleTable } from '../components/table.mjs';
import { formatTokens, formatCost } from '../../format.mjs';

const e = React.createElement;

const PERIODS = ['24h', '7d', '30d', 'all'];
const PERIOD_LABELS = { '24h': 'last 24h', '7d': 'last 7 days', '30d': 'last 30 days', all: 'all time' };

function MetricBox({ label, value, color }) {
  return e(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: color || 'gray', paddingX: 2, marginRight: 1, width: 19 },
    e(Text, { color: 'gray' }, label),
    e(Text, { bold: true, color: color || 'white' }, String(value)),
  );
}

export function UsageScreen({ api, isActive, onError, setFooter }) {
  const [period, setPeriod] = useState('7d');
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    let live = true;
    setUsage(null);
    api
      .usage(period)
      .then((d) => live && setUsage(d))
      .catch((err) => live && onError?.(err.message));
    return () => {
      live = false;
    };
  }, [period]);

  useEffect(() => {
    setFooter?.([['p', 'period']]);
  }, []);

  useInput(
    (input) => {
      if (input === 'p') setPeriod((prev) => PERIODS[(PERIODS.indexOf(prev) + 1) % PERIODS.length]);
    },
    { isActive },
  );

  if (!usage) return e(Text, { color: 'gray' }, `Loading usage (${PERIOD_LABELS[period]})…`);

  const totals = usage.totals || {};
  const byProvider = (usage.by_provider || []).map((p) => ({
    provider: p.provider,
    runs: p.runs,
    tokens: formatTokens(p.tokens),
    cost: formatCost(p.cost),
    failed: p.failed,
  }));

  return e(
    Box,
    { flexDirection: 'column' },
    e(
      Box,
      { flexDirection: 'row' },
      e(Text, { bold: true }, `Usage — ${PERIOD_LABELS[usage.period] || usage.period}`),
      usage.since ? e(Text, { color: 'gray' }, `  since ${new Date(usage.since).toLocaleString()}`) : null,
    ),
    e(Box, { height: 1 }),
    e(
      Box,
      { flexDirection: 'row', flexWrap: 'wrap' },
      e(MetricBox, { label: 'Total Cost', value: formatCost(totals.cost), color: 'green' }),
      e(MetricBox, { label: 'Total Tokens', value: formatTokens(totals.tokens), color: 'blue' }),
      e(MetricBox, { label: 'Runs', value: totals.runs ?? 0, color: 'cyan' }),
      e(MetricBox, { label: 'Failed', value: totals.failed ?? 0, color: 'red' }),
      e(MetricBox, { label: 'Fallbacks', value: totals.fallbacks ?? 0, color: 'yellow' }),
    ),
    e(Box, { height: 1 }),
    e(Text, { bold: true }, 'By Provider'),
    byProvider.length
      ? e(SimpleTable, {
          data: byProvider,
          columns: ['provider', 'runs', 'tokens', 'cost', 'failed'],
          widths: { provider: 26, runs: 7, tokens: 9, cost: 9, failed: 8 },
        })
      : e(Text, { color: 'gray' }, 'No runs in this period.'),
  );
}
