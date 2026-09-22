// Tasks: state-filtered list with inline task creation.
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { StatusBadge } from '../components/status.mjs';

const e = React.createElement;

const FILTERS = [
  { key: '1', id: 'all', label: 'All', states: null },
  { key: '2', id: 'active', label: 'Active', states: 'CREATED,CONTEXT_READY,PLANNING,APPROVED,IMPLEMENTING,TESTING,REVIEWING,REPAIRING' },
  { key: '3', id: 'awaiting', label: 'Awaiting', states: 'AWAITING_APPROVAL' },
  { key: '4', id: 'complete', label: 'Complete', states: 'COMPLETE' },
  { key: '5', id: 'failed', label: 'Failed', states: 'FAILED' },
];

export function TasksScreen({ api, isActive, onOpenTask, setTyping, onError, onMessage, setFooter }) {
  const [filter, setFilter] = useState('all');
  const [tasks, setTasks] = useState([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(null); // null | 'projectId' | 'title'
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');

  const active = FILTERS.find((f) => f.id === filter);

  const load = async () => {
    try {
      setLoading(true);
      const rows = await api.tasks({ state: active.states || undefined });
      setTasks(rows);
      setSelected((i) => Math.min(i, Math.max(rows.length - 1, 0)));
    } catch (err) {
      onError?.(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [filter]);

  useEffect(() => {
    setTyping?.(step !== null);
  }, [step]);

  useEffect(() => {
    setFooter?.([['1-5', 'filter'], ['j/k', 'move'], ['Enter', 'open'], ['n', 'new task']]);
  }, []);

  const startCreate = () => {
    setProjectId('');
    setTitle('');
    setStep('projectId');
  };

  const submitProjectId = (value) => {
    if (!value.trim()) return;
    setProjectId(value.trim());
    setStep('title');
  };

  const submitTitle = async (value) => {
    if (!value.trim()) return;
    setStep(null);
    try {
      await api.createTask(projectId, value.trim());
      onMessage?.({ text: `Task created for project ${projectId}`, color: 'green' });
      await load();
    } catch (err) {
      onError?.(err.message);
    }
  };

  useInput(
    (input, key) => {
      if (step !== null) {
        if (key.escape) setStep(null);
        return;
      }
      const filterMatch = FILTERS.find((f) => f.key === input);
      if (filterMatch) {
        setFilter(filterMatch.id);
        setSelected(0);
        return;
      }
      if (input === 'n') return startCreate();
      if (!tasks.length) return;
      if (input === 'j' || key.downArrow) setSelected((i) => Math.min(i + 1, tasks.length - 1));
      if (input === 'k' || key.upArrow) setSelected((i) => Math.max(i - 1, 0));
      if (key.return && tasks[selected]) onOpenTask(tasks[selected].id);
    },
    { isActive },
  );

  return e(
    Box,
    { flexDirection: 'column' },
    e(
      Box,
      { flexDirection: 'row' },
      ...FILTERS.map((f) =>
        e(
          Text,
          {
            key: f.id,
            color: f.id === filter ? 'black' : 'gray',
            backgroundColor: f.id === filter ? 'blue' : undefined,
            bold: f.id === filter,
          },
          ` [${f.key}] ${f.label} `,
        ),
      ),
    ),
    e(Box, { height: 1 }),
    step !== null
      ? e(
          Box,
          { flexDirection: 'column', borderStyle: 'round', borderColor: 'blue', paddingX: 1 },
          e(Text, { bold: true }, 'New Task'),
          step === 'projectId'
            ? e(
                Box,
                { flexDirection: 'row' },
                e(Text, {}, 'Project ID: '),
                e(TextInput, { value: projectId, onChange: setProjectId, onSubmit: submitProjectId }),
              )
            : e(
                Box,
                { flexDirection: 'row' },
                e(Text, {}, `Project ${projectId} — Title: `),
                e(TextInput, { value: title, onChange: setTitle, onSubmit: submitTitle }),
              ),
          e(Text, { color: 'gray' }, 'Enter to confirm, Esc to cancel'),
        )
      : loading
      ? e(Text, { color: 'gray' }, 'Loading tasks…')
      : tasks.length === 0
      ? e(Text, { color: 'gray' }, 'No tasks match this filter. Press n to create one.')
      : e(
          Box,
          { flexDirection: 'column' },
          ...tasks.map((t, i) =>
            e(
              Box,
              { key: t.id, flexDirection: 'row' },
              e(Text, { color: i === selected ? 'blue' : undefined, bold: i === selected }, `${i === selected ? '›' : ' '} `),
              e(StatusBadge, { state: t.state }),
              e(Text, {}, ` ${t.title.slice(0, 42).padEnd(42)} `),
              e(Text, { color: 'gray' }, `${String(t.id).slice(0, 8)}  proj:${String(t.project_id).slice(0, 8)}`),
            ),
          ),
        ),
  );
}
