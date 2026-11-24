# 04: Tickets link to Objectives; jobs and archive carry the link

**Status:** done
**Owner try:** no
**Blocked by:** 01

**What to build:** Spec §2.3 second bullet. A ticket may carry `**Objective:** <id>` in its header. At `hud_create` with a `ticket` (`src/mcp/dispatch/orchestrator.ts:495-496,558-559`), read that field from the ticket file and stamp `objective: {id, title}` (title from the project's objectives.md at that moment) into job.json; carry it through `retry_of`, `hud_send` repairs, land repairs and Sonic children (inherit from the parent job); never guess from a title or package. Add `objective` to `projectJobFacts` (`src/roles/job-archive.ts:37-52`) so the archive line has it. Unattributed and older jobs stay unattributed. `hud_tickets` add/update accept an optional `objective` that writes the header field (validated against objectives.md). Inspector shows the Objective id and title when set. Size budget about 300 lines incl. tests.

- [x] Test: a ticketed job stamps the Objective id and title; a retry and a repair keep it; a ticket without the field stamps nothing
- [x] Test: the archive line carries `objective`
- [x] Test: hud_tickets update with an unknown objective id fails without writing
- [x] `npm test` passes

## Comments

- Landed in this commit (replay base a5bc860b920d7c10a5a7854db34aa2a3161b03a4); gate 5/5 passed.
