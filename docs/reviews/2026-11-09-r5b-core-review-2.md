Verdict: accept

## Findings

No actionable findings. Both major findings from round 1 are fixed; neither was declined. No new actionable defect was found in the fixes or the reviewed change.

## Earlier findings

1. **Fixed — display mutations on filtered copies.** `src/collectors/model-jobs.ts:876–945` now uses `summaryTree(tree)` only for material planning/hydration and walks the eligible **original** nodes when assigning or deleting `label`, `taskKind` and `digest`. Observation-only branches remain excluded. The strengthened production-restoration test constructs a native-enriched parent with an excluded dispatch-helper child, confirms filtering copies the parent, and verifies restored fields on the displayed original. It also verifies `NO_JOBS` clears all three fields and labels restore when re-enabled. The test passes with real SmallModel/material/cache classes.
2. **Fixed — discarded global coverage.** `src/tree-page.ts:531–536` retains the complete `JobTreeResult` on both normal composition and afterPaint. `panelJobRenderState` (`src/tree-page.ts:372–385`) feeds incomplete coverage, known omissions and diagnostics into existing loading/notice inputs; the live renderer uses those inputs at `src/tree-page.ts:1004–1028`. The new real-collector regression exercises deadline exhaustion and the 199-native/two-job projection limit, checks the partial notice, suppresses the affirmative empty statement, and checks known omission wording. It passes.

## Verified

### Review scope and test paths

- Read the complete task brief, round-2 review brief, implementer notes and previous review; the decided R5 design and architect design; applicable agent/directory guidance; R5a q5/q7 and core q1–q4 rulings.
- Read the full diff against `306b1ff9f7f2741bbecc7e3ecc2991dc5e854fca` and all four untracked test/benchmark files. Final status contains the same reviewed file set. No protected WP0/golden sources, `src/index.ts`, dependencies, material contracts or execution implementations were changed.
- Checked the real collector/composer, shared live composition/afterPaint seam, exact-root attachment, generation fencing, shared action-dispatch boundary and summary exclusions. The production summary tests run real scheduling, eligibility, SmallModel and persistence classes with synthetic transport; they do not replace those mechanisms with expected-value stubs.
- Focused coverage passes for mixed legacy/job rendering and selection, afterPaint dedupe, delayed filesystem/live results, job/helper/external action fencing, native and missing-root containers, the actual `hud panel --root` subprocess, material sentinels, native summary restoration and byte-identical denied cache, and no-write/no-backend dry-run equality.
- Import checks confirm the bar gains no job modules and the panel reaches the collector without the prohibited facade/Jev adapter/client/executor/factory imports.
- Read mutation logs a–h. Each records its intended focused test failing; g catches the original filtered-copy restoration defect and h catches missing render-state propagation. I did not reapply mutations during this read-only review. Current source and rebuilt focused tests contain the fixes, not the mutations.

### Commands and actual results

All required checks passed on this working tree. No isolated failure rerun was needed.

| Command | Actual result |
|---|---|
| `npm run build` | Exit 0 |
| `npm run build:test` | Exit 0 |
| `npm run build:hud-mcp` | Exit 0 |
| `npm run test:unit` | 4,043 tests; 4,019 pass; 0 fail; 24 skipped; exit 0 |
| `npm run test:mjs` | 383 tests; 382 pass; 0 fail; 1 skipped; exit 0 |
| `npm run test:hud-mcp` | 212 tests; 211 pass; 0 fail; 1 skipped; exit 0 |
| `npm run format:check` | “All matched files use Prettier code style!”; exit 0 |
| `bash tests/run-main.sh` | `files=113 tests=1176 pass=1176 fail=0`; exit 0 |
| `node --test dist-test/tests/unit/r5-panel.test.js dist-test/tests/unit/r5-production-summary.test.js dist-test/tests/unit/r5-brief-dry-run.test.js` | 12 pass; 0 fail; 0 skipped; exit 0 |
| `node --test tests/unit/r5-imports.test.mjs` | 3 pass; 0 fail; 0 skipped; exit 0 |
| `git diff --check` | Exit 0 |

### Independent synthetic performance run

`node tests/int/r5-job-performance.mjs` exited 0. Host **Jacob**, Linux **6.18.33.2-microsoft-standard-WSL2 x64**, Node **v24.22.1**. Three fixture runs with 30 samples per scenario per run, 90 total; nearest-rank quantiles. Times below are milliseconds, ordered **p50 / p95 / p99 / max**.

| Scenario | Collection + composition | Repaint | Collection p95 range across runs |
|---|---|---|---|
| Base, no jobs | 0.006 / 0.026 / 0.449 / 0.449 | 0.174 / 0.543 / 3.354 / 3.354 | 0.011–0.054 |
| Quiet | 13.053 / 15.663 / 16.226 / 16.226 | 0.318 / 0.643 / 1.957 / 1.957 | 14.870–15.713 |
| Changed | 12.397 / 13.996 / 14.911 / 14.911 | 0.275 / 0.452 / 0.618 / 0.618 | 13.802–14.075 |
| Discovery | 13.436 / 19.503 / 21.298 / 21.298 | 0.385 / 0.617 / 0.712 / 0.712 | 19.384–19.890 |
| 5,000 records | 13.716 / 38.792 / 49.130 / 49.130 | 1.205 / 1.656 / 2.665 / 2.665 | 37.253–39.532 |
| Herdr unavailable | 12.280 / 14.643 / 17.823 / 17.823 | 0.240 / 0.376 / 0.545 / 0.545 | 14.539–14.699 |

Peak file attempts/bytes/entries per refresh were **32 / 28,704 / 128**; peak process RSS was **180.137 MiB**; synthetic Herdr concurrency was at most **1**.

These are non-gating synthetic measurements. The baseline uses the unchanged native builder over an empty native listing, not historical whole-process timing. Large-history collection remains bounded/incremental; repaint measures rendering without terminal writes. File attempts are not syscall counts, and RSS includes fixture generation/JIT/GC. No real Herdr, logged-in harness, Jev/shared browser, installer or production/WSL qualification was attempted.

Report: `/home/fires/projects/MyHUD/tmp/tasks/R5B-CORE/review-2.md` — 0 findings.
