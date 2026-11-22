# 01: Failed jobs leave Home once superseded

**Status:** done
**Blocked by:** none

**What to build:** docs/design/home-progress/README.md slice 1 HOME-SUPERSEDE with owner answers (D-2026-11-22-14): persist retry_of, stamp observed_at on retry; a failed/stopped job is superseded by a retry/repair, a newer job on the same target, or a landed slice/ticket; superseded failures leave Home, lane tops, hud_read({}) and Recommended (a reveals them muted); unhandled failures leave Home after 30 minutes; a stale AI brief never shows once its inputs changed.

- [x] A failed job whose retry landed is gone from Home at once and visible muted under a
- [x] An unhandled failure leaves Home after 30 minutes and hud_read({}) still reports it
- [x] npm test and check:fixtures pass

## Comments

- 2026-11-22: landed e8945375 via sonic gate (test:mjs 1016/1016 ×2, unit 92/92, fixtures OK). Owner tries it on Home.
