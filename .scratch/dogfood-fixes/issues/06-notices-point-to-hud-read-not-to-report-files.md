# 06: Notices point to hud_read, not to report files

**Status:** ready-for-human
**Blocked by:** none

**What to build:** Owner 2026-11-22: the main session cats $HUD_HOME/jobs/<id>/report.md because notices print the path, so reads go unrecorded (report_unread piles up, read-close never fires). No harness hooks (owner: not needed). MCP task results, watch/session notices and the default hud_read digest stop printing the report path; they name the job and the call to make (`hud_read job=<id>`, `mode: "full"` for the whole report). The path stays available in hud_read mode full. Shipped convention and the hud-delegate skill say to read reports with hud_read. Spec §5 MCP-ORCH result sentence: 'report path' becomes 'the hud_read call'.

- [x] No notice or default digest contains a report.md path
- [x] mode full still gives the path
- [x] npm test and check:fixtures pass

## Comments

- 2026-11-22: landed 41d5bcd9 via sonic gate (test:mjs 1040/1040 on one run; other run one hud-cli-async load flake).
