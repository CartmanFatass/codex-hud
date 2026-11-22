# 02: Long-lived processes run with V8 heap caps

**Status:** done
**Blocked by:** 01
**Owner try:** no

**What to build:** Plan `docs/llm/perf-rust-plan-2026-11-22.md`, row 02. Start the panel with `--max-old-space-size=128 --max-semi-space-size=4` and hud-watch and hud-mcp with `96/2` (through their launchers, overridable by an env var). Before choosing, run a 200-tick 400-job panel soak and a watcher/MCP soak per setting and confirm no OOM or GC-thrash CPU regression; pick the smallest caps that keep CPU within 10% of today. Measure before and after on a synthetic fixture under `tmp/env.sh` and put both numbers in the report.

- [x] Soak numbers (RSS, PSS, CPU) for default vs chosen caps in the report
- [x] An env override restores defaults
- [x] Targeted launcher tests pass

## Comments

- Landed 78ef2522885804ac17a09c73c65c38be881f8995; gate 5/5 passed.
