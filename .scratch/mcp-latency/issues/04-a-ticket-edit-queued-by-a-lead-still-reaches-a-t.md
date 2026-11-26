# 04: A ticket edit queued by a lead still reaches a terminal outcome after the lead's MCP swaps or exits

**Status:** ready-for-agent
**Blocked by:** none
**Objective:** unattended

**What to build:** Repair from milestone review j2814424269891a3c (major finding). Leads may call the main hud_tickets handler (src/mcp/mcp/server.ts:192-200), and a lead's add/update admits a queued receipt and starts its supervisor (src/mcp/ticket-edit-queue.ts submitTicketEdit -> wake). But a lead's MCP has HUD_JOB_DIR set, so `worker` is truthy. Neither cold start (server.ts:297-300) nor hot swap (server.ts:326) calls resumeTicketEdits for it, and stop() aborts the supervisor unconditionally. A lead session also closes right after hud_report, which ends its supervisor. If the detached `workflow-runner --ticket-edits` helper then fails, which is the case ticket 03 covers, the receipt stays `queued` until some main MCP starts or reloads. Unattended runs need not have a main session open. This happens in practice: lead j66891978899adb94 reported with receipt te…2d2 still queued behind consecutive lands. Fix with the simplest of these: (a) give resume (cold start and hot swap) the same eligibility as admission (main or lead); and (b) so the receipt survives the lead closing, have the long-lived process that hosts the lead step (the queue workflow runner, src/mcp/workflow-runner.ts) re-drive active receipts for its project with the existing resumeTicketEdits/wake supervisor while the run is alive, then stop it when the run ends. Reuse the existing bounded wake, its attempt budget, and the commit-marker check. Add no second drainer and no new receipt API. Never replay an `applying` receipt.

- [ ] A lead MCP that admitted a queued receipt resumes its supervision after a hot swap (and on cold start), using the same eligibility as admission (test)
- [ ] With no main MCP running, a lead-admitted receipt whose helper is killed reaches completed or failed after the lead MCP exits, while the queue run is alive, with no further RPC (test)
- [ ] An `applying` receipt is still decided by the commit-marker check and is never applied twice; existing thin-mcp-ticket-commits tests still pass

## Comments
