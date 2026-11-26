# 14: Queue repair: resuming a held item re-judges a corrected worker turn

**Status:** ready-for-agent
**Live try:** none
**Blocked by:** none

**What to build:** Repair of chores/06 after milestone review je1cb09e15e4334b8 (finding 4; read its report for file:line). A lead's owner-only assumption hold sets item.held (src/mcp/ticket-queue-step.ts ~848-859). When the worker publishes a corrected report and main calls hud_tickets run on the paused feature, the successor copies held unchanged (src/mcp/ticket-queue.ts ~247-255) and the judge skips held items (~957-960), so a single-ticket run can go tickets -> review -> accept and finish with no land. Record the report signature and source head on the hold. On resume, an item whose current report signature or head differs from the hold's is un-held and judged again like a new turn (it may land, repair or hold again); an item with the same report stays held and the run stays paused with a notice that names the manual resolution required (worker correction, hud_land, or stop). Resume is never blanket approval of a held item. A run must not reach finish while an item is still held.

- [ ] Test past the initial hold: worker publishes a corrected report, hud_tickets run resumes, the item is re-judged and lands
- [ ] Test: resume with the same report keeps the item held and the run paused with the resolution notice; no review/accept with the held item unlanded
- [ ] A run with a held item never records finish
- [ ] Existing queue/lead/unattended tests pass

## Comments
