---
name: hud-delegate
description: Hand work to a local HUD role in its own herdr tab - imp (implementer), reviewer, sonic (small chores), and any other role hud_roster lists. Use whenever the user delegates in plain words ("交给 imp", "让 implementer 做", "派个 sonic", "让 sonic 查一下", "review 一下", "起个 reviewer", "问 architect", "delegate this", "dispatch a sonic") or a project's docs route work to a role. The main session writes the brief, dispatches with hud_create, waits for the DONE line, reads the report and decides the next step.
---

# Delegate through HUD

The user names a role and a task in plain words; you do the rest. Never ask them to name a tool.

1. Call `hud_roster` once per session; it returns the roles and convention in effect, which the main session follows (`hud-convention.md` in the server's cwd, then `$HUD_HOME`, then the shipped default; first file wins whole, text truncated at 20,000 characters).
2. Write the brief: the goal, scope and out of scope, completion criteria, a size budget and a stop rule. For a small
   ask the user's own sentence plus those limits is enough. Do not name a report file; HUD adds it.
3. `hud_create` with `role`, a short `request_key` (task slug plus date, stable on retry), the brief as `task`, and `cwd`.
4. Tell the user in one line: role, job id. The worker runs in its own tab.
5. Wait for the `[role@job] DONE` or `FAILED` line in your pane; do not poll. `hud_read` with `wait_ms` is the backup.
6. Read the report (`hud_read`), check it (for code: the diff and the named checks), then decide: accept, repair, review
   or stop. DONE means settled, not accepted.
7. `hud_close` once you accept or give up. Inspect a failed job before closing it.

The main session chooses the role, hands off the brief and the artifacts, reads the result, and decides what happens next. HUD does not start the next role when a job finishes. A review verdict is information for you, not permission to continue.

Dispatch requires a herdr pane.

## Roles

The shipped defaults; `hud_roster` lists what is actually defined (files in `$HUD_HOME/roles/` add or override).

- `imp` implements a defined change against a brief and completion criteria.
- `reviewer` independently assesses a specified change and reports findings. You decide whether to accept the change or request repairs.
- `sonic` does small, fully specified chores: lookups and small patches, never test authoring, bug diagnosis, measurement or design.
- `architect` returns design options with their costs, including the smallest; you decide.
- Oracle and Jev browser jobs are not available until M3.

## Details

### Questions

`hud_read` lists unanswered `qa/qN.md` questions by id with the first 2 KiB. Answer with `hud_respond` using `job`, `request_id` and `answer`; it writes `qa/qN.answer.md` only once and never overwrites an existing answer.

### Helpers

An implementer runs with a split pane and may use pi-roles' helpers when the brief asks. Do not duplicate helper work; read the report. Sonic handles only fully specified chores, never tests, diagnosis, measurement or design. The main session owns every next step.

### Repairs

Use `hud_send` with `job`, a stable `message_key` and `text` to continue the same implementer only while STATUS is `idle_grace`. Duplicate message keys are not sent again. Otherwise it returns `not_continuable`: create a new job.

### Close

`hud_close` runs the local `pi-role-reap` for the job's task directory and returns its exit code and last line. Repeated close is fine. Close when resources are no longer needed; cleanup is not acceptance.

Keep request keys stable; never blindly re-create an uncertain launch.

HUD uses the locally installed pi-roles; it does not chain, retry or choose another backend on its own. Oracle and Jev jobs wait until M3.
