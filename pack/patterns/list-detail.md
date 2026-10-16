# list-detail

## When to use
A collection the person browses and opens one item at a time: mail, tickets, sessions, documents, contacts. The list is for choosing; the detail is for reading and acting on one thing.

## The layout
- **Desktop (1280):** two panes inside the page shell. The list on the left, 320-400px wide, scrolls on its own; the detail fills the rest and scrolls on its own. The selected row is marked with a `color.surface` fill and `color.text` weight, not a heavy outline.
- **List rows:** one primary line (the item's name or subject, 14-16px, `color.text`), one secondary line in `color.text-muted` (a snippet, owner, or status), and at most one right-aligned meta value (time, count). Rows are 56-72px tall. Status is a small dot or a short label, not a coloured row.
- **List header:** a filter or search field across the top of the list and the collection's create action ("New ...") as the page's primary action, top-right of the page header - not inside every row.
- **Detail:** the item's title (20-24px) with its own actions in a row top-right of the detail pane: the one thing you do to this item as a primary button, the rest as quiet buttons or under `⋯`. The body below, at most 720px wide for text.
- **Phone (390):** one pane at a time. The list is the screen; opening a row pushes the detail as a full screen with a back control top-left. The item's primary action becomes a bottom-sticky full-width button. The create action becomes an icon button in the header's right corner.

## States
- **List empty (no items yet):** the list pane holds the `states` empty block - what this list collects, and the create action as its primary button; the detail pane is blank `color.bg`, not a second message.
- **Nothing selected:** the detail pane shows one muted line ("Select a conversation") centred in it, no illustration. Better still, select the first item.
- **Filter matches nothing:** in the list, "No results for 'x'" and a clear-filter link - never the first-run empty state.
- **Loading:** 6-8 skeleton rows at real row height; the detail shows a skeleton of a title and three text lines.
- **Error:** in the pane that failed, with retry. A failed detail never blanks the list.

## Spacing & rhythm
- Row padding 12px vertical, 16px horizontal; no borders between rows - 4px gap or a hover fill separates them. If the rows are dense enough to need a divider, use one `color.border` line, inset 16px, and never also a box around the list.
- Detail pane padding 32px; title to body 24px; between body sections 24px or a `color.surface` band.
- The two panes are separated by the list sitting on `color.surface` and the detail on `color.bg`.

## Tokens
- `color.surface` (list pane, selected row), `color.bg` (detail), `color.text`, `color.text-muted` (secondary line, meta), `color.primary` (selected-row accent, primary action), `color.border` (inset dividers only when needed).
- `font.size.*`: 14 or 16 for the row's primary line, 12 or 14 for its secondary line, 20 or 24 for the detail title.
- `space.*`: 4, 12, 16, 24, 32. `radius.*`: the small one on rows. `shadow.*`: none; panes are flat surfaces.

## What to avoid
- Every row a card with its own border, shadow and radius - the list becomes a stack of boxes and the selection disappears among them.
- Actions repeated on every row (edit, delete, share icons) instead of in the detail.
- A detail that opens in a modal on desktop, hiding the list the person is working through.
- Three or more lines of metadata per row, all the same weight.
- The phone layout keeping both panes at half width.

## Why
People alternate between scanning many and acting on one; the two panes let them do that without losing their place. Keeping rows to one strong line and one muted line makes the list scannable by eye, and putting actions in the detail keeps the list calm and makes the one action on the selected item obvious.
