// Root App component, screen router, and the startTUI() entry point used by
// `ai-code tui` (see src/cli.mjs).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { render, Box, useInput } from 'ink';
import { createApi } from './api.mjs';
import { Layout, NAV_ITEMS } from './components/layout.mjs';
import { KeybindBar, GLOBAL_BINDS, HelpOverlay } from './components/keybinds.mjs';
import { OverviewScreen } from './screens/overview.mjs';
import { TasksScreen } from './screens/tasks.mjs';
import { TaskDetailScreen } from './screens/task.mjs';
import { ProvidersScreen } from './screens/providers.mjs';
import { RoutingScreen } from './screens/routing.mjs';
import { RunsScreen } from './screens/runs.mjs';
import { UsageScreen } from './screens/usage.mjs';

const e = React.createElement;
const NAV_KEYS = NAV_ITEMS.map((i) => i.key);

function App({ baseUrl }) {
  const api = useMemo(() => createApi(baseUrl), [baseUrl]);
  const [screen, setScreen] = useState('overview');
  const [taskId, setTaskId] = useState(null);
  const [typing, setTyping] = useState(false);
  const [footerBinds, setFooterBinds] = useState([]);
  const [banner, setBanner] = useState(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [connected, setConnected] = useState(true);

  // Lightweight heartbeat for the header connectivity dot.
  useEffect(() => {
    let cancelled = false;
    const ping = async () => {
      try {
        await api.overview();
        if (!cancelled) setConnected(true);
      } catch {
        if (!cancelled) setConnected(false);
      }
    };
    ping();
    const timer = setInterval(ping, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api]);

  // Auto-dismiss the banner after a few seconds.
  useEffect(() => {
    if (!banner) return undefined;
    const timer = setTimeout(() => setBanner(null), 4000);
    return () => clearTimeout(timer);
  }, [banner]);

  const onError = useCallback((message) => setBanner({ text: message, color: 'red' }), []);
  const onMessage = useCallback((msg) => setBanner(msg), []);
  const onOpenTask = useCallback((id) => {
    setScreen('tasks');
    setTaskId(id);
  }, []);
  const onBack = useCallback(() => setTaskId(null), []);

  const cycle = useCallback(
    (dir) => {
      const idx = NAV_KEYS.indexOf(screen);
      const next = NAV_KEYS[(idx + dir + NAV_KEYS.length) % NAV_KEYS.length];
      setScreen(next);
      setTaskId(null);
    },
    [screen],
  );

  useInput((input, key) => {
    if (typing) return;
    if (helpOpen) {
      if (input === '?' || key.escape) setHelpOpen(false);
      return;
    }
    if (input === 'q') {
      process.exit(0);
      return;
    }
    if (input === '?') {
      setHelpOpen(true);
      return;
    }
    if (key.tab && key.shift) return cycle(-1);
    if (key.tab) return cycle(1);
  });

  const screenProps = { api, isActive: !helpOpen, setTyping, onError, onMessage, setFooter: setFooterBinds };

  let body;
  if (screen === 'overview') body = e(OverviewScreen, { ...screenProps, onOpenTask });
  else if (screen === 'tasks' && taskId) body = e(TaskDetailScreen, { ...screenProps, taskId, onBack });
  else if (screen === 'tasks') body = e(TasksScreen, { ...screenProps, onOpenTask });
  else if (screen === 'providers') body = e(ProvidersScreen, screenProps);
  else if (screen === 'routing') body = e(RoutingScreen, screenProps);
  else if (screen === 'runs') body = e(RunsScreen, screenProps);
  else if (screen === 'usage') body = e(UsageScreen, screenProps);

  if (helpOpen) body = e(HelpOverlay, {});

  const binds = [...footerBinds, ...GLOBAL_BINDS];

  return e(
    Layout,
    { active: screen, connected, baseUrl, footer: e(KeybindBar, { binds, message: banner }) },
    e(Box, { flexDirection: 'column' }, body),
  );
}

export async function startTUI(service) {
  const port = Number(process.env.PORT || 4317);
  if (!process.env.AI_CODE_ROOT && service?.root) process.env.AI_CODE_ROOT = service.root;
  const baseUrl = `http://localhost:${port}`;

  const reachable = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/overview`);
      return res.ok;
    } catch {
      return false;
    }
  };

  if (!(await reachable())) {
    await import('../server.mjs');
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (await reachable()) break;
    }
  }

  render(e(App, { baseUrl }));
}
