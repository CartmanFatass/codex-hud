# 03: Hot reload does not ratchet memory

**Status:** ready-for-agent
**Blocked by:** none
**Owner try:** no

**What to build:** Plan `docs/llm/perf-rust-plan-2026-11-22.md`, row 03. hud-watch reloads after a rebuild by `process.execve` (as `src/utils/panel-reload.ts` does), keeping `watch.pid` and readiness semantics. In `packages/hud-mcp/bin/generation.mjs`, generation 0 no longer stays pinned on the main thread for hud-mcp (stdio owner keeps the pipe) and retired workers are terminated after they drain. A rebuild during a request still answers it. Measure before and after on a synthetic fixture under `tmp/env.sh` and put both numbers in the report.

- [ ] 15 synthetic reloads: watcher PSS stays within 10 MB of a fresh one
- [ ] hud-mcp answers across a reload; retired worker threads exit
- [ ] Targeted watch/mcp reload tests pass
