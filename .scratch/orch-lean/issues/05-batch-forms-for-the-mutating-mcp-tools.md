# 05: Batch forms for the mutating MCP tools

**Status:** done
**Blocked by:** 02

**What to build:** Rank 6: hud_create.jobs (with brief_file), hud_tickets.updates, hud_respond.answers, hud_send.messages; one call, per-item results. Spec §2.1.7 sentence as told to the owner.

- [x] Three creates in one call return three jobs with per-item errors
- [x] npm test and check:fixtures pass

## Comments

- Landed cd3f4e8becee8a89dbaf81fb23b877860dde4ace; gate 6/6 passed.
