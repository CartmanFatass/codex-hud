# B10B-S3F re-check

**Verdict: fix required.** Review-1 fixes address F1–F8 as requested, and both specific follow-up questions are resolved. However, F1 introduces a new rich-navigation regression, and the recorded performance gates fail. The full check set is also not green.

## Scope and report verification

Reviewed implementation `f017ca8254a991e0ef8bfa4adf1d658738ebcacf` against `f1e2a84`, and fix round 1 `9924f87..ee2b032`.

Verified:

- `f017ca8` has parents `ee2b032` and `f1e2a84`, and tree `1533ca31ea82090182866e18332b3441fa263e49`, matching the preparation report.
- Its render implementation and `b10b-s3` tests are unchanged from `ee2b032`.
- Remote `973a3f7` adds only the check and performance logs after `f017ca8`.
- The remote logs exactly match the dispatcher’s local files: Git blob hashes `835270d4543682388bf286463216175bf6ba6c09` and `b83ceb6e6fc95214baf377ffcd23353e9b448fbb`.
- The original implementer report describes the pre-fix state. Its `overflowKeys` API, old Switch baseline, earlier checks and performance results must not be presented as current verification.

No files were edited, no git mutations were performed, and no local-only work was run. Two additional reproductions used synthetic fixtures entirely in memory.

## New findings

### R1 — P2, required: rich `l` navigation still assumes depth-first adjacency

`src/render/monitor-input.ts:562–567`, affected by `src/render/delegation/selection.ts:46–47` — **After F1 changes rich destinations to screen order, the next destination is not necessarily the selected node’s first child.**

Failure scenario:

- Root → A, a delegated card.
- A has native children N1 and N3.
- N1 has an old finished native child D, represented by a `⊕N` row.
- Plan/compact order: `main, A, N1, put:3:codex:N1, N3`.
- Rich screen/destination order: `main, A, N1, N3, put:3:codex:N1`.
- With N1 selected, `l` should enter its destination child, the put-away row. It stays on N1 because `rows[at + 1]` is N3.

Observed reproduction:

- Compact: `rightSelected = put:3:codex:N1`.
- Rich: `rightSelected = N1`.

The same defect occurs when N1 has a child card B: rich draws `A, N1, N3, B`, but `l` on N1 does not enter visible B.

**Suggested fix:** Resolve the first direct-child destination by parent identity rather than adjacency in screen order. Add regression tests for the native-history shape and the child-card shape. Preserve the existing no-op when all children are overflow and therefore have no destination.

### R2 — P2, required acceptance blocker: changed-tick performance fails

`tests/unit/b10b-s3-perf.test.ts:198–217`; recorded evidence: `docs/cloud/handoff/b10b-s3f-performance-20261103.log` — **The current strict measurements exceed acceptance #4.**

All three runs completed during this review and were saved at `973a3f7`. Performance is no longer pending.

| Gate | Limit | Run 1 | Run 2 | Run 3 |
|---|---:|---:|---:|---:|
| Compact no-change p99 | 2 ms | 0.593 | 0.514 | 0.684 |
| Rich no-change p99 | 2 ms | 0.488 | 0.778 | 0.418 |
| Compact changed p99 | 10 ms | **11.257** | **11.076** | **14.706** |
| Rich changed p99 | 15 ms | **15.672** | 13.697 | **16.611** |

Every run exits 1. Compact fails 3/3; rich fails 2/3.

Measurement implementation is appropriate to the previously accepted boundary: 1,000 samples after 200 warm-up, nearest-rank percentiles, 200 nodes at 56 columns, reconciliation/key input/row rendering/frame-diff. Whole `renderMonitor` measurements remain separately printed, not substituted for the gated measurements.

Current execution environment: Node v24.22.1, Linux 6.18.57 x86_64, AMD EPYC 9V74. The logs do not record contemporaneous host load or GC attribution. These are remote design measurements, not formal WSL qualification. No causal claim that F1 introduced the slowdown is established.

**Suggested fix:** Diagnose the changed-tick tail, retain these failed runs, and produce the required three-run evidence after any fix. A documented isolated rerun may investigate host interference, but three failed attempts cannot be converted into a pass by quoting an earlier or best run. Do not change thresholds, sampling or measured scope without the required owner decision.

### R3 — P3, recommended documentation follow-up

`docs/reference.md:127`, `docs/reference.zh.md:126` — **The revised `o` row describes Open as an available effect without the dispatcher caveat given to `L`/`R`, and leaves double-click switching unqualified.**

Failure scenario: A reader selects a verified visible delegated run and presses `o`, expecting pane focus. The panel emits `delegation-open`, but this tree’s `tree-page.ts` has no corresponding dispatcher. Clicking a delegation row twice also does not switch: `monitor-input.ts:260–265` deliberately returns without a `pick` action.

**Suggested fix:** Mark delegation Open as awaiting the dispatcher, and limit the double-click statement to the legacy view. This is not the reason for withholding acceptance.

## Review-1 findings

- **F1: fixed for the reported defect, with R1 above as a regression.** `cards.ts:79–90` derives destinations from the rendering blocks; `selection.ts:39–51` uses that order. `b10b-s3-rich.test.ts:182–242` checks actual screen positions, ↓/↑, Home/End and `n`/`N`, including compact’s unchanged order. Restoring the old depth-first destination order violates these assertions.

- **F2: fixed.** `monitor-input.ts:108–115` gates actions on controls present in the actual frame. `b10b-s3-actions.test.ts:386–427` checks all three keys across five looks, two icon configurations, narrow widths and zero dimensions. The old condition permits actions in cases these assertions reject.

- **F3: fixed.** `control-bar.ts:360–363,461–509` tries row words at the final level before dropping them. `b10b-s3-bar.test.ts:169–211` asserts the 48-column words, shedding order at 40 columns and older-word priority. The corrected baseline lines agree.

- **F4: fixed.** `selection.ts:142–149` derives stops only from projected nodes; the omitted-conflict parent loop is removed. `b10b-s3-keys.test.ts:267–293` supplies three omitted claims, verifies their count, and asserts no stops or navigation. Restoring the loop fails the test.

- **F5: fixed.** `b10b-s3-keys.test.ts:323–349` now locates and clicks the put-away row’s actual line, then asserts selection, no action, no Inspector and no scrolling. The filler assertion is gone. The misleading selection test was renamed, while actual hidden-ancestor coverage remains at `b10b-s3-selection.test.ts:110–151`.

- **F6: fixed by inspection.** `b10b-s3-input-keys.test.ts:168` registers removal of the fake-tmux directory with `t.after`. The test passes in the recorded output. There is no separate assertion proving removal after teardown; I do not claim mutation-test coverage for that cleanup.

- **F7: fixed as originally requested.** Both references name Open and disclose the pending dispatcher for `L`/`R`. See R3 for the remaining wording issue. The existing documentation test checks key-row presence, not these explanatory clauses.

- **F8: fixed.** `monitor.ts:913` obtains the actual title position from `agentsTitleAt`; `agents-view.ts:14–22` shares the pinned-row calculation with drawing. `b10b-s3-bar.test.ts:217–234` checks exact widths, framed parent lines and title edges in both styles. The prior placement fails those assertions.

The listed regression tests pass in the dispatcher’s recorded unit run. This review did not repeat the earlier mutation campaign.

## Specific follow-up questions

**`c-switch` → `b-switch`: correct.** This is a fixture correction, not merely a rename. Situation C’s selected scout is under a delegated session and must not expose Switch under Q4. Situation B’s selected `impl` is a Codex native directly under the Codex viewpoint root, so it correctly shows `⇢ Switch`. The 48×10 replacement visibly exercises the intended control.

**Fifth-sub-row `l` overflow gap: closed.** `b10b-s3-rich.test.ts:245–264` establishes that the child exists in the plan but not the destinations, presses right, and asserts unchanged selection, unchanged collapse state and no action. It also verifies left still folds the real children. Keep this test when fixing R1.

## Checks and integration blockers

Current saved check output, `docs/cloud/handoff/b10b-s3f-checks-20261103.log`:

- Build, build:test and build:hud-mcp: pass.
- `npm test`: **2,453 tests; 2,424 pass; 13 fail; 16 skipped**.
- `test:core`: 209 pass, 1 skipped.
- `test:visual`: 331 pass.
- `test:hud-mcp`: 83 pass, 1 skipped.
- Format, fixture check and diff-check: pass.
- **`test:mjs` did not run:** `npm test` short-circuited after the failing unit command.

The 13 failures are:

1. B11 local resume: `ledger_busy` — 1.
2. B19 adapter/drainer Unix sockets: `listen EPERM` — 4.
3. H05 helper-death tests: missing `/proc/<pid>/task/<pid>/children` — 3.
4. Exec audits: `ptrace(TRACEME)` denied with EPERM — 3.
5. Waiter/forwarder-death tests: missing target assertions — 2.

This is **not** an expected-run-control-only result. Rerun the documented B11 flake alone and record both attempts. Socket and ptrace failures are explicit environment denials; do not bypass them or relabel them passes. The missing-process failures require separate diagnosis. These files are outside B10B-S3F ownership.

## Ownership, hygiene and visual verification

- Package changes remain within rendering, the previously approved Q5 files, associated fixtures/tests and handoff documentation.
- No package diff modifies `tree-page.ts`, core, collectors, packages, contracts or the design document. Changes inherited from `universal-hud` are not B10B implementation changes.
- No new private session content, credentials or real-home paths were found in the inspected implementation/fixture additions.
- Against segment 2: 309 → 321 frames, 12 added, zero removed, exactly the previously listed six changed. All other 303 frames are byte-identical.
- Against review 1: only the two stated control-bar frames changed, plus replacement of `c-switch/48x12` by `b-switch/48x10`.

**Required before acceptance:** fix R1, satisfy R2 with retained evidence, and obtain a complete green check set under the merge rule. Dispatcher execution remains TPD1’s responsibility. No contract change is recommended.