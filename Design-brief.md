# Design brief

**For:** the one person who runs Bench on their own machine or VPS and drives it from a laptop or a phone. They arrive in Settings to change one thing and leave: the model new sessions start on, a provider to switch on or test, a phone to pair, notifications for this device, a restart after an update. **Core action:** run Claude sessions in tasks and land their work - Settings exists to shape how those sessions start. **Vibe:** quiet, dense, trustworthy - a tool, not a showroom (from `Design.md` and the themes' own descriptions).
**Shell:** page-shell as Bench already has it: a 260px left sidebar on `--surface-rail` (projects, then Dashboard / Add project / Settings at the bottom); a bottom tab bar under 860px. Not changed by this brief.

## View: Settings (`#/settings`)
**Job:** change how Bench runs here - what a new session starts with, which providers and devices it uses, and whether the server is healthy - one setting at a time.
**Pattern:** `settings` (and `states`). Adapted: there are eight groups, so the pattern's section nav is used on desktop; on the phone it is dropped rather than turned into a list screen of sub-routes (see *Chosen, not asked*).
**Primary action:** changing a default in **Defaults** - the first group. Per the pattern there is **no page-level filled button**: each row's control is its own action and saves the moment it changes. The only `--accent` on the page is a switch that is on, the current item in the section nav, and the focus ring. Every button in the groups is `secondary` or `ghost`; the destructive ones (Unpair) are `danger`.
**Hierarchy:**
1. The group headings - Defaults, Providers, Notifications, Devices, Install, Spend, Diagnostics, Server (20px `--text-xl`, 650, `--font-title`).
2. Each row's label (14px `--text-md`, 600, `--text`) with its value or control on the right edge.
3. The consequence line under each label (12.5px `--text-sm`, `--muted`), and the group's one-line description under its heading.
4. Footnotes and machine detail - the server's pid and data folder, the diagnostics detail column - in `--muted`, mono where they are machine values.

**Group order** (by how often a person comes for it): Defaults · Providers · Notifications · Devices · Install (only when not already running as an installed app) · Spend (only once there is spend) · Diagnostics · Server last, since its actions restart the process every session runs in.

**Rows.** A row is the full width of the content column: label and consequence on the left, the control on the right, aligned to one right edge (control column `min(280px, 100%)` for selects and fields; switches and buttons at their own width, pushed to the edge). Rows are separated by one `--line` divider; groups by `2 × --space-6` (48px) of space, never by a border or a card. A long value - the projects folder path, a pairing URL - takes the row's full width under its label.

**Saving.** Selects and switches save on change (as today). The projects folder is a text field that needs a commit: its Save button appears only while the field is edited, and Enter saves (as today). In Defaults, a save shows "Saved" beside the control for 2 seconds; a save that fails shows a one-line `--bad` message in that row with "Try again", and the control keeps its old value. Other groups keep their toasts for now.

**States:**
- **Loading:** the page header, the section nav and every group heading render at once. Groups whose data is still coming (Devices, Diagnostics, Server) show skeleton rows at the real row height on `--surface-2` with a slow shimmer that respects reduced motion, instead of "Checking…" or nothing.
- **Empty:** Devices with nothing paired says "No other devices yet. This browser needs no pairing." above the Pair row. Spend with no usage is hidden, as today - nothing to estimate. Providers is never empty (the Claude login is always listed).
- **Error:** a failed load of Devices, Diagnostics or the server's status shows, in place of its rows, a row of its own - "Couldn't load diagnostics" (or devices, or the server's status) as the label, "Check that the server is running, then try again." as its consequence, and a "Try again" button on the right edge. No toast as well: the row already says which part failed, and a toast at the top covered the page header. A Defaults save error sits in its row (above). The server not being a service is a `notice-warn` in the Server group, as today.
- **Not available:** Notifications on a browser without push, or without HTTPS, shows its one muted line saying why and offers nothing to press - as today.
- **Happy path:** four providers (one on, eight models), one or two paired devices, five or six projects in Spend, ten diagnostics rows, a supervised server with Update.

**Layout - desktop (1280):** sidebar 260px. Content area padding 32px (`--space-7`). Page header: "Settings" left (20px title), theme picker right. Below, two columns: a sticky **section nav** 200px wide - one 32px row per group, `--muted` text, the group in view marked with `--accent` text on a `--surface-2` fill (page-shell's current-destination rule) - and, 32px to its right, the **groups column, max 680px**. Each group: heading, one muted description line 4px under it, 16px to the first row, rows 16px padded top and bottom.
**Layout - phone (390):** content padding 16px. The section nav is dropped; the groups are one scrolling page with their headings as the landmarks. Rows whose control is a select or a text field stack the control under the label at full width; rows whose control is a switch or a button keep it on the right. The model picker's two selects stack, each at full width, so the provider's name is not cut off. Diagnostics keeps three columns (tick, name, detail) rather than stacking name over detail. Groups 48px apart, as on desktop.
**Avoid:** every group in its own bordered card (what it was); filled accent buttons competing in every group; a page-level Save; Unpair styled like the buttons around it; consequence lines in the same ink as labels.

**Chosen, not asked:**
- *No filled button on the page.* The pattern says so, and the old page had four (Install, Pair, Turn on, sometimes Update), each shouting equally. "Update Bench" when there are newer commits keeps its emphasis through the "N newer commits" line in `--text`, not a fill.
- *A section nav on desktop, none on phone.* Eight groups is past the pattern's "under five" for a plain page. On the phone the pattern's list-of-groups screen would turn one route into nine, with back-button and deep-link behaviour Bench does not have today; this is a restyle, so the phone keeps one scrolling page. The nav's items scroll the page; they are buttons, not `#` links, because the hash is the router's.
- *Defaults first, Install no longer first.* Install was first as a nudge; it is a one-time thing for a device, so it sits with the other device groups.
- *48px between groups* is `calc(var(--space-6) * 2)` - composed from the scale, which tops out at 32px.
- *Inline save feedback in Defaults only.* It is the primary group and its saves are the ones a person makes and leaves; the other groups' toasts are unchanged so this stays a restyle.
