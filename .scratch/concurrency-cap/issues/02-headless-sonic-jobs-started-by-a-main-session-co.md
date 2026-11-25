# 02: Headless sonic jobs started by a main session count toward the sonic cap

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Owner 2026-11-25 set `roleCaps.sonic: 9` to keep wide sonic fan-outs (e.g. 60+ transcript-labelling jobs) from exhausting RAM (14 GB machine, ~150-300 MB per pi process) and provider rate limits. Today `isCountedJob` (src/roles/concurrency.ts:25-29) excludes every headless sonic, so the cap never applies. Count top-level headless sonic jobs (no parent_job, not scout_only) toward the sonic cap like any other role; keep worker sonic children (hud_sonic) and prewalk scouts excluded so a worker or a target never waits on its own helper. Extra sonic jobs queue oldest-first and start headless when a slot frees, through the same queue path other roles use; make sure the queued-start path supports headless sonic launch (mode, thinking decision, limits). Keep the shipped default uncapped for sonic (only the owner's setting sets 9). Update docs/reference.md (+zh) roleCaps sentence.

- [x] With roleCaps.sonic = 2, three main-session sonic creates: two run headless, the third reports queued with a position and starts headless when one settles
- [x] Worker sonic children and prewalk scouts still start immediately regardless of the cap
- [x] Default settings (no sonic cap) behave as today
- [x] Targeted tests for concurrency and sonic launch pass

## Comments

- Landed in this commit (replay base 67e57c91ef483ec3869a151f9e6aa76084394f1a); gate 5/5 passed.
