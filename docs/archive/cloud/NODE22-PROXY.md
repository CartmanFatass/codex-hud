# Brief NODE22-PROXY: preserve proxy routing and exact output channels

Date: 2026-11-03. Tier S. One bounded HYG2-dependent compatibility amendment.

## Decision and status

Release exactly one bounded implementation submission and one fresh final Oracle review for the test-capture correction and explicit export-help clarification already approved by docs/cloud/rulings/node22-proxy-profile.md. This brief resolves the branch and file-ownership question by making the work an explicitly dependent continuation of HYG2, not an independent package that imports unaccepted HYG2 production.

Design and the narrow ownership reservation are ready to record. Actual branch/worktree materialization, edits, builds, test processes and routing witnesses remain HOLD until the dispatcher records this brief and the exclusive handoff below, receives the active measurement lease back, and assigns a bounded resource window. The dispatcher’s independent NEXT measurements are active at this consultation. The earlier NEXT implementer’s return does not terminate a subsequent dispatcher measurement lease.

HYG2 and NODE22-PROXY remain unaccepted and unmergeable. This is one explicit new compatibility submission, not a reset of HYG2’s prior fix counters, a renewal of its earlier code work, an automatic two-fix-round allowance, or permission to combine unrelated unaccepted packages. Preserve every earlier red matrix.

## 1. Authority, inspected identities and inputs

The governing integration documentary snapshot is universal-hud commit 3ac3019572f0341081bcff89485fec8cb41f16ba, tree 9b6083c68501966dd84d0bebfa5e622d5ae137d2. The preceding ruling is archived there as docs/cloud/rulings/node22-proxy-profile.md, blob 593b79b573111f878ae40f08993aa45c7c5d0067. Its retained proxy-enabled profile, warning boundary and explicit public wording are binding. The complete comparison from 26f6fba36948e6c96e2e109cb374c0d4dbb9ab22 to this governing snapshot contains only documentary changes.

The HYG2 continuation base is exactly ce5e6961a0e6de1304dcebb00fc1b8c805573ec6, tree 455e5cb8fce558bcb0a0f014e0e192a637b7dd2f, independently retrieved as the current dots/hyg2 head. Its one commit after the owner-tested 2bcaa4f9c8eb2c1c230a0249c0fa40bccd6fbd31 adds only docs/cloud/handoff/hyg2-local-review-20261103.md. The original tested tree remains 50438e87a1915d5e739a4a4d926cc9b1e7e85724. The old branch and the owner’s tested target are preserved unchanged.

Read before implementation:

- AGENTS.md; docs/cloud/dots.md and README.md; current STATE; engineering-plan section 3’s complete-brief requirements; architecture section 8; concept section 15; applicable directory notes.
- Current contracts 01–07, especially contract 04’s exact argv/environment/stdin transport, separate raw-byte logs, scope/native-result/cleanup invariants and T-04-1/2/10/15; contract 07’s read-only export v1, complete-document stdout, refusal/privacy limits and separate legacy codex-hud --json boundary. Numeric budgets and capability requirements remain unchanged.
- The preceding Node 22 ruling; HYG2, its ownership/warning ruling and previous reviews, and the local-evidence review at ce5e6961; owner evidence at local-verification/20261103 commit 9be7246c25b5355845e639116c57150ff79d3117, including REPORT.md, proxy-policy-change.txt, the wrapper and the original enabled/no-envproxy logs.
- RUNZ1 and the RUNZ1-KILL diagnosis/ownership disposition, B10B-S3F-NEXT, P065-BUDGET and its release, MCP-ANCESTOR and its ruling. The RUNZ1-KILL text was available as the dispatcher’s exact local transcript during this consultation; archive it before relying on it as a repository record.
- The six owned paths below; read-only src/ledger/runtime.ts, src/cli/hud.ts, bin/hud, src/core/run/process.ts, control.ts and runtime.ts, tests/run/native-group.ts and group-helper.ts, package.json and test compiler configuration.

Relevant frozen blobs on HYG2 are: hud-link-export.test.ts e7f4e0972b946fb375c466968191c5ee41dee1d8; ledger/runtime.ts 3f61a6f4ebfc8607e59dbe464d93d63d8f211662; link-export.ts 0c62d4d025cab6136407ddde392030858ce5af16; run-process.test.ts 86605827a7d7420fdb5ab7f909c11e6ac7903e3e; run-light-leader.test.ts 823b738b944f6ac432cb980828b3eeef2b9a6954. The two run-test blobs and help source are unchanged across the snapshots identified by the preceding ruling.

This consultation inspected source, contracts, reports and primary Node source only. It did not execute code, builds, tests, probes or benchmarks, create a worktree, change a repository, or repeat the earlier archive-wide integrity audit. Prior successful executions and hash audits remain attributed to their recorded reviewers.

## 2. Goal and unchanged product boundary

Make the tests distinguish exact application output from independently established runtime diagnostics without altering either stream. Preserve the owner’s Node 22.23.4 configuration with NODE_USE_ENV_PROXY=1 and its HTTP(S)_PROXY/NO_PROXY policy. The separately labeled run omitting the opt-in remains a control, not a replacement profile.

Production behavior is unchanged except for the named EXPORT_HELP text. In particular:

- No proxy-routing change, environment rewriting, runtime upgrade, dependency change or launcher substitution.
- No suppression of UNDICI-EHPA, arbitrary warnings or application errors. No new emitWarning interception, no global no-warnings/disable-warning/redirect-warning setting, and no resurrection of hudStderr normalization.
- Successful exports keep exactly the producer’s stdout bytes, including their existing newline. Refusals retain their exact HUD reason line, exit status, no successful/partial export document and no initialization/migration/write behavior. Preserve the existing output-failure cases rather than changing I/O handling.
- In-process HudIO tests still expect only HUD’s own output. Do not add runtime-warning allowances to callbacks that do not capture process stderr.
- Scope, exit provenance, helper lifetime, EOF, exact argv/stdin and cleanup assertions are not weakened.
- The ledger runtime predicate stays Node 22.x >=22.13 or Node >=24, excluding 23; this repair does not rewrite package.json’s broader bar-runtime declaration. The built-in envproxy feature appeared on Node 22 at 22.21.0. Older supported Node 22 binaries do not acquire it merely from the variable’s presence.
- No contract/schema/export version, supported-platform gate, performance population/budget, capability cell or later-wave prerequisite changes.

## 3. Exact dependent lineage and exclusive handoff

Reserve branch dots/node22-proxy and worktree /workspace/shared/node22-proxy from ce5e6961a0e6de1304dcebb00fc1b8c805573ec6. Both names were unoccupied when checked. Recheck at admission and stop on a collision; do not delete or repurpose an unexpected branch/worktree.

This is explicitly the HYG2-plus-compatibility acceptance candidate. Its inherited HYG2 runtime/B45/helper changes remain unaccepted and unchanged. Review the amendment diff against ce5e6961 and separately retain the complete inherited HYG2 diff/provenance. Do not present the branch as based solely on accepted universal-hud code, cherry-pick HYG2 production into a supposedly independent package, advance dots/hyg2, or merge other WIP branches into this continuation.

The reason for this lineage is concrete. At integration base 26f6fba, ledger/runtime.ts still uses the old unsuppressed import, and hud-link-export.test.ts contains HYG1’s hudStderr removal of the SQLite notice. HYG2 replaces that normalization with a genuine fresh-process negative regression and narrow runtime suppression. An independent branch cannot honestly claim that HYG2 regression while treating its necessary production prerequisite as accepted.

The dispatcher records the following exclusive handoff before edits: tests/unit/hud-link-export.test.ts remains HYG2’s item-1 regression, but only the runtime-diagnostic expectation/help assertions described here are assigned to NODE22-PROXY. The HYG2 runtime/B45/ProcessClient implementation and already-fixed P2 are frozen. No concurrent HYG2 implementer edits this test. This handoff transfers no other HYG2 path or acceptance authority.

A fresh final Oracle must review the exact dependent candidate, the compatibility delta, retained HYG2 findings, complete evidence and the remaining HYG2 gates. A focused compatibility pass is not HYG2 acceptance. If unrelated baseline failures prevent a green candidate, retain HOLD and obtain a separate exact integration disposition; this brief does not authorize an ad hoc combined repair branch.

## 4. Complete file ownership

Only these six production/test paths are reserved:

1. src/cli/link-export.ts: EXPORT_HELP wording only, exactly as section 5 specifies. No function, parsing, serialization or exit mapping changes.
2. tests/unit/hud-link-export.test.ts: explicit raw runtime-diagnostic expectations for launched children, retained/strengthened SQLite and unrelated-warning regressions, and public-help assertions. Preserve all business, privacy, read-only and refusal checks.
3. tests/unit/run-process.test.ts: separate stdout/stderr descriptors and cleanup in its local fixture, the target exact argv/stdin/EOF test’s independent stderr assertions and deterministic sentinel, plus necessary imports. No lifecycle/identity assertions or other scenarios are relaxed.
4. tests/unit/run-light-leader.test.ts: the corresponding local fixture capture/cleanup and exact-brief/EOF test changes. Do not change production topology, timing allowances or unrelated signal/control assertions.
5. New tests/unit/node-proxy-profile.test.ts: the closed diagnostic-model regressions and bounded synthetic route/NO_PROXY/control witnesses in this brief.
6. New tests/int/node-startup-diagnostics.ts: a small test-only helper for declared profile validation, a minimal no-HUD probe, deterministic expected-byte construction and strict raw-stream assertions. No production import, top-level process/socket side effect, generic warning sanitizer or dependency. Keep route-server fixtures inside the new test file rather than creating unnamed shared fixtures.

The existing build:test import traversal and unit-test glob include these additions. No package.json, compiler, lockfile, test script or build-system change is needed.

Ownership reconciliation:

- HYG2: only the precisely assigned export-test amendment overlaps. src/ledger/runtime.ts, b45-launch.test.ts, tests/int/process-client.ts, process-client.test.ts and the B12/B16 helper callers are read-only.
- RUNZ1: process.ts/process-census.ts and its direct production helpers stay read-only. RUNZ1-KILL exclusively owns run-control.test.ts and its two new kill-evidence/fixture files. Merely including run-process.test.ts in a RUNZ1 focused command is not ownership of its capture amendment. Neither package edits tests/run/native-group.ts or group-helper.ts here.
- NEXT: no overlap with src/render/delegation/facts.ts, projection.ts, b10b-s3-facts.test.ts or b10b-s3-perf-regression.test.ts. All benchmark sources/populations and rendering remain read-only.
- MCP-ANCESTOR: no overlap with packages/hud-mcp/src/process.ts, ancestor-discovery.test.ts, skeleton.test.ts or int-ledger-registry.test.ts.
- P065: no overlap with its reserved twenty production and twenty-three test/fixture paths. In particular src/cli/hud.ts, run.ts, cli/runtime.ts, local-manager/resolver/budget/transaction files and its fixture extensions remain read-only. Sharing a CLI directory is not permission to edit the dispatcher.

All other source-controlled paths are read-only, including existing run helpers, contracts, capability manifests, visual baselines, reference documents, package/lock files and historical evidence. If the six paths cannot express the fix, stop that portion and return a precise ownership/design question.

Dispatcher-owned records, through one serialized writer: this brief; the preceding ruling and any later specifically named ruling; docs/cloud/handoff/node22-proxy/implementation.md, profile-plan.json, commands.sh, environment-manifest.json, checks-<profile>.log, startup-<profile>.stdout/.stderr, routing-<profile>.json/.log, negative-controls.md/.log, source-build-manifest.json, SHA256SUMS and review-1.md, with lossless numbered parts if necessary. STATE and engineering-plan section 1 receive factual status updates only. The implementer returns full report text and evidence locations, not independent shared-document edits.

## 5. Public help clarification

Replace only the ambiguous parenthetical in EXPORT_HELP with the approved explicit wording:

HUD failures emit one reason-code line on stderr and no JSON.
Node/runtime diagnostics may also appear on stderr; stdout remains the machine-readable channel.

Exit codes:

Keep the existing usage, options, privacy/read-only explanation, exit values and meanings otherwise unchanged. The line break between the two sentences is presentation only; their words are the preceding ruling’s approved clarification.

The real --help process must have exact EXPORT_HELP stdout and the independently expected runtime-only stderr, with no ledger access/create. Add a literal assertion for the approved sentences so a test that merely imports the same changed constant is not the only wording check. The in-process help result remains stderr empty. No changes to codex-hud --json, other CLI help strings, reason codes or output promises are authorized.

## 6. Exact diagnostic model, never output normalization

The helper constructs expected bytes from a declared runtime profile and known child launch metadata. It never strips, trims, replaces, reorders or filters bytes in captured stdout/stderr. Preserve raw buffers before decoding; the existing UTF-8 assertions may remain where they are already byte-equivalent for these synthetic strings.

Before HUD tests use a profile, run a minimal child that imports no HUD or SQLite and performs no network request. Use the same pinned Node binary and relevant proxy/warning startup settings. Assert its exit and full separate streams against an explicit source-backed expectation. Its PID/argv0 and binary identity are metadata, not permission to learn an arbitrary expected warning from the failing HUD child. Do not simply accept the probe’s stderr as a template without first validating it.

For the required Node 22.23.4 enabled profile, the exact warning body is:

EnvHttpProxyAgent is experimental, expect them to change at any time.

Its type is Warning and code UNDICI-EHPA. Construct the full Node warning line with the actual child PID, the known runtime release name and exact punctuation/newline, plus Node’s one-time trace-help line with the correct basename of that child’s argv0. The fixed primary source and the minimal probe must agree. An unknown warning, wrong code/text/PID, duplicate, extra prefix/suffix, missing required warning or unexpected trace presentation is failure, not an optional regex match.

Node v24.22.1’s bundled EnvHttpProxyAgent constructor no longer emits this warning, although startup still installs the environment proxy dispatcher. For its explicitly enabled profile, the minimal child therefore expects empty stderr; routing must independently prove enablement. This is a verified source difference, not permission to suppress Node 22’s warning or infer route failure from Node 24’s silence.

The no-envproxy control omits the activation variable, retains its HTTP(S)_PROXY/NO_PROXY values and does not introduce --use-env-proxy through argv or NODE_OPTIONS. Its minimal no-HUD child expects no startup proxy diagnostic. Absence of the warning does not establish equivalent routing.

Pin the required binary patches and record all warning-affecting settings. Positive acceptance profiles have no NODE_NO_WARNINGS, no warning-disable/redirect/preload/trace option and, matching the original required reproduction, no NODE_OPTIONS. Unexpected inherited settings are reported, not silently erased to obtain a pass. A deliberately different diagnostic configuration is separately labeled and cannot substitute. Do not introduce a product runtime floor or broad test skip for unexamined patches; a new patch/presentation needs its exact primary-source/profile expectation recorded before its result is credited. Pre-22.21 Node 22 retains existing support; the newer built-in-routing witness is feature-inapplicable there, not a passing route test.

For each launched export child, compare its entire raw stderr with the exact startup contribution plus the exact expected HUD application line, or the startup contribution alone on success/help. Where source timing could affect ordering, establish the exact supported order with the minimal fixture and actual launch path; do not fall back to unordered substring membership. Preserve in-process exact application assertions without inserting startup bytes.

Keep the fresh-process SQLite-negative test against raw stderr, explicitly detecting the exact initialization notice in addition to the full expected-stream comparison. Restoring that notice must fail. Preserve restoration of emitWarning after both failed and successful initialization and the unrelated SyntheticWarning cases, including text mentioning SQLite. The existing two successful load calls may emit two deliberate loader sentinels; model their actual fixed count and the one later unrelated sentinel, accounting for Node’s one trace-help line per process. Do not mistake the first warning’s hint for a hint repeated after every warning. No allowance for arbitrary SyntheticWarning text is created.

## 7. Separate process captures and deterministic separation proof

Give the two local fixtures separate 0600 output and error files/descriptors. Return both paths, close both descriptors and retain their raw contents in failure evidence before cleanup. Do not change production GroupProcess, process.ts, control.ts or the existing native test helper.

Keep the original stdout contract:

- run-process: exact JSON bytes for the original argv values and brief/EOF, including the original newline; preserve the semantic JSON assertion as well. Keep exit 7, signal null, real helper/workload/scope assertions, helper death and final scope proof.
- run-light-leader: exact Buffer equality with the original metacharacter-containing brief, EOF and the forbidden-file noncreation assertion. Preserve its existing completion semantics.

Have each target workload write one fixed synthetic stderr sentinel after its startup and stdin completion. Assert that sentinel’s exact bytes/count on stderr and its absence from stdout. This makes descriptor separation fail deterministically even when the runtime emits no startup warning. Do not manufacture silence by sending stderr to ignore or replacing the workload with a mock.

Account for the actual topology. run-process’s native=true path starts a Node test helper and then a Node workload; under the enabled Node 22 profile each contributes its own one-time warning and trace-help line, with distinct known helper/command PIDs. Its expected stderr therefore contains both contributions plus the single workload sentinel. The production shell-leader path in run-light-leader has no Node helper; its target case expects only the workload’s runtime contribution and sentinel. Do not apply a one-warning-per-test assumption to a multi-process fixture. The primary native helper and workload source were inspected, including the unchanged --max-semi-space-size=1 helper flag.

All later lifecycle assertions must actually execute in the new passing matrix. The old failed matrices cannot be retroactively credited with assertions after their original failure points.

## 8. Bounded synthetic routing witness

In node-proxy-profile.test.ts, use a controlled HTTP target and proxy bound only to loopback on ephemeral ports, with fixed synthetic requests/responses and no credentials. The proxy accepts/forwards only the exact owned target and bounded requests; reject other destinations. Use the built-in default fetch dispatcher, without an explicit custom dispatcher or per-request proxy override, so removing startup enablement changes the observation.

Run the same declared child program/environment both as a direct Node child and through production launchGroup. The latter supplies distinct stdout/stderr FDs and must preserve the exact synthetic proxy variables, stdin/argv and normal cleanup. Child output may report only predetermined synthetic environment values. Do not dump the parent/user environment.

Required cases on both launch paths and both pinned runtime families:

1. NODE_USE_ENV_PROXY=1, valid synthetic proxy, target absent from NO_PROXY: successful exact target response, the expected proxy hit/forwarding and matching target observation.
2. Same enabled environment with an explicit matching NO_PROXY entry: exact response, zero proxy hit for that request and a direct target observation.
3. A separately labeled disabled-opt-in control, retaining the same proxy values: direct target observation and zero proxy hit. Applying the enabled-route expectation to this result must fail.
4. Uppercase-only and lowercase-precedence coverage using distinct controlled synthetic values, proving the inherited native precedence is preserved rather than rewritten by HUD. Bound the case list in profile-plan.json before execution.

Record request identifiers, exact counts, child launch route, observed target/proxy outcomes, raw streams and exit status. Await request completion and close all owned sockets, servers, descriptors and children. Every child/request has a finite deadline; no retry-until-pass and no background server survives the test.

This intentionally synthetic child environment does not change live proxy settings or replace the owner-profile export/process matrix. It proves the specified HTTP/fetch route and NO_PROXY behavior. Preserve/check the other synthetic HTTP(S)/NO_PROXY variables’ transport, but do not claim untested HTTPS/TLS, external connectivity, real harness capability or every Node networking API passed. No TLS-verification weakening, trust-store change, new package or external endpoint is needed.

If loopback sockets or launchGroup are denied/unavailable, report the exact action/capability and mark the witness blocked. Do not bypass the restriction, retry an unchanged denied operation or convert the test to a skip counted as acceptance. Use only an already authorized capable host or the owner’s separate bounded test workflow. Assistant-run local testing remains withdrawn.

## 9. Required negative controls

Keep the candidate and historical evidence immutable. Put any temporary reverted build in a separate scratch copy with its own identity; never publish the negative mutation as product code. Each control must fail for the intended behavioral assertion, not a compile error, missing new export or setup failure.

- Rejoin the two capture descriptors in the isolated fixture: the stderr sentinel must make the exact stdout/separation assertion fail, with and without envproxy.
- Corrupt one stdout byte or its final newline: exact export/echo comparison fails even if JSON still parses.
- Change, duplicate or remove the expected HUD reason line, or alter the exit status: the refusal assertion fails; startup-warning acceptance cannot hide it.
- Add an unexpected warning/diagnostic before or after the permitted stream, duplicate UNDICI-EHPA, change its code/text/PID, or remove the required Node 22 startup warning: the strict matcher rejects. These matcher controls operate on explicitly labeled copies, not normalized actual evidence.
- Restore the old SQLite initialization behavior only in an isolated copy, retaining the final raw-stderr test: it fails for the SQLite notice. Preserve the unrelated-warning/emitWarning-restoration positive controls; broadened suppression or failure to restore must be detected.
- Remove NODE_USE_ENV_PROXY from the enabled routing child while retaining proxy addresses: the enabled proxy-hit assertion fails. Remove/change the intended NO_PROXY bypass or lose the launchGroup environment: the corresponding route/bypass/transport witness fails.
- Revert the two approved help sentences in an isolated control: the literal public-help assertion fails.

The old HYG2 enabled-profile eleven export and two process failures remain historical evidence of the original defects. Meaningful failing-before/reverted controls for the new assertions supplement that evidence. Security and lifecycle assertions that pass on both trees are regression controls, not newly fixed defects.

## 10. Execution profiles, commands and timeouts

These are future commands after admission; none ran in this consultation. Record profile-plan.json and the expanded isolation wrapper before tests. Required compatibility profiles are:

- node22-envproxy: Node 22.23.4, NODE_USE_ENV_PROXY=1 before launch, the declared HTTP(S)_PROXY/NO_PROXY policy, NODE_OPTIONS absent.
- node22-noenvproxy-control: the same binary and proxy values, only the activation opt-in omitted; no alternate enabling flag.
- node24-envproxy: Node 24.22.1 with explicit activation and the corresponding declared proxy policy. The owner’s earlier Node 24 HYG2 run occurred before the proxy-policy change and is not this comparison.

Run the focused compatibility checks for all three and obtain the complete README check set for the final dependent candidate under those recorded configurations. If the owner’s exact binary/settings are not available on the cloud executor, label the cloud comparison honestly and leave exact-profile evidence pending for the owner; do not claim equivalence from a different patch or disabled launcher.

Choose absolute runtime/npm paths before replacing HOME and put the selected Node directory first on PATH. Use fresh temporary HOME/HUD_HOME/TMPDIR, synthetic roots, and the existing removal of real harness/session selectors and color overrides. Preserve declared proxy routing and record relevant variable presence/meaning without printing proxy credentials, secret environment contents or personal paths. The dedicated routing fixture overrides only its own child’s declared synthetic proxy values. No test touches real ~/.hud, ~/.claude, ~/.codex* or ~/.pi.

Commands and outer limits:

- git rev-parse HEAD HEAD^{tree}; git status --short; git diff --name-status; source/dependency/generated-output manifests: 60 seconds each.
- npm ci --ignore-scripts only if the established dependencies are missing, using the unchanged lockfile and permitted dependency-network configuration: 900 seconds. Do not stage node_modules/.package-lock.json.
- npm run build; npm run build:test; npm run build:hud-mcp: 600 seconds each, separately recorded.
- node --test --test-concurrency=1 dist-test/tests/unit/node-proxy-profile.test.js: 300 seconds per profile. Internal individual child/request deadlines must be at most 10 seconds, with explicit bounded cleanup.
- node --test --test-concurrency=1 dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/run-process.test.js dist-test/tests/unit/run-light-leader.test.js: 600 seconds per profile.
- The same three-file command without --test-concurrency=1: 600 seconds per profile. A serialized diagnostic pass does not replace normal runner behavior.
- node --test dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/b45-launch.test.js dist-test/tests/unit/b12r-store.test.js dist-test/tests/unit/b12d-wal.test.js dist-test/tests/unit/b16-writer.test.js dist-test/tests/unit/process-client.test.js: 900 seconds per profile, preserving the HYG2 six-suite regression set.
- npm test: 1800 seconds per profile. If its unit stage prevents mjs execution, also run npm run test:mjs, 600 seconds, retaining npm test’s failing result.
- npm run test:core: 900 seconds; npm run test:visual: 600 seconds; npm run test:hud-mcp: 900 seconds, per profile.
- npm run format:check; npm run check:fixtures: 300 seconds each; git diff --check: 60 seconds. Source-format checks can be shared only when the exact unchanged tree is documented, not as a substitute for runtime results.
- Each declared negative-control command: 300 seconds, after its own identified build where required; label expected failures and exact assertion evidence.

Expected positive result is exit 0 with every specified assertion reached. A timeout, cancellation, missing capability, unreached stage or failed setup is failed/incomplete, not green. Run commands separately so an earlier failure cannot conceal later omissions. Only the README’s existing named flakes receive its one isolated rerun, preserving both results. Envproxy, EACCES, new routing and separation failures are not added to that list. A known denied test operation stays blocked until authorized capable execution exists; do not repeatedly exercise it unchanged.

No dedicated performance optimization or new benchmark is in scope. The only production delta is help text. Preserve all existing performance assertions/results; no new RUNZ1 scan-cost or NEXT diagnostic series is authorized by this brief. Local-only Herdr/tmux/logged-in-harness/probe/install tests and formal WSL performance qualification are not simulated.

## 11. Evidence and review deliverable

Record exact parent/candidate commit and tree, full changed-path list, source hashes for the six paths and frozen inherited production, lock/dependency identity, freshly generated artifact hashes, binary paths/versions, commands, UTC start/end, raw separate stdout/stderr and numeric exit/signal status. Embed identities in the new logs; do not rely solely on a later report header.

Keep a per-profile assertion/outcome inventory showing that all eleven former export cases and both process cases reached their remaining assertions. Preserve the original raw failing enabled matrix, owner no-envproxy matrix and prior Node 24 evidence under their original identities. Do not relabel them or overwrite historical summaries.

Include the minimal no-HUD diagnostic validation, exact expected-warning construction inputs, deterministic sentinels, route-hit/bypass observations and every negative-control result. For raw workload capture, retain each stream separately; a convenience combined human log is additional evidence only and never parsed as the stdout document.

Produce a SHA256 manifest and lossless evidence archive/parts before publication. Public repository material is synthetic or carefully sanitized; document any required redaction without deleting failure text, changing asserted bytes or exposing proxy credentials/real user data. Preserve raw private originals when publication requires redaction. A claim about exact bytes must be supported by the appropriate unmodified synthetic capture, not a redacted reconstruction.

The report states changed paths/APIs, exact help change, inherited HYG2 provenance, profile differences, passed/failed/blocked/unrun checks, negative-control failures, resource-window use and outstanding gates. No production API or environment policy change is expected. The dispatcher verifies the report against the frozen candidate and passes it with raw evidence to a fresh Oracle; the implementer does not decide acceptance.

## 12. Resource admission, stop conditions and integration

Read-only preparation and serialized documentary archival may proceed now. Source ownership is not compute permission. Do not materialize the worktree, install, compile, run children, open route sockets or benchmark while the active independent NEXT measurement lease remains held.

After explicit lease return or explicit dispatcher rescheduling, the dispatcher may assign bounded, non-overlapping windows among NEXT verification, P065, MCP-ANCESTOR, RUNZ1-KILL and this amendment. State the owner, executor, permitted phase/commands and return point. Return the window promptly after that phase and reschedule remaining checks; no package owns the executor through acceptance. This work need not wait for P065 acceptance, but P065’s release does not authorize it. An independent capable executor still needs a recorded assignment and existing access authority.

Hierarchy: one Astra-high implementer; fresh Astra-max Oracle for a design fork or the final exact-candidate review; dispatcher schedules, records, verifies and merges only by rule. This release permits one bounded submission and one fresh review. Further remedial submissions need a new explicit disposition rather than recycling HYG2’s consumed review allowance or reopening its already-fixed P2/runtime/helper work.

Stop affected work and report the exact action, target, reason and completed evidence for: a changed source base or unexpected writer; ownership expansion; a needed production/process/warning-filter change; unknown diagnostic presentation; altered profile or gate; denied sockets/process capability; privilege/security change; suppressed warning; lost stdout/application-error assertion; unsafe cleanup; required local-only work; or an attempt to combine unaccepted packages. Preserve candidate and failures while independent authorized work continues.

Acceptance requires the exact scoped implementation/help text, strict diagnostic and routing evidence, meaningful failing-before/negative controls, preserved HYG2 guarantees, the required complete green check sets, and a fresh Oracle accept verdict for the exact dependent candidate with HYG2’s remaining blockers resolved. An amendment-only correctness finding does not accept inherited HYG2 production or authorize a merge.

MCP-ANCESTOR’s real unreadable-ancestor evidence and acceptance remain separate. P065’s budget work and the unresolved startup ledger-registry lock-held process/content reads remain separate. RUNZ1-KILL’s cancellation evidence and NEXT/PERF’s performance gates remain with their assigned work. No package is accepted by this brief, and DOC2/TPD1 and later waves retain their existing prerequisites.

If standalone or prospective integration checks need another repair, request a separate precise integration disposition. Do not cherry-pick unaccepted fixes or fabricate a green aggregate. Only after the appropriate package acceptance may the sole active merger prepare --no-ff into universal-hud. The full README set must be green on the actual merged tree under its recorded required profiles before pushing or marking merged. Never touch main, force-push, rewrite history or stage dependency state.

Final status: bounded dependent design and exclusive ownership defined; archival/handoff and explicit resource admission required before execution; verification, HYG2/NODE22 acceptance and merge HOLD.

## Sources

- Governing ruling: https://github.com/CartmanFatass/codex-hud/blob/3ac3019572f0341081bcff89485fec8cb41f16ba/docs/cloud/rulings/node22-proxy-profile.md
- HYG2 local review and fixed provenance: https://github.com/CartmanFatass/codex-hud/blob/ce5e6961a0e6de1304dcebb00fc1b8c805573ec6/docs/cloud/handoff/hyg2-local-review-20261103.md
- HYG2 warning/ownership ruling: https://github.com/CartmanFatass/codex-hud/blob/ce5e6961a0e6de1304dcebb00fc1b8c805573ec6/docs/cloud/rulings/hyg2.md
- Owner evidence: https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/REPORT.md
- Exact export regression: https://github.com/CartmanFatass/codex-hud/blob/ce5e6961a0e6de1304dcebb00fc1b8c805573ec6/tests/unit/hud-link-export.test.ts
- Exact process fixtures: https://github.com/CartmanFatass/codex-hud/blob/ce5e6961a0e6de1304dcebb00fc1b8c805573ec6/tests/unit/run-process.test.ts and https://github.com/CartmanFatass/codex-hud/blob/ce5e6961a0e6de1304dcebb00fc1b8c805573ec6/tests/unit/run-light-leader.test.ts
- Native helper topology: https://github.com/CartmanFatass/codex-hud/blob/ce5e6961a0e6de1304dcebb00fc1b8c805573ec6/tests/run/native-group.ts and https://github.com/CartmanFatass/codex-hud/blob/ce5e6961a0e6de1304dcebb00fc1b8c805573ec6/tests/run/group-helper.ts
- Contract 04 and 07: https://github.com/CartmanFatass/codex-hud/blob/3ac3019572f0341081bcff89485fec8cb41f16ba/docs/contracts/04-supervision.md and https://github.com/CartmanFatass/codex-hud/blob/3ac3019572f0341081bcff89485fec8cb41f16ba/docs/contracts/07-outbound-compat.md
- Node 22 option/startup: https://github.com/nodejs/node/blob/v22.23.4/doc/api/cli.md#node_use_env_proxy1 and https://github.com/nodejs/node/blob/v22.23.4/lib/internal/process/pre_execution.js
- Node 22 exact diagnostic and formatting: https://github.com/nodejs/node/blob/v22.23.4/deps/undici/src/lib/dispatcher/env-http-proxy-agent.js and https://github.com/nodejs/node/blob/v22.23.4/lib/internal/process/warning.js
- Node 24 source difference: https://github.com/nodejs/node/blob/v24.22.1/deps/undici/src/lib/dispatcher/env-http-proxy-agent.js and https://github.com/nodejs/node/blob/v24.22.1/lib/internal/process/pre_execution.js
- Ownership/resource records: https://github.com/CartmanFatass/codex-hud/blob/3ac3019572f0341081bcff89485fec8cb41f16ba/docs/cloud/P065-BUDGET.md and https://github.com/CartmanFatass/codex-hud/blob/3ac3019572f0341081bcff89485fec8cb41f16ba/docs/cloud/MCP-ANCESTOR.md and https://github.com/CartmanFatass/codex-hud/blob/3ac3019572f0341081bcff89485fec8cb41f16ba/docs/cloud/B10B-S3F-NEXT.md

End of brief.