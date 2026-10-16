# cards-grid

## When to use
A collection whose items are recognised by a picture or a visual preview - templates, products, projects with thumbnails, media, people. If the items are recognised by their name and compared by their fields, use `table` or `list-detail` instead.

## The layout
- **A responsive grid** in the content area: columns of a minimum 240px card width, so 4 columns at 1280, 2 at 768, 1 (or 2 for small thumbnails) at 390. All cards the same width; height set by a fixed media aspect ratio (16:9 for screens, 1:1 for avatars and products, 3:4 for documents), so rows line up.
- **A card, top to bottom:** the media, edge to edge at the card's top; then 16px of padding holding the title (14-16px semibold, one line, ellipsis), one line of `color.text-muted` meta (owner, date, price), and nothing else. The whole card is one link to the item. A secondary action (`⋯` menu, favourite) sits top-right over the media, visible on hover and always visible on touch.
- **Above the grid:** a toolbar row with the count ("24 templates"), a filter or sort control on the left and a view toggle (grid/list) on the right if both make sense. The collection's create action is the page's primary button, top-right of the page header - not a "+" card inside the grid.
- **Featured items**, when one item is the point (the current project, a recommendation): give it its own row above the grid, spanning 2 columns or the full width, with a larger title - rather than making it an equal tile among others.

## States
- **Empty:** the `states` first-run block in place of the grid - not a single empty "+ New" card.
- **Loading:** a full row or two of skeleton cards at the real aspect ratio.
- **Missing image:** a `color.surface` block at the same ratio with the item's initial or type icon - never a broken-image icon or a collapsed card.
- **No results:** the "No results for 'x'" line with clear-filters, above where the grid was.
- **Error:** the error block in place of the grid, with retry.

## Spacing & rhythm
- Gap between cards 24px on desktop, 16px on phone. Card padding 16px below the media; title to meta 4px.
- The grid starts 24px under the toolbar.
- Cards on `color.surface` against `color.bg`, no border; or on `color.bg` with a 1px `color.border` - one of those, never border plus shadow plus surface.

## Tokens
- `color.surface` (card, image placeholder), `color.bg`, `color.text` (title), `color.text-muted` (meta), `color.border` (only if cards are on the page colour), `color.primary` (focus ring, selected card).
- `font.size.*`: 14 or 16 for titles, 12 or 14 for meta.
- `space.*`: 4, 16, 24. `radius.*`: the medium one on the card, the media clipped to it. `shadow.*`: the smallest one on hover in light only, or none.

## What to avoid
- Three equal cards side by side when one thing is the point.
- Cards with no image at all - a grid of text boxes is a list wearing a costume.
- Cards with title, description, four tags, two buttons and a footer, all at the same weight.
- Mixed aspect ratios so rows are ragged, or text overlaid on photos without a scrim.
- A "+ Add new" card as the first tile.
- Buttons inside a card that is also a link, so a click lands somewhere unexpected.

## Why
A grid works when the eye recognises items by sight, and it gets worse as the cards grow more text - that is when a list is better. One fixed ratio and one line of meta keep the grid calm enough to scan; making the whole card the target makes it easy to hit on both mouse and touch.
