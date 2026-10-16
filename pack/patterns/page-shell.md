# page-shell

## When to use
Every app screen sits in one. Decide it once, before the first view: the frame that holds navigation, the page title and the page's primary action, so each view only has to fill its content area.

## The layout
- **Desktop (1280):** a left sidebar 240px wide on `color.surface`, full height, holding the product name at the top (16px, weight semibold) and the main destinations below it, one per row, 40px tall, icon + label. Account and settings go at the bottom of the sidebar, never mixed in with the destinations. The content area is `color.bg`.
- **Page header**, top of the content area: the page title on the left (24px, semibold), at most one line of `color.text-muted` description under it, and the page's **one primary action top-right**, aligned to the title's baseline row. Secondary actions sit left of it as quiet buttons, or behind a `⋯` menu when there are more than two.
- **Content** below the header, left-aligned to the title, with a max width: 960px for reading and forms, full width only for tables, grids and dashboards that use it.
- **Fewer than five destinations and no hierarchy:** a top bar 56px tall instead of the sidebar - name left, destinations centre-left, account right.
- **Phone (390):** the sidebar becomes a bottom tab bar of at most five destinations, 56px plus the safe-area inset, icon over a 12px label; anything past five goes into a "More" tab. The page header is the title alone (20px); the primary action moves to a **bottom-sticky full-width button** above the tab bar, or into the header's right corner as an icon button when it is a "new" action that would cover content.
- The current destination is marked with `color.primary` on its icon and label and a `color.surface` fill behind the row - not with a bold border or a coloured bar alone.

## States
- **Loading the app:** the shell renders at once with its real navigation; only the content area shows a skeleton. A full-page spinner before the shell exists is the wrong answer.
- **Signed out / session expired:** hand over to the `auth` pattern; never show the shell around a login form.
- **Content states** (empty, loading, error) live inside the content area and follow `states` - the header and its primary action stay put, so the person never loses their place.

## Spacing & rhythm
- Content area padding 32px on desktop, 16px on phone. Header to content: 24px.
- Sidebar: 16px padding, 4px between destinations, 24px before the bottom group.
- Title to its description: 4px. The primary action is 40px tall on desktop, 48px on phone.
- The sidebar meets the content with a surface change (`color.surface` beside `color.bg`), not a 1px border on top of one.

## Tokens
- `color.bg` for the content area, `color.surface` for the sidebar and tab bar, `color.text` and `color.text-muted` for labels, `color.primary` / `color.on-primary` for the primary action and the current destination.
- `font.size.*`: 24 for the page title (20 on phone), 14 for navigation labels, 12 for tab-bar labels.
- `space.*`: 4, 16, 24, 32. `radius.*`: the small radius on navigation rows and buttons.
- `shadow.*`: none on the shell. A shadow on the sidebar or header says "floating", and the shell does not float.

## What to avoid
- A top bar that holds navigation, search, three icon buttons, an avatar and the primary action all at once - the eye has nowhere to land.
- The primary action repeated in the header, in the sidebar and as a floating button.
- A page title centred over left-aligned content.
- A sidebar that is the same colour as the content with a 1px border between them, then a second border under the header: a page cut into boxes.
- A phone layout that is the desktop sidebar squeezed into a hamburger and nothing else changed.

## Why
The shell is the part a person sees on every screen, so every inconsistency in it is multiplied. Fixing the position of the title and the primary action means a person learns once where "do the thing" lives. Separating regions by surface rather than border keeps the frame quiet so the content - the reason the screen exists - carries the contrast.
