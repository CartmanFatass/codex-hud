# 06: A land builds incrementally and once

**Status:** ready-for-agent
**Blocked by:** none
**Owner try:** no

**What to build:** Plan `docs/llm/perf-rust-plan-2026-11-22.md`, row 06. Keep `tsc` build info (`--incremental`) outside the staged dist dirs in `scripts/build.mjs` so gate and after builds are warm; skip the `after: npm run build` when the integration checkout's tested build inputs match the landed tree exactly (publish through the existing staged publisher, never a partial copy over live dist). Record each gate step's wall time in the flow file. Do not change test concurrency in this slice. Measure before and after on a synthetic fixture under `tmp/env.sh` and put both numbers in the report.

- [ ] Flow files carry per-step timings
- [ ] Second build of an unchanged tree takes a few seconds; after-step skipped when inputs match, rebuilt when not
- [ ] Targeted build/land tests pass
