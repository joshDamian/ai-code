# dashboard

## When to use
A home or overview screen that answers "how are things, and what needs me?" for someone who comes back often: operations, analytics, a project's status. Not for a landing page, and not as a way to fill a home screen that has nothing to report - then the home is the main list.

## The layout
- **Decide the one question first.** The top of the page answers it: either one headline number with its trend and comparison ("Revenue this month, +12% vs last"), or a short "needs attention" list of the items waiting on the person. Not both at equal weight.
- **Desktop (1280), top to bottom:**
  1. Page header: title left, a period selector and the one primary action (often "Export" is not it - ask what the person does next) top-right.
  2. **The headline**, full width or two-thirds: the key metric at 32-40px, its label and comparison in `color.text-muted` under it, a sparkline or chart for it beside or below.
  3. At most 3-4 supporting stats in one row, each smaller (20-24px values) than the headline. Fewer is better.
  4. The detail: a chart or two at 2:1 or full width, then a table or list of the items behind the numbers, each row linking through.
- **"Needs attention"** goes above the charts when it is non-empty, as a list (see `list-detail` rows) with an action per item; when empty it collapses to one line, "Nothing waiting on you".
- **Phone (390):** one column in the same order: the headline first, supporting stats as a 2-up grid or horizontal scroll, charts full width at a lower height, the table becomes a list. The period selector moves under the title.
- Every number states its unit and its period; every chart has a title that says what it shows, not "Chart 1".

## States
- **Loading:** each tile shows a skeleton in place independently; the slowest query never blocks the headline.
- **Empty (new account, no data):** the headline area becomes the `states` first-run empty block - what will appear here and the action that produces data (connect a source, create the first item). Never a grid of zero-value tiles and empty charts.
- **Partial error:** the tile that failed says so with retry; the others stay.
- **Stale:** an "Updated 5 min ago" in muted text near the period selector, with refresh.

## Spacing & rhythm
- 24px between tiles in a row and between rows; 32px between the headline band and what follows, or a `color.surface` band behind the headline.
- Inside a tile: 16-24px padding, label to value 4px, value to comparison 4px.
- Tiles on `color.surface` against a `color.bg` page, no border; or, in a flat style, no tile backgrounds at all and the 24px gaps doing the grouping.

## Tokens
- `color.surface` (tiles or the headline band), `color.bg`, `color.text` (values), `color.text-muted` (labels, periods, axes), `color.primary` (the main series, the primary action), `color.danger` (a value that is bad, and only then).
- `font.size.*`: 32 or 40 for the headline value, 20 or 24 for supporting values, 12 or 14 for labels. Numbers in tabular figures.
- `space.*`: 4, 16, 24, 32. `radius.*`: the medium one on tiles. `shadow.*`: none on tiles in light, and never in dark - tiles are separated by surface.

## What to avoid
- A wall of eight equal stat cards at the top, all the same size and weight, so nothing is the point.
- Three equal cards when one number is the point.
- Charts for the sake of it: a pie of two values, a line chart of four points, a gauge.
- Every stat coloured green or red, so colour stops meaning anything.
- Numbers with no period or comparison ("1,204") - big but not informative.
- A dashboard as the first screen of an app that has no data yet.

## Why
A dashboard earns its place by saving the person a click: they glance and know. That only works if the page has an order of importance a glance can follow - one big thing, a few supporting things, then the detail - and size, not colour, says which is which. Linking every number to the items behind it turns the overview into a starting point instead of a dead end.
