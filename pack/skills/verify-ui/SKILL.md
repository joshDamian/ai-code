---
name: verify-ui
description: "Apply when a session changes what a person sees - CSS, a component, a layout, a theme - and has to prove it rather than describe it. Renders the app before and after the change at desktop and phone widths and hands back the screenshots."
disable-model-invocation: true
---

# Show the UI change

Editing CSS is not proof the page changed the way you meant. This is the UI version of pasting test output: a picture of the page before, a picture of the page after, and what you can see in the difference.

1. Find how the app runs and at what URL it serves. Start it, and note the pid: stop only what you started, never by port or by name.
2. The shooter: use the project's own browser tooling if it has any - Playwright (`npx playwright screenshot --viewport-size=1280,900 http://127.0.0.1:5173 shot.png`) or its test suite with screenshots. Otherwise use the one Bench ships, which launches the browser itself and shoots nothing else:
   ```sh
   PACK="$(bench pack)"      # the folder the skills and their scripts live in
   node "$PACK/skills/design-check/design-check.mjs" --url http://127.0.0.1:5173 --routes /,/settings \
     --only-shots --shots .bench/evidence --label after
   ```
   `--shots-widths` (default 1280,390) and `--label` are what name the files.
3. Shoot **after** from this working tree, where the change is.
4. Shoot **before** from the commit the change started from, in a throwaway worktree so you never disturb the change itself:
   ```sh
   BASE="$(git merge-base HEAD origin/main 2>/dev/null || git rev-parse HEAD)"   # the commit before your change
   git worktree add "$TMP/before" "$BASE"
   ln -s "$PWD/node_modules" "$TMP/before/node_modules"   # only if the project needs it
   ```
   Run the app there on another port and shoot with `--label before --shots "$PWD/.bench/evidence"`: the path has to be absolute, because the pictures belong to the tree you are working in and the throwaway one is about to be removed. A before shot that comes back 2 means that tree has nothing to render or the app is not up there - check the ref you checked out.
   Then `rm -f "$TMP/before/node_modules"; git worktree remove "$TMP/before"` before you stop: the linked `node_modules` stops a plain remove, and a worktree left behind is one every later command in this project has to step around.
   A before shot from the same shooter as step 3 is the only way the two are comparable: same route, same width, same label shape.
5. Look at the pictures yourself - open the PNGs. If the page is blank, the app is not up or the route needs auth; check the server's log and the URL before blaming the CSS. A screenshot of a blank page proves nothing, so never hand one over as evidence.
6. Save both under `.bench/evidence/` as `<before|after>-<route>-<width>.png`, add `.bench/evidence/` to `.gitignore`, and show them to the person: the paths, which route and width each is, and what actually differs. If the before is identical to the after, say so - the change did not reach the page.
7. For the mechanical rules, run the gate in the same skill folder against the same URL. It answers 0 pass, 1 a defect it names, 2 it could not look. The two together are the proof a UI change is usually held to: it renders, it moved as asked, and it still passes the rules.

**Reply:** the before and after screenshots, what they show, the commands that produced them, and what you could not render.
