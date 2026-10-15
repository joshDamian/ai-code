---
name: catch-up
description: "Apply when the person comes back to a task and asks what has been done, where things stand, or to get up to speed. Writes a short brief: what was done, what was decided and why, what is unproven, and what needs the person."
disable-model-invocation: true
---

# Catch up the person on this task

Write the brief from the task's own record, not from memory of the conversation.

1. Call `task_status` — the title, done means, the check and its last result, files changed, commits ahead and behind, the other sessions, and the last decision-log entries.
2. Call `task_diff` — the actual change, so what you report is what is in the worktree, not what someone said.
3. If the task has a check, note its last result from `task_status`; if it has not run, say so rather than guessing.

Then write the brief, short, in these sections:

- **What was done** — from the diff and the check, the concrete change and where it stands.
- **What was decided and why** — from the decision log's entries and their evidence.
- **What is unproven** — anything the change claims that the check or a test has not yet shown.
- **What needs the person** — decisions, reviews, merges, or questions only they can resolve.

Quote numbers and test output verbatim where they matter. Keep it to what a person who was away needs; if nothing much has changed, say that in one line instead of padding it out.
