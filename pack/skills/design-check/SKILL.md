---
name: design-check
description: "Apply when a session changes what a page looks like and needs to know whether it broke the mechanical rules - contrast, touch targets, type size, the spacing grid, design tokens, real buttons, focus, sideways scroll, motion. Renders the page in a browser and answers pass, defect, or could-not-look."
disable-model-invocation: true
---

# Gate a page's design

A session can see a page's HTML but not the page. This renders it in a real browser and holds it to what a machine can judge. It cannot tell you the layout is right or the design is any good - `verify-ui` and the person's eyes are for that.

1. Find how the app runs and at what URL: package scripts, README, the project's own verify skill. Start it. Every command you write down, run first.
2. Find the design tokens - a CSS file of custom properties, or JSON of values. The gate looks for the usual names itself (`tokens.css`, `design-tokens.json`, `src/styles/tokens.css`) and takes `--tokens <file>` for anything else. **No token file: say so and move on** - the colour and spacing token rules are skipped, and the gate says so in its report. Do not add a token file so the gate has something to read; a project gets one through `design-tokens`, with the person.
3. Write `.bench/design-check.json` so every later run and the task's check judge the same pages:
   ```json
   { "routes": ["/", "/settings"], "themes": ["light", "dark"], "grid": 8, "wait": 30000 }
   ```
   `grid` only when the project is not on 8s. `ignore` takes selectors the rules cannot judge, such as a third-party widget's; each one is a hole in the gate, so put the reason next to it in the file.
4. Run it. `PACK="$(bench pack)"` is the folder the skills and their scripts live in - if `bench` is not on your PATH, it is the newest `~/.local/share/bench/releases/*/pack` here, or ask the person.
   `node "$PACK/skills/design-check/design-check.mjs" --url http://127.0.0.1:5173 --json`. `--help` lists the rest: `--routes`, `--themes`, `--widths`, `--width`, `--ignore`, `--wait`, `--shots`, `--only-shots`, `--label`.
5. Read the exit code, not the text. **0 passed, 1 found a defect and named it, 2 could not look.** Fix each defect - the finding says which selector, which value, and what it should be. A 2 means the gate never saw your page: wrong URL or route, the app not up, a browser that is not installed. Fix that and run it again. A 2 is a failure, never a pass.
6. Wire it as one command in `.bench/design-check.sh`, which is what a check runs:
   ```sh
   #!/bin/sh
   # Starts the app, waits for it to answer, gates the pages, stops only what it started.
   PORT=${PORT:-5173}; export PORT
   npm start & APP=$!
   trap 'kill $APP 2>/dev/null' EXIT     # runs however the script ends
   # ...wait until $PORT answers, or give up
   node "$(bench pack)/skills/design-check/design-check.mjs" --url "http://127.0.0.1:$PORT"
   exit $?                               # the gate's code, 2 included
   ```
   No `exec` and no `set -e` on that line: `exec` would replace the shell and the trap would never stop the app, and `set -e` would leave it running too. Carry the code out by hand. If the URL already answers before you start anything, gate what is running, start nothing, and stop nothing - you did not start it. Stop only the process you started, and if the launcher spawns children of its own, stop its whole process group: never kill by port or by name.
7. Prove the wiring, both ways: with the app down it must fail rather than pass, and with a defect planted - a `width: 15px` button - it must come back 1 and name that button. Put the tree back as you found it, and check you left no process of yours running.
8. Tell the sessions that come after you. Put this block in the project's `CLAUDE.md` - create the file if there is none, otherwise add the block and change nothing else. If the markers are already there, replace what is between them rather than adding a second block:
   ```md
   <!-- bench:design-check -->
   UI changes: before you finish, run `/bench:verify-ui` and show its before and after screenshots. The design gate is `sh .bench/design-check.sh`: 0 passed, 1 a defect it names, 2 it could not look, which is a failure. Fix what it names.
   <!-- /bench:design-check -->
   ```
9. Commit `CLAUDE.md`, `.bench/design-check.sh` and `.bench/design-check.json`. A task works in its own worktree, which has only what is committed, so wiring left untracked is not there for the next task. If `git check-ignore -v .bench/design-check.sh` names a rule, the project ignores `.bench/`: change that rule from `.bench/` to `.bench/*` (git cannot re-include a file whose folder is ignored) and add `!.bench/design-check.*` under it, then check again.
10. A session cannot set its own task's check. Hand the person the line to paste into the task's check - `sh .bench/design-check.sh` - and how long it takes to run.

**Reply:** the config you wrote, what you added to `CLAUDE.md`, the command you ran, its real output and exit code, what you fixed, and anything the gate cannot see here that a person should look at.
