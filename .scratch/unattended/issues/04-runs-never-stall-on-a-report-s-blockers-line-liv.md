# 04: Runs never stall on a report's Blockers line: live-try notes are hints, the lead triages the rest, an owner matter holds only its ticket

**Status:** done
**Owner try:** no
**Live try:** Start a ticket queue on a scratch feature with two independent tickets whose fake worker reports say `Blockers: owner live try remains` and `Blockers: needs an owner decision on deleting X`: the first lands and its note appears in the run's todo; the second is held after the lead's escalation while the other ticket still lands; main gets one notice, not a pause of the whole run.
**Blocked by:** none
**Objective:** unattended

**What to build:** Owner 2026-11-26: queue runs stalled because workers wrote "owner live try remains" on their `Blockers:` line and `hasReportBlockers` (src/mcp/workflow-lead.ts:39) paused the whole run for main (src/mcp/ticket-queue-step.ts:91-92, 321-324); three runs (nav-redesign, select-send, herdr-fork) stopped this way today. Owner rule: a pending live try or owner try is only a hint and never a blocking reason. Change: (1) The run rule text (workflow-lead.ts:23, :26) says `Blockers:` is only for an owner decision needed before this can land (scope, value trade-off, visible deletion, irreversible act); a pending live try or owner try goes on a `Try:` line or in the report and is never a blocker; write `Blockers: none` otherwise. (2) A Blockers line whose content is only about a live try / owner try / acceptance try is recorded as a todo note and does not stop the item. (3) Any other Blockers line goes to the lead exactly like a scope assumption (same packet, decisions recorded with kind `blocker`): the lead continues (text goes to todo) or escalates. (4) An escalated owner matter holds only that item and the items blocked by it, in every run mode (today only unattended runs hold a single item, ticket-queue-step.ts:1057-1061); independent items keep dispatching and landing; main gets one notice naming the held item; resuming answers that hold. Keep the hand-back record format compatible with `hud_respond` and the panel. Update docs/reference.md and the run-rule docs (packages/hud-mcp/instructions/lead.md if it describes blockers).

- [x] A report with `Blockers:` mentioning only a pending live try/owner try lands without pausing and the text appears in the run todo (test)
- [x] Any other Blockers line is judged by the lead; continue lets the item land (test with a fake lead decision)
- [x] An escalated owner matter holds only that item and its dependents while an independent item in the same run lands (test, non-unattended run)
- [x] Worker run-rule text says live tries are never blockers
- [x] Existing assumption hand-back tests still pass

## Comments

- Landed in this commit (replay base abd8e222f835ce72d6c7e606d7d8e8b1e925f78d); gate 5/5 passed.
