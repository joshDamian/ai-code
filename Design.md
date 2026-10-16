# Design

Bench's design system already exists, as CSS custom properties. This file says where it lives and why it is the way it is; `design-tokens.json` records the values in the shape the design skills and `design-check` read.

## The source

- **`web/app.css` `:root`** - the Classic theme (the default, dark) and every token that is not a colour: the type scale (`--text-*`), the spacing scale (`--space-*`), the faces (`--font-ui`, `--font-mono`), motion (`--ease`, `--dur-fast`), the chart and syntax palettes. Each block carries a comment saying why.
- **`web/themes.css` `:root[data-theme="…"]`** - the ten other themes. Each overrides the same names: page and surfaces, ink, accent, the four tones, `--radius`/`--radius-sm`, `--shadow-1/2/3`, `--wash`, `--scrim`, `--well-bg`/`--well-text`, `--font-title`, `--title-transform`, `--title-spacing`, `--dot-idle`, `--theme-color`.
- **`web/theme.mjs`** - the picker's list. `tests/themes.test.mjs` holds it to the stylesheet and holds every theme to the contrast floors below, so a theme cannot ship unreadable.

A component reads `var(--name)`, never a value. A value the source lacks is added to the source with its reason, not written into a component. `design-tokens.json` is a record, not a second source: change the stylesheet, then the record.

**Themes.** Bench has eleven themes, not a light and a dark. The theme is the device's choice (localStorage), not the OS colour scheme. `design-tokens.json` records Classic as `color.dark` and Quiet Temple, the quietest light theme, as `color.light`: those are the two `design-check` is pointed at.

## Tokens

| Role | Property | Classic (dark) | Quiet Temple (light) |
|---|---|---|---|
| page | `--bg` | `#0a0c10` | `#f7f8fb` |
| panel | `--surface-1` | `#11151b` | `#ffffff` |
| raised / hover | `--surface-2` | `#171c23` | `#f5f5f5` |
| sunken (code, inputs) | `--surface-sunken` | `#090b0e` | `#eff1f4` |
| ink | `--text` | `#edf2f7` | `#1f2228` |
| secondary ink | `--muted` | `#8e9aaa` | `#696e7d` |
| primary action | `--accent` / `--on-accent` | `#9fb9ff` / `#0b0d10` | `#5a6882` / `#ffffff` |
| divider | `--line` / `--line-strong` | `#29313c` / `#39424f` | `#e1e3e8` / `#cdd0d9` |
| danger | `--bad` / `--bad-bg` / `--bad-line` | `#ff8585` | `#b3362c` |
| radius | `--radius` / `--radius-sm` | 10px / 6px | 10px / 6px (8-18px across themes) |

**Contrast.** On every surface it can sit on: `--text` at 7:1 or better; `--muted`, `--accent` and the four tones at 4.5:1 or better; `--on-accent` on `--accent` at 4.5:1. `tests/themes.test.mjs` computes these for every theme.

## Type

Six steps, `--text-xs` 11 · `--text-sm` 12.5 · `--text-md` 14 · `--text-lg` 16 · `--text-xl` 20 · `--text-2xl` 28. Body is 14px at line-height 1.5. Weights: 400 for prose, 600 for labels and small buttons, 650 for headings and buttons.

*Why:* Bench is a dense tool, read for hours on a laptop and on a phone. The scale is tight between 11 and 14px, where the chrome lives (labels, counts, table heads), and open above, where only titles sit. A 16px body would halve what fits on a phone's transcript. This is a deliberate departure from the 16px body minimum `design-check` assumes; its `type` findings on 14px body text are known and accepted.

Titles take the theme's `--font-title` (a serif stack, the UI face, or the mono face in capitals), so a theme's character comes through in its headings and nowhere else.

## Space

Seven steps on a 4px base: `--space-1` 4 · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 20 · `-6` 24 · `-7` 32. Anything under 4px is chrome (a hairline, a keycap's inset) and stays a literal; anything over 40px is layout geometry. A gap the scale does not have is composed from it (`calc(var(--space-6) * 2)` for the 48px between settings groups), never typed.

*Why 4 and not 8:* the 12px and 20px steps are where a dense row gets its breathing room. On an 8px grid they would round to 8 or 16, and rows would either crowd or float. `design-check`'s 8px `spacing` findings on 12/20px values are known and accepted.

## Hierarchy

- **One primary action per view.** `.btn` with no variant is the filled accent button: the thing the view is for. Everything else is `secondary` (surface fill, a line), `ghost` (text only) or `danger` (tinted). Two filled buttons on one screen means one of them is wrong.
- **Emphasis in this order: size, then weight, then colour.** A heading is bigger before it is bolder; a label is `--text`, its consequence line `--muted` and a step smaller; the accent colour is kept for what the person can do, and `--info` for what Bench is waiting on.
- **Machine values are mono.** A path, a hash, a command is `--font-mono`; prose never is.

## Sections

Sections are separated by **space or a surface change, not by stacking borders**. A page is not cut into boxes: a group has a heading, then its rows on the page's own background, then space before the next group. A border is a divider between rows of one group, inset and `--line`, never a frame around each group. A card (`--surface-1`, `--line`, `--shadow-1`) is for something that sits *on* the page - a dialog, a toast, a list of items - not for a page's own sections.

*Why:* borders stacked on borders make every group shout equally, and the eye has nowhere to land. Space carries the grouping without adding ink, so the content holds the contrast.

## Shape and depth

`--radius` for panels, `--radius-sm` for buttons, inputs and rows. Three shadows: `--shadow-1` a card resting on the page, `--shadow-2` something over content (a tooltip, a toast), `--shadow-3` a full overlay. The shell and a page's sections have none.
