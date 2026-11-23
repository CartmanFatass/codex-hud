# 02: A Rust statusline renders the Claude line

**Status:** done
**Blocked by:** 01, perf-ts/06
**Owner try:** yes

**What to build:** Plan `docs/llm/perf-rust-plan-2026-11-22.md`, row 02. Stage 2 row 02 and its constraints (fresh stdin per call, buffered stdin replayed to the TS fallback, forward/admin/details modes stay TS, email suppression, quota publication, existing parity cache files). std-only crate under `native/`; `npm run build` builds it only when cargo exists and `native/` changed; polyglot `bin/hud-statusline` dispatches to it with TS fallback; a differential test renders the same fixtures through TS and Rust and must match byte for byte; release archive and `./install` carry the Linux x64 binary and fall back to TS without it. Measure before and after on a synthetic fixture under `tmp/env.sh` and put both numbers in the report.

- [x] p50 < 5 ms and < 5 MB RSS on the fixture (TS before/after in the report)
- [x] Differential parity passes on Claude, CJK, ANSI, NO_COLOR, malformed and oversize input
- [x] Missing or broken binary falls back to TS with identical output
- [x] Land gate time with and without native changes reported

## Comments

- Landed 290eb95b001f2ea9315db3251f1347307fd6a74b; gate 5/5 passed.
