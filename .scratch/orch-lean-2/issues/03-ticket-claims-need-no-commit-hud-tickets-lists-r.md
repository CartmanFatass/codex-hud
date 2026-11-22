# 03: Ticket claims need no commit; hud_tickets lists ready tickets

**Status:** ready-for-human
**Blocked by:** none

**What to build:** docs/llm/post-change-load-2026-11-22.md Rank 2 (owner agreed 2026-11-22): the main session stops committing `Status: claimed` before each dispatch. A ticket with a live job (hud_create ticket field) counts as claimed wherever claimed state is read (panel ticket lanes, HOME-PROGRESS rollup, hud_tickets); the file keeps ready-for-agent until hud_land records ready-for-human. Add hud_tickets({op: "ready"}) returning unblocked, unclaimed tickets (feature/NN, path, title, one-line what) so a dispatch can use brief_file. Update docs/delegation.md and the hud-delegate skill to drop the claim commit.

- [ ] A ready-for-agent ticket with a working job shows as claimed in the panel and in hud_tickets without any file change
- [ ] hud_tickets op ready lists only unblocked tickets with no live job
- [ ] npm test and check:fixtures pass

## Comments
