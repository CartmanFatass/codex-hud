# B10B-S3F-NEXT: Oracle review of owner-run local evidence

Date: 2026-11-03. Fresh independent read-only evidence review.

## Decision

**Verdict: fix required. The six exact-NEXT owner-run strict processes are verified passes on the recorded workstation. The complete candidate check set is still red. This is neither package acceptance nor merge authorization.**

The owner has completed the bounded verification request in the post-review route ruling §7. It now supplies a well-identified, freshly built independent observation of the exact NEXT candidate, including actual execution of the previously blocked full command. Do not describe these results as old-PERF evidence, missing NEXT verification, or an unsuccessful attempt to run the requested checks.

The result does not erase the valid cloud failures, qualify the full supported-WSL production profile, resolve the missing rejection-audit event, or preserve the original complete cloud profile archive. No further B10B production change, strict retry, new diagnostic, runtime removal, threshold change, dependent-wave release or merge is released by this review.

## Inputs, identity and method

- Owner evidence: commit **88b997e51144c84f8ffc9bf8b20c3b9fe9a8b547**, `docs/cloud/handoff/local-verification/20261103/NEXT/REPORT.md`, blob `dd632bdd7b9de5f293e414602d1c7fa35b3be746`, plus its published logs, manifests, scripts and checksums.
- Tested candidate: **0cca9caa6ddf3249291c8ed85a41da1eed800ee4**, complete tree **4b66dca450ad717455321e2b103dc9b5d190716c**. This is not the evidence commit's tree and not old PERF `9496910`.
- Governing reference used by the owner: `48abc4fc5e4b71ef36af720a69cad344ad71ea34`, including `docs/cloud/rulings/b10b-next-post-review-route.md`, blob `5d51285f92062ebf713b7505d4dfe546c23ea422`.
- Prior final review: `00b2d197ce165882a768b86c5c2b650667528486`, `docs/cloud/handoff/b10b-next-review-1.md`, blob `427fca8a65d12a2b47947fb809d280f2861b791f`; implementation and both dispatcher logs at the pinned evidence lineage.

Read AGENTS.md, dots.md, the cloud README/check and known-flake rules, STATE, the NEXT brief, post-review route, previous final review, relevant contract 06 measurement/qualification sections, the frozen benchmark and fixture, the candidate ledger-process test, and the recorded owner evidence. The earlier final correctness review is not repeated or reopened. No new source diff is being reviewed.

Method: read-only GitHub retrieval and comparison, inspection of existing retained evidence, and bounded checksum/count/arithmetic comparisons. No repository mutation, dependency install, build, test, benchmark, instrumentation, profile, shared-executor workload, local-machine session or subagent was started. Only review scratch material and this requested ruling artifact were written. The owner-run published files are redacted originals; I did not obtain the private unredacted logs or execute the unpublished redaction script.

## Verified provenance and execution

1. **Publication is additive.** GitHub comparison from prior owner evidence `9be7246c25b5355845e639116c57150ff79d3117` to `88b997e` is one commit, 106 added files, all under the new `NEXT/` directory. The earlier report and evidence remain unchanged. All **105 entries in the published SHA256SUMS verify** against retrieved bytes; the remaining file is SHA256SUMS itself. This verifies the published packet, not the unredacted originals or the original cloud profile archive.
2. **The candidate is correctly pinned.** GitHub comparison establishes `e5ccee38165b30809bd537e7f31cfed7f227f152` as the ancestor/merge base, with exactly four commits and four owned changed files. Independent reconstruction of the recorded 1,329-entry Git index, including Git-quoted filenames, produces tree `4b66dca450ad717455321e2b103dc9b5d190716c`. Every recorded step header names the same target commit/tree. The published source-index record also matches the existing equivalent candidate checkout. The earlier final review independently established the published commit's full-tree equivalence.
3. **Critical source blobs match GitHub.** The benchmark is `371b8f784229636f66e88434c422484dd85251eb`; fixture is `a711705346161d155324c86564ab819e546d3fae`. Facts/projection blobs are `6820c8f3fca966409e229b2d9bd042cbea6cd426` / `77c61250733d33527204a819893dd08d5d0b62a5`; the two additive test blobs are `20f2f7a7a268b87bdd224e71be93a51c1f98f79f` / `53aa1088483ee0d0f0ebe833a809c6ab94692edb`. The lockfile is `87327f35757f729247f1f2256e7ba87345956a01`. The source manifest has 1,329 records and SHA256 `254b3e2826bc43dd690b837c588d7a4b2387e29fdf5f71afe8ee8f92dfa0ced1`.
4. **Fresh output and dependencies are recorded.** The driver removes all three output trees before each runtime's three successful builds. One unchanged dependency installation is used for both runtimes. Its 332-entry manifest has SHA256 `843e84e7586722ab8673d9f3cc252e08357dbea9e52410a9dc9da69d596742f3`. Both 2,341-entry generated manifests are byte-identical, SHA256 `649becafa0aca4ef1da7a450c827379259b94161e489ed90ecfc6dfcaacdc0e0`. The compiled benchmark is `24a2437918e49b34339f5eb15c3c325e50bb9d1cf9b0faefada2139d74425022`. Recorded status changes are confined to the unstaged `node_modules/.package-lock.json`; no source/test/baseline change is reported. The main driver's final status capture precedes the separately logged B21 rerun; it should not be portrayed as a new post-rerun status capture.
5. **The new wrapper meets the intended isolation record.** All 24 outer step records have different HOME values and different HUD_HOME values, the selected runtime first on PATH, expanded `env -i` wrappers, declared timeouts and UTC start/end/exit. Strict invocations explicitly set B10B_PERF=1. No step times out. The driver steps are serial; this establishes no overlap among these steps, not continuous machine-wide isolation. Clearing inherited variables is supported by the actual wrapper, rather than retrospective assertion. The separately required core runner also creates its own temporary HUD_HOME.
6. **Host scope is clear.** WSL2 Linux 6.18.33.2, Ubuntu 24.04.4, Ryzen 7 8745H, 16 logical CPUs, about 15.6 GB RAM, ext4 `/dev/sdd`; Node 22.23.4/npm 10.9.9 and Node 24.22.1/npm 11.19.1. Other owner sessions remained active. The recorded 1-second strict monitors show load ranges 1.14–1.66 for Node 22 and 1.35–4.13 for Node 24. Process %CPU is lifetime-averaged and Windows-side scheduling is not observed. These limitations are appropriately disclosed, not a reason to discard the passes or an explanation for other failures.

### Additional existing-artifact comparison

All **2,341** generated files in the owner's manifest have the same recorded hashes as the retained cloud candidate's `final-generated-manifest.txt`. The cloud manifest has 2,344 entries; its only additional entries are the separately named v3 diagnostic JavaScript, diff and transform metadata. That retained manifest's SHA256 is `c52aab9ed5ce9bdf66c0ff0aea524ec25cb5869226720dcaec46e0f943dae352`, matching its entry in the already reviewed cloud SHA256SUMS.

This is meaningful same-build corroboration beyond the benchmark hash. It does not recover missing dispatcher provenance, prove which files each historical process opened, identify scheduling/GC/JIT causation, or establish a durable copy of the cloud archive. Host, environment and dependency-install identities remain separately reported.

## Strict performance: local observation passes, unresolved failures retained

I independently parsed all six raw logs and compared every population with SUMMARY.json. Each process prints all **16 populations**, each with **n=1,000**, strict=true and p50/p95/p99/max. All four test cases exit successfully; the fourth is a printed diagnostic case. The four numerical predicates are compact/rich no-change ≤2 ms, compact changed ≤10 ms and rich changed ≤15 ms. The unchanged source preserves 200 warm-ups, nearest-rank, 200 nodes/56 columns, moved clocks, actual alternating selection, fresh clones, and the existing preparation/measured boundary.

Per-process gated p99 in milliseconds, CN / RN / CC / RC:

| Runtime/process | CN | RN | CC | RC | Exit |
|---|---:|---:|---:|---:|---:|
| Node 22 run 1 | 0.735 | 0.666 | 5.326 | 5.506 | 0 |
| Node 22 run 2 | 0.599 | 0.557 | 4.536 | 5.224 | 0 |
| Node 22 run 3 | 0.707 | 0.625 | 4.693 | 6.652 | 0 |
| Node 24 run 1 | 0.573 | 0.288 | 7.756 | 11.440 | 0 |
| Node 24 run 2 | 0.457 | 0.388 | 8.414 | 8.535 | 0 |
| Node 24 run 3 | 0.419 | 0.315 | 7.653 | 9.301 | 0 |

The table and reported per-runtime ranges agree with the raw output. Maxima such as Node 24 run 1 compact 11.031 ms and rich 16.414 ms remain recorded. They do not fail these package predicates, which gate p99 rather than those maxima. No pooled percentile or selected subset is used.

**R2 remains unresolved at package level, with a verified positive local observation now added.** Preserve, as distinct series:

- Cloud implementer Node 24: 0/3; compact 16.600/14.726/30.930 ms, rich 14.899/20.701/15.546 ms. These are attributable failures, not removed by NEXT-E1.
- Cloud dispatcher Node 24: 0/3; compact 16.866/12.154/16.069 ms, including rich failures 16.699/20.010 ms.
- Corrected cloud dispatcher Node 22: 1/3, with compact 48.571/118.364 ms, rich no-change 2.778 ms, and the retained 5,876.457 ms compact maximum. Preserve its provenance limitations and the initial failed-build series separately.
- Owner workstation: Node 22 3/3 and Node 24 3/3, on the exact candidate and newly recorded output.

The new evidence establishes that the unchanged candidate can meet the bounded package benchmark on this named workstation with both supported runtime families. It does not establish a host-independent performance guarantee, a causal explanation for the failed cloud populations, or permission to redefine which populations count. In particular, the same runtime's slower changed-tick results remain observable on the workstation; neither “all Node 24 is broken” nor “the cloud failures were only contention” follows.

No baseline pair or new allocation diagnostic was required by the scoped owner request. Their deliberate omission is not a defect in this packet. Conversely, this packet cannot be used as new paired proof of the optimization's speedup or mechanism. It is not formal P-06-7/B14 supported-profile qualification: the full production-chain, declared-population, sample/window and operational evidence required by contract 06 is not supplied by these six package microbenchmark processes. Do not ask for an unrequested expanded B14 matrix as a condition for acknowledging the useful result obtained here.

## V1: actual execution obtained, full checks still red

The Node 24 README set ran. The results are:

- Three fresh builds: exit 0 each.
- `npm test`: **exit 1**; unit stage 2,450 pass, 2 fail, 16 skip of 2,468. Its mjs stage is not reached. The separate earlier 3-test output block is the nested B21 subrun, not the aggregate unit count.
- Separately required `test:mjs`: 47/47 pass, without converting npm test to green.
- `test:core`: 209 pass, 1 skip; `test:visual`: 331/331; `test:hud-mcp`: 83 pass, 1 skip.
- Format, fixture and diff checks: exit 0. Focused facts/regression: 16/16. Normal-mode B10B: 385/385; this is not another strict series.

The skip/count blocks and failure names agree between logs and SUMMARY.json. The extra full suite on Node 22 was correctly not added.

### V1 — P2, still a must-resolve acceptance blocker

`tests/unit/ledger-processes.test.ts:184`; `NEXT/logs/checks-node24/04-npm-test.log:2592–2610` — **the expected intent.rejected audit event is missing after a concurrent conflicting request** — the test observes one successful intent, one idempotency-conflict rejection and a complete accepted record, but zero rather than one rejection event — **P2** — assign baseline/cause classification to the actual core/ledger owner, preserving the failed process and the existing contract. Any code or test remedy needs its own reconciled ownership and bounded disposition; do not silently repair it inside NEXT or weaken the event assertion.

The nearby “20 ms busy budget” message is the test's existing one-request retry path (`ledger-processes.test.ts:123–144`), not proof that the final assertion is a listed ledger_busy flake. The final error is an assertion, not a ledger_busy refusal. The same named test later **passes inside the required core suite** (`05-test-core.log:182`), which is useful evidence of differing execution outcomes, not an isolated flake rerun or permission to delete the npm-test failure. The prior cloud core failure is the same source assertion. Neither a new NEXT regression nor its root cause is established by this review.

The other npm-test failure, B21 real-SQLite refusal, is the README-listed ledger_busy family. Its one isolated b21-capacity rerun is correctly recorded and passes 5/5. That handles only the named known-flake observation. The retained original failure and the separate unresolved audit assertion mean the full set remains red.

The successful hud-mcp run, including physical caller registration, applies to the recorded user-owned ancestry below PID 1. It does not test the older root-owned Relay ancestor case, accept MCP-ANCESTOR, or erase prior ledger_busy failures. Do not import unaccepted P065, RUNZ or MCP changes as presumed fixes.

## Carry-forward status

- **R1:** preserved. No new source change; the existing B10B correctness guards pass. No reopening of the previous semantic review.
- **R2:** unresolved overall; exact-NEXT workstation three-process series passes on each runtime. This is a material improvement in evidence, not an acceptance verdict.
- **R3:** unchanged non-blocking P3, outside scope.
- **V1:** no longer merely missing/blocked on this owner host; the requested complete command actually ran and failed. Actual local mjs/core/hud-mcp passes narrow the missing evidence, while the audit-event failure keeps acceptance blocked.
- **V2:** retained historical provenance limitation, not retroactively repairable.
- **NEXT-E1:** the old dispatcher omissions remain historical facts. The owner packet supplies a new adequate independent rebuild/digest/wrapper record for this observation. Do not continue claiming that no independent exact-NEXT rebuilt evidence exists, and do not relabel the old logs as compliant.
- **NEXT-E2:** unresolved for the original complete cloud evidence archive, SHA256 `941c11f5d11a76c4c01f2c2c1e2b6500aab67b29294f287751a8cd4783379cd4`. Durable retrieval of the new redacted owner packet does not preserve the different cloud CPU/heap/GC/raw-sample archive. No later verified archive disposition was supplied to this review.
- **Integration:** no accepted candidate or green merged-tree result. The existing --no-ff/complete-check gate and DOC2/TPD1 dependency hold remain unchanged.

## Minor documentary clarifications

`NEXT/REPORT.md:189,208,224` — the literal wording “not rerun” / “only rerun” and the claimed inclusion of the redaction script is broader than the artifacts — **P3, non-blocking**. The ledger test was not given an extra isolated retry, but was executed again as part of the required core command and passed. `redaction-manifest.txt` explicitly says `scripts/redact.py` is intentionally unpublished because its patterns contain private values; the directory contains the other scripts, not that one. Record these clarifications in an additive note or this ruling, not by overwriting the original report or publishing private redaction patterns. They do not change any numerical result or blocker.

## Next steps and stopping boundary

1. Record this review and the pinned owner evidence separately from prior PERF and cloud NEXT attempts. The bounded owner request is complete. Do not ask the owner to repeat the same six strict runs merely to obtain more passes.
2. Make the unresolved rejection-audit assertion the precise V1 ownership item. Start with existing-source/baseline/call-path classification under the core/ledger owner; distinguish a true product defect, an existing test assumption and environment sensitivity without inventing a new flake category. A later remedy and verification must be explicitly scoped; this read-only review does not authorize additional runtime execution or edits.
3. Keep B10B production changes and new strict/profile expenditure held under the post-review route. The cross-host same-build result is materially new evidence for a later focused route decision, but it does not identify another optimizer. Re-entry still requires the named missing observation or a discriminating-method proposal, verified preservation, explicit ownership and one bounded non-overlapping window. A proposal is not execution permission.
4. Continue authorized reconciliation/preservation of the original cloud archive without resuming an uncertain or denied publication by another route. Retain its original digest, and verify an authorized durable retrieval before claiming NEXT-E2 closed or releasing another discretionary B10B experiment.
5. Continue already authorized independent queue work. No automatic merge, source transplant, wave advancement or full-suite runtime matrix follows from this packet. Any eventual acceptance needs an applicable Oracle verdict and complete green exact-target evidence; integration then needs its own full green merged-tree checks with only the established named-flake handling.

This review is complete. The remaining blockers are task outcomes and evidence gaps, not a failure to inspect the published owner packet. No new test request or repeating benchmark window is issued here.

## Pinned sources

- [Owner report and complete new evidence directory](https://github.com/CartmanFatass/codex-hud/tree/88b997e51144c84f8ffc9bf8b20c3b9fe9a8b547/docs/cloud/handoff/local-verification/20261103/NEXT).
- [Additive owner-publication comparison](https://github.com/CartmanFatass/codex-hud/compare/9be7246c25b5355845e639116c57150ff79d3117...88b997e51144c84f8ffc9bf8b20c3b9fe9a8b547).
- [Candidate four-file comparison](https://github.com/CartmanFatass/codex-hud/compare/e5ccee38165b30809bd537e7f31cfed7f227f152...0cca9caa6ddf3249291c8ed85a41da1eed800ee4).
- [Strict benchmark source](https://github.com/CartmanFatass/codex-hud/blob/0cca9caa6ddf3249291c8ed85a41da1eed800ee4/tests/unit/b10b-s3-perf.test.ts).
- [Failing unit log](https://github.com/CartmanFatass/codex-hud/blob/88b997e51144c84f8ffc9bf8b20c3b9fe9a8b547/docs/cloud/handoff/local-verification/20261103/NEXT/logs/checks-node24/04-npm-test.log#L2592-L2610), [later core pass](https://github.com/CartmanFatass/codex-hud/blob/88b997e51144c84f8ffc9bf8b20c3b9fe9a8b547/docs/cloud/handoff/local-verification/20261103/NEXT/logs/checks-node24/05-test-core.log#L180-L184), [source assertion](https://github.com/CartmanFatass/codex-hud/blob/0cca9caa6ddf3249291c8ed85a41da1eed800ee4/tests/unit/ledger-processes.test.ts#L166-L185).
- [Previous final review](https://github.com/CartmanFatass/codex-hud/blob/00b2d197ce165882a768b86c5c2b650667528486/docs/cloud/handoff/b10b-next-review-1.md), [initial dispatcher evidence](https://github.com/CartmanFatass/codex-hud/blob/00b2d197ce165882a768b86c5c2b650667528486/docs/cloud/handoff/b10b-next-dispatcher-initial.log), [corrected Node 22 evidence](https://github.com/CartmanFatass/codex-hud/blob/00b2d197ce165882a768b86c5c2b650667528486/docs/cloud/handoff/b10b-next-dispatcher-node22-corrected.log).
- [Governing post-review route](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/cloud/rulings/b10b-next-post-review-route.md), [NEXT brief](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/cloud/B10B-S3F-NEXT.md), [README check and flake rules](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/cloud/README.md), [contract 06](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/contracts/06-observation.md).
