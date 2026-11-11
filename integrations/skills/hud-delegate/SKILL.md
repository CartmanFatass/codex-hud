---
name: hud-delegate
description: Choose a fixed HUD role and hand work off one step at a time. The main session owns every handoff. Use when delegating design, implementation, review, a small task, or browser work.
---

# Delegate through HUD

The main session chooses the role, hands off the brief and the artifacts, reads the result, and decides what happens next. HUD does not start the next role when a job finishes. A review verdict is information for you, not permission to continue.

Use `hud_roster` to see the available local pi-roles. Dispatch requires a herdr pane; there is no preset selection.

## Roles

- `oracle` is not available until M3.
- `imp` implements a defined change against a brief and completion criteria.
- `reviewer` independently assesses a specified change and reports findings. You decide whether to accept the change or request repairs.
- `sonic` does small, fully specified chores: lookups and small patches, never test authoring, bug diagnosis, measurement or design.
- `jev` browser jobs are not available until M3.

## Default workflow

This is an overridable default, not a worker obligation. A project's own docs override it.
- Give each brief scope, out of scope, completion criteria, a size budget and a stop rule:
  if the work will not fit, stop and report rather than expand it.
- Build one end-to-end slice per imp job with the simplest change that works.
- Ask the main session only when blocked or a choice changes what the user sees or contradicts the brief or spec;
  otherwise choose the simplest option and note it.
- Have the implementer run the brief's main-path tests once at the end; no full suites unless requested.
- Review at milestones or for risky changes: owner configs, deleting data, killing processes, installers—not per change.
- Review spec compliance and scope creep separately from simplicity and real defects; findings do not imply new tests.
- Read each result and decide whether to integrate, request a repair, review or stop. Workers do only their own job.
The main session owns every handoff and decides every next step. HUD does not chain these steps.

## Jobs

Call `hud_create` with `role`, a stable `request_key`, the brief as `task`, and optionally `cwd`. Available roles are `imp` (pi-roles implementer), `reviewer` and `sonic`. The returned `task_dir` contains the brief, status, questions and report.

### Wait

Use `hud_read` with `job` and `wait_ms` (up to 120000), or wait for the DONE line pi-dispatch pushes to the caller's pane. Reads poll until `idle_grace`, `closed`, `failed`, an open question, or the timeout. Read again after a timeout, answer or repair. DONE means settled, not accepted: read the report yourself. Reports are capped at 64 KiB with a truncation flag; omit `job` to list the 20 newest jobs.

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
