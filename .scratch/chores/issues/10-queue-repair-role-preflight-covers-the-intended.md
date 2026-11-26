# 10: Queue repair: role preflight covers the intended workset, and hud_respond cannot revive a superseded run

**Status:** done
**Live try:** none
**Blocked by:** 05
**Objective:** unattended

**What to build:** Repair of chores/05 after milestone review jcb3010cb6270dbe6 (findings 3 and 5 and its deletion note; read the report for file:line). (1) The role preflight in src/mcp/ticket-queue.ts ~195-209 finds frontend-imp only among immediately dispatchable tickets, so a ready-for-agent frontend ticket blocked by an imp ticket passes preflight and fails after the first land. src/unattended/control.ts ~63 checks a fixed three-role list even when the selected Objective has a ready frontend ticket, which breaks the start-time promise in docs/reference.md. Derive the needed roles from the run's intended workset: every ready-for-agent ticket the run can reach, including blocked successors and, for unattended, the selected Objectives' tickets. Share the role parser with dispatch instead of keeping a second regex. (2) Starting hud_tickets run on a paused feature creates a successor run and leaves the old receipt paused with accept asking. answerTicketQueueHandback (~284-360) checks only the old receipt, so answering repair on the old pause notice can set it working next to its successor. Reject an answer to a superseded hand-back with a clear error (e.g. code superseded_run naming the successor), and fence both resume paths (hud_tickets run resume and hud_respond answer) with the same feature admission lock so only one run per feature can be working. (3) Optional if small: share the repair transition (cap check, new-work check, round increment, cursor reset) between the main answer path (ticket-queue.ts ~313-379) and lead accept (ticket-queue-step.ts ~1499-1531), leaving lead closure and main's retryable invalid-answer reply at the callers.

- [x] A feature with imp ticket 01 and a ready-for-agent frontend ticket 02 blocked by 01 is refused at start, before any dispatch, when frontend-imp is hidden, and the error names the fix (test)
- [x] Unattended start checks the frontend role when a selected Objective has a ready frontend ticket (test)
- [x] hud_respond repair on a paused run that has a successor is rejected and the old run stays paused; at most one run per feature is ever working (test)

## Comments

- Landed in this commit (replay base cf6e0e464719d40cec854bd0d84c9d5ea0d7b2c7); gate 5/5 passed.
