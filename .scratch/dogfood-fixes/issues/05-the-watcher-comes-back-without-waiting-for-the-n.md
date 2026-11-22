# 05: The watcher comes back without waiting for the next dispatch

**Status:** done
**Blocked by:** none

**What to build:** Found 2026-11-22: after the watcher process ended, nothing restarted it until the next hud_create (ensureWatcher runs only there), so a stop-requested job whose pid had died stayed 'working' and settlement waited. Call the same cheap ensureWatcher on hud_read, hud_send, hud_respond and hud_land too.

- [x] With no watcher running, a hud_read starts it and a dead stop-requested job settles
- [x] npm test and check:fixtures pass

## Comments

- 2026-11-22: landed 41d5bcd9 via sonic gate (test:mjs 1040/1040 on one run; other run one hud-cli-async load flake).
