# 02: Local CPU and RAM in the statusline

**Status:** done
**Owner try:** no
**Blocked by:** 01

**What to build:** Spec §5 M2. Show local CPU% and RAM (Linux/WSL guest, labelled as such) in the statuslines without blocking. CPU% needs a persisted prior `/proc/stat` sample, because each `hud statusline` call is a fresh process: keep one small sample file under `$HUD_HOME` and compute the delta; the first call after a gap shows no CPU% rather than a guess. RAM from `/proc/meminfo` (MemAvailable); add swap only when it is under pressure. No host (Windows) metrics.

- [x] Test: two calls with synthetic `/proc/stat` samples give the expected CPU%; a missing or stale sample shows no CPU%
- [x] Test: RAM from a synthetic meminfo; swap appears only above the pressure threshold
- [x] Measured: statusline wall time stays within its current budget (number in the report)
- [x] `npm test` passes; reference.md (EN/ZH) updated

## Comments

- Landed in this commit (replay base e5e2ec75dfb320ff17c2a441cca084c4d14d96e0); gate 5/5 passed.
