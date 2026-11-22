# 04: hud_read({}) lists only what the main session needs

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Found 2026-11-22: hud_read({view:'compact'}) returned ~130 rows, almost all closed child sonics (started by workers via hud_sonic) and old closed jobs with report_unread. The main session never reads a worker's child reports, so they are noise. Default and compact lists: active jobs of this session/project, plus settled jobs the main session dispatched whose report is unread; worker-started children appear only under their parent (count) and in view:'recent'; older settled-unread rows fold into one count line. Keep the listing under ~2 KB for a busy day.

- [ ] A day with 100 closed child sonics lists none of them in hud_read({}); their parent shows a child count
- [ ] npm test and check:fixtures pass

## Comments
