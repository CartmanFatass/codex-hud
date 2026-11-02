---
name: hud-handoff
description: Write the fixed-form handoff that lets a fresh session (same or another harness) continue a long task, and start the successor from it. Use when the pause before the next step is long or unknown, when the conversation is no longer the best carrier of the task state, or when the user ends a long session.
---

# Handoff to a fresh session

**Purpose.** A handoff is a brief for the successor, not a ledger object and not a chat summary. It carries the task
state the successor needs, in a fixed form, so the successor can start without the predecessor's conversation.

## When

- The pause before the next step is long or unknown (design §5.3 step 4).
- The user ends a long session and expects the work to continue later.
- Not for a short pause: a native wake or a bounded wait keeps this session (see `hud-delegate` §8).
- Resolve outstanding children first: wait for them or cancel them. A handoff transfers no runs.

## Template

Sections are mandatory and in this order; an empty section says "none".

```
# Handoff: <slug>
- from: <harness> session <short id or n/a>, link <linkId or none>, run <runId or none>; date
- to: <harness/role of the successor>; reason: long_pause | context_budget | user
- repo/branch/commit: <path> <branch> <sha>
## Task (what the successor must deliver; acceptance commands)
## State: done / in progress / not started (file paths; tests green; verified vs assumed)
## Decisions made and why (bullets; cite docs/contract sections, not chat)
## Open questions and known risks
## Outstanding delegations (linkId/runId, state, what the successor may only *observe*; resolved before handoff unless listed here)
## Next steps (ordered; command and expected result)
## Pointers (files to read first; report paths; the handoff's own path)
## Content rule: actual task state the successor needs; no secrets or credentials; no transcript excerpts beyond what the task needs;
   no paths outside the repo or HUD_HOME
```

## Artifact

- Path `tmp/handoff/<date>-<slug>-<8 hex random>.md`; write a temp file, fsync it, then rename (atomic).
- Keep that file at that stable path until the successor has confirmed it read it. Nothing retains a copy for you:
  the delivered bytes are held in memory and sent through the child's input pipe, and `$HUD_HOME/runs/<runId>/brief.md`
  does not exist in this build. No `handoff.recorded` event is written either; the handoff file is the only record.
- Delegated successor: the parent starts it with
  `delegate_spawn{backend, role, brief: '<absolute handoff path>', cwd, mode:'headless', request_key}`. `brief` is the
  handoff file, whose head carries the role template (§2 of `hud-delegate`); the path is absolute because the child's
  cwd is the repo.
- User-driven successor: the user opens a new session and tells it to read the handoff file. There is no
  `hud <harness> --brief <path>` launcher in this build.
- Content rule: actual task state, no secrets or credentials, no transcript excerpts beyond what the task needs, no
  paths outside the repo or `HUD_HOME`.

## Outstanding delegations

- Outstanding delegations are observe-only for the successor: it never resumes, cancels or reports for them.
- Observe-only grants no read access. `delegate_status` and `delegate_wait` authorize through the caller's owner key,
  and a successor session has a different one, so those calls are refused with `unauthorized`.
- So the handoff carries the last verified status and report path per outstanding delegation (linkId/runId, state,
  latest report, cursor). The successor treats them as read-only facts of the handoff, not as fresh state.
- If the successor needs fresh state, it asks the user, or reads `hud run status <runId>`. That command reads the
  ledger as the local user and does not require the predecessor's session owner.
- There is no ownership transfer in this build: resume, cancel and report for the predecessor's runs stay with the
  predecessor.
- If the predecessor must stay alive for a child, it stays alive and keeps draining wakes instead of handing off.
