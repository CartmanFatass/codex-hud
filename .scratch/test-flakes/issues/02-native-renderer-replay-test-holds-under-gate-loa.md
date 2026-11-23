# 02: Native renderer replay test holds under gate load

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** test-flakes/01 left native-statusline 'failed native renderer replays fresh stdin exactly' alone (spawnSync ETIMEDOUT at the file's own 7 s per-process watchdog; passed focused reruns). It failed again in the panel-polish/02 land gate 2026-11-22 (excerpt ~/.hud/flows/f32c448e14d394e42-3.json.gate-1.log, and fcb8fd4161ce2ac15.json.gate-1.log). Find whether the launcher is genuinely slow on that path under load (a product issue: measure the failed-native → TS replay path) or the 7 s watchdog is just too tight for a cold TS render under a parallel suite; fix accordingly.

- [x] Cause named with a timing of the failed-native replay path under parallel load
- [x] Test passes 20 consecutive runs alongside npm run test:mjs
- [x] If the replay path is slow, the fix is in the launcher

## Comments

- Landed in this commit (replay base 30cd3ce6010addbf44f0d451fc9f9f15de9898a4); gate 5/5 passed.
