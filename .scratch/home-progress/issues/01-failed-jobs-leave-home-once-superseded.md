# 01: Failed jobs leave Home once superseded

**Status:** claimed
**Blocked by:** none

**What to build:** docs/design/home-progress/README.md slice 1 HOME-SUPERSEDE with owner answers (D-2026-11-22-14): persist retry_of, stamp observed_at on retry; a failed/stopped job is superseded by a retry/repair, a newer job on the same target, or a landed slice/ticket; superseded failures leave Home, lane tops, hud_read({}) and Recommended (a reveals them muted); unhandled failures leave Home after 30 minutes; a stale AI brief never shows once its inputs changed.

- [ ] A failed job whose retry landed is gone from Home at once and visible muted under a
- [ ] An unhandled failure leaves Home after 30 minutes and hud_read({}) still reports it
- [ ] npm test and check:fixtures pass

## Comments
