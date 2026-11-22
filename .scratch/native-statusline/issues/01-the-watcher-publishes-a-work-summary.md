# 01: The watcher publishes a work summary

**Status:** ready-for-agent
**Blocked by:** none
**Owner try:** no

**What to build:** Plan `docs/llm/perf-rust-plan-2026-11-22.md`, row 01. Stage 2 row 01. hud-watch and hud-mcp write `$HUD_HOME/display/work-summary.v1.json` (private, atomic, size-bounded, versioned, with producer generation and observed-at) on meaningful job changes: per pane and global running/asking counts by role, enough for `src/render/work-summary.ts`. Absent or stale means unknown. The pi footer segment (`src/harness/pi/segment.ts`) reads it instead of scanning jobs, falling back to today's read when stale. Measure before and after on a synthetic fixture under `tmp/env.sh` and put both numbers in the report.

- [ ] Snapshot updates within 200 ms of a job state change; stale after the watcher exits is detected
- [ ] pi segment refresh at 356 jobs drops from ~22 ms to <1 ms with a fresh snapshot
- [ ] Targeted tests pass
