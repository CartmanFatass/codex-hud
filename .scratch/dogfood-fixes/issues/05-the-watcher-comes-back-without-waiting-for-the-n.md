# 05: The watcher comes back without waiting for the next dispatch

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Found 2026-11-22: after the watcher process ended, nothing restarted it until the next hud_create (ensureWatcher runs only there), so a stop-requested job whose pid had died stayed 'working' and settlement waited. Call the same cheap ensureWatcher on hud_read, hud_send, hud_respond and hud_land too.

- [ ] With no watcher running, a hud_read starts it and a dead stop-requested job settles
- [ ] npm test and check:fixtures pass

## Comments
