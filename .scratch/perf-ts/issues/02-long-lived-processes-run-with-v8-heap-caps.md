# 02: Long-lived processes run with V8 heap caps

**Status:** ready-for-agent
**Blocked by:** 01
**Owner try:** no

**What to build:** Plan `docs/llm/perf-rust-plan-2026-11-22.md`, row 02. Start the panel with `--max-old-space-size=128 --max-semi-space-size=4` and hud-watch and hud-mcp with `96/2` (through their launchers, overridable by an env var). Before choosing, run a 200-tick 400-job panel soak and a watcher/MCP soak per setting and confirm no OOM or GC-thrash CPU regression; pick the smallest caps that keep CPU within 10% of today. Measure before and after on a synthetic fixture under `tmp/env.sh` and put both numbers in the report.

- [ ] Soak numbers (RSS, PSS, CPU) for default vs chosen caps in the report
- [ ] An env override restores defaults
- [ ] Targeted launcher tests pass
