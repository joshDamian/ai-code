# dialog

## When to use
A short, interrupting decision or a small edit that must happen before the person goes on: confirm a destructive action, rename, invite someone, pick one option. If it has more than about four fields, scrolls, or the person needs to refer to the page behind it, it is a page (`form`) or a side panel, not a dialog.

## The layout
- **Desktop (1280):** centred horizontally, 96px from the top of the viewport (not dead centre), 480px wide (400 for a confirm, 560 for a small form), on `color.surface` over a dimmed backdrop.
- **Inside, top to bottom:** a title that names the decision as a question or a verb phrase ("Delete 'Q3 report'?", 20px semibold); the body - one or two sentences of consequence ("This deletes 12 files. It can't be undone.") or the fields; then the actions row.
- **Actions bottom-right:** the primary on the far right, labelled with the verb ("Delete", "Send invite") - never "OK" or "Yes"; "Cancel" as a quiet button to its left. For a destructive action the primary is `color.danger`, and for an irreversible one with large loss, the person types the item's name to enable it.
- A close `×` top-right only for dialogs that are not decisions (an info sheet); a decision is closed by Cancel or Escape.
- **Phone (390):** a bottom sheet, full width, rounded top corners, max 85% of the screen tall, with the actions stacked full width at the bottom - primary on top, Cancel under it.

## States
- **Working:** the primary button shows a spinner and stays the same width; Cancel and Escape still work if the action can be abandoned.
- **Error:** a one-line `color.danger` message above the actions; the dialog stays open with what was typed.
- **Done:** the dialog closes and the page shows the result (the item gone, the name changed) with a short confirmation - and an Undo instead of the confirmation dialog where the action can be undone.

## Spacing & rhythm
- Padding 24px; title to body 8px; body to actions 24px; between buttons 8px.
- Focus moves into the dialog on open (to the first field, or to Cancel for a destructive confirm) and back to the control that opened it on close.

## Tokens
- `color.surface` (the dialog), `color.bg` at reduced opacity, or a dark scrim, for the backdrop, `color.text`, `color.text-muted` (body), `color.primary` / `color.on-primary`, `color.danger` (destructive primary and errors), `color.border` (inputs).
- `font.size.*`: 20 title, 14 body.
- `space.*`: 8, 24, 96. `radius.*`: the large one on the dialog, the small one on its buttons. `shadow.*`: the largest one in light; in dark a lighter `color.surface` and a 1px `color.border` instead.

## What to avoid
- "Are you sure?" with "OK / Cancel" - it says neither what will happen nor to what.
- A confirmation dialog for every reversible action, when Undo would be kinder.
- Dialogs that open dialogs.
- A long form or a whole flow inside a scrolling modal.
- Primary on the left on one dialog and the right on another, or two filled buttons of equal weight.
- Clicking the backdrop discarding typed input without a word.

## Why
A dialog takes the whole app away from the person for a moment, so it has to earn that: one decision, stated in its title, with the consequence spelled out and a button that names the action. Putting the primary in the same place every time makes it findable without reading; making destructive actions red and specific makes them hard to hit by habit.
