# settings

## When to use
Preferences and configuration the person changes now and then: account, notifications, appearance, integrations, billing. Each setting stands on its own, and there is no single "submit" that the whole page is for.

## The layout
- **Desktop (1280):** a section nav on the left of the content area, 200-240px, listing the groups (Account, Notifications, Appearance, ...), and the selected group's settings on the right, max width 640px. Under five groups and twenty settings in all: one scrolling page with the groups as headings instead of a nav.
- **Each group** has a heading (20px semibold) and one muted line of what it controls, then its settings as rows.
- **A setting row:** label (14-16px, `color.text`) and one muted line of consequence under it on the left; the control on the right - a switch, a select, or a quiet "Change" button that opens an inline editor. The row is the full width of the column, so all controls line up on one right edge.
- **No page-level primary action.** Each row's control is its own action, so no filled button competes for the eye; the only `color.primary` on the page is the switches that are on and the focus ring.
- **Saving:** switches and selects save the moment they change, with a small "Saved" next to the control for 2 seconds. Text fields that need a commit get their own small Save button inside the row, shown only while edited. No page-level Save button for instant controls.
- **Danger zone** - delete account, leave workspace - is the last group, separated by 48px, with the action as a `color.danger` outline button that opens a confirmation naming exactly what will be lost.
- **Phone (390):** the section nav becomes a list screen (each group a row with a chevron); a group opens as its own screen with a back control top-left. Rows stack the control under the label only when the control is a select or text field; switches stay on the right.

## States
- **Loading:** skeleton rows at real height inside the group; the nav renders at once.
- **Save failed:** the control returns to its old value and a one-line `color.danger` message appears in that row with "Try again". Never a toast only - the person needs to see which setting did not stick.
- **Empty group** (no integrations connected yet): the group's heading, then one line saying what connecting does and the "Connect" button - the `states` empty pattern at small scale.
- **Not allowed** (the person lacks the role): the rows show their values, controls disabled, and one muted line at the group head saying who can change them.

## Spacing & rhythm
- Row padding 16px vertical; rows separated by one inset `color.border` line or by 8px of space, never boxed one by one.
- Group heading to first row 16px; group to group 48px.
- Label to its consequence line 4px. Control to the column's right edge: 0 - align it to the edge.

## Tokens
- `color.text`, `color.text-muted` (consequence lines), `color.border` (row dividers), `color.surface` (selected nav item, the group background if groups need a surface), `color.primary` (switch on, focus), `color.danger` (danger zone and save errors).
- `font.size.*`: 20 for group headings, 14 or 16 for labels, 12 or 14 for consequence lines.
- `space.*`: 4, 8, 16, 48. `radius.*`: small for buttons and selects. `shadow.*`: none.

## What to avoid
- A settings screen that centres a lone card in the middle of the page with all settings crammed inside it.
- Every group in its own bordered card, cards stacked down the page - borders stacked on borders.
- One Save button at the bottom of a page of switches, so a person toggles three things, navigates away and loses them.
- Labels that name the control rather than the outcome ("Toggle email" instead of "Email me when a task finishes").
- The destructive actions styled like the rest, or mixed in among ordinary settings.

## Why
People come to settings to change one thing and leave. A nav to the group, a scannable column of labelled rows, and controls on a single right edge make the one thing findable. Saving instantly removes a whole class of "I changed it but it didn't stick". Isolating the dangerous actions keeps them away from the hand that is toggling things quickly.
