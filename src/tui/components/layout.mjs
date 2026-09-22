// Sidebar nav + main content area.
import React from 'react';
import { Box, Text } from 'ink';

const e = React.createElement;

export const NAV_ITEMS = [
  { key: 'overview', label: 'Overview' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'providers', label: 'Providers' },
  { key: 'routing', label: 'Routing' },
  { key: 'runs', label: 'Runs' },
  { key: 'usage', label: 'Usage' },
];

function Sidebar({ active }) {
  return e(
    Box,
    { flexDirection: 'column', width: 16, borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
    ...NAV_ITEMS.map((item) => {
      const isActive = item.key === active;
      return e(
        Text,
        {
          key: item.key,
          color: isActive ? 'black' : 'white',
          backgroundColor: isActive ? 'blue' : undefined,
          bold: isActive,
        },
        `${isActive ? '›' : ' '} ${item.label}`,
      );
    }),
  );
}

function Header({ connected, baseUrl }) {
  return e(
    Box,
    { borderStyle: 'round', borderColor: 'blue', paddingX: 1, justifyContent: 'space-between' },
    e(Text, { bold: true, color: 'blue' }, 'AI Code — Mission Control'),
    e(Text, { color: connected ? 'green' : 'red' }, `${connected ? '●' : '○'} ${baseUrl || ''}`),
  );
}

export function Layout({ active, connected, baseUrl, footer, children }) {
  return e(
    Box,
    { flexDirection: 'column', width: '100%' },
    e(Header, { connected, baseUrl }),
    e(
      Box,
      { flexDirection: 'row' },
      e(Sidebar, { active }),
      e(
        Box,
        { flexDirection: 'column', flexGrow: 1, paddingX: 1, borderStyle: 'round', borderColor: 'gray', minHeight: 18 },
        children,
      ),
    ),
    footer,
  );
}
