# table

## When to use
Many records of the same shape that a person compares, sorts or acts on in bulk: invoices, users, runs, orders, logs. If they open one record at a time and read it, use `list-detail`; if they recognise items by picture, `cards-grid`.

## The layout
- **Toolbar above the table:** search on the left (240-320px), filters as compact selects or chips beside it, the result count in `color.text-muted`; the collection's create action is the page's primary button, top-right of the page header. When rows are selected, the toolbar is replaced by a bulk-action bar: "3 selected", the bulk actions, and "Clear".
- **Columns:** the identifying column first (name, ID), left-aligned and in `color.text` weight medium - it is the row's link. Text left-aligned, numbers and money right-aligned in tabular figures, dates in one short format, status as a small dot plus a word. Only the columns a person compares by: 4-7 at 1280; the rest live in the detail.
- **Header row:** 12-14px `color.text-muted`, sortable columns show a sort arrow on hover and on the active sort. The header sticks to the top on scroll.
- **Row actions:** at most one inline, right-aligned, visible on hover (and always on touch); the rest in a `⋯` menu in the last column.
- **Pagination or "load more"** below the table, left: the range ("1-50 of 1,240"); right: previous/next.
- **Phone (390):** no horizontal scrolling table. Each row becomes a list row (`list-detail`): the identifying column as the primary line, the two most important values as the secondary line, status on the right. Sorting and filters go into one "Filter" button that opens a sheet.

## States
- **Empty:** the `states` first-run block in place of the table, with the header row hidden.
- **No results:** keep the header row, then one row-wide line "No invoices match these filters" with clear-filters.
- **Loading:** 8-10 skeleton rows under a real header, cell widths matching the columns.
- **Error:** the error block under the header, with retry. A failed page of results keeps the previous page visible.
- **Long values:** truncate with an ellipsis and a full-value tooltip; a cell never wraps to three lines.

## Spacing & rhythm
- Rows 48px tall (40px for dense, data-heavy tools; 56px when rows have two lines). Cell padding 12-16px horizontal.
- Rows separated by one `color.border` line, full width, and no vertical lines between columns. Or zebra fill on `color.surface` - one or the other.
- Toolbar to header 16px. The table is not wrapped in a bordered card on a page that is about the table.

## Tokens
- `color.text` (identifying column, values), `color.text-muted` (header, secondary values), `color.border` (row lines), `color.surface` (header background, hover, selected rows, zebra), `color.primary` (selection checkbox, sort indicator, links), `color.danger` (a failed status, bulk delete).
- `font.size.*`: 14 for cells, 12 for the header. Tabular numerals.
- `space.*`: 12, 16, 24. `radius.*`: small on chips and the bulk bar. `shadow.*`: none, except under the sticky header once scrolled.

## What to avoid
- Every cell bordered, a grid of boxes, with the header in a dark band.
- Fifteen columns and a horizontal scrollbar on desktop, the same table squeezed on phone.
- Edit / duplicate / delete icon buttons visible on every row at all times.
- Numbers left-aligned so their magnitudes cannot be compared.
- Status shown only as a coloured pill with no word, or every status a different bright colour.
- A table inside a card inside a card.

## Why
A table exists for comparison down a column, so everything that helps the eye travel vertically - right-aligned numbers, one quiet line between rows, no vertical rules - is the point, and anything that adds visual weight per cell works against it. Keeping actions to hover and bulk actions to a bar makes the rows readable when nobody is acting on them.
