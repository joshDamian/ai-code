// Runs: history table, most recent first (server already sorts DESC).
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { SimpleTable } from '../components/table.mjs';
import { formatDuration, formatTokens, formatCost } from '../../format.mjs';

const e = React.createElement;

export function RunsScreen({ api, isActive, onError, setFooter }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const rows = await api.runs();
      setRuns(rows);
    } catch (err) {
      onError?.(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setFooter?.([['r', 'refresh']]);
  }, []);

  useInput(
    (input) => {
      if (input === 'r') load();
    },
    { isActive },
  );

  if (loading) return e(Text, { color: 'gray' }, 'Loading runs…');
  if (!runs.length) return e(Text, { color: 'gray' }, 'No runs yet.');

  const data = runs.slice(0, 40).map((r) => ({
    role: r.role || '',
    provider: (r.provider_id || '').replace(/-claude-code$/, ''),
    model: (r.model_id || '').split(':').pop(),
    status: r.status || '',
    tokens: formatTokens(r.tokens),
    cost: formatCost(r.cost),
    duration: formatDuration(r.duration_ms),
  }));

  return e(
    Box,
    { flexDirection: 'column' },
    e(Text, { bold: true }, `Runs (${runs.length})`),
    e(SimpleTable, {
      data,
      columns: ['role', 'provider', 'model', 'status', 'tokens', 'cost', 'duration'],
      widths: { role: 13, provider: 11, model: 18, status: 12, tokens: 8, cost: 9, duration: 9 },
    }),
  );
}
