# Brief MCP-ANCESTOR: fail-closed optional ancestor discovery

Date: 2026-11-03. Tier S, one bounded shared wave-1 verification repair.

**Design and scope released; execution awaits a free dispatcher-assigned resource window. Acceptance and merge remain held.** Binding design ruling: docs/cloud/rulings/mcp-ancestor-gate-20261103.md. This brief does not authorize a later queue wave, local assistant-run testing, a gate/profile change or privilege expansion.

## 1. Base and binding inputs

Create a distinct worktree and branch dots/mcp-ancestor from pinned universal-hud commit 26f6fba36948e6c96e2e109cb374c0d4dbb9ab22. This is the existing integration lineage with documented baseline failures, not a claim that its current full check set is already green. No unaccepted HYG2, RUNZ1, B10B-NEXT, P065 or B10D code may be imported into this branch to conceal a prerequisite. Later documentation-only archival commits do not change the inspected source; any later production/test changes require rechecking this brief and ownership before selecting a newer base.

Read:

- AGENTS.md; docs/handoff/STATE.md; docs/cloud/dots.md; docs/cloud/README.md; engineering-plan §3 complete-brief requirements; docs/ARCHITECTURE.md §8; concept §15.
- Contract 01 CallerId/ProcessKey/SourceId separation, current-source and PID-domain rules, I-01-2/10/12 and T-01-6/27/28/33/35/36. Preserve the existing contracts 02–07 and capability boundaries.
- The MCP-ANCESTOR ruling, P065-BUDGET ownership and metadata-exception §6, and B10B-S3F-NEXT ownership/resource rules.
- packages/hud-mcp/src/process.ts, registry.ts, ledger-registry.ts, resolvers.ts, main.ts, lifetime.ts and README.md; tests/hud-mcp/skeleton.test.ts, int-ledger-registry.test.ts, authorization.test.ts, hook-source.test.ts and benchmark.mjs.
- Owner evidence at local-verification/20261103 commit 9be7246c25b5355845e639116c57150ff79d3117, particularly REPORT.md §§2.4 and 5, the HYG2 raw hud-mcp failure and Node 22 proxy-policy matrices; the archived HYG2 local Oracle review.

The inspected production discovery and registration files are unchanged from f1e2a84. This is a baseline cross-package blocker, not a new HYG2/RUNZ1/NEXT regression.

## 2. Goal and exact behavior

Permit physical CallerId registration when its mandatory self/actual-parent/cwd/PID-domain checks succeed but optional ancestor discovery encounters access denial. Preserve fail-closed logical identity.

The only selected production mechanism is a narrow error boundary around reader.get in findHarness:

1. On OS errno EACCES or EPERM from that optional ancestor read, return null immediately. Null means no usable harness evidence; it does not prove there is no harness.
2. Do not read any later ancestor after that denial. Do not retain a partial ProcessInfo, fabricate env, or continue using a remembered/previous harness.
3. Preserve existing behavior for all other errors and Refusals, including malformed/changed identity evidence. Do not use message-string matching or a blanket catch.
4. Preserve the eight-ancestor bound, PID > 1 termination and self-parent-cycle behavior. No retries, scans, polling, PID guessing, fallback process discovery or caches.
5. Keep LinuxProcessReader.get strict and unchanged. Mandatory calls from registerCaller, LedgerCallerRegistry and per-call stamp checks are not made best-effort. Their denial, source mismatch, namespace mismatch, unavailable domain, changed stamps or cwd failure still prevents the corresponding registration/authorization.
6. Keep ProcessReaderPort and the findHarness result shape unchanged. inferHarness and actualSourceRoot are unchanged. Existing read byte caps, environment allowlist and process-stamp checks are unchanged.
7. If discovery returns null, registration retains null harness/source fields and null harness PID/start rather than producing source/SessionRef/OwnerKey evidence. Tools/list and physical diagnostic registration can work, but subsequent tools/call without source remains refused. No scope/context/alias/claim/binding/report/run/operation is authorized by this fallback.
8. A readable nearest genuine harness still follows the existing positive path. Later permission loss or missing/currently inconsistent evidence never falls back to the last successful identity.

No contract, runtime support, output promise, schema, exported tool shape, capability cell, performance number or security boundary changes.

## 3. Complete file ownership

Production, exactly one file:

- packages/hud-mcp/src/process.ts: only findHarness's access-denial boundary and an in-file private errno predicate/comment if necessary. Do not refactor LinuxProcessReader, ProcessReaderPort, inferHarness or actualSourceRoot.

Tests:

- New tests/hud-mcp/ancestor-discovery.test.ts: deterministic synthetic ProcessReaderPort faults and bounded traversal/registration/resolver assertions.
- tests/hud-mcp/skeleton.test.ts: additive genuine-harness/current-source security regressions only, if they fit existing fixtures better than the new file.
- tests/hud-mcp/int-ledger-registry.test.ts: additive assertions or isolated regression cases for physical registration without logical authority. Preserve the existing real-process registration test and its production reader; do not replace it with a mock, force a convenient ancestry or weaken any assertion.

Keep fixtures local to those test files. Existing hud-mcp build/test globs already include the new file; no package or compiler configuration change is needed.

Dispatcher-owned records only:

- docs/cloud/MCP-ANCESTOR.md.
- docs/cloud/rulings/mcp-ancestor-gate-20261103.md and any necessary later specifically named scoped ruling.
- docs/cloud/handoff/mcp-ancestor/implementation.md, checks-node22.log, checks-node24.log, negative-controls.log, root-ancestor-evidence.md, environment-manifest.json, performance-summary.json, review-1.md and numbered lossless evidence parts if needed.
- STATE and the engineering-plan §1 factual status, serialized with every other documentation writer.

The implementer returns full report text and raw evidence locations. It does not independently edit shared records or historical reports. Generated build output, dependency state and temporary files are not committed.

All other paths are read-only. In particular: registry.ts, ledger-registry.ts, resolvers.ts, io.ts, errors.ts, main.ts, lifetime.ts, P065-owned files, core/run, ledger/runtime, HYG2 helpers, B10B rendering/tests, benchmark sources, scripts, capability manifests, package/lock files, contracts and visual baselines. Stop for a new Oracle ownership/design revision if the solution requires any excluded path.

## 4. Required deterministic regressions

Use synthetic values and trusted test-only readers. Assert behavior, calls/read counts and state, not only lack of an exception.

1. A valid physical self and actual parent with a deeper unrelated ancestor returning EACCES: physical registration succeeds; exact self/parent start and cwd survive; harness/source/harness PID/start remain null; no logical-authority tables or backend operations are created. Repeat for EPERM. Label these as simulated access-denial faults, not real root-owned-process evidence.
2. Put a readable harness above the denied ancestor in the synthetic map. Assert that PID is never read and never selected. No traversal resumes past the denied boundary.
3. With a configured matching profile, make the candidate harness itself unreadable. The same absence of source authority must hold; neither the profile root nor the MCP's HOME/CODEX_HOME rescues it. If it is also the mandatory actual parent and its strict read fails, registration must still fail without a write.
4. Make self and actual-parent mandatory reads fail separately with EACCES/EPERM, including a denial during final registration revalidation. Assert refusal and zero registry write. Preserve changed procStart, PID-namespace/domain and unavailable-cwd guards, and the forged caller/cwd ledger-registry rejection tests.
5. Non-permission errors and explicit registration_unverified/identity_unverified Refusals from optional reads are not silently converted to a successful discovery. Assert the same error/refusal behavior rather than only an arbitrary rejection.
6. No-harness normal ancestry, nearest readable genuine harness, maximum depth, PID 1 and self-parent termination retain their present results and bounds. No new unbounded traversal or retry.
7. Valid readable Codex root metadata + exact source/header/process evidence still resolves through the existing tested combination. Native-child metadata, forged arguments._meta, missing/currently conflicting metadata, PID reuse, source mismatch, unsupported/shared-daemon forms and unmeasured versions remain refused. Existing Claude hook root/native-child protections remain unchanged and are rerun.
8. Register a valid readable source, then deny an optional discovery read during a later resolver call. The call must refuse, not reuse remembered identity, and not touch scopes/contexts/claims/aliases or dispatch. Retain a subsequent independently valid root-call control where applicable so the change cannot be an always-refuse implementation.
9. The unconfigured real MCP composition still answers initialize/tools/list, and delegate_whoami remains identity_source_missing. Stdout remains JSON-RPC only. No stdout/stderr normalization is added.

For the new access-denial behavior, run the same meaningful tests on the pinned baseline or a narrowly reverted behavior. The baseline must fail at the old propagation/registration assertion, not at compilation, a missing export or a fabricated test-only branch. Security guards may pass on both trees and must be labeled regression controls, not claimed as newly fixed bugs.

## 5. Real root-owned ancestor evidence

The owner's existing report establishes the failure but its Relay/UID attribution lacks a separate contemporaneous raw snapshot. The completed evidence must distinguish those facts.

On an already authorized capable Linux/WSL host with the naturally occurring root-owned/unreadable ancestor, rerun the unchanged real physical-registration integration on the exact candidate. Record the tested SHA/tree, runtime, UID/eUID, bounded PID/PPID/start/UID ancestry facts, the relevant denial code, command, unfiltered stdout/stderr and exit code. Collect only nonsecret metadata that is already readable. Never print environment contents, real session data or unsanitized personal paths. A root-owned row is not itself proof that access was denied; record the observed denial separately.

No sudo, su, capabilities, ptrace, changed dumpability/procfs/security policy, chmod/chown, alternate privileged helper, forced reparenting or denied-read bypass. Do not select a different parent merely to hide the failure. Do not touch another process or change the owner's environment. Synthetic permission faults are mandatory portable tests, but they cannot be relabeled this host evidence.

Assistant-run local testing remains withdrawn. The owner may run this bounded procedure in their existing local verification workflow. Until valid real evidence exists, mark this portion pending, keep the package unaccepted, and continue allowed cloud work. If the original topology no longer exists, report that exact limitation instead of manufacturing or claiming a reproduction.

## 6. Commands, isolation and timeouts

These are future execution instructions after resource admission; none ran during this consultation. Select the runtime binary before replacing HOME. Run separately on an available Node 22 >=22.13 and Node 24, with exact patch/binary identity, synthetic source roots and fresh temporary HOME/HUD_HOME/TMPDIR per command. Retain the effective proxy/warning policy explicitly. Do not introduce no-warnings flags or silently strip NODE_USE_ENV_PROXY. Existing owner-requested no-envproxy measurements are separately labeled evidence, not a new blanket profile waiver. Preserve required network/proxy policy for dependency access.

Remove inherited real harness/session/HERDR selectors and NO_COLOR/FORCE_COLOR as the existing isolation instructions require, without logging secrets. Own and clean only exact child PIDs and temporary resources created by the command. A timeout, child failure, denied operation or omitted command is failed/incomplete evidence, not a pass.

Per-command outer limits:

- npm ci, only if dependencies are missing: 900 seconds. Do not stage node_modules/.package-lock.json.
- npm run build: 600 seconds.
- npm run build:test: 600 seconds.
- npm run build:hud-mcp: 600 seconds.
- node --test packages/hud-mcp/dist/tests/hud-mcp/ancestor-discovery.test.js packages/hud-mcp/dist/tests/hud-mcp/skeleton.test.js packages/hud-mcp/dist/tests/hud-mcp/int-ledger-registry.test.js: 300 seconds.
- npm test: 1800 seconds. If the unit stage aborts before mjs, additionally run npm run test:mjs with 600 seconds and retain both results; that supplement does not change npm test's failing exit.
- npm run test:core: 900 seconds.
- npm run test:visual: 600 seconds.
- npm run test:hud-mcp: 900 seconds. This includes authorization and hook-source security regressions.
- npm run format:check: 300 seconds.
- node node_modules/prettier/bin/prettier.cjs --check packages/hud-mcp/src/process.ts tests/hud-mcp/ancestor-discovery.test.ts tests/hud-mcp/skeleton.test.ts tests/hud-mcp/int-ledger-registry.test.ts: 300 seconds, because the root format command does not cover packages.
- npm run check:fixtures: 300 seconds.
- git diff --check: 60 seconds.
- The meaningful baseline/reverted focused negative control: 300 seconds after its own unchanged build. Preserve its expected failing assertions and exit.
- Existing node tests/hud-mcp/benchmark.mjs: 600 seconds per run, three isolated matched baseline/candidate runs per runtime if the existing host permits it, with no concurrent workload. Keep the driver unchanged and report its actual 30 cold samples and 200 calls per method, reported p95/max and all exits. Do not invent unavailable percentiles or relabel it full B14/P-06 qualification. Unavailable/failed startup samples remain failures, not faster results. No new numerical gate is introduced; the script's gates and existing contracts remain unchanged.

Each command's expectation is exit 0 and preservation of the assertions described above, except explicitly labeled negative controls. Apply only the README's existing single isolated rerun for a genuinely listed known flake, retaining original and rerun logs. EACCES/EPERM registration and envproxy warning failures are not added to that list. A raw stdio/diagnostic issue in the existing benchmark requires reporting, not editing the benchmark or hiding output.

Keep raw command wrappers, source/build/dependency identities, timestamps, unfiltered output and exit codes under a distinct MCP-ANCESTOR evidence directory. Produce a SHA256 manifest before publication. Repository evidence is synthetic/sanitized; log redaction must be described and must not erase failure text or change test results.

## 7. Workflow, resource scheduling and stop conditions

Hierarchy: dispatcher schedules and records; one Astra-high implementer owns this brief; a fresh Astra-max Oracle handles a design fork or final review; fixes return unchanged to the same implementer, then a fresh re-check. At most two fix rounds for this new package. No Oracle starts subagents or edits source. The dispatcher does not make acceptance/design judgments.

The four source/test reservations are disjoint from the current P065 and NEXT reservations. This is not permission to consume the same executor concurrently. NEXT's current explicit lease remains first. Once it returns the lease, the dispatcher assigns bounded, non-overlapping windows for P065 and MCP-ANCESTOR, with explicit return/rescheduling between windows. P065 source ownership is not a lease through acceptance. MCP-ANCESTOR need not wait for P065 acceptance, and no package imports the other's unaccepted code. Separately scheduled independent authorized executors do not waive access restrictions or evidence requirements.

Stop the affected work and report the exact blocker for: ownership expansion, a changed base, denied capability, required privilege/security change, proposed new error fallback, mandatory evidence relaxation, proxy/output-profile change, skipped check, new warning suppression, local-only task, unexpected shared writer or a need to modify ledger-registry/resolvers. Preserve the candidate and failed evidence. Do not hide an unresolved baseline failure in a broader patch.

The startup ledger-registry lock-held process/content reads remain a separate unresolved issue. This package neither fixes nor approves them. P065's narrow metadata exception remains narrow, and all per-call budgets/current-source requirements stay intact.

## 8. Acceptance and integration

Acceptance requires:

1. The exact bounded implementation and meaningful failing-before regression evidence.
2. All genuine-harness and mandatory-physical-evidence protections, including unchanged shared ledger assertions.
3. The real unreadable/root-owned-ancestor evidence described above, honestly labeled and without privilege changes.
4. A complete green README check set on the exact candidate for the recorded intended runtime/configuration, all required focused results, and retained failures. The separate Node 22 envproxy compatibility question must be explicitly dispositioned before its failures can be closed; this brief does not waive it.
5. A fresh Oracle verification of diff, report, raw evidence, ownership and verdict accept.

Only then may the sole active merger use --no-ff into universal-hud and run the full check set on the actual merged tree. Push/update STATE and plan only after that merged-tree gate is green under the existing permitted flake rule. No main changes, force push, history rewrite, dependency-state staging or unaccepted-feature integration.

If another baseline defect prevents the standalone or merged-tree green gate, hold acceptance/integration and seek a separate exact integration disposition rather than combining unaccepted branches ad hoc. A focused pass does not accept HYG2, RUNZ1, B10B or P065. Those packages retain their own reviewers and final-code gates. DOC2/TPD1 and all later waves retain their existing prerequisites.

Final status of this brief: the bounded design/ownership is ready; execution is queued for an explicitly assigned free window; no code, test, performance pass, package acceptance, capability promotion or merge is claimed.