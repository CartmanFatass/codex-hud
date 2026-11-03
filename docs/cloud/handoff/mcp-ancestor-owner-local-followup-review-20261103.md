# MCP-ANCESTOR owner-local follow-up: fresh Oracle review

Date: 2026-11-03. Evidence run: `20261103T224919Z`.

**Verdict: fix required. MCP-ANCESTOR remains NOT ACCEPTED and NOT MERGEABLE. No new source or test fix is requested.**

The new evidence closes the missing Node 24 final-candidate check execution and confirms both focused gates. Every new local benchmark run passes the unchanged numerical thresholds. It does not establish the required real unreadable ancestor above PID 1, make the Node 22 envproxy aggregate green, establish the brief's no-concurrent-workload benchmark condition, or deliver the old cloud evidence bundles. These are distinct existing requirements, not additional gates introduced by this review.

## 1. Scope, identities, and method

Read-only review of `AGENTS.md`, `docs/cloud/dots.md`, the cloud README and STATE, the MCP-ANCESTOR brief and governing ruling, the original review and R1 re-check, the exact candidate/source delta, the owner's follow-up report, and its published MCP-specific raw logs, scripts, manifests, and checksums. I executed no build, test, benchmark, capability or topology probe, changed no repository file, performed no Git mutation, and started no subagents. Local writes were limited to downloaded review inputs and this requested ruling.

- Candidate: `b2897a4f9769bca6305ff0e3ae3dc694a9320ffe`.
- Candidate tree: `0d195bd47ff2b29581e1c394c2973d9479f8d928`.
- Pinned base: `26f6fba36948e6c96e2e109cb374c0d4dbb9ab22`, tree `03bd36610d46fd220eb9c0e4fbf153a52bc3c3b9`.
- Reviewed evidence commit: `1db757ec1f5c51a79f47eaabfe6483d0cb2db19d`, evidence branch `local-verification/20261103`.
- Evidence directory: `docs/cloud/handoff/local-verification/20261103/followup-20261103T224919Z/`.
- Binding integration documents: `48abc4fc5e4b71ef36af720a69cad344ad71ea34`.
- Reviewed MCP documentation head: `dc4b96b8b3e224736cf0aeee4062184a433a023e`.

GitHub Git metadata independently confirms the candidate/tree. The base-to-candidate comparison changes only the four owned source/test paths plus three handoff documents. Candidate-to-documentation-head adds only the three R1 report/publication/review documents. It imports no NODE22-PROXY, HYG2, RUNZ1, NEXT, or P065 implementation.

The four affected source/test files, unchanged benchmark driver, package.json, and root package-lock.json were fetched at the immutable candidate and independently SHA-256 checked against the local-run source manifest. All seven match. In particular, the revised integration-test blob remains `234a3f2253f4bcf61f039732ae99c9c878853a1d`, SHA-256 `d9f52537e2182ec6cea624522efbf13c868c1eecdac2ecf6c42f37ae073bc770`; benchmark blob remains `c36817dee4cf70c27a39a86b3965f4eb6701ceb0`.

Sources: [candidate](https://github.com/CartmanFatass/codex-hud/commit/b2897a4f9769bca6305ff0e3ae3dc694a9320ffe), [base comparison](https://github.com/CartmanFatass/codex-hud/compare/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22...b2897a4f9769bca6305ff0e3ae3dc694a9320ffe), [documentation-only comparison](https://github.com/CartmanFatass/codex-hud/compare/b2897a4f9769bca6305ff0e3ae3dc694a9320ffe...dc4b96b8b3e224736cf0aeee4062184a433a023e), [owner report](https://github.com/CartmanFatass/codex-hud/blob/1db757ec1f5c51a79f47eaabfe6483d0cb2db19d/docs/cloud/handoff/local-verification/20261103/followup-20261103T224919Z/REPORT.md), [prior R1 re-check](https://github.com/CartmanFatass/codex-hud/blob/dc4b96b8b3e224736cf0aeee4062184a433a023e/docs/cloud/handoff/mcp-ancestor-review-2.md).

## 2. Disposition of existing findings

### R1. Complete stdio capture: remains fixed

The exact previously accepted bounded test correction is unchanged. `captureMcpOutput` waits for `close`; complete stdout is still checked for framing, exact three-record count, and JSON-RPC IDs. Both newly recorded three-file runs pass all 43 cases, including the three late-output controls and real unconfigured MCP discovery/refusal case. There is no basis to reopen R1 or request another code round.

The optional-reader production boundary also remains unchanged: `process.ts:62–82` reads at most eight ancestors while PID > 1; only EACCES/EPERM from the optional `reader.get` returns null immediately. It does not continue upward or invent source authority. Mandatory physical reads remain strict. The old meaningful failing-before evidence remains relevant to this unchanged production change; it was not rerun locally and is not represented as new evidence.

### R2. Real unreadable-ancestor evidence: not fixed; hard acceptance blocker

**`docs/cloud/MCP-ANCESTOR.md:79–87,133`; local `REPORT.md:132–148`; both runtimes' `11a/11b-ancestry-probe-*.stdout:100–110` — the required naturally occurring denied optional ancestor is absent from the exercised traversal — P2 — retain the gate and obtain only the already bounded owner-controlled evidence when that topology exists.**

All four before/after probes show uid/euid 1000/1000. Every ancestor above PID 1 is uid 1000 and its environ can be opened and closed unread. The sole EACCES row is root-owned systemd PID 1. Production explicitly stops before reading PID 1, so this denial does not exercise the new catch. The unchanged real-process registration test passes on readable ancestry. The synthetic EACCES/EPERM cases pass, but cannot substitute for the real-topology requirement.

The report correctly states that the natural topology was not reproduced. Its sentence about the earlier root-owned WSL Relay must retain the earlier review's qualification: the old raw log proves the EACCES call path, while the Relay/UID attribution is the owner's recorded explanation without a separate contemporaneous ancestry/UID snapshot. This run does not retroactively establish that attribution.

No privilege change, ptrace-based access bypass, forced reparenting, convenient-parent substitution, test alteration, or assistant-run owner-local session is authorized. If the natural topology remains unavailable, this requirement stays pending. Removing or replacing it would be an explicit owner gate decision, not an inference from the synthetic pass.

### R3. Full candidate checks: partly fixed; Node 22 remains a hard blocker

**`docs/cloud/MCP-ANCESTOR.md:134,139`; local `logs/mcp/node22-envproxy/04-npm-test.stdout:7557–7880,10372–10480,10976–10992` and command metadata — exact-candidate Node 22 envproxy npm test exits 1 with 12 failures — P2 — resolve through the separately scoped NODE22-PROXY dependency/integration disposition, preserving the failures and enabled proxy policy.**

The Node 24 final-candidate README set is now complete and green. The Node 22 set was fully attempted, but npm test is red. Its supplemental mjs pass does not change that exit. The ten hud export/help/refusal failures expose UNDICI-EHPA stderr against exact diagnostic expectations; the light-leader fixture receives warning bytes; the run-process fixture parses a warning-prefixed stream as JSON. These are the established output-capture/profile class, not listed flakes. They were correctly not rerun or replaced with a no-envproxy profile.

| Exact-candidate check | Node 22.23.4 envproxy | Node 24.22.1 envproxy |
|---|---|---|
| build / build:test / build:hud-mcp | 0 / 0 / 0 | 0 / 0 / 0 |
| npm test | exit 1; unit 2317 pass, 12 fail, 16 skip; mjs not reached | exit 0; unit 2329 pass, 0 fail, 16 skip; mjs 47/47 |
| supplemental test:mjs | 47/47, exit 0 | not needed; reached inside npm test |
| test:core | 209 pass, 1 existing skip, exit 0 | same |
| test:visual | 319/319, exit 0 | same |
| test:hud-mcp | 107 pass, 1 existing skip, exit 0 | same |
| root format / fixtures / diff check | 0 / 0 / 0 | 0 / 0 / 0 |
| three-file ancestor gate | 43/43, exit 0 | 43/43, exit 0 |
| explicit four-owned-file prettier | exit 0 | exit 0 |

There is no reason to repeat the unchanged green Node 24 suite merely because this review occurred. An actual source/dependency integration later creates a new candidate and requires its own prescribed checks. NODE22-PROXY's separate local success cannot be credited as this candidate's success or authorize combining unaccepted branches. Request the already contemplated exact integration disposition rather than broadening the MCP production patch.

### R4. Performance: numerical failure remedied on this host; isolation condition not established

**`docs/cloud/MCP-ANCESTOR.md:111`; local `REPORT.md:91–95,150–179` and all twelve `bench-*.monitor.txt` — every new numerical gate passes, but the required no-concurrent-workload condition is not established — existing P2 acceptance-evidence gap — complete only the already specified matched benchmark series in an appropriately scheduled window, or obtain an explicit owner disposition of that condition.**

The new data must not continue to be described as “all measured runs fail.” All twelve local runs exit 0, report 30 cold samples and 200 calls per method, and satisfy cold p95 < 200 ms and each method p95 < 50 ms. Raw JSON, SUMMARY.json, wrappers, runtime/commit identities, and exit metadata agree. The predeclared alternating base/candidate order was followed; recorded package commands do not overlap.

| Arm/runtime, three runs | Cold p95 range (ms) | Cold max range (ms) | tools/list p95 range (ms) | whoami refusal p95 range (ms) |
|---|---:|---:|---:|---:|
| baseline Node 22 | 102.169–148.961 | 120.793–251.875 | 0.410–0.430 | 0.394–0.398 |
| candidate Node 22 | 106.028–167.188 | 126.886–277.166 | 0.397–0.455 | 0.391–0.487 |
| baseline Node 24 | 119.293–138.319 | 141.005–153.826 | 0.430–0.466 | 0.385–0.422 |
| candidate Node 24 | 121.392–133.223 | 140.765–145.206 | 0.397–0.448 | 0.367–0.423 |

This is positive, host-specific threshold evidence. The monitor records other-session ast-grep/python and intermittent other work. Neither command serialization nor 1-second lifetime-average CPU snapshots proves host isolation. “No concurrent workload” is an existing brief condition at line 111; it has not been waived. No fresh code defect, performance regression, or threshold failure is inferred from this limitation.

The least additional measurement, if needed under the unchanged condition, is the same twelve-run series, once, on the same exact arms with the same driver/proxy policy and an owner-controlled or otherwise authorized window without competing controlled work. Preserve all runs. No full README rerun, extra percentile, modified driver, new performance experiment, or repeated-until-green loop is required solely for R4. If such a window cannot be arranged, stop and record that precise limitation rather than manufacture isolation or interfere with unrelated sessions.

Other limitations are labels, not new blockers: the driver measures spawn through initialize response, reuses its per-run synthetic HUD home, and uses nearest-rank p95; it does not print individual samples or p99. Their absence does not justify changing the driver. The 179-byte Node 22 stderr warning is retained, not suppressed. Cold max exceeding 200 ms is not a failure of the cold-p95 gate. The twelve historical cloud failures remain recorded and are not overturned by another host. No improvement/equivalence claim, B14 capability promotion, or formal supported-WSL P-06 qualification is made.

### R5. Durable evidence: new local MCP evidence delivered; historical cloud bundles still open

**Prior `mcp-ancestor-review-2.md:82–86` — the newly delivered local run does not contain the original and R1 cloud bundles, including historical negative controls and failed measurements — P2 evidence-delivery blocker remains for those bundles — publish the already retained sanitized bundles to an authorized durable destination and verify their identities by read-back; do not rerun them.**

The new run is not “only executor-local.” Its MCP portion is durably present in the immutable GitHub evidence commit and was read back for this review. That delivery credit must be preserved. It does not fulfill the separate obligation to retain the complete earlier cloud evidence durably. The old original and R1 archive bytes remain available locally and still hash to the values verified by the previous review:

- Original sanitized archive: 308,455 bytes; SHA-256 `b1b01d2683500441c23f0544eb5ac3546b290a7c563145515c318cddd6bde395`.
- R1 sanitized archive: 43,345 bytes; SHA-256 `d96a6dcd0374fc886f7ad992eec11db6b1de27e1f2096a80b437e03e07989070`.

This is an archival task, not a requirement for additional tests or source edits. No new durable destination or read-back identity for those two older bundles was supplied in the reviewed evidence.

## 3. Verified evidence integrity and execution boundaries

- Read back 307 published files covering all MCP and baseline command outputs/metadata/ancestry/monitor files, relevant source/dependency/generated manifests, the report, summary, plan, scripts, and both checksum manifests. All 307 match the immutable Git tree's blob hashes and byte lengths. All 306 applicable entries in published SHA256SUMS match; SHA256SUMS itself is identified by its Git blob and SHA-256 `55ed05db89882c5f9e419c27ff0c70206135ce80857eece202c061e5be0f12b9`. Report SHA-256 is `1e121328474cf6e2203b8a38cfec06ec93085e40d8d5f3da1e45a054988f5ce6`.
- This is a complete check of the selected MCP review inputs, not a claim to have downloaded or independently validated all 4,060 files across the three packages. The manifest contains 4,059 published entries. Its comparison with the raw manifest identifies 152 changed and 3,905 unchanged files, exactly matching the declared redaction list after normalizing `./` path prefixes. Private owner-local originals were not available here; equality of two recorded hashes is not a fresh inspection of those originals.
- All 51 MCP/baseline command SUMMARY records agree with their independent metadata for command, package/profile, UTC start/end, exit and signal/timeout. All are exit 0 except the one Node 22 npm test exit 1. No recorded timeout/signal and no overlapping recorded command intervals. All 153 recorded HOME/HUD_HOME/TMPDIR paths are distinct. Each wrapper uses env -i, selected runtime first on PATH, NODE_USE_ENV_PROXY=1, and retained proxy-variable presence without values; warning suppression/redirect flags are absent.
- Recorded host is WSL2 Linux 6.18.33.2, Ubuntu 24.04.4, Ryzen 7 8745H with 16 logical CPUs and ext4 work/temp storage. Node 22.23.4 binary SHA-256 is `94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90`; Node 24.22.1 is `e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb`. The latter differs from the cloud binary hash; the new host/runtime identity is explicit, not silently equated with the cloud.
- The recorded owner-host probes establish AF_UNIX, own-child ptrace, and proc-children availability in that local workflow only. They do not change the cloud executor's access limits and are not real unreadable-ancestor evidence.
- Source checks retain the candidate HEAD/tree. npm ci changes only tracked dependency metadata `node_modules/.package-lock.json`; it is not staged. The after-install/after-checks/after-bench/final tracked-byte digest is unchanged. Root package-lock.json and source/test bytes match their candidate identities.
- Candidate generated manifests for Node 22, Node 24 and benchmark rebuild are byte-identical, 2,305 files, manifest SHA-256 `2b71ace13c5ea0cd265af96b3d6e6898afedc8032f5084936a49782e8f1832f6`. Both arm dependency manifests match, 332 entries, SHA-256 `843e84e7586722ab8673d9f3cc252e08357dbea9e52410a9dc9da69d596742f3`. These are verified published manifest identities, not regeneration of the owner's build products here.

## 4. Shortest compliant route

1. Preserve this exact candidate and all new/old failures. Do not send the implementer an unnecessary new code change or retry the same Node 22 failures as flakes.
2. Complete R5 by durable publication/read-back of the two existing sanitized cloud bundles. This needs no compute window or test rerun.
3. Obtain the separately scoped NODE22-PROXY acceptance/dependency integration disposition required by MCP brief §8. Do not combine unaccepted candidates ad hoc. Any authorized resulting candidate must get the prescribed final-code check set under the supported enabled-proxy profiles.
4. For R2, use only the owner's already bounded verification workflow when a naturally occurring relevant unreadable ancestor exists. Capture exact identity, UID/eUID, bounded ancestry/start/UID facts, actual denial, unchanged real integration output and exit. The established readable-topology pass and synthetic security controls need not be discarded. If the topology is unavailable, keep R2 pending or ask for an explicit decision on the existing gate.
5. For R4, retain the verified numerical passes and arrange only the original isolated matched series if the original condition remains binding. No extra samples/percentiles, driver changes, performance experiments, formal-qualification work, or unrelated full suite is added.
6. Once these existing acceptance requirements are resolved, obtain a fresh Oracle verdict on the final candidate and evidence. Only an accept verdict permits the sole merger to prepare the prescribed --no-ff integration; the full check set must then be green on that actual merged tree under the existing single-known-flake rule before push/status updates. That later merged-tree gate is not satisfied here and is not a reason to merge now for experimentation.

The startup ledger-registry process/content reads remain a separate unresolved issue; this review neither fixes them nor extends P065's metadata exception. Other package verdicts, P065 process-lifecycle uncertainty, local-only boundaries and later-wave prerequisites are unchanged.

Binding sources: [AGENTS.md](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/AGENTS.md), [dots workflow](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/cloud/dots.md), [MCP brief](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/cloud/MCP-ANCESTOR.md), [governing ruling](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/cloud/rulings/mcp-ancestor-gate.md), [cloud README](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/cloud/README.md).

**Final disposition: R1 remains fixed; R2 open; R3 partly fixed with Node 24 complete and Node 22 red; R4 numerical thresholds pass locally but original isolation condition remains unproven; R5 new local delivery verified but old cloud bundle delivery remains open. Overall fix required; acceptance and merge HOLD.**
