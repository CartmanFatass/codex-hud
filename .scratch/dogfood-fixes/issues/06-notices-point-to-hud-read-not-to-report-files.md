# 06: Notices point to hud_read, not to report files

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Owner 2026-11-22: the main session cats $HUD_HOME/jobs/<id>/report.md because notices print the path, so reads go unrecorded (report_unread piles up, read-close never fires). No harness hooks (owner: not needed). MCP task results, watch/session notices and the default hud_read digest stop printing the report path; they name the job and the call to make (`hud_read job=<id>`, `mode: "full"` for the whole report). The path stays available in hud_read mode full. Shipped convention and the hud-delegate skill say to read reports with hud_read. Spec §5 MCP-ORCH result sentence: 'report path' becomes 'the hud_read call'.

- [ ] No notice or default digest contains a report.md path
- [ ] mode full still gives the path
- [ ] npm test and check:fixtures pass

## Comments
