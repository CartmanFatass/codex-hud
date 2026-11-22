# 03: Land the approved spec; milestone ids like 0.2.0

**Status:** ready-for-human
**Blocked by:** 01, 02

**What to build:** Proposal 17 Slice 4 after the owner approves ticket 02: merge docs/spec.md and docs/decisions-log.md, point CLAUDE.md / docs/README.md at the log; Q3 A: src/collectors/project-board.ts milestone parsing also accepts 0.x.y ids so STATE's 'Milestone: 0.2.0' highlights in the ladder; spec §5 lists the current milestone.

- [x] Project ladder highlights 0.2.0 (synthetic test); spec under 32 KiB
- [x] npm test, check:fixtures, test:release pass

## Comments

- 2026-11-22 owner approved the draft (wt/SPEC-DOCS-02 a15deee7, after two oracle audits) and resolved the ten FLAGs as main recommended ("do as your recommendation"):
  - F-1: Project has no Control page; drop "control" from the Project hub page list.
  - F-2: backup skills live in Help (`?`); drop the "Skills tab lists the whole inactive collection" wording.
  - F-3: list the real tool set: hud_roster, hud_create, hud_read, hud_send, hud_respond, hud_close, hud_wait (hidden from MCP-task clients), hud_peek, hud_tickets, hud_lease, hud_statusline.
  - F-4: "Inbox is deleted" meant the old panel-level Inbox; the Project layout keeps Timeline (default), Board and Inbox.
  - F-5: keep the MCP tasks text only under MCP-ORCH; delete the M5 duplicate.
  - F-6: §5 lists 0.2.0 (MCP orchestration & Panel V2) as the current milestone; the collector accepts 0.x.y ids.
  - F-7: no count: "pi gets the same worker tools natively".
  - F-8: §2.1.6's per-response changes, watcher_alive and hud_wait apply to clients without MCP tasks; task clients get task completions instead.
  - F-9: the non-goal reads "no general process-supervision platform"; the per-job CLI supervisor and watcher are allowed.
  - F-10: the later rule wins: worker decisions are collected but not shown; delete the older decision display/title rules.

- 2026-11-22 main: landed faceafcc. Spec 39.8 KB → 29.8 KB, no FLAG markers left; decisions log D-2026-11-22-01..; ladder accepts 0.x.y. Suite 952/952; release test passed in the imp's clean worktree.
