# 05: MCP calls do one scan and start no needless watcher

**Status:** ready-for-agent
**Blocked by:** none
**Owner try:** no

**What to build:** Plan `docs/llm/perf-rust-plan-2026-11-22.md`, row 05. In hud-mcp: memoize project/shared git root lookups (`src/roles/projects.ts` spawnSync) with a short TTL keyed by cwd; scan `jobs/` once per tool call (adoptSessionJobs + rows share it); compute queue positions once per response with a lazy lookup (`src/mcp/thin-main.ts` readRow / changes cursor), using the global per-role FIFO; do not start a watcher for a read when the store has affirmative evidence of no live jobs, and coalesce concurrent launches while readiness is pending. Measure before and after on a synthetic fixture under `tmp/env.sh` and put both numbers in the report.

- [ ] 400-job fixture: hud_read and hud_roster ms before/after; 96 queued roster before/after
- [ ] Five empty reads start no watcher; a read with live jobs still ensures one
- [ ] Targeted thin-mcp tests pass
