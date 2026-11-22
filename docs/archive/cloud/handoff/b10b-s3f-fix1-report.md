# B10B-S3F single fix-round report

**Published:** `dots/b10b-s3f` at [a754871612b8e56e8df12e907e8ae1654c24f999](https://github.com/CartmanFatass/codex-hud/commit/a754871612b8e56e8df12e907e8ae1654c24f999).

Remote ref verified. Checkout `/tmp/b10bs3f-repo` fast-forwarded to that commit. Only the pre-existing `node_modules/.package-lock.json` modification remains unstaged.

## Changes

Two files, 37 insertions and 2 deletions:

- `src/render/monitor-input.ts`: right-arrow navigation finds the first destination whose `parentKey` equals the selected row’s key, rather than assuming screen adjacency.
- `tests/unit/b10b-s3-rich.test.ts`: two regressions cover a native sub-row’s history/put-away child and child card. Both verify compact and rich behavior, no action, unchanged collapse state, and left-navigation back to the parent.

**R1 fixed.** Both new tests failed against the original implementation:
- Actual `codex:N1`, expected `put:3:codex:N1`.
- Actual `codex:N1`, expected `codex:B`.

After the change, all 13 rich tests pass. The fifth-sub-row overflow test is unchanged and passes.

No API, fixture, visual baseline, threshold, sample count, benchmark scope, contract, or supported-profile changes.

## R2: diagnostic findings and runtime-specific evidence

No speculative performance source changes were retained.

Node24’s changed-tick failures remain valid and preserved. An instrumented diagnostic copy attributed **86.9% of the elapsed time across the ten slowest gated compact samples to overlapping GC**. All ten overlapped GC. Diagnostic compact p99 remained **13.685 ms**, so this is diagnosis, not a pass.

A bounded-memo experiment worsened performance and was reverted. The final benchmark source is unchanged.

The existing supported **Node22.23.4** runtime completed three full strict runs, all exit 0:

| Gated p99, ms | Run 1 | Run 2 | Run 3 | Limit |
|---|---:|---:|---:|---:|
| Compact no-change | 0.539 | 0.958 | 0.710 | 2 |
| Rich no-change | 0.790 | 0.717 | 0.655 | 2 |
| Compact changed | 7.594 | 5.873 | 8.290 | 10 |
| Rich changed | 5.698 | 10.534 | 9.578 | 15 |

Command, each run:

`env -u NO_COLOR -u FORCE_COLOR -u NODE_USE_ENV_PROXY HOME=$(mktemp -d) HUD_HOME=$(mktemp -d) B10B_PERF=1 /workspace/scratch/6daef0397a95/hyg2-node22/node_modules/node/bin/node --test dist-test/tests/unit/b10b-s3-perf.test.js`

Host: `d14215e6cbaa`, AMD EPYC 9V74, Linux 6.18.57 x86_64. Unchanged measurement: 1,000 samples after 200 warm-up, nearest-rank, 200 nodes at 56 columns. Raw log includes p50/p95/p99/max, host load and all exits.

**This does not repair or waive Node24 failures.** The fresh Oracle must judge the supported-runtime evidence explicitly; I do not claim universal performance acceptance.

## Final focused checks

Actual output summaries:

- Build, build:test, build:hud-mcp: `BUILD_EXIT=0`.
- B10B suites excluding performance files: `tests 360`, `pass 360`, `fail 0`.
- Isolated visual suite: `tests 331`, `pass 331`, `fail 0`.
- Format: `All matched files use Prettier code style!`
- Fixtures: `check-fixtures: OK (tests/fixtures tests/prototypes docs/probes docs/design)`
- Diff-check: exit 0.

The initial combined check command did not give its visual subcommand a temporary HOME. I reran visual explicitly with temporary HOME/HUD_HOME; that isolated run passed 331/331 and is the cited visual result.

Full README checks are **not newly green**. I did not rerun denied socket/ptrace operations or relabel prior failures. The earlier failed full-suite results and unrun `test:mjs` remain outstanding.

## Evidence for dispatcher archival

- `/tmp/b10bs3f-r1-before.log`: both new tests failing without the fix.
- `/tmp/b10bs3f-r1-after.log`: all 13 rich tests passing.
- `/tmp/b10bs3f-fix-evidence/focused-checks.log`
- `/tmp/b10bs3f-fix-evidence/visual-isolated.log`
- `/tmp/b10bs3f-fix-evidence/performance-node22.log`
- `/tmp/b10bs3f-profile/gc-diagnostic2.log`
- `/tmp/b10bs3f-profile/gc-diagnostic.mjs`: reproducible diagnostic instrumentation.
- `/tmp/b10bs3f-profile/baseline.log`
- `/tmp/b10bs3f-profile/bounded-memo.log`: unsuccessful, reverted experiment.

R3 remains an optional documentation follow-up outside this narrowly scoped fix. No merge into `universal-hud` was performed.