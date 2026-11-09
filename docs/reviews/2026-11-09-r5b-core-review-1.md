Verdict: changes-required

## Findings

### 1. Major — summary application mutates filtered copies instead of displayed native nodes

**`src/collectors/model-jobs.ts:876–877`** — Filtering the tree before applying display fields loses label, task-kind and digest updates on retained native ancestors of excluded job nodes.

`summaryTree` copies a retained node whenever filtering changes its children (`model-jobs.ts:532–533`). `ModelJobs.apply` then assigns/deletes `label`, `taskKind` and `digest` on that copy, but neither returns it nor updates the original tree. For example, a native-enriched parent with a synthetic dispatch-helper child is copied to exclude that helper: restored/generated summaries never reach the parent handed to the renderer. Turning summaries off also fails to clear existing display fields on that parent. This violates preservation of the native summary path.

**Reproduction:** With a native parent carrying `label: 'previous label'` and `digest: 'previous digest'`, plus a `role-job:…:dispatch:sonic-1` child, production `ModelJobs.apply(tree, NO_JOBS, 'en')` leaves both fields on the displayed parent. Removing the helper makes the same call clear both fields. `summaryTree(tree).nodes[0] === parent` is false in the failing case.

**Suggested fix:** Keep the filtered tree for material eligibility/planning, but apply display mutations to eligible original node references, or explicitly copy the resulting display fields back. Add a production restoration/application regression with a native parent and an excluded helper, including disabling summaries.

### 2. Major — global job coverage is discarded, allowing false empty/complete displays

**`src/tree-page.ts:517–524`** — Live composition drops `JobTreeResult.coverage` and `diagnostics`, so incomplete discovery and projection omissions never reach the panel's coverage or empty-state logic.

If the shared deadline expires before the first job read, the collector returns `incomplete: true, omitted: null` and no admitted nodes. The page nevertheless marks the tree built/collection complete, and the renderer says **“No agents started in this session yet.”** Similarly, jobs omitted by the projection limit have no global partial/omission indication. Per-node `job.coverage` cannot represent undiscovered or entirely omitted nodes. Architect §6 requires incomplete/unknown omission reporting; absence must not prove no work.

**Reproduction:** `PanelJobPipeline.refresh(undefined, { deadline: 0 })`, followed by composition over an empty native `main` tree and rendering with `loading: false`, returns incomplete coverage but visibly prints the affirmative empty statement, with no partial/incomplete indication.

**Suggested fix:** Retain composition coverage/diagnostics in the live render inputs and use the existing partial/unavailable/loading vocabulary. Suppress the affirmative empty state while coverage is incomplete, and surface projection omissions through that same path. Add deadline-exhaustion and projection-truncation render-path tests. Orchestrator ruling **`qa/q4.answer.md`** confirms this propagation belongs to R5b-core, not the parallel UI package.

## Verified

### Scope and implementation

- Read the complete task/review briefs, implementer notes, decided design and architect design; applicable agent/directory guidance; R5a q5/q7 and core q1–q4 rulings.
- Reviewed the full diff against `306b1ff9f7f2741bbecc7e3ecc2991dc5e854fca` and all four untracked test/benchmark files.
- The supplied tests use the real observation collector/composer, production SmallModel/material scheduling/cache classes, and synthetic local transport. The tested mixed/afterPaint, generation-fence, action-fence, root selection, material-sentinel, restoration and no-write dry-run cases pass. They do not cover the two failing cases above.
- Runtime import checks pass: the bar gains no job modules; the panel reaches the collector without the prohibited facade/Jev adapter/client/executor/factory imports.
- No changes to `src/index.ts` or protected WP0/visual-fixture sources were present in the reviewed diff. Additional render-file hunks are covered by core q1/q2 authorization.
- Read the recorded mutation a–f logs: each records the intended focused test failing. I did not reapply mutations during this read-only review.

### Commands and actual results

All required commands passed on the reviewed working tree; no failure rerun was needed.

| Command | Actual result |
|---|---|
| `npm run build` | Exit 0 |
| `npm run build:test` | Exit 0 |
| `npm run build:hud-mcp` | Exit 0 |
| `npm run test:unit` | 4,042 tests; 4,018 pass; 0 fail; 24 skipped; exit 0 |
| `npm run test:mjs` | 383 tests; 382 pass; 0 fail; 1 skipped; exit 0 |
| `npm run test:hud-mcp` | 212 tests; 211 pass; 0 fail; 1 skipped; exit 0 |
| `npm run format:check` | “All matched files use Prettier code style!”; exit 0 |
| `bash tests/run-main.sh` | `files=113 tests=1176 pass=1176 fail=0`; exit 0 |
| `node --test dist-test/tests/unit/r5-panel.test.js dist-test/tests/unit/r5-production-summary.test.js dist-test/tests/unit/r5-brief-dry-run.test.js` | 11 pass; 0 fail; 0 skipped |
| `node --test tests/unit/r5-imports.test.mjs` | 3 pass; 0 fail; 0 skipped |
| `git diff --check` | Exit 0 |

Also ran read-only `node --input-type=module` diagnostic probes against the built production classes to reproduce findings 1 and 2; outputs are quoted in the findings.

### Independent synthetic performance run

Ran `node tests/int/r5-job-performance.mjs`: exit 0. Host **Jacob**, Linux **6.18.33.2-microsoft-standard-WSL2 x64**, Node **v24.22.1**; three fixture runs, 30 samples per scenario per run (90 total), nearest-rank quantiles. Values below are milliseconds, ordered **p50 / p95 / p99 / max**.

| Scenario | Collection + composition | Repaint |
|---|---|---|
| Base, no jobs | 0.009 / 0.047 / 0.299 / 0.299 | 0.218 / 0.704 / 3.106 / 3.106 |
| Quiet | 14.157 / 17.369 / 18.982 / 18.982 | 0.384 / 0.628 / 2.091 / 2.091 |
| Changed | 13.621 / 15.953 / 17.115 / 17.115 | 0.338 / 0.593 / 0.751 / 0.751 |
| Discovery | 14.832 / 20.589 / 24.402 / 24.402 | 0.437 / 0.718 / 0.884 / 0.884 |
| 5,000 records | 16.954 / 43.425 / 54.618 / 54.618 | 1.433 / 2.222 / 2.889 / 2.889 |
| Herdr unavailable | 14.212 / 17.510 / 19.082 / 19.082 | 0.338 / 0.558 / 0.912 / 0.912 |

Collection p95 ranges across the three runs: quiet **15.474–18.492 ms**, changed **15.099–16.370 ms**, discovery **19.747–22.681 ms**, large history **42.396–45.051 ms**, outage **17.389–18.434 ms**. Peak measured file attempts/bytes/entries per refresh were **32 / 28,704 / 128**; peak process RSS was **180.141 MiB**; synthetic Herdr concurrency was at most **1**.

The benchmark explicitly uses an empty-native-list baseline, bounded incremental large-history collection, and render-only repaint timing. File attempts are not syscall counts; RSS is process-wide. These are synthetic design measurements, not historical whole-panel timings or live-provider/production qualification. No real Herdr, logged-in harness, Jev/browser or installer acceptance was attempted.

Report: `/home/fires/projects/MyHUD/tmp/tasks/R5B-CORE/review-1.md` — 2 findings (2 major).
