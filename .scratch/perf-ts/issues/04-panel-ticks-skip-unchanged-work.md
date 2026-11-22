# 04: Panel ticks skip unchanged work

**Status:** ready-for-agent
**Blocked by:** 01
**Owner try:** no

**What to build:** Plan `docs/llm/perf-rust-plan-2026-11-22.md`, row 04. Memoize `ProjectCollector.collect()` (`src/collectors/project-board.ts`) on the `.scratch` and ledger stamps; skip `thin-jobs` `exportFacts()` and its JSON stringify when nothing changed (`src/collectors/thin-jobs.ts`); add an ASCII `charCodeAt` fast path to `visualWidth` and build strings without per-char concatenation (`src/render/colors.ts`); make `Intl.Segmenter` lazy (`src/render/monitor-text.ts`). Width results must stay identical (CJK, emoji, ANSI). Measure before and after on a synthetic fixture under `tmp/env.sh` and put both numbers in the report.

- [ ] 400-job fixture: panel tick ms before/after (target <8 ms from ~40)
- [ ] visualWidth/truncateAnsi results identical on the existing width fixtures
- [ ] Targeted render/collector tests pass
