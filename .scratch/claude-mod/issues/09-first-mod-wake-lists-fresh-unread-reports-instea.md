# 09: First mod wake lists fresh unread reports instead of folding them

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** 2026-11-23: scan-fixes/06 (j0832e29597649ef6) and open-review-fixes/06 (jc85f76cee84bccae) settled at 07:56Z/07:53Z, minutes before /reload-plugins. The new mod's first wake (claude-mod/07) folded them into `23 older unread reports — hud_read view:compact`, so the main session missed two finished slices for about an hour. Fix: the first wake lists, one line each, unread settled reports of jobs this caller created that settled within the last 2 h (or since the previous mod watch's last delivery, if recorded), and folds only older ones into the summary line. Keep the ≤1 summary line rule for the rest.

- [x] Reload with 2 fresh (10 min old) and 30 old (hours) unread reports: first wake shows 2 lines + 1 summary line
- [x] Fresh reports of other callers' jobs are not listed
- [x] Unit test plus `claude plugin test` pass

## Comments
