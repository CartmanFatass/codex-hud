# NODE22-PROXY initial bounded submission

Date: 2026-11-03. Status: scoped candidate frozen and published, NOT ACCEPTED and NOT MERGEABLE. W2 execution lease returned to dispatcher at 18:47 UTC. No further execution without a new assigned window.

## Identity and inherited provenance

Repository: CartmanFatass/codex-hud.
Branch: dots/node22-proxy.
Candidate commit: b4047320262f72f401a513db07236ff1473db933.
Candidate tree: d9be29f28da496a880802c267a08e8bb4fcbee74.
Exact parent: ce5e6961a0e6de1304dcebb00fc1b8c805573ec6, tree 455e5cb8fce558bcb0a0f014e0e192a637b7dd2f.
URL: https://github.com/CartmanFatass/codex-hud/commit/b4047320262f72f401a513db07236ff1473db933
Worktree: /workspace/shared/node22-proxy. Final worktree status is clean.

The remote branch and reserved worktree were unoccupied at admission. GitHub connector created the exact six-file tree/commit/branch, then fetch_commit(dots/node22-proxy) confirmed the exact SHA. The connector comparison is ahead by one, behind by zero, with exactly the six reserved paths. The local branch fast-forwarded to the connector-published commit after all six blob hashes matched. No main, universal-hud, dots/hyg2 or unrelated source branch was changed; no force push, rewritten history or dependency-state staging occurred.

This is explicitly the HYG2-dependent candidate, not accepted integration code. The inherited HYG2 runtime/B45/ProcessClient/P2 implementation is unchanged. Complete inherited diff f1e2a8408fbc6ddef181978e8a2d9fd5831242e9..ce5e6961 is retained separately as inherited-hyg2.patch and inherited-hyg2-paths.txt. No unaccepted MCP-ANCESTOR, RUNZ1, NEXT or P065 production was imported. Historical owner enabled/no-opt-in matrices and HYG2 red findings retain their original identities and are not overwritten or waived.

## Changed paths and behavior

Exactly six paths:
1. src/cli/link-export.ts, EXPORT_HELP wording only.
2. tests/unit/hud-link-export.test.ts, exact raw child diagnostic expectations, launched help and literal wording assertions, retained/strengthened SQLite negative and fixed-count unrelated-warning restoration checks.
3. tests/unit/run-process.test.ts, local fixture separate 0600 descriptors/capture cleanup and exact argv/stdin/EOF stdout plus deterministic stderr sentinel.
4. tests/unit/run-light-leader.test.ts, corresponding local fixture separation and exact brief/EOF target assertions.
5. tests/unit/node-proxy-profile.test.ts, closed diagnostic controls and bounded synthetic HTTP/fetch routing witnesses.
6. tests/int/node-startup-diagnostics.ts, test-only declared profile validation, minimal no-HUD/no-SQLite/no-network probe, source-derived expected bytes, strict Buffer assertions and optional lossless evidence captures.

The only production change is the exact approved text:
HUD failures emit one reason-code line on stderr and no JSON.
Node/runtime diagnostics may also appear on stderr; stdout remains the machine-readable channel.

Exit codes:

All other help wording, exit values, implementation, runtime predicate, product environment policy, serializers, launchers, process topology, deadlines, capability/performance gates and dependencies remain unchanged. No warning filtering or suppression was added. In-process HudIO assertions remain application-only with empty runtime contribution.

The helper derives the entire Node 22 UNDICI-EHPA stream from pinned runtime version, known child PID/release/argv0, exact warning text and one trace-help line; it never learns an arbitrary HUD-child stderr template or normalizes captured bytes. Before HUD children, the minimal no-HUD process must match that source-backed expectation. Node24 expects no startup diagnostic and independently proves routing. Unknown profiles/settings fail validation, not a product-runtime skip/floor. Relevant primary sources are nodejs/node v22.23.4 lib/internal/process/pre_execution.js and warning.js and bundled env-http-proxy-agent.js, plus the v24.22.1 bundled agent. The Node22 source explicitly uses one trace hint per process. The two loader sentinels plus one later unrelated sentinel are compared exactly.

Both process targets keep their original payload bytes and lifecycle assertions. The native helper target compares helper warning then workload warning then one sentinel, using distinct known PIDs; it still checks exit 7, null signal, real helper/workload/scope, helper death and final scope proof. The production shell-leader target expects one Node workload contribution plus sentinel, and still checks exact metacharacter brief/EOF and forbidden-file noncreation. Raw separate captures survive fixture cleanup in evidence.

Routing uses only loopback HTTP target/proxies and the built-in default fetch dispatcher. Each child has finite deadlines, each proxy forwards only its exact owned target/singleton request, and sockets/servers/descriptors/children are explicitly closed. Seven predeclared cases execute on each of direct Node and production launchGroup: uppercase proxy, uppercase bypass, uppercase disabled control, lowercase precedence proxy, lowercase bypass, lowercase disabled control and lost-environment negative control. Exact response/stdin/argv/proxy-variable transport, proxy hit counts and target connection provenance are asserted. HTTPS variables are transported and checked but TLS/HTTPS routing is NOT claimed. No credentials, real proxy values, external request, TLS weakening or live-home access was used.

## Runtime and execution profile

Cloud host: Linux 6.18.57 x86_64 GNU/Linux.
Node22 binary: /workspace/shared/b10b-next-runtime22/package/bin/node, 22.23.4.
Node24 binary: /opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node, 24.22.1.
Binary SHA256 identities are in environment-manifest.json.
Profiles: node22-envproxy (NODE_USE_ENV_PROXY=1), node22-noenvproxy-control (activation omitted only), node24-envproxy (activation=1). Inherited cloud HTTP(S)_PROXY/NO_PROXY and lowercase equivalents are preserved outside the explicitly synthetic routing children. NODE_OPTIONS/NODE_NO_WARNINGS/NODE_REDIRECT_WARNINGS are absent. Environment metadata records presence rather than secret proxy values. These are cloud comparisons, not a claim to reproduce the owner’s exact host or proxy addresses.

Commands select absolute Node before fresh temporary HOME/HUD_HOME/TMPDIR and remove harness/session/color selectors. commands.sh contains the expanded wrapper and exact outer timeouts; each command has UTC start/end, numeric exit, separate stdout/stderr and source/build reconciliation metadata. No builds/tests/benchmarks overlapped. No local-only work or new performance series ran.

## Positive outcomes on the final unchanged candidate

For EACH of the three profiles:
- Serialized export plus two target-process subset: 15 tests, 15 pass, 0 fail/cancel/skip, exit 0.
- The same subset under normal runner concurrency: 15 tests, 15 pass, 0 fail/cancel/skip, exit 0.
- Complete new node-proxy-profile suite: 5 tests, 5 pass, 0 fail/cancel/skip, exit 0. Its route test executes fourteen real children (seven cases × two launch paths); diagnostics record every request, count, route and status. This includes validated no-HUD probes and all closed matcher controls.
- Original HYG2 six-suite command: 76 tests, 76 pass, 0 fail/cancel/skip, exit 0.

The 15-test subset includes all eleven formerly failing export cases plus the retained in-process byte-for-byte producer case and warning-restoration case, and both former process-capture failures. Every remaining assertion in those selected cases executes; this is not inferred from old stopped failures.

Node24 build, build:test and build:hud-mcp each exit 0. The identical generated artifacts are used across focused runtimes, with source/generated hashes. Node24 format:check, check:fixtures and git diff --check each exit 0. Node22 build attribution and complete README matrices remain pending the later sweep rather than implied by those Node24 build results.

Exact filtered command:
node --test [--test-concurrency=1] --test-name-pattern='^(hud |ledger initialization|one-shot group launch preserves argv|light leader preserves exact brief)' dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/run-process.test.js dist-test/tests/unit/run-light-leader.test.js

Exact full new suite:
node --test --test-concurrency=1 dist-test/tests/unit/node-proxy-profile.test.js

Exact HYG2 command:
node --test dist-test/tests/unit/hud-link-export.test.js dist-test/tests/unit/b45-launch.test.js dist-test/tests/unit/b12r-store.test.js dist-test/tests/unit/b12d-wal.test.js dist-test/tests/unit/b16-writer.test.js dist-test/tests/unit/process-client.test.js

## Negative controls and retained pre-submission failures

Separate generated-JavaScript scratch copies under /workspace/shared/node22-proxy-negative carry MUTATION.json before/after artifact hashes; the successful candidate source/build remains untouched. Mutations execute as JavaScript, not compiler failures. The report does not misdescribe these as independently rebuilt source copies.

- Rejoined capture descriptors: both target tests fail exact stdout Buffer equality with envproxy and without envproxy, command exit 1 in each profile. The disabled case fails deterministically on the stderr sentinel.
- Restored SQLite initialization warning: completed-fixture control exits 1 at the explicit SQLite-notice negative assertion, while raw stderr retains both UNDICI-EHPA and SQLite notice.
- Broad warning suppression: exits 1 at exact stderr comparison because the loader warning sentinels disappear.
- Omitted emitWarning restoration: exits 1 with the child reference-equality assertion after failed initialization.
- Reverted approved help wording: exits 1 at the literal public-help assertion.
- Closed matcher controls assert rejection of missing/duplicated/unknown warnings, wrong code/text/PID/hint/prefix/suffix/newline, altered/missing/duplicated application reason or exit status, and parseable JSON byte/newline corruption.
- Real disabled route children retain proxy addresses and reject the enabled-hit expectation; non-bypass children reject the bypass expectation; lost-environment children reject exact declared transport bytes. All assertions run in both launch paths on both pinned runtime families.

Preserved failures, NOT credited as desired behavioral failures:
1. First formatting attempt exited 1, Cannot find module /workspace/shared/node22-proxy/node_modules/prettier/bin/prettier.cjs. The base contains tracked dependencies without prettier; an initial directory copy nested the established dependencies. The existing prettier directory was then copied into the correct ignored dependency location. Package-lock SHA256 matches the established dependency tree, and no dependency source/lock was staged. Final format check passes.
2. Initial Node24 guard wrongly inspected the test runner parent’s normalized execArgv, which contains --use-env-proxy when enabled through the environment. Initial focused run failed its before hook (15 failures), and initial model suite had 3 pass/1 fail. Evidence retained. The helper now validates actual child launch flags, which are explicitly supplied, rather than unrelated normalized parent flags. Fresh rebuild and all final Node24 groups pass. No runtime warning or flag was suppressed or changed.
3. First SQLite reverted control failed setup on missing tests/ledger/fixtures.mjs. The original log remains, uncredited. Adding that unchanged fixture to the isolated control produced the intended SQLite-notice assertion failure under a separately labeled completed-fixture result.

## Evidence and integrity

Evidence directory: /workspace/shared/node22-proxy-evidence.
Lossless archive created before source publication: /workspace/shared/node22-proxy-evidence-20261103.tar.gz.
Archive SHA256: bf22a3540b29458741609aa8e811917ec4ff48774f3df1a662e0d085727d45fc.
Archive SHA sidecar: /workspace/shared/node22-proxy-evidence-20261103.tar.gz.sha256.
SHA256SUMS covers 1,588 evidence files; its SHA256 is 0f78caf0c81c9b9e396921c75ebbab5d3894a148ddb2708ebb6970078136b99d.
Final source/build manifest SHA256: 7725258b6debf2bd198290c400dcb455069253dafd705bd373ccc72cbb6ab7cb.

Included: profile-plan.json, commands.sh, environment-manifest.json, initial and final source/build manifests, all raw stdout/stderr and status metadata, separate child captures, route diagnostics, model and behavioral-negative logs/scripts/mutation hashes, six final source files, inherited HYG2 diff/provenance, initial failures, negative-controls.md and remaining-checks.md. Raw streams are unmodified; combined .log files are convenience only. A secret/credential/real-home pattern scan of relevant captures/manifests/patches found no matches. No redaction was necessary. The post-publication commit/tree mapping in this report binds the archived six blob-identical files to the remote commit.

Published blob identities: link-export c7a05e752c166a29564db41385cf022365d83f0b; hud-link-export test 5c2d0b2f0e698791ebc249fdca6af2774aeec317; run-process test e95e606c912919f7770e053670ef5600147024f6; run-light-leader test dcff130926e1e88ada11b7a73d5de5869345cea4; node-proxy-profile test 134a43985ab7fdbda12a6239517f9c7d3203de01; startup helper e1feac9598d0c3e3abfd19084b9274920a008699. Every local hash matched the connector-created blob.

## Outstanding gates and exact blockers

The unfiltered three-file commands were NOT run. This same cloud executor already has established ptrace EPERM and absent CONFIG_PROC_CHILDREN affecting existing run-process/run-light-leader scenarios; repeating known denied operations unchanged was prohibited. The name-selected subset is supplementary evidence, never relabeled an unfiltered-suite pass.

Full per-profile README sets remain for separately assigned verification-sweep windows: npm test (and separate mjs if required), test:core, test:visual, test:hud-mcp and all required per-profile build/check attribution. Known AF_UNIX/ptrace-denied cells remain blocked pending authorized capable execution, not skipped acceptance. The older ancestor-registration gate is inherited and separate; no ad hoc WIP integration was made to get green.

The exact owner-host enabled profile remains owner-capable evidence if the final review requires it; no assistant-run local testing is resumed. No TLS/external-connectivity, formal WSL performance or real harness capability is claimed.

Fresh final Oracle review must consider this exact compatibility delta AND inherited HYG2 findings/guarantees. W2 completion does not accept HYG2, close its full-green gate, authorize another fix submission, release later waves or permit merge. Further remedial submissions require the prescribed new disposition. The dispatcher retains sole scheduling/acceptance/integration authority.

End of report.