# 05: The ticket queue runs as a workflow template

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 04

**What to build:** `.scratch/workflow/spec.md` slice 5. Ticket queue = `batch` step with a ticket source, per-item `job → land`, policy `first`, no pilot. Keep `q…` ids, new id on resume with carried tickets, auto-resume after a `hud_respond` answer, the clean-settlement rules (declared report, no `Blockers:`, checks not skipped, not marked for main review, HUD checks passed), `ticketQueueNotice` text, cross-feature blocker waits. Retire `ticket-queue-runner`.

- [ ] `thin-mcp-ticket-queue.test.mjs` passes unchanged.
- [ ] Land gate passes.

## Comments
