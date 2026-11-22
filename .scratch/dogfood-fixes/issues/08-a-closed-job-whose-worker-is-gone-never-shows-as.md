# 08: A closed job whose worker is gone never shows as working

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Found 2026-11-22: general job j288fb04c6c951215 was closed with hud_close while starting (it returned 'reaped'), its pi pid is dead, STATUS.json still says working with a STATUS.json.stop-requested marker, and hud_read({}) keeps listing it as working (with a child) hours later; the watcher log has no line for it. Find why close-during-startup leaves STATUS working and why the watcher skips it; a stop-requested job with a dead pid settles as stopped on the next watcher pass.

- [ ] Closing a job during startup leaves it stopped/closed, never working
- [ ] A STATUS working + stop-requested + dead pid job settles on the next watcher pass
- [ ] npm test and check:fixtures pass

## Comments
