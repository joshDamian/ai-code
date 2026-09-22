// Minimal monospace table renderer. `ink-table` (last released for Ink 3,
// CJS-only) crashes under Ink 5's ESM/top-level-await, so runs/usage
// screens render their tabular data with this instead.
//
// Columns are fixed-width and truncate (never wrap) so the table stays
// aligned even in narrow (80-column) terminals.
import React from 'react';
import { Box, Text } from 'ink';

const e = React.createElement;

const MAX_WIDTH = 22;
const MIN_WIDTH = 6;

function titleCase(s) {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

export function SimpleTable({ data, columns, widths = {} }) {
  if (!data || !data.length) return e(Text, { color: 'gray' }, 'No data.');
  const cols = columns || Object.keys(data[0]);
  const colWidth = (c) => {
    if (widths[c]) return widths[c];
    const natural = Math.max(c.length, ...data.map((r) => String(r[c] ?? '').length));
    return Math.min(Math.max(natural, MIN_WIDTH), MAX_WIDTH) + 1;
  };
  const w = Object.fromEntries(cols.map((c) => [c, colWidth(c)]));

  const row = (cells, opts = {}) =>
    e(
      Box,
      { flexDirection: 'row' },
      ...cells.map((c, i) =>
        e(
          Box,
          { key: i, width: w[cols[i]] },
          e(Text, { bold: opts.bold, color: opts.color, wrap: 'truncate-end' }, String(c)),
        ),
      ),
    );

  return e(
    Box,
    { flexDirection: 'column' },
    row(cols.map(titleCase), { bold: true, color: 'blue' }),
    ...data.map((r, ri) => e(React.Fragment, { key: ri }, row(cols.map((c) => r[c] ?? '')))),
  );
}
