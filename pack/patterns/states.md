# states

## When to use
Every view that loads, lists or saves something - which is every view. A brief names the empty, loading and error state of each view; this is how they look. Other patterns say where these go; this says what they are.

## The layout
- **Empty - first run** (the person has not made anything yet): in the area the content would fill, left-aligned with the content or centred within that area only (never the whole page), a 16-20px semibold line saying what will be here ("Your projects live here"), one muted line saying why it is worth making one, and the create action as the **primary button** below. One small icon or illustration at most, 48-96px, above the heading - or none.
- **Empty - no results** (a filter or search matched nothing): one line, "No results for 'x'", with a clear-filters link. No illustration, no create button - the person did not ask to create.
- **Empty - all done** (an inbox at zero, nothing to review): one calm line in `color.text-muted`; this is a good outcome, not an error.
- **Loading:** skeletons at the real size and position of what is coming - rows for a list, blocks for cards, a title and lines for text - in `color.surface`, with a slow shimmer that respects reduced motion. Show nothing for the first 300ms, then the skeleton; for an action, the spinner lives inside the button that started it.
- **Error:** in place of the content that failed, not in a modal: a 16px semibold line of what failed in plain words ("Couldn't load your projects"), a muted line of what to do, and a "Try again" button. If part of the page loaded, only the failed part shows the error.
- **Partial / stale:** content that is there but out of date keeps showing, with a one-line muted note and a refresh control at the top of that region.

## States
This pattern is the states. Per view, the brief has to say which empty is the first one a new person sees, which loading shape matches the content, and what the error says and offers.

## Spacing & rhythm
- Empty block: icon to heading 16px, heading to body 8px, body to button 24px; the block's text max width 400px.
- The empty or error block sits 48-96px below the page header on desktop, 32px on phone - not vertically centred in a tall viewport.
- Skeleton rows use the real row height and the real gaps of the content they stand for.

## Tokens
- `color.text` (heading), `color.text-muted` (body, all-done line), `color.surface` (skeleton blocks), `color.danger` (the error heading's icon, and only that - the error body stays `color.text`), `color.primary` / `color.on-primary` (the one button).
- `font.size.*`: 16 or 20 for the heading, 14 for the body.
- `space.*`: 8, 16, 24, 32, 48, 96. `radius.*`: the same radius the real content uses, on skeletons.

## What to avoid
- A big grey "No data" in the middle of the page, or an empty table with only its header row.
- A full-page spinner where the shape of the page was knowable in advance.
- A cartoon illustration 300px tall on every empty state.
- Error text that is the exception ("TypeError: Failed to fetch", "Error 500") or a red toast that disappears with the reason.
- The same empty state for "nothing yet" and "nothing matches", so a filtered-out person is told to create their first item.
- An error page that throws away what the person had typed.

## Why
States are what a new person sees first and what everyone sees when things go wrong, so they are where an app looks finished or not. An empty state is the best onboarding there is - it says what the place is for and hands over the one action. Skeletons that match the content keep the layout from jumping; errors in place keep the rest of the page usable.
