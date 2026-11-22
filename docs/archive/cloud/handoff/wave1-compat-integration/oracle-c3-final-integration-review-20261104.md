# Wave 1 composite C3: final integration Oracle review

Date: 2026-11-04 UTC. Read-only review of the frozen dependent candidate and the owner's completed local qualification.

## Verdict

**HOLD / FIX REQUIRED (evidence completion), NOT ACCEPTED, NOT MERGEABLE. No source or test repair is requested.**

Credit the substantial completed work:

- The exact C3 composition remains conforming.
- The complete shared three-profile README matrix and all prescribed focused commands are green on C3.
- The previously failing combined Node 22 output/fixture cases now complete successfully.
- C3 meets the unchanged MCP driver's numerical gates in all six runs. The bounded, prospectively declared measurement window is adequate for this host-specific design-evidence comparison.
- The new composite evidence is durably present and the selected raw publication bytes have been independently read back and checked.

**Two existing acceptance requirements remain open:** the natural, actually traversed unreadable optional ancestor at PID > 1, and durable custody/read-back of the specified historical evidence. The first is a missing observation, not a newly found code defect. The second is archival work, not a reason to rerun tests.

The baseline U result at **208.678213 ms cold p95, exit 1**, is preserved as a real baseline failure. This review does not turn the twelve-process series into twelve green exits, call that baseline result a C3 regression, or request an extra favorable replacement run.

The later actual merged-tree gate remains mandatory, but is not a prerequisite to this candidate review and is not permission to merge an unaccepted candidate for experimentation.

## 1. Identities, scope and sources

- Candidate C3: **36d3fd584bd403ed7ada95d1d863a8f63e96588b**.
- Candidate tree: **0c8c67ede1f13122987802d9a0346cd6e6ecf73b**.
- Composition/report successor H: **87ef8d1f59177badeebf8c863a5ad29abdc20ba1**.
- Existing V0 review: **27990db71ca33136fbe3263a5eb92e57093dc0f5**, documentary only.
- Benchmark/integration base U: **f248f320d42528fd1eb97db9f1cd2ba97e6d3c86**, tree **2a6491f7c0ca5262587d4ab15a8ae53cbf6901ce**.
- New owner evidence commit read back: **d769dc8b5b1faf87e1c30f356ae0223795f202c6**.
- New evidence directory: **docs/cloud/handoff/local-verification/20261103/wave1-composite-20261104T031916Z-680937/**.

Read AGENTS.md, dots.md, the README/check rules, STATE, the three package briefs and applicable prior reviews, the integration ruling and connector addendum, V0, the owner report, immutable source inventories and relevant implementation/assertion sources. The previous already-reviewed source findings are reused where the implementation/assertion bytes are identical; this is not a second wholesale implementation review.

Primary sources:

- [Owner report at immutable evidence commit](https://github.com/CartmanFatass/codex-hud/blob/d769dc8b5b1faf87e1c30f356ae0223795f202c6/docs/cloud/handoff/local-verification/20261103/wave1-composite-20261104T031916Z-680937/REPORT.md)
- [Published checksums](https://github.com/CartmanFatass/codex-hud/blob/d769dc8b5b1faf87e1c30f356ae0223795f202c6/docs/cloud/handoff/local-verification/20261103/wave1-composite-20261104T031916Z-680937/PUBLISHED-SHA256SUMS)
- [Binding integration ruling](https://github.com/CartmanFatass/codex-hud/blob/87ef8d1f59177badeebf8c863a5ad29abdc20ba1/docs/cloud/rulings/wave1-compat-integration-20261103.md)
- [Connector construction addendum](https://github.com/CartmanFatass/codex-hud/blob/87ef8d1f59177badeebf8c863a5ad29abdc20ba1/docs/cloud/rulings/wave1-compat-integration-connector-addendum-20261104.md)
- [V0 composition and qualification assignment](https://github.com/CartmanFatass/codex-hud/blob/27990db71ca33136fbe3263a5eb92e57093dc0f5/docs/cloud/handoff/wave1-compat-integration/oracle-v0-composition-review-20261104.md)

## 2. Independently verified source and evidence identity

### Source composition

Complete, non-truncated recursive trees were retrieved for U, C3 and the pinned P/M/R source lineages. Independent entry comparison confirms:

- C3 has 1,370 leaves.
- U..C3 changes exactly 58 leaves: the authorized 26 implementation/test/source-document paths and 32 inherited documents.
- All 13 P, 4 M and 9 R owned entries are byte/object-, mode- and type-identical to their respective pinned owner sources.
- Every other implementation/configuration/dependency entry is unchanged from U.
- C3's returned Git commit object names tree 0c8c67ed and ordered parents C2/80a4de01 and R/7ba567ee, consistent with V0's complete three-merge graph audit.
- Twenty-nine remotely fetched C3 files, comprising all 26 owned entries plus package.json, package-lock.json and the benchmark driver, independently match their SHA-256 entries in the owner's source manifest. Zero mismatches.
- The source check excluding node_modules retains **1d9362af9f1710b0466b1f09a51781f0e4f277f53c915d313993db725ca60b9b** at all seven C3 checkpoints. The only reported worktree change is the unstaged npm-generated node_modules/.package-lock.json.
- The four C3 generated-output manifests, three profiles and benchmark preparation, are byte-identical: 2,327 entries, SHA-256 **6f10b7d98c0685a3a4d54f319f98e36f11ca7bab78e56cbdc844abf0b39b90fc**.
- The two dependency manifests are identical: 332 entries, SHA-256 **843e84e7586722ab8673d9f3cc252e08357dbea9e52410a9dc9da69d596742f3**.

These are checks of the recorded manifests and remote source bytes, not a regeneration of owner-local build products by this review.

At review time universal-hud was **d17a8affb89bcf16a78cb9b2beee3300b975266a**. Complete-tree comparison against U shows only two added documents, p065-rejection-audit-repair-20261104.md and tpd1-effect-boundaries-20261104.md. No source drift is presently shown. A future merger must still read back then-current refs and retain those documents.

### Publication integrity and raw-result audit

The immutable evidence directory has 4,049 files. Its 4,048 PUBLISHED-SHA256SUMS paths exactly cover every file except that checksum list itself, with no duplicate or missing path.

I retrieved **1,022 files**, including every command's stdout/stderr/result/meta/ancestry/monitor, scripts and plan, source/dependency/generated manifests, the complete benchmark window, all 22 KILL JSON captures, and all three focused node-proxy-profile capture sets.

- All 1,022 retrieved Git blob identities and byte lengths match.
- All **1,021 applicable published SHA-256 entries match**.
- PUBLISHED-SHA256SUMS itself hashes to **5076095e7bdff6a35f864c4adbab22fb1bdd93389c79d9024f4b33664eacedc6**.
- REPORT.md hashes to **8357a26b7ca06babd96d25ce7a6f9746a3b0df08b9152181bc6418cfcf9ec7c4**.
- All 76 command records agree with their result/meta records for command, profile, source, UTC interval, limit, exit and signal/timeout. Intervals do not overlap; no timeout/signal is recorded; every owned_left field is none.
- All 50 assigned C3 matrix/focused command invocations exit 0. The only nonzero command among all 76 is bench-node24-u-1.

This is a complete audit of these selected inputs, not a claim to have downloaded and hashed all 4,049 files or authenticated execution independently of the owner's evidence.

The raw and published bytes remain distinct. The 4,046 paths common to both checksum manifests comprise 3,929 equal recorded hashes and 117 changed hashes. RAW-SHA256SUMS and redaction-manifest.json are publication metadata; the private redact.py is deliberately omitted. In particular the failed baseline's SUMMARY.stderr_bytes is the original 401-byte count, whereas the retrieved redacted stderr is 329 bytes after path replacement. Its expected publication hash matches and its failure text remains present. This is not an unexplained missing-output discrepancy.

Private originals and the substitution map were not retrieved. No fresh independent raw-to-published transformation audit or protected-original backup is claimed.

## 3. C3 check disposition

### Shared README matrix: satisfied on C3

Each of node22-envproxy, node22-noenvproxy-control and node24-envproxy ran its own fresh complete matrix:

| Check | Result on each profile |
| --- | --- |
| build / build:test / build:hud-mcp | exit 0 / 0 / 0 |
| npm test | exit 0; unit 2,394 pass, 16 existing skips, 0 fail; mjs 47/47 |
| test:core | exit 0; 209 pass, 1 existing skip |
| test:visual | exit 0; 319/319 |
| test:hud-mcp | exit 0; 107 pass, 1 existing skip |
| format:check / check:fixtures / git diff --check | exit 0 / 0 / 0 |

The extra three-test block in the Node 24 aggregate is a nested summary, not another suite execution. Separate mjs was unnecessary because npm test reached it everywhere. No known-flake rerun was needed or used.

### Prescribed focused coverage: satisfied on C3

All three profiles: node-proxy-profile 5/5; export/run-process/light-leader 76/76 both serialized and at normal concurrency; HYG2 six-suite 76/76.

Both enabled profiles: KILL evidence plus complete run-control 44/44; runz1-process/run-control/run-process 54/54; MCP ancestor-discovery/skeleton/int-ledger-registry 43/43; explicit four-file MCP prettier exit 0.

The formerly failing one-shot argv/stdin EOF and exact light-leader brief-byte cases now pass on this actual combined tree. This resolves those required C3 checks through the authorized composition, not by transferring an isolated-branch pass.

The wrapper retains all eight proxy variables, explicitly enables NODE_USE_ENV_PROXY in the two enabled profiles, omits activation only in the labeled control, and removes diagnostic suppression/redirect/preload settings. Node 22 startup diagnostics remain in separate raw stderr and TAP diagnostics as applicable. Proxy captures support the prescribed synthetic HTTP loopback routing, bypass and native-precedence cases. They do not establish external proxy, TLS/HTTPS or untested-network-API coverage.

### Existing MCP/RUNZ1 correctness findings remain fixed

MCP R1's complete-close stdio correction is unchanged. The focused and full suites retain synthetic EACCES/EPERM, no traversal beyond the denied ancestor, strict mandatory physical evidence, genuine-harness and no-remembered-authority controls. Real physical registration passes under readable ancestry only.

RUNZ1 K1/K2 source and assertion corrections remain unchanged. The 22 new captures represent seven ladder executions and five controlled live-to-Q executions, not 22 independent executions. Independent data inspection found:

- Five live captures retain the slot, no receipt and zero terminal transitions.
- Their Q/final captures end receiptlessly with one terminal transition and a revoked claim; Q and final differ only in label.
- Seven ladder finals are cancelled, receiptful and file/receipt-consistent, with one terminal transition.
- All native exit fields remain null, without inventing a lost native wait result.
- All 36 unique captured reconciliation records have matching CAS revisions and correctly bound/time-valid incoming evidence; releasing transitions have complete supporting receipt/Q prerequisites.
- 11,664 typed scope/boot/PID-domain identity occurrences use the ten published aliases.

The existing unchanged tests also retain the K1 embedded-identity mutation control, K2 held-complete-Q counterexamples and scope-proof rejection controls. None of this reconstructs the missing historical 15:57 snapshot. That missing snapshot remains unexplained and does not justify another diagnostic burst.

## 4. MCP benchmark: explicit mixed-series disposition

The unchanged driver is blob **c36817dee4cf70c27a39a86b3965f4eb6701ceb0**. It measures spawn through initialize, uses 30 cold samples and 200 calls per method, and computes nearest-rank p95. Its gates remain cold p95 < 200 ms and both method p95 < 50 ms. There is no cold-max gate and no new relative-improvement threshold.

Exactly the declared twelve processes ran in alternating U/C3 order, three pairs per enabled runtime. There was no thirteenth replacement, control-profile series, trimming or selective omission.

| Arm/runtime | Cold p95 values, ms | Exits |
| --- | --- | --- |
| U, Node 22 | 142.788, 148.945, 188.852 | 0, 0, 0 |
| C3, Node 22 | 188.335, 150.338, 161.107 | 0, 0, 0 |
| U, Node 24 | **208.678**, 144.215, 176.695 | **1**, 0, 0 |
| C3, Node 24 | 169.807, 137.790, 162.449 | 0, 0, 0 |

All method p95 values pass. Candidate cold maxima reaching 278.370 ms do not fail the p95 gate.

**Isolation disposition:** credit the required contemporaneous controlled-window evidence for this bounded host-specific comparison. The new evidence is materially stronger than the superseded lifetime-average snapshots: it samples per-process CPU deltas throughout a 60-sample pre-observation and the complete 129-sample window, fixes the criterion before execution, and records no interleaved build/test/install. Independent recomputation gives zero Q1 and Q2 violations; non-owned mean/max are 0.096/0.47 core over the full window. The benchmark process interval is 03:37:30.268–03:38:33.225Z.

This is not a claim of zero operating-system activity or proof against every short-lived process, I/O, memory or cache interaction. Sampling has those limits. They are disclosed limitations of design evidence, not grounds to add a new instrumentation campaign or require a physically idle host. No formal WSL qualification is credited.

**Numerical disposition:** C3 satisfies its unchanged absolute numerical requirement on both enabled runtimes. The complete comparison is **11/12 exit 0, not 12/12 green**. U's 208.678213 ms run is a baseline-only gate failure and remains a real retained result. It limits the strength of margin/regression attribution. It does not establish a C3 defect, justify repairing the accepted baseline inside this candidate, or require another series merely to obtain a passing control. No improvement/equivalence or MCP-only causal claim is made.

Thus the pending C3 measurement assignment is completed with this explicit mixed-series disposition; no additional benchmark is requested for this unchanged candidate. Old cloud failures and the previous local series are not overwritten. Near-threshold performance and host variation remain visible.

## 5. Open findings and package-by-package disposition

### I1. Natural optional-ancestor denial still absent: P2 acceptance blocker

**REPORT.md:169–186; MCP-ANCESTOR.md §5; integration ruling §5C — no actually traversed optional ancestor at PID > 1 has an observed EACCES/EPERM — a readable-ancestry pass cannot demonstrate the required real-host denied-read path — retain PENDING and obtain only the already bounded natural-topology evidence, or an explicit owner decision changing that gate.**

All four contemporaneous probes show uid/euid 1000/1000 and readable PID > 1 ancestry. Only PID 1 returns EACCES. Production terminates before PID 1. Synthetic denials and a real readable-ancestry registration pass are valuable separate facts, but cannot be renamed the missing observation.

No reparenting, chosen-parent workaround, permission/security alteration, privileged helper, new probe campaign or assistant-run owner-local testing is authorized. Repeating this same unchanged readable topology is not the next useful test.

### I2. Historical full-evidence custody remains open: P2 evidence-delivery blocker

**REPORT.md:252–261; integration ruling §6.4; prior package custody findings — the new composite directory does not deliver the distinct historical full archives — losing the retained originals would lose negative controls and old failed-run evidence — complete only authorized preservation/publication and exact read-back, without running tests.**

Previously audited archive identities, retained here as attributed provenance rather than newly retrieved archive bytes:

| Required historical material | Prior verified identity |
| --- | --- |
| NODE22-PROXY full archive, 545,457 bytes | bf22a3540b29458741609aa8e811917ec4ff48774f3df1a662e0d085727d45fc |
| MCP original sanitized archive, 308,455 bytes | b1b01d2683500441c23f0544eb5ac3546b290a7c563145515c318cddd6bde395 |
| MCP R1 sanitized archive, 43,345 bytes | d96a6dcd0374fc886f7ad992eec11db6b1de27e1f2096a80b437e03e07989070 |
| RUNZ1 corrected sanitized archive, 290,624 bytes | 43afcc2f9bfc464e745b001246b86cac51d0e0c55f1a45f994c4bd0265b31180 |

NODE22-PROXY's 706-file courier is a selected subset, not the full archive. Its 13-part concatenation hash 3d31b7116a57d48e9971d2e632147503ce43e8af65f2210bfd0d94d3bee23757 must not be substituted for the full-archive identity.

Do not resume the stopped 13-part/44-part operations without resolving the specific stop/resumption permission. Do not switch transport or destination to evade it. No generic reapproval of the entire project is needed. Protected RUNZ1 originals remain protected; the old unsanitized archive is not the approved public bundle. Preserve them locally and report the existing backup limitation if no authorized private destination exists. Obtaining a new private-storage destination is not an added acceptance gate.

### Package ledger on C3

| Package | Satisfied now | Still open | Verdict |
| --- | --- | --- | --- |
| HYG2 / NODE22-PROXY | Composition, inherited reviewed fixes, complete three-profile matrix, focused route/output/strict-byte coverage | I1 inherited ancestor requirement; I2 full historical custody | HOLD, not accepted |
| MCP-ANCESTOR | R1 remains fixed; R3 final-candidate full checks now satisfied on both enabled runtimes; focused/security checks satisfied; C3 benchmark requirement completed with the explicit baseline-failure disposition above | R2 = I1; historical R5 = I2 | HOLD, not accepted |
| RUNZ1 / RUNZ1-KILL | K1/K2 remain fixed; required combined Node 22 54/54 now completes; shared matrix and proof controls satisfied | I1 inherited ancestor requirement; I2 distinct historical sanitized archive custody | HOLD, not accepted |

These are dispositions within the single C3 dependent set. They do not independently accept old P/M/R commits. No new must-fix implementation finding is identified.

## 6. Exact shortest next action

1. **Record the completed C3 checks and this HOLD disposition. Keep C3 frozen.** Do not rerun the shared matrix, old package matrices, twelve-run benchmark, mutation archive, KILL burst or RUNZ1 n=1,000 scan-cost experiment merely because review occurred.
2. **Complete the existing custody task independently of topology.** Preserve the named artifacts, establish only any missing bounded resumption permission for the stopped publication, then publish/read back the correct approved full archives with exact hashes and destination identities. No source change or compute lease is needed.
3. **For the ancestor gap, use the owner workflow only when a natural qualifying topology exists.** On the same verified C3 bytes/build/runtime, obtain one real PID > 1 optional-ancestor EACCES/EPERM observation accompanying successful unchanged physical registration without logical authority. The existing focused command is sufficient; its 300-second bound and raw identity/ancestry/stdout/stderr/exit recording remain. Both enabled runtime security suites already passed; the natural-topology observation need not be duplicated per package or per runtime.
4. **If that topology is unavailable, tell the owner that exact fact and keep the gate pending.** Removing or substituting it is a specific owner acceptance-gate decision, not something inferred from full green tests or general project authority. Do not ask for the same broad test run again or consume repeated windows looking for a different answer.
5. **When I1 and I2 are actually resolved, give a fresh integration Oracle the supplements and this unchanged C3 record for the final accept decision.** Reuse the verified completed rows. Reopen them only for real source/dependency/profile drift or relevant new failure.
6. **Only after explicit joint acceptance:** the sole merger rechecks current target drift, performs one history-preserving --no-ff integration, and runs the prescribed complete three-profile README gate on the actual merged tree before push or status promotion. A merged-tree failure returns to a fresh Oracle with original evidence intact.

The owner-local run does not release either held cloud executor or establish historical process cleanup. No local-only B13_REAL/B45/B14, real harness/tmux/Jev, install/statusline, deployment, later-wave release, main update, force push or dependency-state staging is authorized.

## Method and final statement

This review used read-only connected GitHub retrieval, immutable inventory comparisons, and local parsing/hashing of downloaded evidence. No repository build, test, benchmark, capability/topology probe, source edit, Git mutation, publication, process-control action or further delegation was performed.

**Final disposition: C3 composition and prescribed candidate checks verified; candidate numerical benchmark gates met with the real U-only failure preserved; no new source repair or redundant measurement requested; I1 natural ancestor and I2 historical custody remain; the entire dependent set stays NOT ACCEPTED and NOT MERGEABLE.**

