---
name: hud-handoff
description: Write the fixed-form handoff that lets a fresh session (same or another harness) continue a long task, and start the successor from it. Use when the pause before the next step is long or unknown, when the conversation is no longer the best carrier of the task state, or when the user ends a long session.
---

# Handoff to a fresh session

**Purpose.** A handoff is a brief for the successor, not a ledger object and not a chat summary. It carries the task
state the successor needs, in a fixed form, so the successor can start without the predecessor's conversation.
For ticketed work, point to the tickets and their land records for slice status; do not recreate a slice ledger in STATE.md.

## When

- The pause before the next step is long or unknown.
- The user ends a long session and expects the work to continue later.
- Not for a short pause: keep the current session using `hud watch`, the client's queue, or `hud_read` with `wait_ms`
  (see `hud-delegate`).
- Prefer waiting for or closing active HUD jobs (`hud_close`) before handing off.

## Template

Sections are mandatory and in this order; an empty section says "none".

```
# Handoff: <slug>
- from: <harness> session <short id or n/a>, job <job id or none>; date
- to: <harness/role of the successor>; reason: long_pause | context_budget | user
- repo/branch/commit: <path> <branch> <sha>
## Task (what the successor must deliver; acceptance commands)
## State: done / in progress / not started (file paths; tests green; verified vs assumed)
## Decisions made and why (bullets; cite docs/contract sections, not chat)
## Open questions and known risks
## Outstanding HUD jobs (job id, state, report path; settled job directories are deleted about a day after closure, so write needed conclusions to the tracker or repo docs first)
## Next steps (ordered; command and expected result)
## Pointers (files to read first; report paths; the handoff's own path)
## Content rule: actual task state the successor needs; no secrets or credentials; no transcript excerpts beyond what the task needs;
   no paths outside the repo or HUD_HOME
```

## Artifact

- Path `tmp/handoff/<date>-<slug>-<8 hex random>.md`; write a temp file, fsync it, then rename (atomic).
- Keep that file at that stable path until the successor has confirmed it read it. The handoff file is the record.
- Main-session successor: the main session chooses a role from `hud_roster` and starts it with `hud_create`
  (`role`, `request_key`, `cwd`, and the handoff file as the brief in `task`, using an absolute path because the job's
  `cwd` is the repo).
- Owner-started successor: the owner opens a new session and tells it to read the handoff file.
- Content rule: actual task state, no secrets or credentials, no transcript excerpts beyond what the task needs, no
  paths outside the repo or `HUD_HOME`.

## Outstanding HUD jobs

- List each relevant open or recently settled HUD job in the handoff: `job` id, `state`, and `report` path.
- A settled job directory (`$HUD_HOME/jobs/<job>/`) is deleted about a day after closure on a later watcher scan, taking
  its `report.md` and `qa/` files with it. Any conclusions the successor needs must be written into the issue tracker or
  repo docs before handing off.
- A successor can inspect remaining jobs with `hud_read` (`full: true` to reread an already-read report), answer open
  questions with `hud_respond`, or stop an open job early with `hud_close`. Because pane-scoped `hud watch` and MCP
  `changes` belong to the session that created the job, prefer settling or closing active jobs before handing off.
