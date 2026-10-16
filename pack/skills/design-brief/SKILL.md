---
name: design-brief
description: "Apply when a session is about to build or restyle a screen, before it writes any component, or the person asks for a plan, a sketch, or a design. Picks the patterns the screens are built from, asks the person only the product facts, and writes Design-brief.md - each view's job, its one primary action, hierarchy, states, and layout at desktop and phone width - that the work and design-review are held to."
disable-model-invocation: true
---

# Write the brief before the pixels

Generated UI looks generic for two reasons: the session starts coding a screen with no idea what it is for, and a model asked to make it look good invents instead of composing from structures that are known to work. The brief fixes the first, the patterns fix the second. Write it before any component; the work is then held to it.

1. **Read the patterns.** `PACK="$(bench pack)"` is the folder the skills live in - if `bench` is not on your PATH, it is the newest `~/.local/share/bench/releases/*/pack` here, or ask the person. The library is `$PACK/patterns/`, one file per pattern:
   - `page-shell` - the frame every screen sits in: navigation, title, where the primary action lives.
   - `list-detail` - browse a collection, open one item at a time.
   - `table` - many records of one shape, compared, sorted, acted on in bulk.
   - `cards-grid` - items recognised by a picture or preview.
   - `form` - create or edit one thing by filling in fields.
   - `wizard` - an ordered, rarely-done task in three to six steps.
   - `settings` - preferences that each save on their own.
   - `dashboard` - an overview answering "how are things, what needs me?".
   - `search` - finding a thing by what the person remembers about it.
   - `dialog` - one short interrupting decision.
   - `auth` - sign in, sign up, reset, verify.
   - `states` - empty, loading and error, for every view.

   Read `page-shell` and `states` always, and every pattern the views this task touches will use - the whole file, including **What to avoid**. A view that fits no pattern is fine: compose it from the nearest ones and say which.
2. **Read what the project already decided.** `Design-brief.md`, `Design.md` and `design-tokens.json` at the root, and the screens that exist. A brief already there is extended, not rewritten: change only the views this task touches. If `Design.md` records who the product is for, its core action and its vibe, those are answered - do not ask again.
3. **Ask the person only the product facts**, in one `AskUserQuestion` round at most, and only what is not already written down:
   - who it is for, and what they are doing when they open this screen;
   - the one core action - the thing this product or view exists to let them do;
   - the vibe - three words, or a product they want it to feel like.
   Everything else - which pattern, the hierarchy, the layout, the states - is yours to choose. Choose it, and say in the brief what you chose and why, as `design-tokens` does with its onboarding. Unanswered is fine: choose, and say you chose.
4. **Write `Design-brief.md`** at the root, beside `Design.md`. A product section, then one section per view, in this shape:
   ```md
   # Design brief

   **For:** who, and the moment they arrive in. **Core action:** the one thing. **Vibe:** three words.
   **Shell:** page-shell - sidebar or top bar, and why.

   ## View: Projects (`/projects`)
   **Job:** one sentence - what the person comes here to do.
   **Pattern:** list-detail (and states), and anything adapted from it, with why.
   **Primary action:** "New project" - top-right of the page header on desktop; header icon button on phone. Exactly one.
   **Hierarchy:** 1. the project names; 2. each project's status; 3. last activity. What the eye lands on, in order.
   **States:**
   - Empty: what a new person sees, and the action it offers.
   - Loading: the skeleton's shape.
   - Error: what it says, and what it offers.
   - Happy path: the screen with real, typical data - how many items, how long the names are.
   **Layout - desktop (1280):** the pattern's structure with this view's content in it: regions, widths, where each element of the hierarchy sits.
   **Layout - phone (390):** what changes - what stacks, what collapses, where the primary action moves, what is dropped.
   **Avoid:** the pattern's tells that this view is most at risk of.
   **Chosen, not asked:** the decisions you made, each with its reason.
   ```
   Concrete, not aspirational: names of real elements, positions, widths and counts, never "clean and modern". Exactly one primary action per view - a view that seems to need two is two views, or one of them is secondary. Every view has all four states. Sizes, spaces and colours come from `design-tokens.json` and the patterns' **Tokens** - name the token, not a new value.
5. **Wire it.** Add to the project's `CLAUDE.md` - create it if there is none, change nothing else - and replace the block if the markers are already there:
   ```md
   <!-- bench:design-brief -->
   UI work: `Design-brief.md` says what each view is for, its one primary action, its states and its layout at both widths. Build to it; change the brief first when a view's job changes.
   <!-- /bench:design-brief -->
   ```
   Commit `Design-brief.md` and `CLAUDE.md` before the first component, so the brief is what the work is checked against rather than written to match it afterwards.
6. **Build from it.** Compose each view from its pattern and the tokens; where you depart from the brief, update the brief first and say why. When the UI is ready, `design-check` holds it to the numbers and `design-review` holds it to the brief: a layout that contradicts the brief is a finding there.

**Reply:** the patterns you read, what you asked the person and what they answered, what you chose and why, and the path of the brief with its views listed by job and primary action.
