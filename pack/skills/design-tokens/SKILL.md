---
name: design-tokens
description: "Apply when a session is about to build or restyle UI, or the person asks for a design system, a theme, or to stop the UI looking generic. Finds the project's token source and holds every value to it; with none, runs a short onboarding and writes design-tokens.json and Design.md."
disable-model-invocation: true
---

# Work from the tokens

Hardcoded values are why generated UI looks generic. One source of truth fixes that: every colour, size, space, radius and shadow comes from a token, and a value that is not a token is a bug.

1. **Find the source.** Look for `design-tokens.json`, `tokens.json`, `tokens.css`, CSS custom properties on `:root`, a Tailwind or theme config, a component library (MUI, Chakra, shadcn, a local `ui/` folder), and a `Design.md`. If there is one, it is the source: use it, and **do not invent new values**. A value it lacks is a question for the person, or a token added to the source with its reason - never a literal in a component.
2. **No source: onboard.** Ask the person, in one `AskUserQuestion` round where you can:
   - form factor - phone, desktop, both;
   - app type - tool, content, commerce, dashboard, game, …;
   - identity - the name, who uses it, the one core action, three vibe words;
   - colour direction - a brand colour, or a mood to derive one from.
   Unanswered is fine: choose, and say you chose.
3. **Write `design-tokens.json`** at the root - the canonical source, and where `design-check` finds it. Plain values with their units (`"16px"`, `"#0b6bcb"`), which is what the gate reads, grouped: `color.light.*` and `color.dark.*` (the same names in both: `bg`, `surface`, `text`, `text-muted`, `primary`, `on-primary`, `border`, `danger`, …), `font.family`, `font.size.*` (a scale - 12, 14, 16, 20, 24, 32, 40 or a ratio you state), `font.weight.*`, `line-height.*`, `space.*` (multiples of 8, with 4 for hairline gaps), `radius.*`, `shadow.*`. Text on its background meets 4.5:1 in both themes - check it.
4. **Write `Design.md`** beside it: the tokens in light and dark, the type scale, the 8pt spacing, the hierarchy rules (one primary action per view; size, weight and colour in that order of emphasis), section isolation (sections are separated by space or a surface change, not by stacking borders), and **a stated rationale for each decision** - why this colour for these vibe words, why this scale for this form factor.
5. **Wire it.** Generate the CSS custom properties from the JSON (a `tokens.css`, or the theme file the stack expects) with dark under `prefers-color-scheme: dark` or the app's theme switch, and read every value from them. Then add to the project's `CLAUDE.md`, between `<!-- bench:design-tokens -->` markers, one line: tokens in `design-tokens.json` are mandatory, `Design.md` says why, and no hardcoded values. Commit all of it.
6. **Prove it.** Run `design-check` (it enforces the tokens: a colour or spacing written out instead of taken from a token is a defect) and fix what it names.
7. **Then the screen.** Tokens say what values to use, not what to build: before the first component, read the pattern(s) in `$(bench pack)/patterns/` for the screen you are about to build, and write its brief with `design-brief`. Each pattern's **Tokens** names the groups above it draws on.

**Reply:** where the tokens came from (found, or onboarded and with what answers), the files written, and the gate's real output.
