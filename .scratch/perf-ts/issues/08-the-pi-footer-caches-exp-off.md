# 08: The pi footer caches EXP off

**Status:** done
**Blocked by:** none
**Owner try:** no

**What to build:** Plan `docs/llm/perf-rust-plan-2026-11-22.md`, row 08. `src/harness/pi/p10k-footer.ts` and `subscription.ts` reread EXP settings on every draw (120 reads per 120 paints with EXP off). Cache the observed disabled state as well as enabled, refresh only when settings, binding or proxy change or a watch is lost; keep demand-only refresh. Measure before and after on a synthetic fixture under `tmp/env.sh` and put both numbers in the report.

- [x] 120 paced paints with EXP off read settings once
- [x] Turning EXP on is picked up without restart
- [x] Targeted pi footer tests pass

## Comments

- Landed cb08bb1d5ec6b920a064639c8ab5ec440fdc86f4; gate 5/5 passed.
