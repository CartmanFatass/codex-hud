# 04: Retime the remaining slow panel tests

**Status:** ready-for-human
**Blocked by:** none

**What to build:** Proposal 09 S4 with owner default Q3=A (keep native node --test; add tests/run-mjs.mjs only if three full runs flake): src/cli/panel-pane.ts timing parameter; panel-caller, decision-labels, home-recommendation tests.

- [x] Production default unchanged without override
- [x] test:mjs green three runs in a row; wall time reported

## Comments

- 2026-11-22 main: landed 58e7dfa2 (panel-reload-views merged with MONITOR-STATE-04 by hand). decision-labels 6.5→1.2 s, home-recommendation 6.7→0.8 s; three native green runs in the imp; main 952/952. Suite still ~70 s: the rest is subprocess-heavy MCP lifecycle tests (left for later).
