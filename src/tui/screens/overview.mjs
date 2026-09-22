// Overview: metric boxes + active tasks + provider health. Polls every 3s.
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { StatusBadge, EnabledBadge, HealthBadge } from '../components/status.mjs';

const e = React.createElement;

const ACTIVE_STATES = ['CREATED', 'CONTEXT_READY', 'PLANNING', 'AWAITING_APPROVAL', 'APPROVED', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'REPAIRING'];

function MetricBox({ label, value, color }) {
  return e(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: color || 'gray', paddingX: 2, marginRight: 1, width: 20 },
    e(Text, { color: 'gray' }, label),
    e(Text, { bold: true, color: color || 'white' }, String(value)),
  );
}

export function OverviewScreen({ api, isActive, onOpenTask, onError, setFooter }) {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    setFooter?.([['j/k', 'move'], ['Enter', 'open task']]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const d = await api.overview();
        if (!cancelled) setData(d);
      } catch (err) {
        if (!cancelled) onError?.(err.message);
      }
    };
    load();
    const timer = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api]);

  const activeTasks = (data?.tasks || []).filter((t) => ACTIVE_STATES.includes(t.state));

  useInput(
    (input, key) => {
      if (!activeTasks.length) return;
      if (input === 'j' || key.downArrow) setSelected((i) => Math.min(i + 1, activeTasks.length - 1));
      if (input === 'k' || key.upArrow) setSelected((i) => Math.max(i - 1, 0));
      if (key.return && activeTasks[selected]) onOpenTask(activeTasks[selected].id);
    },
    { isActive },
  );

  if (!data) return e(Text, { color: 'gray' }, 'Loading overview…');

  const activeProviders = (data.providers || []).filter((p) => p.enabled).length;
  const health = new Map((data.health || []).map((h) => [h.providerId, h]));
  const jobs = data.jobs || [];

  return e(
    Box,
    { flexDirection: 'column' },
    e(
      Box,
      { flexDirection: 'row', flexWrap: 'wrap' },
      e(MetricBox, { label: 'Projects', value: data.projects.length, color: 'blue' }),
      e(MetricBox, { label: 'Active Tasks', value: activeTasks.length, color: 'yellow' }),
      e(MetricBox, { label: 'Total Runs', value: data.runs.length, color: 'cyan' }),
      e(MetricBox, { label: 'Active Providers', value: activeProviders, color: 'green' }),
      e(MetricBox, { label: 'Queued Jobs', value: jobs.length, color: jobs.length ? 'magenta' : 'gray' }),
    ),
    e(Box, { height: 1 }),
    e(Text, { bold: true }, `Active Tasks (${activeTasks.length})`),
    activeTasks.length === 0
      ? e(Text, { color: 'gray' }, '  No active tasks.')
      : e(
          Box,
          { flexDirection: 'column' },
          ...activeTasks.slice(0, 10).map((t, i) =>
            e(
              Box,
              { key: t.id, flexDirection: 'row' },
              e(Text, { color: i === selected ? 'blue' : undefined, bold: i === selected }, `${i === selected ? '›' : ' '} ${t.title.slice(0, 40).padEnd(40)}`),
              e(StatusBadge, { state: t.state }),
            ),
          ),
        ),
    e(Box, { height: 1 }),
    e(Text, { bold: true }, 'Provider Health'),
    e(
      Box,
      { flexDirection: 'column' },
      ...(data.providers || []).map((p) =>
        e(
          Box,
          { key: p.id, flexDirection: 'row' },
          e(Text, {}, `  ${p.name.padEnd(30)}`),
          e(EnabledBadge, { enabled: p.enabled }),
          e(Text, {}, ' '),
          e(HealthBadge, { health: health.get(p.id) }),
        ),
      ),
    ),
    jobs.length
      ? e(
          Box,
          { flexDirection: 'column' },
          e(Box, { height: 1 }),
          e(Text, { bold: true }, `Background Jobs (${jobs.length})`),
          ...jobs.map((j) =>
            e(
              Text,
              { key: j.id, color: 'gray' },
              `  ${j.kind.padEnd(10)} ${j.state.padEnd(8)} ${String(j.task_id).slice(0, 8)}`,
            ),
          ),
        )
      : null,
  );
}
