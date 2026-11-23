# 03: Antigravity uses the native statusline

**Status:** done
**Blocked by:** 02
**Owner try:** yes

**What to build:** Plan `docs/llm/perf-rust-plan-2026-11-22.md`, row 03. Stage 2 row 03. The Antigravity statusline path uses the same binary and `bin/hud-statusline-cache.sh` is removed, keeping its tested staleness policy (caller PID and birth, config/build/env stamp, slot limits, fresh/stale caps, refresh lock, bounded pipe drain). Measure before and after on a synthetic fixture under `tmp/env.sh` and put both numbers in the report.

- [x] Agy hit < 5 ms (from ~22 ms); staleness behaviour tests unchanged
- [x] Targeted agy statusline tests pass

## Comments

- Landed e903dd6eaeacc1b51d2f27769b580eeb8ba2d3b3; gate 5/5 passed.
