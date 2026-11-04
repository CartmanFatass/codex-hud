# RUNZ1 local-evidence Oracle re-check, 2026-11-03

## Verdict

**FIX REQUIRED. WIP / NOT ACCEPTED / NOT MERGEABLE.**

The owner-provided local evidence closes the earlier AF_UNIX, ptrace, proc-children and unexecuted-mjs evidence gaps for the pinned RUNZ1 code on the recorded capable WSL host. It does not close the complete-check gate. Every local RUNZ1 `test:hud-mcp` run still fails, and the Node 24 focused run has an unresolved `run-control` failure. Neither the passing runs nor an environmental explanation waives these failures. No unsafe RUNZ1 production behavior is established by the new failure log alone.

## Scope and pinned identities

This is an independent, read-only verification of published evidence, not a new execution or a repeated full implementation review. I used the GitHub connector to read the evidence, compare identities, inspect relevant code and recompute published-file hashes. I ran no repository tests, accessed no owner computer, and made no repository writes or merges.

- Evidence branch: `local-verification/20261103`, pinned to `9be7246c25b5355845e639116c57150ff79d3117`.
- Evidence root: `docs/cloud/handoff/local-verification/20261103/`.
- Tested RUNZ1 head: `86ca8887fcfb331750ec6dc5518d69134cb795e4`; GitHub independently confirms tree `da3e386e3512736f3078d0fd9c7b85a868f83f6d`. The current `dots/runz1` ref still pointed to that head when checked.
- Previous reviewed implementation: `2eb08fbd091a44b77bbaa3761c68ae8b11688778`, tree `bbebbd2b1d7e7f6fb02b8300aee820721af3bd29`. GitHub comparison shows exactly nine later commits, changing only nine handoff files: the seven dispatcher-log parts, implementation report and previous Oracle review. Thus the tested production code, tests and benchmark are unchanged from the previous reviewed implementation, although the complete Git trees differ because documentation was added.
- Read the [previous Oracle review](https://github.com/CartmanFatass/codex-hud/blob/86ca8887fcfb331750ec6dc5518d69134cb795e4/docs/cloud/handoff/runz1-review-1.md), RUNZ1 brief, cloud README/check policy, branch STATE and current `universal-hud` STATE. The brief independently requires green `run-control` and green README checks. STATE still requires acceptance plus a green merged-tree check set.

## Evidence integrity and provenance

I recomputed SHA-256 over the UTF-8 contents of **66 relevant published files**, including REPORT, SUMMARY, every RUNZ1 check/focused/supplementary log, all six RUNZ1 performance logs, six before/after status files, the successful RUNZ1 install log, and relevant manifests and driver/probe/redaction scripts. **All 66 match SHA256SUMS.** This is not a claim that the unrelated HYG2/B10B files were all independently hashed in this review.

Key verified SHA-256 values:

- REPORT.md: `959e66f4fd51254cd919de7604be065b119fc5fd650d10f0df185f1b35ad818f`.
- SUMMARY.json: `d65c905df9081a44da4be89d8fcef80b1d962db3ef85c53f00edb8f547b59373`.
- Node 24 focused RUNZ1 log: `015231dc35707c82062e5b522baf32c73873116e72ad98b0ab456f7468347b9e`.
- Node 24 hud-mcp log: `6fd564d977cd192382c9a3375bd17d30a752bbfbf95643ebab26af3fee7ea496`.

All **42 RUNZ1 rows** in `manifest/results.tsv` agree with their retained log headers/footers for commit, command, start/end times and exit code. Raw reporter totals agree with the substantive SUMMARY/REPORT outcomes. The six performance JSON objects agree exactly with SUMMARY. The additional 3-test/2-pass/1-skip block embedded in the Node 24 unit log is a nested child-runner summary, not an extra top-level suite to add to 2,369.

The logs are deliberately redacted publication copies. Their matching hashes verify the retained published bytes and internal consistency; they do not independently authenticate the unredacted originals, prove every environmental assertion, or substitute for witnessing the runs. No separate RUNZ1 compiled-artifact digest is supplied. Provenance instead rests on pinned log headers, successful builds and retained status records. Before and after each RUNZ1 sequence, the only recorded tracked modification is `node_modules/.package-lock.json`.

The recorded host is WSL 2.7.11.0, Ubuntu 24.04.4, Linux 6.18.33.2-microsoft-standard-WSL2, Ryzen 7 8745H, native ext4; runtimes are Node 24.22.1 and 22.23.4. The retained wrapper uses fresh temporary HOME, HUD_HOME unset, restricted PATH and NODE_OPTIONS unset. Node 24 RUNZ1 checks finished before the 16:00 proxy-policy change. The original Node 22 pass retained NODE_USE_ENV_PROXY=1; the owner-chosen later Node 22 pass omitted only that variable while retaining other proxy variables. These are separate runs, not interchangeable outcomes.

## Raw check outcomes

| Check | Node 24 | Node 22 with envproxy | Node 22 without envproxy |
| --- | --- | --- | --- |
| build / build:test / build:hud-mcp | All exit 0 | All exit 0 | All exit 0 |
| npm test, unit stage | 2,353 pass / 0 fail / 16 skip | 2,341 pass / 12 fail / 16 skip | 2,353 pass / 0 fail / 16 skip |
| test:mjs | 47/47, inside npm test | 47/47, separate supplementary command | 47/47, inside npm test |
| test:core | 209 pass / 0 fail / 1 skip | Same | Same |
| test:visual | 319/319 | 319/319 | 319/319 |
| test:hud-mcp | 82 pass / 1 fail / 1 skip | 80 pass / 3 fail / 1 skip | 82 pass / 1 fail / 1 skip |
| format:check / check:fixtures / git diff --check | All exit 0 | All exit 0 | All exit 0 |
| Focused RUNZ1 command | 53 pass / 1 fail | 53 pass / 1 fail | 54/54 |

The Node 22 `npm test` failure prevented its automatic mjs stage. The documented driver-detection bug was repaired at the evidence level by a separately retained `test:mjs` execution at 16:37:40–16:37:41 UTC. That is valid additional mjs evidence, not a retroactive green `npm test` result.

The two additional Node 22 hud-mcp failures are the README-listed `ledger_busy` family: B20 advice and B45 accepted spawn. Their single isolated reruns passed **9/9** and **8/8**. Both initial failures remain retained. This permitted treatment does not remove the third, non-listed EACCES failure or make the original aggregate run green.

## Previous finding disposition

Previous review F1 is **partly resolved, not closed**.

Closed for these pinned local runs:

1. Both runtime capability probes demonstrate AF_UNIX listen/connect, PTRACE_TRACEME, own-child PTRACE_ATTACH and proc-children enumeration. Their scripts and raw results are retained.
2. The earlier 12 unit failures attributed to socket, ptrace and proc-children limitations no longer fail in the capable-host Node 24 and Node 22/no-envproxy unit runs. This includes the two previously unvalidated helper-discovery cases; it is now passing behavioral evidence, not merely inference from a missing proc interface.
3. The previously failing/unreached mjs checks now have 47/47 passing evidence under each recorded runtime/environment.
4. All **24 RUNZ1-named cases pass in all six** full/focused runs. The true zombie-only positive, first-census fork race, same-session join race, visible-scope rule, second-snapshot escape, live sibling and escaped-original-subject regressions are present and passing. The receiptless-Q `run-control` regression also passes in all six.
5. Additional n=1,000 scan-cost evidence exists for three fresh processes per runtime.

Still open: an unchanged green complete check set, the Node 24 focused `run-control` failure below, and eventually the merged-tree gate. No merged-tree execution was supplied or performed here.

## Findings requiring disposition

### F1: the mandatory full-check gate remains red

**`docs/cloud/RUNZ1.md:43`; `packages/hud-mcp/src/process.ts:29,57–68`; `packages/hud-mcp/src/registry.ts:88` — ancestor EACCES aborts physical caller registration — P1 acceptance blocker, with a cross-package startup/ancestry robustness failure beneath it.**

[Node 24 raw log, lines 108–125](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/logs/runz1/node24/07-test-hud-mcp.log#L108-L125) records `EACCES` opening `/proc/29952/environ` through `LinuxProcessReader.get`, `findHarness`, and `registerCaller`. The same test fails with the same path in all three RUNZ1 environments. It is not in the known-flake list.

Static inspection corroborates the mechanism: `get()` reads environ before returning a ProcessInfo; `findHarness()` calls it for up to eight ancestors without handling the error; `registerCaller()` calls that walk before registry publication. These files are unchanged by RUNZ1. This is not evidence of a RUNZ1 process-census regression, but it is an actual failing production registration path exposed by test ancestry, not a check that can be declared passed because the host supports procfs generally.

The report attributes PID 29952 to a root-owned WSL Relay after driver reparenting. I did not independently reconstruct the live ancestry or UID. The retained error and code establish the ancestor-read failure; the exact root-owned Relay attribution remains the owner's recorded observation.

Required disposition: resolve the expected behavior for inaccessible unrelated ancestors in the owning package, or establish an explicitly justified test topology without changing the contract or hiding the recorded failure. Preserve physical identity verification and fail-closed guarantees. Do not elevate privileges, loosen `/proc` permissions, blanket-catch identity failures into success, or waive this check. A passing run under a different parent alone would not explain away the exposed failure.

### F2: Node 24 focused cancellation failure is unresolved

**`tests/unit/run-control.test.ts:350–374`; `docs/cloud/RUNZ1.md:42` — no-receipt snapshot had slotHeld=false where the test requires true — P1 acceptance blocker; root cause remains unproved.**

[Focused raw log](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/logs/runz1/node24/11-focused-runz1.log) at 15:57:06–15:57:26 UTC fails `cancel escalates INT then TERM then KILL; lost KILL wait remains unknown without complete scope proof`. The failing assertion is `false !== true` at compiled line 360, corresponding to source line 374: `if (!p.receipt) assert.equal(p.slotHeld, true)`. The prior assertions of INT/TERM/KILL order and native-exit null were reached without failure. This run predates proxy passthrough, so the Node 22 warning does not explain it.

The same test passed in the other five full/focused runs. It is not a listed known flake and was not rerun. Preserve the one failure and all five passes; five passes do not erase the failure.

There is a concrete diagnostic distinction. Contract 04 permits complete receiptless Q to end a run and release its slot. `control.ts:746–833` can decline its initial final-receipt proof and then call reconciliation; `control.ts:196–224` can obtain a later complete proof and emit `scope_reconciled` without a receipt. Therefore **receipt absence alone does not prove that a slot release was unsafe**. The failing log does not retain the snapshot's facts, reconciliation row, run state or proof outcomes, so it cannot establish whether this was legitimate receiptless Q, a stale assertion, or an actual premature-release defect.

Required disposition: diagnose this exact path with the relevant snapshot and proof outcomes on an authorized executor. Preserve both negative cases (incomplete proof must retain the slot and emit no terminal evidence) and positive complete-Q behavior (native result remains unknown, terminality and release require full proof). If the assertion is too broad, replace it only with evidence-sensitive coverage that proves both branches; do not simply delete it, add a skip or label the case flaky. Any fix and resulting green checks need a fresh Oracle re-check.

### F3: Node 22 envproxy failures are explained but remain failures

**Node 22 `04-npm-test.log` and `11-focused-runz1.log` — UNDICI-EHPA warning contaminates exact-output expectations — P2 runtime/environment compatibility evidence, not a RUNZ1 safety regression and not a waiver.**

The 12 unit failures comprise ten hud-link-export stderr assertions, one lightweight-leader exact-byte assertion, and one run-process JSON parse. Raw error blocks show `[UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental...`; the focused run's one failure is the same JSON case. In `run-process.test.ts:71–74,113`, stdout and stderr deliberately share the fixture output FD, so a runtime stderr warning reaches JSON.parse. The reported mechanism is supported by both the raw bytes/errors and test code.

The owner-chosen no-envproxy Node 22 rerun passes those unit/focused checks. This separates the observed warning effect from the earlier executor capability failures; it does not establish that the original envproxy configuration is green or authorize dropping Node 22 support, stripping inherited proxy policy generally, suppressing all warnings, or weakening exact-output requirements. Any lasting fixture/runtime-profile change must go through its owning review route.

## Scan-cost evidence

All six `node tests/int/runz1-perf.mjs` processes exit 0. The retained script uses 100 warmups, n=1,000 per population, wall-clock performance.now, empirical nearest-rank percentiles, sequential populations and no explicit GC. Three supplied subject stamps represent two unique processes. The full proof includes subject checks, existing inspection, both censuses and visibility/thread checks; a single-census population is not the complete incremental proof overhead.

Ranges across three runs, milliseconds:

| Population | Node 22 p50 / p95 / p99 / max range | Node 24 p50 / p95 / p99 / max range |
| --- | --- | --- |
| Full zombie proof | 7.033–13.873 / 9.522–17.374 / 11.196–20.509 / 13.107–34.560 | 8.300–14.274 / 10.217–17.322 / 11.797–19.853 / 13.725–62.957 |
| One complete census | 1.922–3.438 / 2.449–4.277 / 3.348–5.221 / 4.455–9.819 | 2.140–3.921 / 2.917–5.789 / 3.279–7.222 / 3.932–10.480 |
| Full proof under churn | 6.511–11.147 / 8.115–14.154 / 9.359–15.604 / 11.321–28.016 | 9.117–11.797 / 14.038–15.830 / 15.458–19.804 / 17.390–38.312 |
| Full ESRCH proof | 2.185–3.567 / 2.773–4.489 / 3.754–5.600 / 4.414–11.477 | 4.058–4.200 / 5.754–6.182 / 7.317–8.128 / 12.080–18.070 |

Recorded census snapshots range from 172 to 182 processes. These are busy-host measurements, not the script's suggested otherwise-idle baseline: raw snapshots include substantial concurrent activity, including chrome-headless at 935% CPU after one run. Quiet full-proof refusals are 17–32 per 1,000; churn refusals are **878–974 per 1,000**. One Node 24 ESRCH population has one refusal; the other five have zero. Refusals are retained in the timing populations.

The numbers satisfy the brief's request to report scan cost with n≥1,000 and materially extend the earlier small-census evidence. They do not demonstrate a stable uncontended latency guarantee, formal P-06-7 qualification, acceptable availability under arbitrary process churn, or any new performance threshold. The high conservative-refusal rate is an operational limitation worth retaining, not evidence of unsafe acceptance. Do not subtract/add independent percentile populations or ascribe tails to GC without measurement.

## Required next disposition

1. Keep RUNZ1 **WIP / NOT ACCEPTED / NOT MERGEABLE**. Record previous F1 as partly resolved, not closed.
2. Preserve the pinned local evidence and every failed/passing outcome. The capability-related behavioral gaps are closed for these local runs; the new EACCES and focused-cancellation issues are not.
3. Diagnose F2 and route F1's inherited hud-mcp failure to its owner. Do not make an out-of-scope RUNZ1 production change merely to hide either failure. Retain the envproxy compatibility result distinctly.
4. Obtain the unchanged full check set and brief-specific checks green on the final authorized candidate, with any actual fix reviewed. No assistant-run local test is authorized or performed by this review.
5. Only an eventual accept verdict can unlock the prescribed merge procedure. The separate complete merged-tree gate remains required and unexercised here. Local-only real-harness/tmux/install work and formal WSL qualification remain excluded and unclaimed.

Primary published evidence: [REPORT](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/REPORT.md), [SUMMARY](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/SUMMARY.json), [SHA256SUMS](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/SHA256SUMS).