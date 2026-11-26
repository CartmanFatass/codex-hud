# 03: A queued ticket edit always reaches a terminal outcome even when its drain helper fails

**Status:** done
**Live try:** While a hud_land of a MyHUD job runs, call hud_tickets add for a scratch feature in a temp project and kill the spawned `workflow-runner --ticket-edits` helper; after the land finishes, without another submission, hud_read on the receipt shows completed (ticket file and commit present) or failed with a reason, never stuck queued
**Blocked by:** 02
**Objective:** unattended

**What to build:** Repair from milestone review jd2fc9755a1a3a2b6 (finding 'accepted edit can remain queued indefinitely'). Today src/mcp/ticket-edit-queue.ts:29-40 `wake()` drops spawn errors and ignores an early helper exit. The detached runner can fail its dist import/lock (packages/hud-mcp/bin/workflow-runner.mjs:8-10), for example during the rebuild of the very land that caused the queueing. `settle()` can also throw out of `drainTicketEdits` when `takeLease` itself errors. Either way the receipt stays queued/active and nothing re-drives it: `hud_read` only reads the row (ticket-edit-queue.ts:42-46), and a hot swap skips `resumeTicketEdits` (src/mcp/mcp/server.ts:293-301). Only another submission or a cold MCP restart recovers it. Fix: the MCP that admitted (or still holds) pending receipts re-drives them on a bounded trigger, so no caller action is needed. Use the simplest of these: a recovery check when the drain mutex is free and the receipt is still active, run from the existing notice/idle path or a bounded timer, and/or on hot-swap start. When the helper exits without settling, re-wake it a bounded number of times. Past that bound, record a definite `failed` with the launch error. Never replay a receipt that is already `applying`; the existing commit-marker check still decides it. Also, while there, avoid re-parsing every retained terminal receipt on each admission and each drained item when only active ids are needed (optional simplification from the same review), but only if that stays small.

- [x] The first helper launch fails (or the helper exits before settling); after the lease is released, the receipt reaches completed or failed without another submission or a cold MCP restart (test)
- [x] An `applying` receipt is never applied twice by the re-drive; the commit-marker check decides it (test)
- [x] Re-wake attempts are bounded; past the bound the receipt is `failed` with the reason, and the caller gets the usual completion notice (test)
- [x] Existing thin-mcp-ticket-commits tests still pass

## Comments

- Landed in this commit (replay base 08f8dd05f47aa586e0950a4488e06ba35aab3ed4); gate 5/5 passed.
