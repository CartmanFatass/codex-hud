# MCP-ANCESTOR R1 fresh Oracle re-check, 2026-11-03

**Verdict: fix required. R1 is fixed; MCP-ANCESTOR remains unaccepted and must not be merged because R2–R5 remain open.**

The bounded stdio-capture correction satisfies the previous R1 finding. No new must-fix code regression was found in this fix. This is not a package accept verdict, a full-check pass, a performance disposition or proof of durable evidence delivery. No contract, gate, supported profile or security predicate is waived.

## Scope and exact identity

This was a fresh read-only re-check of the binding MCP-ANCESTOR brief and governing ruling, repository workflow, previous full review, original implementation/publication reports, R1 fix/publication reports, exact fix diff, affected source and tests, and recorded raw evidence. I ran no build, test, benchmark, process-topology probe or owner-local work. I edited no source or repository documents, made no GitHub mutation, and started no subagents. NODE22-PROXY's active verification compute window was not used.

- Repository: CartmanFatass/codex-hud; work branch: dots/mcp-ancestor.
- Original pinned base: 26f6fba36948e6c96e2e109cb374c0d4dbb9ab22.
- Previously reviewed implementation: bfe630c981efeb7914dfffb2764c2c715b791a46; tree 10ce62eb316fb8954a5b667da261d301e2dd69ea.
- R1 fix commit: b2897a4f9769bca6305ff0e3ae3dc694a9320ffe.
- Fix tree: 0d195bd47ff2b29581e1c394c2973d9479f8d928.
- Sole parent: 7d1bb9d7358bf8b4e92ef54a4c7baa3d28cf9a25.
- Revised tests/hud-mcp/int-ledger-registry.test.ts blob: 234a3f2253f4bcf61f039732ae99c9c878853a1d; SHA-256 d9f52537e2182ec6cea624522efbf13c868c1eecdac2ecf6c42f37ae073bc770.

GitHub commit and comparison read-back independently confirms the fix tree, sole parent and exactly one changed source/test file, with 89 additions and 27 deletions. Comparing the original implementation to the fix adds only that test delta and the three already published implementation/publication/review documents. Production process.ts, ancestor-discovery.test.ts and skeleton.test.ts retain their reviewed blobs and SHA-256 values. Their current working bytes and the revised test match the R1 source manifest and exact remote blobs.

At this review's branch read-back, dots/mcp-ancestor was 99a851212943484e893390992db8dceabe8341a8. Its two commits after the fix add only mcp-ancestor-fix1.md and mcp-ancestor-fix1-publication.md. They do not change tested code. The local worktree remains the pinned base HEAD plus working changes; it is not represented as a checkout of the publication commit. Its unstaged node_modules/.package-lock.json difference remains excluded.

The R1 publication addendum supersedes only the initial report's publication-blocked statement. The initial denial remains in the chronology. Verified publication of the test fix does not close the separate full-evidence delivery finding.

Sources: [exact fix](https://github.com/CartmanFatass/codex-hud/commit/b2897a4f9769bca6305ff0e3ae3dc694a9320ffe), [sole-parent comparison](https://github.com/CartmanFatass/codex-hud/compare/7d1bb9d7358bf8b4e92ef54a4c7baa3d28cf9a25...b2897a4f9769bca6305ff0e3ae3dc694a9320ffe), [post-fix documentation-only comparison](https://github.com/CartmanFatass/codex-hud/compare/b2897a4f9769bca6305ff0e3ae3dc694a9320ffe...99a851212943484e893390992db8dceabe8341a8).

## Disposition of previous findings

### R1. Complete stdio capture: fixed

Relevant final code: tests/hud-mcp/int-ledger-registry.test.ts:220–295 and 298–357.

The file-local captureMcpOutput helper installs both data listeners immediately and resolves its completion promise only on ChildProcess close. The real MCP case awaits that promise before inspecting the residual parse buffer and complete stdout. Pending requests are rejected at completed close, with captured stderr available, rather than at the earlier exit event. Cleanup awaits the same completion before removing the temporary home.

The final assertions are preserved: exit code zero, empty residual buffer, final newline, parsing of every newline-delimited record, exactly three records, and exact JSON-RPC versions and IDs 1/2/3. There is no trimming, filtering or stderr suppression. A malformed line received after the pending-request map becomes empty can no longer escape solely because its data event follows process exit; the final complete-output validator still examines it. An extra valid record fails the exact record count. Unterminated output fails the residual/framing checks.

This completion boundary agrees with Node's documented semantics: close follows process termination and closure of the child's stdio, while exit can occur before the streams close. [Node 22.23.4 ChildProcess events](https://github.com/nodejs/node/blob/v22.23.4/doc/api/child_process.md#event-close).

The three deterministic controls use the same capture helper and stdout validator as the real test:

1. stdio capture rejects non-JSON line delivered after exit and before close.
2. stdio capture rejects extra JSON-RPC record delivered after exit and before close.
3. stdio capture rejects unterminated output delivered after exit and before close.

Each fixture first supplies three valid replies and proves that prefix passes validation. It then emits exit, yields a promise turn and asserts that completion has not occurred. It supplies the specified trailing stdout plus late stderr, drains both PassThrough streams through end, again proves close is required, emits close and observes the expected rejection. The malformed-line case requires SyntaxError; the extra-record and unterminated cases require AssertionError. The exact complete stdout and late stderr are checked afterward. These fixtures are synthetic event-order controls, not a claimed real-process reproduction or unreadable-ancestor topology.

Both recorded runtime suites execute and pass all three controls plus the real MCP case. On static inspection, reverting completion to exit would violate the explicit pre-close completion assertion; removing late-output capture or acceptance validation would also violate these controls. No exit-event mutation run was performed, so no measured failing-before result for such a mutation is claimed. The executed negative evidence is the expected validator rejection within each fixture. This meets the earlier request for deterministic late malformed/extra-output rejection without adding an unrequested production change.

The original real LinuxProcessReader registration case, forged-start/cwd guards and unrelated composition test remain unchanged. The fix is entirely inside the already owned test file. No benchmark or HYG2 helper was changed. No further R1 implementer fix is required by this re-check.

### R2. Real unreadable-ancestor final-candidate evidence: not fixed, still pending

**docs/cloud/MCP-ANCESTOR.md §5 and §8; root-ancestor-evidence.md — the required naturally occurring unreadable topology is not established on the final candidate — P2 acceptance blocker — retain the pending gate and obtain only the already bounded owner-controlled evidence.**

The earlier owner failure still establishes EACCES through readBounded → LinuxProcessReader.get → findHarness → registerCaller. The root-owned WSL Relay attribution remains the owner's explanation without a separate contemporaneous UID/ancestry snapshot. The new real-process focused passes and synthetic EACCES/EPERM cases do not supply that missing evidence.

Required evidence remains the exact final SHA/tree, runtime, UID/eUID, bounded readable PID/PPID/start/UID ancestry, separately observed denial code, unchanged real integration command, unfiltered output and exit. Root ownership alone is not denial evidence. No assistant-run local session, privilege change, forced reparenting, convenient-parent substitution or access-denial bypass is authorized. If the topology no longer exists, record that limitation rather than manufacture it.

### R3. Complete candidate and actual merged-tree checks: not fixed

**docs/cloud/MCP-ANCESTOR.md §6 and §8; original implementation report and blocked command records — the required aggregate remains incomplete or failed — P2 acceptance blocker — obtain the missing full checks on an already permitted capable executor, preserving all initial failures.**

The R1 window deliberately ran only builds, the affected three-file focused suite, changed-file formatting and diff checks. It did not run npm test, test:mjs, test:core, test:visual, the full test:hud-mcp aggregate, root format:check or check:fixtures anew. Its focused pass is not a complete final-candidate README pass.

The preserved prior candidate records remain unchanged: npm test was blocked_not_run on both runtimes; Node 24 test:mjs executed with 32 pass / 15 fail and exit 1 from synthetic Unix-socket listen EPERM; Node 22 test:mjs was blocked, not retried. The earlier Node 24 hud-mcp aggregate remains 103 pass / 1 fail / 1 existing skip, exit 1, with its permitted single isolated nine-test ledger_busy rerun recorded separately. The earlier Node 22 hud-mcp aggregate was 104 pass / 1 existing skip, exit 0. None supplies the missing aggregate or a fresh full check set for this R1 tree.

Prior owner-host capability evidence for other trees does not establish this cloud executor's capabilities or a pass for this candidate. Do not retry denied facilities here, skip assertions or combine unaccepted branches to manufacture green. No actual --no-ff merged-tree checks exist for this candidate; that later gate remains required after package acceptance.

### R4. Twelve cold-start performance failures: not fixed

**tests/hud-mcp/benchmark.mjs:65–101; original performance-summary.json and review — every required existing benchmark run fails the unchanged cold-start threshold — P2 acceptance blocker — preserve all failures and seek a separately bounded remedy/disposition followed by valid required measurements.**

No performance measurement was run in the R1 window. The unchanged driver remains blob c36817dee4cf70c27a39a86b3965f4eb6701ceb0. All twelve earlier runs still exit 1. Cold p95 values in milliseconds, retaining run order within each arm, are:

- Baseline Node 22: 404.379, 251.948, 218.628.
- Candidate Node 22: 235.458, 544.945, 210.635.
- Baseline Node 24: 407.240, 375.217, 237.383.
- Candidate Node 24: 285.203, 548.036, 275.888.

Each run has 30 cold samples and 200 calls per method. Cold p95 must be strictly below 200 ms; both method p95 thresholds remain strictly below 50 ms. Method timings passed, but all cold timings failed. The baseline being red prevents a regression-attribution claim; it does not make the candidate green, prove equivalence or establish an approved flake. The earlier cold/max and method values remain in the unchanged original report and evidence. No sample trimming, favorable-run selection, driver change, threshold relaxation, warning suppression or formal WSL/B14/P-06 qualification is credited.

### R5. Durable full-evidence delivery: not fixed, still unverified

**docs/cloud/MCP-ANCESTOR.md §3 and §6; original and R1 evidence/publication reports — checked archives remain executor-local without verified durable bundle delivery — P2 evidence-delivery blocker — publish the authorized sanitized lossless evidence to a suitable durable destination and verify its identity/checksum by read-back.**

The inspected branch contains narrative reports and the published test correction, not a verified durable copy of the full evidence bundle. No new verified durable bundle URL, object identity and read-back checksum was supplied. Local integrity checks cannot close this gate. Original raw files, failed checks, publication denials and chronological addenda must be retained. Sanitized archives must not be described as byte-identical to raw directories.

## Verified R1 checks and evidence integrity

The twelve recorded commands ran serially from 20:41:37.229106 through 20:43:06.906882 UTC. All twelve per-command JSON records agree with their raw log headers and CHECK_END footers, all exit 0, and their recorded intervals do not overlap. This establishes serialization of the recorded commands, not exclusive control of external host load.

For each of Node 22.23.4 and Node 24.22.1:

- npm run build: exit 0; 600-second outer limit.
- npm run build:test: exit 0; 600-second limit.
- npm run build:hud-mcp: exit 0; 600-second limit.
- node --test on the compiled ancestor-discovery, skeleton and int-ledger-registry files: 43 pass, 0 fail, 0 cancelled, 0 skipped; exit 0; 300-second limit.
- Explicit prettier --check on tests/hud-mcp/int-ledger-registry.test.ts: exit 0; 300-second limit.
- git diff --check: exit 0; 60-second limit.

The two focused runs completed at 20:42:25.718992 and 20:43:05.899448 UTC. The count is the previous 40 cases plus three capture controls, not 43 newly measured baseline cases.

All twelve records use distinct fresh HOME/HUD_HOME/TMPDIR values, retain NODE_USE_ENV_PROXY=1 and proxy-variable presence, and record NODE_OPTIONS and NODE_COMPILE_CACHE unset. The wrapper removes the named inherited harness/session/color selectors. Raw proxy and npm warnings remain visible. There was no dependency install in this window. The root package-lock SHA-256 remains 98a7e2d3f5256810fe477812be64b35411aeede8b34f91e648d62e96c39e3294.

Runtime binary hashes agree with the preserved runtime identities:

- Node 22.23.4: 94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90.
- Node 24.22.1: 61ab14cd750fc24d5db53490ec5fc40f756e4b6e136b78cf7004265471d9bd1d.

All 39 entries in the R1 RAW-SHA256SUMS match. All 120 final-build-manifest entries match the retained current files. That manifest describes the final Node 24 build; it is not a separately captured Node 22 build manifest, and I make no new cross-runtime artifact-equality claim for R1.

All 41 R1 publication SHA256SUMS entries match. All 24 declared sanitization transformations match exactly; the only transformation is the recorded cloud-home-prefix replacement. Corresponding files outside that transformation list are unchanged. All 42 archive file members match the sanitized publication directory, with no missing directory files. The separate R1 archive SHA-256 is d96a6dcd0374fc886f7ad992eec11db6b1de27e1f2096a80b437e03e07989070.

The earlier evidence is preserved: all 127 original RAW-SHA256SUMS entries and all 115 original publication SHA256SUMS entries still match. The original archive still hashes to b1b01d2683500441c23f0544eb5ac3546b290a7c563145515c318cddd6bde395. These are local integrity findings, not durable-delivery credit.

The original meaningful production negative controls remain valid historical evidence for the unchanged production change: both baseline suites reported 32 pass / 8 fail, while the original candidate reported 40 pass. The optional-denial registration/ledger failures and source-loss classification controls retain their original distinctions. No new baseline run occurred for R1, and no prior security regression control is relabeled an authorization escape.

## Unchanged security and integration boundaries

The production fix remains the previously reviewed narrow catch around the optional reader.get expression in findHarness. Only object errors with code EACCES or EPERM yield immediate null discovery; no farther ancestor is read. Other errors propagate, inference stays outside the catch, and strict mandatory physical evidence remains unchanged. The R1 test-only diff cannot manufacture a SessionRef, source, remembered harness or logical authority.

The separate startup-writer process/content reads in ledger-registry.ts remain unresolved and outside this fix. P065's metadata exception is not extended to cover them. NODE22-PROXY's profile/implementation/route-evidence work remains separately owned; the MCP focused results do not accept it or permit importing its unaccepted code. No other package or later queue wave is accepted here.

The same implementer need not receive another R1 code-change request on this evidence. Dispatcher work should preserve R2–R5 as distinct open gates and route their evidence, capable-executor checks, performance disposition and durable-publication needs within existing authorization and scheduling. Any further source change needs the applicable bounded scope and a fresh review. Package integration remains prohibited until a fresh accept verdict after all required gates; the sole merger must then establish the complete green check set on the actual --no-ff merged tree before pushing.

Sources: [binding brief](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/MCP-ANCESTOR.md), [governing ruling](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/rulings/mcp-ancestor-gate.md), [previous full review](https://github.com/CartmanFatass/codex-hud/blob/99a851212943484e893390992db8dceabe8341a8/docs/cloud/handoff/mcp-ancestor-review-1.md), [R1 fix report](https://github.com/CartmanFatass/codex-hud/blob/99a851212943484e893390992db8dceabe8341a8/docs/cloud/handoff/mcp-ancestor-fix1.md), [R1 publication addendum](https://github.com/CartmanFatass/codex-hud/blob/99a851212943484e893390992db8dceabe8341a8/docs/cloud/handoff/mcp-ancestor-fix1-publication.md).

**Final disposition: R1 fixed; no new must-fix code regression found; overall fix required; acceptance and merge HOLD for R2–R5.**