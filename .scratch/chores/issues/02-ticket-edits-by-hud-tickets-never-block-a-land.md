# 02: Ticket edits by hud_tickets never block a land

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none
**Objective:** unattended

**What to build:** Owner 2026-11-26. hud_tickets add/update (and HUD's own ticket writes such as done marks and comments) leave `.scratch/**` changes uncommitted in the main checkout; a later land then fails with 'Main checkout has dirty or hidden changes on paths the landing touches' (seen twice on 2026-11-26). Make HUD's ticket writes commit themselves (one small commit per call, message `tickets: <feature>/<NN> <op>`, only the ticket paths it wrote, under the main-checkout lease so a running land is never disturbed; queue them until the lease is free). Hand edits by main stay main's job.

- [ ] Tests: add/update commit only their ticket files; during a held land lease the commit waits and lands after; a land after hud_tickets update no longer fails on dirty ticket paths
- [ ] Live try: none

## Comments
