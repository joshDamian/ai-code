# form

## When to use
The person creates or edits one thing by filling in fields: a new project, a profile, an order, a support request. For a long flow with steps that depend on each other, use `wizard`; for preferences that save one at a time, use `settings`.

## The layout
- **One column**, left-aligned under the page title, max width 560px. Fields run top to bottom in the order a person thinks of them - the thing's name first, rarely-touched options last.
- **Labels above their fields**, 14px semibold `color.text`, 8px above the input. Help text, when a field needs it, sits under the input in 12-14px `color.text-muted`. Placeholder text is an example value, never the label.
- **Inputs** full width of the column, 40px tall (48px on phone), `color.bg` fill, one `color.border` line, the small radius. Short values (a postcode, a quantity) get a short input, not a full-width one.
- **Related fields in a group** under a 16px semibold group heading - "Shipping", "Payment" - and only two fields side by side when they are one thing split (first/last name, expiry/CVC).
- **Actions at the end of the form, left-aligned with the fields:** the primary button ("Create project", the verb and the noun - never "Submit") first, the quiet "Cancel" after it. On phone (390), the primary button is **bottom-sticky and full width**; Cancel moves to the header's left as a back control.
- Optional fields say "(optional)" in the label; required ones say nothing. If most fields are optional, ask whether they belong in the form.

## States
- **Pristine:** the primary button is enabled. Validate on submit and on blur of a field the person has touched, not on every keystroke of the first entry.
- **Field error:** the input's border turns `color.danger`, and a one-line message in `color.danger` replaces its help text: what is wrong and how to fix it ("Use 8 or more characters"), not "Invalid". After a failed submit, focus moves to the first field in error.
- **Submitting:** the primary button keeps its width, shows a spinner and "Creating...", and is disabled; the fields stay visible and readable.
- **Server error:** a `color.danger` banner directly above the actions - not at the top of a long page where it is off-screen - with what failed and that the entries are kept.
- **Done:** go where the thing now is (its detail page), with a brief confirmation; do not leave the person on a cleared form.

## Spacing & rhythm
- Label to input 8px; input to help text 4px; field to next field 24px; group to group 40px, or 32px plus a group heading.
- Last field to the actions 32px. Between the primary and secondary buttons 8px.
- No box around the form on a page that only holds the form: the page is the surface.

## Tokens
- `color.text` (labels, values), `color.text-muted` (help, "(optional)"), `color.border` (input outline), `color.primary` (focus ring, primary button), `color.on-primary`, `color.danger` (field error, banner), `color.bg` (inputs), `color.surface` (group background, when groups need separating).
- `font.size.*`: 14 for labels and inputs (16 on phone, so iOS does not zoom), 12 for help, 16 for group headings.
- `space.*`: 4, 8, 24, 32, 40. `radius.*`: the small one for inputs and buttons. `shadow.*`: none.

## What to avoid
- A form centred in a card in the middle of an empty page - unless it is `auth`, the form belongs to the page shell like any other content.
- Labels to the left of inputs on a narrow column, or labels only as placeholders that vanish when typing starts.
- Two or three columns of fields to "use the space": the eye zig-zags and tab order fights reading order.
- "Submit" / "OK" buttons, a Reset button, or the primary action right-aligned while the fields are left-aligned.
- A red error summary at the top and nothing on the fields.
- Disabling the primary button until the form is valid with no clue why.

## Why
A form is read top to bottom and finished at the bottom, so everything sits on one vertical line the eye follows: label, field, next label, and the action where the eye already is when the last field is done. Errors next to their field are fixable without hunting; a specific verb on the button tells the person what will happen.
