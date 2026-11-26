# 02: Ticket edits under a held land lease return a queued receipt within 2 s and commit in order later

**Status:** ready-for-agent
**Owner try:** no
**Live try:** while a hud_land runs, call hud_tickets add for a scratch feature in a temp project: it returns queued within 2 s; after the land finishes the ticket file and commit appear and the receipt shows its number
**Blocked by:** 01
**Objective:** unattended

**What to build:** Diagnosis job j728520f939adb5de, proposal 2. Today src/mcp/ticket-commits.ts:16-32 waits for the main-checkout lease (held by land through gate, publish and cleanup, src/mcp/land-runner.ts:532-593) before planning or writing, so hud_tickets add/update block for minutes (647 s observed). Keep the synchronous fast path when the lease is free (unchanged reply). When the lease is held: admit the edit to an ordered, private, bounded durable queue under $HUD_HOME and return within 2 s `state: queued` with a receipt id (no assigned paths or per-item outcomes yet; say so in the reply). Admission must not wait behind another edit's lease wait. After the lease is granted, revalidate against the current checkout, apply with the existing path-only commit and hand-edit protections, and record the outcome on the receipt; recovery after an MCP restart applies each receipt at most once (no duplicate adds). Read the outcome with hud_read({job: <receipt>}) or a hud_tickets op the main session already uses, whichever adds less surface; a finished receipt also reaches the caller like other notices. Keep chores/02: edits never write into the main checkout while a land holds it. Update docs/reference.md (hud_tickets) and the tool description in as few words as the schema budget allows.

- [ ] Lease free: add/update reply as today, under 2 s (test)
- [ ] Lease held: reply `queued` with a receipt in under 2 s; a second edit is admitted without waiting behind the first (test)
- [ ] After the lease is released, queued edits apply in admission order with path-only commits; receipt shows assigned numbers/paths or the error (test)
- [ ] MCP restart with pending receipts applies each once, no duplicates (test)
- [ ] docs/reference.md and tool description updated

## Comments
