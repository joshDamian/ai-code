// Footer keybind legend, contextual per screen/state.
import React from 'react';
import { Box, Text } from 'ink';

const e = React.createElement;

export const GLOBAL_BINDS = [
  ['Tab', 'next'],
  ['S-Tab', 'prev'],
  ['?', 'help'],
  ['q', 'quit'],
];

export function KeybindBar({ binds = [], message }) {
  return e(
    Box,
    { flexDirection: 'column', borderStyle: 'single', borderColor: 'gray', paddingX: 1 },
    message ? e(Text, { color: message.color || 'yellow' }, message.text) : null,
    e(
      Box,
      { flexDirection: 'row', flexWrap: 'wrap' },
      ...binds.flatMap(([key, label], i) => [
        e(Text, { key: `k${i}` }, ' '),
        e(Text, { key: `b${i}`, color: 'blueBright', bold: true }, key),
        e(Text, { key: `l${i}`, color: 'gray' }, ` ${label}`),
      ]),
    ),
  );
}

export function HelpOverlay({ onClose }) {
  const rows = [
    ['Tab / Shift+Tab', 'cycle screens'],
    ['j/k or ↑/↓', 'navigate lists'],
    ['Enter', 'open / confirm'],
    ['Esc / Backspace', 'back'],
    ['p', 'start planning / replan (plan tab)'],
    ['a', 'approve (plan tab)'],
    ['r', 'reject (plan tab)'],
    ['f', 'refine with feedback (plan tab)'],
    ['E', 'edit plan in $EDITOR (plan tab)'],
    ['e', 'execute (when approved)'],
    ['c', 'cancel the running agent'],
    ['n', 'new task (tasks screen)'],
    ['1/2/3/4', 'switch tabs in task detail'],
    ['q', 'quit'],
    ['?', 'toggle this help'],
  ];
  return e(
    Box, { flexDirection: 'column', borderStyle: 'double', borderColor: 'blue', paddingX: 2, paddingY: 1 },
    e(Text, { bold: true, color: 'blue' }, 'Keybinds'),
    e(Box, { height: 1 }),
    ...rows.map(([key, label], i) =>
      e(Box, { key: i, flexDirection: 'row' },
        e(Box, { width: 18 }, e(Text, { color: 'blueBright', bold: true }, key)),
        e(Text, { color: 'gray' }, label),
      ),
    ),
    e(Box, { height: 1 }),
    e(Text, { color: 'gray' }, 'Press ? or Esc to close'),
  );
}
