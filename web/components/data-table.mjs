// Sortable, filterable-by-composition data table.
// Props: columns: [{key, label, sortable?, sortValue?(row), render?(row)}]
//        rows: array of row objects
//        onRowClick?(row)
//        rowKey?(row) -> unique key, defaults to row.id
// With onRowClick set the table is focusable and drives row navigation from the
// keyboard (ArrowUp/ArrowDown move the focused row, Enter activates it).
import { html, useState, useMemo } from '../lib.mjs';

export function DataTable({ columns, rows, onRowClick, rowKey = (r) => r.id }) {
  const [sort, setSort] = useState({ key: null, dir: 1 });
  const [focused, setFocused] = useState(-1);

  const sorted = useMemo(() => {
    if (!sort.key) return rows;
    const col = columns.find((c) => c.key === sort.key);
    const get = (col && col.sortValue) || ((r) => r[sort.key]);
    return [...rows].sort((a, b) => {
      const av = get(a);
      const bv = get(b);
      if (av == null && bv == null) return 0;
      if (av == null) return -1 * sort.dir;
      if (bv == null) return 1 * sort.dir;
      if (av > bv) return sort.dir;
      if (av < bv) return -sort.dir;
      return 0;
    });
  }, [rows, sort, columns]);

  function toggleSort(col) {
    if (!col.sortable) return;
    setSort((s) => (s.key === col.key ? { key: col.key, dir: -s.dir } : { key: col.key, dir: 1 }));
  }

  // A table with no row action has nothing to do on Enter, so keyboard
  // navigation is gated on onRowClick rather than always on.
  function onKeyDown(e) {
    if (!onRowClick) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocused((i) => Math.min(i + 1, sorted.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocused((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (focused >= 0 && sorted[focused]) onRowClick(sorted[focused]);
    }
    // Anything else returns without touching focus.
  }

  return html`
    <table class="data-table" tabIndex=${onRowClick ? 0 : -1} onKeyDown=${onKeyDown}>
      <thead>
        <tr>
          ${columns.map(
            (col) => html`
              <th key=${col.key} class=${col.sortable ? 'sortable' : ''} onClick=${() => toggleSort(col)}>
                ${col.label}
                ${sort.key === col.key ? html`<span class="sort-arrow">${sort.dir === 1 ? '▲' : '▼'}</span>` : null}
              </th>
            `
          )}
        </tr>
      </thead>
      <tbody>
        ${sorted.map((row, i) => {
          // `focused` indexes the rendered (sorted) order, so re-sorting can
          // never leave the highlight sitting on a different row.
          const rowClass = [onRowClick ? 'clickable' : '', i === focused ? 'focused' : ''].filter(Boolean).join(' ');
          return html`
            <tr
              key=${rowKey(row)}
              class=${rowClass}
              onClick=${() => {
                if (!onRowClick) return;
                // Clicking parks the cursor on the row so the keyboard
                // continues from where the mouse left off.
                setFocused(i);
                onRowClick(row);
              }}
            >
              ${columns.map((col) => html`<td key=${col.key}>${col.render ? col.render(row) : row[col.key]}</td>`)}
            </tr>
          `;
        })}
      </tbody>
    </table>
  `;
}
