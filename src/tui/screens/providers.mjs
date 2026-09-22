// Providers: list with models and a test-connection action.
import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import SelectInput from 'ink-select-input';
import { EnabledBadge, HealthBadge } from '../components/status.mjs';

const e = React.createElement;

export function ProvidersScreen({ api, isActive, setTyping, onError, onMessage, setFooter }) {
  const [providers, setProviders] = useState([]);
  const [models, setModels] = useState([]);
  const [health, setHealth] = useState([]);
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [testing, setTesting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [lastResult, setLastResult] = useState(null);

  const load = async () => {
    try {
      const d = await api.providers();
      setProviders(d.providers);
      setModels(d.models);
      setHealth(d.health || []);
    } catch (err) {
      onError?.(err.message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    setFooter?.([
      ['j/k', 'move'],
      ['Enter', 'expand models'],
      ['t', 'test connection'],
    ]);
  }, []);

  useEffect(() => {
    setTyping?.(picking);
  }, [picking]);

  const current = providers[selected];
  const currentModels = current ? models.filter((m) => m.provider_id === current.id || m.providerId === current.id) : [];

  const runTest = async (modelId) => {
    setPicking(false);
    setTesting(true);
    setLastResult(null);
    try {
      const result = await api.testProvider(current.id, modelId);
      setLastResult(result);
      onMessage?.({ text: result.ok ? `${current.name}: OK` : `${current.name}: ${result.error}`, color: result.ok ? 'green' : 'red' });
    } catch (err) {
      onError?.(err.message);
    } finally {
      setTesting(false);
    }
  };

  useInput(
    (input, key) => {
      if (picking) return;
      if (!providers.length) return;
      if (input === 'j' || key.downArrow) {
        setSelected((i) => Math.min(i + 1, providers.length - 1));
        setExpanded(false);
      }
      if (input === 'k' || key.upArrow) {
        setSelected((i) => Math.max(i - 1, 0));
        setExpanded(false);
      }
      if (key.return) setExpanded((v) => !v);
      if (input === 't' && current && !testing) {
        const enabledModels = currentModels.filter((m) => m.enabled);
        if (enabledModels.length > 1) setPicking(true);
        else runTest(enabledModels[0]?.id);
      }
    },
    { isActive },
  );

  return e(
    Box,
    { flexDirection: 'column' },
    e(
      Box,
      { flexDirection: 'column' },
      ...providers.map((p, i) => {
        const count = models.filter((m) => m.provider_id === p.id || m.providerId === p.id).length;
        const h = health.find((x) => x.providerId === p.id);
        return e(
          Box,
          { key: p.id, flexDirection: 'column' },
          e(
            Box,
            { flexDirection: 'row' },
            e(Text, { color: i === selected ? 'blue' : undefined, bold: i === selected }, `${i === selected ? '›' : ' '} `),
            e(Text, {}, `${p.name.padEnd(28)} `),
            e(Text, { color: 'gray' }, `${p.kind.padEnd(12)} `),
            e(EnabledBadge, { enabled: p.enabled }),
            e(Text, {}, ' '),
            e(HealthBadge, { health: h }),
            e(Text, { color: 'gray' }, `  ${count} model${count === 1 ? '' : 's'}`),
          ),
          i === selected && expanded
            ? e(
                Box,
                { flexDirection: 'column', marginLeft: 4 },
                ...currentModels.map((m) =>
                  e(
                    Text,
                    { key: m.id, color: m.enabled ? 'white' : 'gray' },
                    `${m.enabled ? '•' : '○'} ${(m.displayName || m.name).padEnd(26)} quality:${m.quality ?? '-'} speed:${m.speed ?? '-'} reasoning:${m.reasoning ?? 'unknown'}${m.toolUse === false ? ' no-tools' : ''}`,
                  ),
                ),
              )
            : null,
        );
      }),
    ),
    e(Box, { height: 1 }),
    picking
      ? e(
          Box,
          { flexDirection: 'column', borderStyle: 'round', borderColor: 'blue', paddingX: 1 },
          e(Text, { bold: true }, `Choose a model to test for ${current.name}`),
          e(SelectInput, {
            items: currentModels.filter((m) => m.enabled).map((m) => ({ label: m.displayName || m.name, value: m.id })),
            onSelect: (item) => runTest(item.value),
          }),
        )
      : null,
    testing ? e(Text, { color: 'yellow' }, e(Spinner, { type: 'dots' }), ' testing connection…') : null,
    lastResult
      ? e(
          Box,
          { flexDirection: 'column', borderStyle: 'round', borderColor: lastResult.ok ? 'green' : 'red', paddingX: 1 },
          e(Text, { color: lastResult.ok ? 'green' : 'red', bold: true }, lastResult.ok ? 'Connection OK' : `Connection failed: ${lastResult.error}`),
          lastResult.response ? e(Text, { color: 'gray' }, lastResult.response.slice(0, 200)) : null,
        )
      : null,
  );
}
