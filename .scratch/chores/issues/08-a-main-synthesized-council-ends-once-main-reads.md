# 08: A main-synthesized council ends once main reads it, and hud_close can end it

**Status:** ready-for-agent
**Owner try:** no
**Live try:** council j84ec335faab925fb no longer shows as working in hud_read after the fix lands
**Blocked by:** none
**Objective:** unattended

**What to build:** Seen 2026-11-26: council j84ec335faab925fb (synthesizer main, created 2026-11-25 17:33, pi-worker design) still shows state working / 'Council in progress' a day later although all three members closed with reports and main used them; it counts as live work on Home and in hud_read's job list. hud_close on it fails with `hud-reap: ENOENT ... SESSION.txt` because a council parent has no session. Fix: with synthesizer main, the council parent becomes done (state closed, reason 'members collected by main') when every member has settled and main has read the council with hud_read (the call that returns the member digests and synthesis instructions); hud_close on a council parent closes it (and any still-running members through normal closure) instead of failing on a missing SESSION.txt. Existing stuck council records are settled by the same rule on the next watcher pass.

- [ ] A synthesizer:main council whose members all settled closes after main's hud_read (test)
- [ ] hud_close on a council parent closes it without the SESSION.txt error (test)
- [ ] A stuck pre-existing council record with settled members and a prior read is settled on the next pass (test)

## Comments
