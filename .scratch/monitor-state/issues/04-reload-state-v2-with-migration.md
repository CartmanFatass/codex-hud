# 04: Reload state v2 with migration

**Status:** done
**Blocked by:** 03

**What to build:** 04 S4: ReloadStateV2 whitelist codec with v1/v0 migration; panel stops writing `modes`; dead settings keys changesPane/detailsPane/monitorModes/monitorPreferences removed (owner default).

- [x] A panel reloaded from a v1 payload keeps its place
- [x] v/f/Esc no longer rewrite hud-settings.json

## Comments

- 2026-11-22 main: landed 603f8fd0 (import conflict with BUILD-DEDUP-04 merged by hand). Suite 951/951, release test green.
