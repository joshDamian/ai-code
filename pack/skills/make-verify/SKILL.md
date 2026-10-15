---
name: make-verify
description: "Apply when a project has no scripted way for an agent to prove a change works. Writes a project skill, verify-<app>, that launches the app, drives it, and returns evidence."
disable-model-invocation: true
---

# Make a verification skill

An agent that can check its own work keeps going until the check passes. Write the skill that lets every later session in this project do that.

1. Find how the project really runs: package scripts, Makefile, README, CI config, Dockerfiles. Run each command you plan to write down. A command you did not run is a guess.
2. Write `.claude/skills/verify-<app>/SKILL.md` with `disable-model-invocation: true` and these sections, each a short list of commands that worked:
   - **Launch**: start the app isolated from anything already running. Pick a free port (`PORT=0` or similar) and record the pid you started.
   - **Doctor**: what to check and fix when launch fails (missing deps, env vars, a port taken).
   - **Drive**: how to exercise a change for real. A web app: a browser at desktop and phone widths. A CLI: the commands and their expected output. A library: a script that calls it. An API: requests with expected responses.
   - **Evidence**: what to hand back. Screenshots or recordings saved under `.bench/evidence/` with descriptive names, test output pasted verbatim, before and after for any change.
   - **Cleanup**: stop only the processes you started. Never kill by port or by name.
3. Add the checks that already exist (tests, typecheck, lint) as one command, and note how long it takes.
4. Prove the skill: follow it yourself from a clean shell, end to end, and fix every step that did not work as written.
5. Add `.bench/evidence/` to `.gitignore`.

**Reply:** the path of the new skill, the commands you ran to prove it with their real output, and anything you could not get working and why.
