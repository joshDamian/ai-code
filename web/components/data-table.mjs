// Sortable, filterable-by-composition data table.
// Props: columns: [{key, label, sortable?, sortValue?(row), render?(row)}]
//        rows: array of row objects
//        onRowClick?(row)
//        rowKey?(row) -> unique key, defaults to row.id
import { html, useState, useMemo } from '../lib.mjs';

export function DataTable({ columns, rows, onRowClick, rowKey = (r) => r.id }) {
  const [sort, setSort] = useState({ key: null, dir: 1 });

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

  return html`
    <table class="data-table">
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
        ${sorted.map(
          (row) => html`
            <tr key=${rowKey(row)} class=${onRowClick ? 'clickable' : ''} onClick=${() => onRowClick && onRowClick(row)}>
              ${columns.map((col) => html`<td key=${col.key}>${col.render ? col.render(row) : row[col.key]}</td>`)}
            </tr>
          `
        )}
      </tbody>
    </table>
  `;
}
