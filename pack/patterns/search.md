# search

## When to use
Finding a thing by what the person remembers about it, across more items than they can scroll: documents, products, messages, commands. For narrowing a list already on screen, a filter field in that list's toolbar is enough - this is for search as a destination or a global command.

## The layout
- **Global search** is a field in the page shell: in the sidebar's top or the top bar, 240-320px, with a muted placeholder that says what it searches ("Search projects and tasks") and a keyboard hint (`/` or `⌘K`) on the right. Focusing it opens results in a panel under it, or a centred command palette 640px wide placed 96px from the top.
- **The results page** (Enter, or "See all"): the query field is the primary control - there is no primary button competing with it. It is a large field at the top of the content area (full content width, 48px tall), result count and filters (type, date, owner) in one row under it, then the results as a single column of rows, max width 720px.
- **A result row:** the item's title with the matching words in semibold (not a yellow highlight), its type and location in `color.text-muted` on the line under it ("Task · Project Alpha"), and a one-line snippet showing the match in context. Rows link to the item.
- **Grouping:** by type when results mix types ("Projects", "Tasks"), at most 3-5 per group in the panel with "See all N".
- **Phone (390):** tapping search opens a full screen with the field at the top, focused, a "Cancel" on its right, and recent searches below it until the person types.

## States
- **Before typing:** recent searches and, if useful, a few suggested destinations - never a blank panel.
- **Typing:** results update after a short pause (about 150ms), the previous results stay visible (dimmed is fine) until new ones land - no flash of empty.
- **No results:** "No results for 'x'", then what to try (check spelling, fewer words, search everywhere) and, if relevant, the create action ("Create 'x'").
- **Error:** one line in the results area with retry; the query stays in the field.
- **Slow:** a small spinner in the field's right edge, not over the results.

## Spacing & rhythm
- Field to filters 16px, filters to results 24px. Result rows 12px vertical padding, 8px between title and meta.
- Groups separated by 24px and a 12px `color.text-muted` group label in sentence case - not by borders.

## Tokens
- `color.bg` (field and page), `color.surface` (the panel or palette, the highlighted result), `color.text`, `color.text-muted` (meta, placeholder, group labels), `color.border` (field outline), `color.primary` (focus ring, keyboard-selected row).
- `font.size.*`: 16 in the field (results page and phone), 14 in the panel; 12 for meta.
- `space.*`: 8, 12, 16, 24, 96. `radius.*`: small on the field, medium on the palette. `shadow.*`: the large one under the floating panel or palette in light; in dark, a `color.surface` step up instead.

## What to avoid
- A search box with a separate "Search" button next to it, and nothing until it is pressed.
- Results as a grid of cards, so the snippet and location - the things that tell results apart - have no room.
- Matched words in yellow highlighter on every occurrence.
- An empty panel on focus, or "No results" flashing between keystrokes.
- Search hidden behind an icon on desktop when it is how people navigate the app.

## Why
Search is how people get somewhere when they know what they want and not where it is, so speed and recognisability matter more than anything else on the screen. Rows with title, location and context let the person pick the right result without opening three; showing recent searches before typing turns the empty field into a shortcut.
