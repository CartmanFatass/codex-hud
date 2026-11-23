# 06: Small MCP contract fixes from the session scan

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** From the scans: (a) hud_report summary: schema maxLength 320 vs description '160 code points' — one number; (b) hud_tickets update `unknown acceptance item: 4` should list the valid range and validate the whole tick list before writing; (c) placement-option refusal on non-general roles names the offending field(s); (d) hud_roster shows imp routing presets (`hard: astra`) that hud_create refuses — say these are chosen by auto-route, not passable; (e) pi `hud-sonic-ready` notices are not sent for a child whose report the same session already collected with `hud_sonic wait` (37% redundant); (f) watch.log logs an unresolved worker-tree snapshot once per job, not every minute.

- [ ] Each of (a)-(f) fixed with a unit test or updated snapshot
- [ ] Tool schema bytes do not grow by more than 200 B total

## Comments
