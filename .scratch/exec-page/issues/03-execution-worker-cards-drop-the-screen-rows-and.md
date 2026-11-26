# 03: Execution worker cards drop the 画面 screen rows and HUD stops their periodic screen reads

**Status:** ready-for-agent
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Owner 2026-11-26 (D-2026-11-26-09, docs/design/tab-roles/README.md §3a): the 画面 "print window" thumbnails on Execution worker cards (工作者) are not needed. Remove the screen rows, the "画面每 2 秒读取一次" note and every periodic pane read that exists only to feed them. Keep on-demand pane reads elsewhere (hud_peek lines, Inspector on request). Owner-approved visible removal: the 画面 rows only.

- [ ] Execution worker cards render without 画面 rows or the read-interval note in EN and ZH at 40 and 62 columns; the freed rows go to the workflow section.
- [ ] No periodic pane/screen read runs for Execution (verified by a test that counts reads over a watcher tick with Execution open).
- [ ] hud_peek lines and other on-demand reads still work.
- [ ] docs/reference.md no longer describes the 画面 rows.

## Comments
