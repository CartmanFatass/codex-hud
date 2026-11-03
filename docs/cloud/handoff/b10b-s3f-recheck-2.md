# B10B-S3F final re-check after the single fix round

**Verdict: fix required.** R1 is fixed, with meaningful regression coverage and an independent before/after reproduction. R2 is not closed: the dispatcher’s new Node 22 series fails its first run, while the earlier Node 24 failures remain valid. The complete check set is still not green. R3 remains a non-blocking documentation follow-up.

## Scope and source verification

Reviewed fix commit [`a754871612b8e56e8df12e907e8ae1654c24f999`](https://github.com/CartmanFatass/codex-hud/commit/a754871612b8e56e8df12e907e8ae1654c24f999), parent `a35abd3`. Remote branch `dots/b10b-s3f` resolved after the final evidence upload to `dc9cc4257fab36cd1eca053a010d0b1466386f74`.

- The implementation fix changes exactly two files: `src/render/monitor-input.ts` and `tests/unit/b10b-s3-rich.test.ts`, 37 insertions and 2 deletions.
- The twelve commits after `a754871` add only reports and recorded evidence, including the seven complete check-log parts. They do not change the reviewed implementation.
- The benchmark, thresholds, sample count, fixtures, visual baselines, projection implementation, contracts and supported-runtime declaration are unchanged.
- The implementer’s original Node 22 results and the dispatcher’s subsequent Node 22 results are **different evidence sets**. Both are retained and must be reported distinctly.

Read the repository workflow, both B10B briefs, the applicable rulings, prior re-check, fix report, recorded checks and performance evidence. Previously accepted F1–F8 conclusions are carried forward except for the R1 navigation path touched by this fix. No repository writes, git mutations, local-only work or permission-denied operations were performed in this review. The existing unstaged `node_modules/.package-lock.json` modification was left untouched.

## Previous findings

### R1 — fixed

`src/render/monitor-input.ts:562–568` now resolves the first direct-child destination by `parentKey`, rather than taking the next screen row. This is correct when rich layout draws a native sibling before the selected native row’s history row or child card. The search is over destinations, so children hidden beyond the fifth sub-row remain excluded. Folded-branch unfolding and left navigation are unchanged.

`tests/unit/b10b-s3-rich.test.ts:266–298` covers both requested shapes in compact and rich styles. It establishes the intervening rich sibling’s actual screen position, the destination kind, the child-card identity, successful right navigation, no action, unchanged collapse state and left navigation back to N1. The pre-existing overflow test at lines 245–264 remains unchanged.

Verified evidence:

- The implementer’s original negative log has exactly the two new failures: actual `codex:N1`, expected `put:3:codex:N1` or `codex:B`.
- The original after-log passes all 13 rich tests.
- The dispatcher’s full log, reconstructed from the seven parts, passes both new tests and the overflow test at reconstructed lines 499–501.
- This Oracle independently ran the compiled rich suite on Node v22.23.4 with temporary HOME/HUD_HOME: **13 tests, 13 pass, 0 fail, exit 0**. Command: `env -u NO_COLOR -u FORCE_COLOR -u NODE_USE_ENV_PROXY HOME="$h" HUD_HOME="$u" /workspace/scratch/6daef0397a95/hyg2-node22/node_modules/node/bin/node --test dist-test/tests/unit/b10b-s3-rich.test.js`, from `/tmp/b10bs3f-repo`, with `h` and `u` separate fresh `mktemp -d` directories.
- An additional in-memory differential reproduction evaluated the original and fixed navigation functions against real synthetic delegation frames, without editing either implementation. Compact already entered both children and still does. Rich changed from `codex:N1` to `put:3:codex:N1` for history and from `codex:N1` to `codex:B` for the child card.

No new correctness regression was found in this narrowly scoped fix.

### R2 — not fixed; P2 acceptance blocker remains

`tests/unit/b10b-s3-perf.test.ts:175–217`; `docs/cloud/B10B-s3.md:100`; `docs/cloud/handoff/b10b-s3f-fix-perf22-20261103.log:1–79` — **The required strict performance evidence is not consistently passing, and the new dispatcher series also fails the no-change gate.** A passing earlier series or two later runs cannot silently replace the recorded failed run.

The dispatcher’s new Node 22 results, gated p99 in milliseconds:

| Gate | Limit | Run 1 | Run 2 | Run 3 |
|---|---:|---:|---:|---:|
| Compact no-change | 2 | **3.726** | 0.715 | 0.753 |
| Rich no-change | 2 | **not measured** | 0.778 | 0.513 |
| Compact changed | 10 | **31.765** | 9.002 | 6.046 |
| Rich changed | 15 | 14.073 | 6.421 | 5.830 |
| Process exit | 0 | **1** | 0 | 0 |

Run 1’s rich no-change measurement is absent because the compact assertion ends that shared test before the rich iteration. It is neither a pass nor a measured failure. The observed compact changed range is **6.046–31.765 ms**, and compact no-change is **0.715–3.726 ms**.

The implementer’s separate original Node 22 log was inspected and **does** substantiate its reported three passes:

| Gate | Run 1 | Run 2 | Run 3 |
|---|---:|---:|---:|
| Compact no-change | 0.539 | 0.958 | 0.710 |
| Rich no-change | 0.790 | 0.717 | 0.655 |
| Compact changed | 7.594 | 5.873 | 8.290 |
| Rich changed | 5.698 | 10.534 | 9.578 |

Thus the fix report is accurate about that original experiment, but it is not the result of the later dispatcher verification. Across all six supplied Node 22 runs, compact changed p99 spans **5.873–31.765 ms** and compact no-change spans **0.539–3.726 ms**; five processes pass and one fails, with one rich no-change population unmeasured.

The earlier Node 24 series remains unchanged: compact changed p99 **11.257 / 11.076 / 14.706 ms**, rich changed **15.672 / 13.697 / 16.611 ms**, exits **1 / 1 / 1**. No retained performance source fix addresses those results.

**Measurement and diagnosis.** The unchanged benchmark still uses 1,000 samples after 200 warm-up, nearest-rank percentiles, 200 nodes at 56 columns, and the previously accepted reconciliation/key/row-render/frame-diff boundary. Whole `renderMonitor` numbers remain separately printed and are not substituted for gated numbers. In the instrumented Node 24 diagnostic, all ten slowest gated compact samples overlap GC: summed overlap 175.386878 ms / summed sample time 201.719836 ms = **86.95%**. That supports a GC-tail diagnosis for those samples, not a subtraction from the gate or proof of the cause of every failure. Its compact p99 is still **13.685 ms**, a failure.

**Provenance limitation.** The dispatcher confirmed Node v22.23.4 on host `d14215e6cbaa`, Linux 6.18.57 x86_64. The host CPU is AMD EPYC 9V74 in the original evidence. The archived dispatcher performance file itself omits the exact command, runtime/host header, timestamps and contemporaneous load. The dispatcher cannot reliably reconstruct its exact command or concurrent load. It reports the full-suite log finished at 13:39:18 UTC and the performance log at 13:44:57 UTC on 2026-11-03; other workers were active and overlap with unrelated work is possible. That is not proof that host interference caused Run 1.

Node 22 is an already permitted runtime, so testing it is legitimate. Its passing original series is useful design evidence, but neither establishes the later dispatcher run as green nor waives Node 24 failures. `STATE.md` permits a single over-limit compact changed result to be treated as a known flake only after a recorded isolated rerun. The supplied evidence does not document that isolation, and the dispatcher also failed the separate no-change gate. Do not stretch that exception into a blanket performance waiver.

**Required resolution:** retain every failed and successful run; establish reproducible, properly documented strict evidence on the unchanged acceptance basis, with an isolated investigation of the failed series if authorized. Record the exact commit, command, runtime, host and concurrent-load conditions. Any proposal to change thresholds, sampling, measured scope or supported profiles is an owner decision. Remote measurements remain design evidence, not formal WSL qualification.

### R3 — not fixed; remains P3, non-blocking

`docs/reference.md:127`, `docs/reference.zh.md:126` are unchanged. They still describe delegation Open without the pending-dispatcher caveat and leave double-click switching unqualified. The recommendation remains to disclose pending Open dispatch and limit the double-click statement to the legacy view. This does not determine the verdict. TPD1 still owns effect dispatch; this fix correctly does not add it.

## Full checks and remaining integration gate

The authoritative full-check source for this review is `docs/cloud/handoff/b10b-final.log.part01.txt` through `part07.txt`, concatenated in order without inserting separators. These parts supersede the earlier single-file archive for verification. Their reconstructed results are:

| Check | Recorded result |
|---|---|
| build / build:test / build:hud-mcp | pass |
| npm test, unit stage | **2,455 tests; 2,427 pass; 12 fail; 16 skipped; exit 1** |
| test:mjs | **not run**, because npm test short-circuits after test:unit |
| test:core | 209 pass, 1 skipped, exit 0 |
| test:visual | 331 pass, exit 0 |
| test:hud-mcp | 83 pass, 1 skipped, exit 0 |
| format / fixtures / diff-check | pass |

The dispatcher reported an incomplete earlier single-file upload and requested use of the parts. Direct comparison in this review found the seven parts concatenate to 280,266 characters and exactly match the content returned for `b10b-s3f-fix-checks-20261103.log`, blob `23691a9cc8941a9770bdc2ad050cb1b72edf9a6f`. No additional test outcomes appeared on reassembly. The reviewed content therefore does not independently demonstrate byte loss in that stored single file; display truncation and stored-content truncation must not be conflated. The parts are the cited source regardless.

The implementer’s focused 360/360 result and isolated visual 331/331 result are also supported by their local raw logs; they do not replace the full check set.

The B11 `ledger_busy` follow-up is resolved as a recorded flake: the isolated archived rerun passes 20/20, and the new full run also passes the specific local-resume test. Keep the original failure and isolated rerun.

The remaining 12 failures are:

1. Four B19 adapter/drainer failures: Unix-socket `listen EPERM`.
2. Three H05 helper-death failures: missing `/proc/<pid>/task/<pid>/children`.
3. Three exec-audit failures: `ptrace(TRACEME)` denied with EPERM.
4. Two waiter/forwarder-death failures: missing target assertions.

Socket and ptrace failures are explicit environment denials, not passing tests and not permission to bypass restrictions. The five missing-process/target failures still need their own diagnosis; this review does not claim they are all environmental or all repaired by RUNZ1. These files are outside this fix’s ownership. This is not merely the expected named `run-control` failure. The all-green merged-tree rule remains unmet, independently of performance.

## Verified boundaries and evidence identifiers

- Only the two authorized render/test files change in the implementation fix. No dispatcher, core, collector, package, contract or design changes are hidden in it.
- No visual baseline or fixture changed in this fix; the new visual run is green. The prior frame-rename ruling remains accepted.
- The inspected new fixture data is synthetic. No new private session content or credentials were found in the fix.
- Complete check-log part blobs, in order: `12ccbde7900d4b5b9a6a31a3ae973fedcdefc92a`, `f4ec67aa74a1604c05383001e90b233bfab16705`, `9b12e4b5e94ff358deecb63ba62a1d8af8191596`, `a7f9ced53ba9ecdb67b6b40a4e54cba3e50a38ba`, `1d393d3aee8972fd5e19f852159656d3fcf08e43`, `60345c86126164d35c89a8b68d7bfe34085b5cfe`, `f5f77e95fdee174abec6f802d6fc48601079f0db`.
- Archived dispatcher Node 22 performance blob: `e6a7e825825892cc8807f23f31f51b11ce0421b2`.
- Earlier Node 24 performance blob: `b83ceb6e6fc95214baf377ffcd23353e9b448fbb`.
- Distinct original implementer Node 22 local-log blob: `6c4e67b52091484df935528e9031083acbf6a180`.

## Disposition

**Do not merge B10B-S3F.** Its brief allows at most one fix round, now consumed. Preserve the correct R1 fix and all evidence, and record the unresolved R2 and full-check gates for the owner rather than automatically starting another implementation round. Recommendation: keep the package unaccepted while arranging bounded performance diagnosis and a permitted environment for the outstanding checks; do not lower gates or silently drop a supported runtime. A later accept verdict and a complete green merged-tree check set are still required.