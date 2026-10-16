# wizard

## When to use
A task that has to be done in an order, where later steps depend on earlier answers, and that is done rarely: first-time setup, importing data, creating something with many required parts, checkout. Three to six steps. Two steps is a form; more than six is a sign some steps belong elsewhere.

## The layout
- **Its own focused frame:** the page shell's navigation is hidden or reduced to the product mark and an "Exit" (or "Save and exit") control top-right. The person is in one task until they finish or leave.
- **Progress at the top**, left-aligned with the content: step names, not just numbers ("Account · Source · Mapping · Review"), the current one in `color.text` semibold, done ones with a check, future ones in `color.text-muted`. On phone (390): "Step 2 of 4 - Source" and a thin progress bar.
- **One step on screen,** a single column, max width 560px, using `form` rules: a 24px heading that asks the step's question, one muted line of why, then the fields.
- **Navigation at the bottom of the step:** the primary "Continue" (or the step's real verb on the last step - "Create project", "Pay $40") on the **right**, "Back" as a quiet button on the left of the same row. On phone (390), a bottom-sticky bar holding both, Continue taking the remaining width.
- **The last step is a review:** a summary of every answer, grouped by step, each group with an "Edit" link that jumps to that step and returns here.

## States
- **Validation:** on Continue, the `form` field-error rules; the step does not advance.
- **Saving between steps:** answers are kept if the person goes back, reloads, or exits and returns - say so near Exit ("Your progress is saved").
- **Working** (a step that runs something - an import, a check): the step shows what is happening with real progress, not just a spinner, and Continue is disabled until it is done.
- **Final submit fails:** stay on the review step with the error above the primary button and all answers intact.
- **Done:** a completion screen with what was made and one primary action into it ("Open project"), not back to the start.

## Spacing & rhythm
- Progress to step heading 48px; heading to first field 32px; fields per `form` (24px apart).
- Last field to the navigation row 40px. On desktop, the navigation row is in the flow, not pinned to the window bottom.

## Tokens
- `color.text`, `color.text-muted` (future steps, why-lines), `color.primary` (current step marker, Continue, progress bar), `color.on-primary`, `color.border` (inputs), `color.surface` (review groups), `color.danger`.
- `font.size.*`: 24 step heading, 14 progress labels and fields (16 inputs on phone).
- `space.*`: 8, 24, 32, 40, 48. `radius.*`: small on inputs and buttons, medium on review groups. `shadow.*`: none.

## What to avoid
- A wizard in a modal over the app, with its own scroll inside the modal.
- Numbered circles joined by lines as the only progress, with no step names.
- "Next" on the last step, so the person cannot tell which click commits.
- Losing every answer on Back, reload or Exit.
- A step with one checkbox, made a step only to make the wizard look longer.
- Continue and Back as two equal primary buttons.

## Why
Splitting a long, dependent task into named steps lets a person hold one question at a time and see how far they have to go. The review step catches mistakes before they cost anything, and keeping answers across Back and Exit makes it safe to explore. The navigation stays in one place on every step so the hand never hunts for it.
