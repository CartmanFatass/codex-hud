# 05: The ticket queue runs as a workflow template

**Status:** done
**Objective:** unattended
**Owner try:** no
**Blocked by:** 04

**What to build:** `.scratch/workflow/spec.md` slice 5. Ticket queue = `batch` step with a ticket source, per-item `job → land`, policy `first`, no pilot. Keep `q…` ids, new id on resume with carried tickets, auto-resume after a `hud_respond` answer, the clean-settlement rules (declared report, no `Blockers:`, checks not skipped, not marked for main review, HUD checks passed), `ticketQueueNotice` text, cross-feature blocker waits. Retire `ticket-queue-runner`.

- [x] `thin-mcp-ticket-queue.test.mjs` passes unchanged.
- [x] Land gate passes.

## Comments

- 2026-11-25 main: deferred by the owner (D-2026-11-25-08): complex workflows wait until one is designed on the engine. Not ready for agents.

- 2026-11-26 main: revived for the unattended service (D-2026-11-26-02, unattended/01). Owner's hand-back rule for unattended runs: the lead escalates only an item that would delete a user-visible feature or change the spec; everything else (failures, owner-try acceptance, worker questions) the lead handles within its authority. A run must not depend on the main session being alive.

- Landed in this commit (replay base 1f5e08398fc265c3584d78d817f28d89e4521a84); gate 5/5 passed.
