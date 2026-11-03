# P065-BUDGET: six frozen-candidate design dispositions

Date: 2026-11-03. Fresh read-only design Oracle. This is a design ruling, not implementation acceptance or performance qualification.

## Decision

1. Approve the internal durable-result marker for the three inspected eligibility paths, with the provenance, successful-return and cleanup conditions below. Its SQL change counter is a conservative guard, not independent proof of durability.
2. Approve the proposed configurable-capacity synthetic H/R workload, precisely labeled as a cloud workload surrogate. Use independently authorized callers and real ledger writer APIs; disclose foreground additions to the baseline active-run population.
3. Charge the current cold CLI lazy imports to the original resume budget. Genuine process/module startup may be reported separately only when it actually precedes request handling and contains no displaced per-request preparation.
4. Explicitly separate operational numerical qualification from predeclared, deliberately forced-overrun safety controls. Every overrun remains a failed numerical sample. This section deliberately amends qualification composition, not a threshold or a production timing boundary; it requires the serialized documentary amendments below before implementation relies on it.
5. Preserve the exact historical AF_UNIX-listen and PTRACE_TRACEME blocks. They do not ban every test or every child process. The aggregates that invoke those operations remain blocked without materially new, relevant executor/permission evidence; do not retry them automatically.
6. Preserve status/wait's existing read-only timing behavior. P065 does not add a new 30 ms source/read-authorization refusal to either tool. Remove the candidate's newly introduced enforcement on those paths while retaining all source checks and original full-response/client-wait measurements.

No production API, schema, error vocabulary, authority source, capability profile, numeric threshold, denied-operation bypass, local-machine work, compute lease, acceptance or merge permission is created.

## Basis and authority

I read the full pending-design-questions.md, P065-BUDGET, metadata-exception, replay-expiry-clock, scheduling-release and wave1-resource-windows rulings; the relevant identity/execution/lifecycle/timing contracts; the actual candidate call sites, test assertions, CLI/server/source/read boundaries, configurable capacity, supervisor/heartbeat APIs and original denial logs.

The source basis is uncommitted candidate 2 on dots/p065-budget, based on 26f6fba36948e6c96e2e109cb374c0d4dbb9ab22, base tree 03bd36610d46fd220eb9c0e4fbf153a52bc3c3b9. Its manifest declares aggregate SHA-256 ffbeda20c512181de5f7e49ecb6edc1adfd1440ffff4fcc2e54636161febd602. All 30 listed files independently matched their recorded byte lengths and SHA-256 values during this read-only inspection. A base commit is not a commit of this WIP candidate. I did not execute its tests or independently reproduce its reported results.

The dispatcher supplied this trusted conversation evidence:

<transcript_evidence>
User: 那么我们放弃本地测试了 起码在本项目是 你来做云端的任务即可
User: 你将需要测试的给我prompt 我用来让本地的claude测试即可
User: 后续你有本地测试需求可以发给我 然后继续工作即可 我有空会完成测试 队列任务你直接完成即可 无需我批准 有需要抉择的地方请让oracle直接决定
</transcript_evidence>

This authorizes the project design disposition, including the bounded documentary clarification in section 4. It does not authorize overriding environment restrictions or restarting assistant-run local testing.

## 1. Durable-result marker

**Adopt the inspected approach for these exact paths:**

- acceptIntent: current source/context/owner authorization and, where applicable, the original bound-store guard precede canonical owner/key/version/digest lookup. The returned outcome and link/run IDs are from the prior durable record. Fresh expectedRun/capacity/capability admission remains after lookup.
- commitHandshake: the currently authorized, unrevoked binding is already persisted for the same caller/context/generation and current run. The existing claim, independent launch/session, captured-version and ownership checks still run. Slot repair, binding creation or remapping is new transactional work and cannot use this exception.
- requestCancel: after current authorization and snapshot comparison, a nonterminal run already has a persisted cancelRequestedAt. Return that original fact without a second cancellation intent. The terminal/no-new-acceptance path is not silently promoted into this marker.

The commitCompared wrapper's re-marking of the exact wrapper result is acceptable: it preserves the same independently durable inner fact and rechecks that no preceding transaction mutation occurred. It is not an additional generic recovery path. report has no canonical request key and gains no marker-based deduplication or automatic resubmission.

Candidate transaction.ts:65–79 records total_changes at transaction-object creation and rejects marking after counted DML, including writes through get/all RETURNING. This is a useful conservative guard. It does not establish that a read came from an earlier committed operation, cover arbitrary schema/connection-state changes, or prove that authority is independent of rolled-back writes. The trusted, audited call sites establish those facts. Do not advertise this as a general SQL mutation detector or allow arbitrary future callbacks to declare ok:true durable. No schema/PRAGMA changes or new marker call sites are authorized by this decision.

Candidate ledger.ts:94–145 recognizes the marker only after synchronousResult successfully returns the exact marked result, then rolls the current transaction back. That matches the earlier ruling. A callback exception, including undefined/null/false/0/empty-string throws, a thenable, or a different returned object must not be rescued. Incidental writes after a genuinely eligible marker may be rolled back, but cannot create the returned authority or alter the historical result. Mandatory cleanup must finish or the unusable connection must be isolated before returning it; queued work must never reuse a dirty transaction. No replay dispatch, new ticket, rejection audit or hint for rolled-back work follows.

Required verification remains behavioral and uses real SQLite: all three positive call sites across expiry; canonical old-key replay after currentRun advances; stale/revoked source and failed store proof before replay; slot repair/remap as fresh work; counted writes through run/get/all before marking; marker followed by falsy throw, thenable or a different return; incidental rollback and cleanup failure with isolation; zero duplicate acceptance/report/cancel/launch/hint. Keep the existing independent late-COMMIT and uncertain-COMMIT controls. These requirements are not a claim that candidate 2 already supplies every case.

## 2. Synthetic H/R fixture

**Approve existing configured limits, for example maxActiveRuns=12 and maxActiveRunsPerOwner=12, in the synthetic fixture only.** The accepted configuration already supports these fields. This does not increase the production defaults of 6/4, bypass capacity checks, or turn the old comparator's concurrency_limit abort into success. Record the exact chosen limits for every population and preserve separate default-limit/capacity-refusal regressions.

For this cloud driver, define the labels explicitly:

- H is the number of independently registered, concurrently exercised synthetic MCP caller/server compositions. H=2 needs two real server/stream instances in the test composition, two valid registrations and current source/context premises, with both participating in the declared concurrent schedule. Merely issuing two IDs through one caller is insufficient. If both compositions live in one OS process, say so. Do not claim two actual harness processes.
- R is the baseline active ledger-run load supplied to that experiment: 1 or 10 valid accepted, nonterminal runs, with matching slots, issued/armed claims, registered synthetic supervisor identities and real heartbeat CAS traffic. It is not ten fabricated rows or ten reported-but-unowned tasks.
- Contract 06's formal H=actual loaded harnesses and R=actual active supervisor topology remains unchanged. The above is the brief's explicitly synthetic cloud workload surrogate, not P-06-1/B14 topology qualification.

The proposed ten-run baseline is legal. Seed it through real acceptIntent and registerSupervisor APIs and exercise createHeartbeatWriter with each correct registered producer and monotonically valid facts. Existing visibly synthetic identity/process/capability fixture seams are allowed; they are not production evidence. Do not fabricate child_bindings, force-update state/slots, or use an unauthorized caller to make a benchmark cell succeed.

Parent-operation compositions may share a verified logical owner/session if their separate current process/context evidence supports it. Sharing an owner does not create extra capacity or a second owner. Child whoami/report success populations require each participating child composition's own valid claim, run and current binding, established through the existing handshake path. A second child cannot reuse the first child's identity or binding. Parent identity does not authorize a child report.

Foreground spawn/resume can add runs to the baseline: with two in-flight creations, R_baseline=10 can temporarily become 11 or 12. Record baseline, before/after/peak active counts and the foreground target IDs separately; never label every instant as exactly ten active runs. A previously terminal resume target is not part of the ten-active baseline. For status/cancel/whoami/report, use appropriately authorized targets within the declared population where possible. Restore the baseline between declared trials through valid terminal-evidence/reconciliation APIs or a separately disclosed fresh fixture, never by force-releasing slots or deleting live authority. Prevent unreported accumulation of accepted runs, historical rows or setup work from changing the workload.

Fixture assertions must verify active counts, distinct slots/claims, matching registrations/heartbeat sequences, both H participants, current owner/source premises, and cross-child refusal. Record fixture/setup time separately without excluding per-request source or preparation. Use the same real SQLite file/storage for the declared heartbeat, actual writer-lock contention and accepted observation-store load. Maintain production clocks, actual framed flush measurement, all attempts/outcomes, prescribed warmups/sample counts and three isolated series per Node family. A fixture precondition failure is incomplete evidence, not a busy/success sample or permission to weaken authority.

## 3. Cold CLI boundary

**The current imports remain charged.** hud.ts captures the resume budget before privateHome; run.ts then parses the request, loads config, opens the bound store, dynamically imports the independently built delegation module and performs target/executable preparation. Those operations occur inside this request's original clock. A cold import that crosses the deadline must stop further uncommitted acceptance at the next required checkpoint, complete mandatory cleanup, and retain its failed numerical sample. If COMMIT already succeeded, preserve its truth instead of manufacturing refusal.

Genuine reusable process/module initialization may precede request handling and be measured separately. It must actually be initialization, independent of this request's target, home/config contents, current source/authority and admission work. Moving a resume-selected lazy import or await above a newly sampled timestamp does not qualify. Benchmark-only prewarming, priming module caches without reporting first use, or timing only resumeLocal is prohibited.

A real startup restructuring within owned paths can be considered as implementation, but must preserve the original request boundary and report cold process launch, module initialization, first command/tool and warm calls separately. It cannot conceal a slow first request or load the whole HUD graph into MCP against P-06-6. Request-specific config/store/gate/target/executable work remains charged even if a helper is named startup. Any excluded entry/build-file change needs a separate ownership disposition.

Tests must cover the actual compiled CLI-to-MCP module graphs in a fresh process, a warmed comparison, slow module/preparation completion, unchanged original budget/binding propagation and zero new acceptance after expiry. A warm semantic seam is not evidence that the cold production path meets 30 ms.

## 4. Forced-overrun controls and qualification composition

The brief requires deliberately forced callback/COMMIT overruns while also saying every over-30-ms sample fails the bound. An implementation cannot guarantee a 30 ms wall clock when the test deliberately holds uninterruptible work beyond 30 ms. Correct rollback/committed-truth handling is nevertheless mandatory. **Resolve this by an explicit, narrow separation of acceptance populations, not by changing a failed sample into a pass.**

Approved normative addition for P065 §§7, 9 and 10 and contract 06's P065 measurement guidance:

> Predeclare operational performance populations and test-only forced-overrun safety controls before execution. Every measured interval and every failed numerical bound remains in the raw evidence, including deliberately induced callback/COMMIT stalls. A forced-overrun control may pass only its declared safety, rollback, committed-truth and no-duplicate-action assertions; it does not pass the 30 ms bound and does not contribute a successful latency sample. P065's operational numerical qualification is evaluated over the complete predeclared operational populations. Acceptance additionally requires all prescribed forced-overrun controls to complete with their expected semantics. The inclusive all-samples numerical result remains false whenever any applicable sample exceeds its bound. Never report an unqualified all-samples performance pass.

This deliberately supersedes only the reading that one inclusive Boolean must make correct forced-overrun negative controls indistinguishable from ordinary performance failure. It is an acceptance-composition amendment under the owner's delegated authority. Historical rulings, samples and failed reports are not rewritten.

The exception is confined to test-only, predeclared synchronous delay/fault injection that deliberately forces the callback or COMMIT completion beyond its deadline, with the injection point, duration, affected call identities and expected outcome recorded before execution. Keep the real monotonic clock and real SQLite transaction/cleanup. Separate these controls from operational distributions and from each other when their semantics differ. Test-induced time is never subtracted from the recorded duration.

It does not exempt naturally slow callbacks/COMMIT, cold or first-use imports, real source/config/metadata work, ordinary queued expiry, actual lock contention, heartbeat/observation-storage load, scheduler interference, refusal, busy, successful-late COMMIT or failed/uncompleted attempts in an operational population. Those remain operational numerical failures. A long lock is not automatically semantic-only: the ordinary contention path is still expected to stop attempting acceptance within the unchanged limits. No post-hoc relabeling of a slow call as injected is allowed. Isolate forced controls so they cannot silently contaminate another operational series.

Emit at least three separately scoped results: operational numerical qualification, forced-control semantic completion, and inclusive all-samples numerical status. Also emit population completeness and every per-call numerical flag. If a legacy single overall-qualified Boolean is retained, it must remain false when the inclusive numerical status is false; it cannot conceal the distinction. A separately named acceptance-check result may combine complete operational qualification with successful prescribed fault semantics, with its scope explicit. A driver may exit successfully for that correctly implemented expected-fault test bank, but must fail for any operational gate failure, incomplete required population, unexpected fault semantics, undeclared injection or misclassified sample. Exit zero alone is never qualification evidence.

All existing per-call 30 ms, cumulative 20 ms, busy_timeout=0, full-response p95<50 ms and applicable joint p95<150 ms gates remain unchanged. No required warmup, sample count, tool, workload, runtime or series is removed. Correct handling of forced uncertainty still never authorizes a retry or duplicate dispatch.

## 5. Exact denied-operation scope

The inspected logs establish specific earlier runtime failures:

- HYG2 supplemental npm run test:mjs, source dced9114e9d15977fef07fa52c1a329a58dfa505: tests/unit/herdr-bridge.mjs fakeHerdr calls Node net.Server.listen on a fresh temporary hud-herdr-*/api.sock pathname. The operation returned EPERM, syscall listen, before the fake endpoint could serve the intended protocol assertions. The first detailed failure is lines 83–99 of docs/cloud/handoff/hyg2-fix-mjs-dispatcher-20261103.log on dots/hyg2.
- RUNZ1 npm test, source 2eb08fbd091a44b77bbaa3761c68ae8b11688778: run-light-leader's exec-audit tests invoke tests/int/b3ar1-env-audit.py. Its freshly forked owned child calls libc.ptrace(PTRACE_TRACEME, 0, ...) and receives errno 1/Operation not permitted before the exec-stop audit. See part05 lines 657–671 and part06 lines 35–48 and 70–83. The later standalone test:mjs also records the Unix-path listen failure in part07 lines 66–82.

These are actual OS-operation failures, not evidence that a reviewer denied the names npm test or herdr-bridge, and not proof that all spawning, pipes, SQLite, /proc reads, Unix-socket client operations or independent tests are forbidden. Missing CONFIG_PROC_CHILDREN and unrelated product/registration failures are separate blockers; do not collapse them into ptrace permission.

At the current base, package.json expands npm test through test:unit, whose wildcard includes run-light-leader.test.js and its ptrace helper, then test:mjs, whose wildcard includes the listener tests. Therefore an unchanged aggregate would deliberately re-attempt known blocked operations. The dispatcher identifies prior executor contexts and has supplied no verified permission change. Historical failure does not prove a fresh measurement of current capability, but the absence of new evidence is not authority to probe again. Keep these aggregate stages blocked/unrun for P065, with the underlying operation and prior evidence named.

Continue independently allowed exact focused stages after inspecting their dependency paths, under a later assigned lease. Do not alter aggregate scripts, skip assertions, substitute synthetic success or call those focused passes a full gate. Do not change socket paths, transport, tracing method, permissions, seccomp, sysctls, privileges or executor merely to evade a block. A genuinely separate sanctioned executor must have its own authorized scope and relevant capability evidence; the owner's successful WSL run is not assistant permission to use that machine or a P065 exact-tree result.

Any reconsideration must first record materially new, relevant evidence for the exact operation/target and applicable executor. If an authorization denial is known not to have executed and that evidence addresses it, only the specifically permitted single retry may be considered; uncertain outcomes are checked first. Nothing in this ruling schedules or automatically performs such a retry. Owner-run exact-tree evidence may be requested through the existing workflow while permitted cloud work continues.

## 6. Status and wait

**Choose preservation of existing read behavior, not a new 30 ms refusal.** Base delegation.ts returns status and enters wait before constructing the B5 write deadline. P065 §4 specifically defines the write/authorization budget and separately preserves wait/client timing and read-only behavior. The original source/security predicates are still mandatory, but this package does not turn every read into a newly deadline-failing B5 operation.

The candidate's unconditional server.ts:118–120 source budget checks, the budget passed into source/hook resolver checks for these tools, delegation.ts:177 entry check and :185 status-completion check therefore need narrowing. Fix every layer, not only the final status check. For status/wait, preserve the original receipt timestamp and use non-enforcing timing observation; do not supply an expiring P065 write budget to their source or read-authority path. No public argument/config knob selects enforcement. Tool classification is trusted internal dispatch. Write-capable spawn/resume/cancel/whoami/report retain the same original 30 ms clock before source resolution, even when that particular call ultimately refuses or replays.

Status still has the complete receipt-to-serialization/flush p95<50 ms gate. A valid 35 ms status is not newly rejected as P065 busy merely for exceeding 30 ms. A slow status still counts against its applicable response distribution and cannot be hidden by fast refusals. Wait retains its original client/request deadline, response margin, cancellation/EOF/shutdown behavior and upfront-cost reporting; source/read work consumes that original elapsed time, not a later reset. Neither tool adds root registration, last_seen, audit, metadata guard or other ledger writes. Keep existing independent bounded source-search/freshness limits and all current identity/captured-generation checks.

Record P-06-5 as not applicable to status/wait's read-only path, rather than manufacturing a successful write-budget sample or treating a legitimate long poll as a 30 ms failure. This is an applicability clarification preserving existing behavior, not an exemption for write tools or a relaxation of P-06-4.

Add deterministic paired tests: valid slow source/read authorization above 30 ms does not create the new refusal for status or wait; invalid/stale/native-child source still refuses; the same preparation delay for each write-capable dispatch prevents further new authorization/admission; status/wait make zero ledger writes; wait retains its original elapsed/client deadline and cancellation responsiveness. Measure real status flush latency and separately reported wait upfront cost. Revert the candidate's new read-only checks as a behavioral control where useful, without weakening any source predicate.

## Recording, ownership and remaining gates

One dispatcher-owned documentation writer must archive this ruling unchanged, append its decisions to P065-BUDGET, and record section 4's exact measurement-composition amendment plus section 6's applicability clarification in contract 06 and concept §15. No historical ruling or failed evidence is overwritten. The implementer must not make shared-document edits. The existing twenty production and twenty-three test/fixture reservations suffice; no package/build/lock files, error mapper, schemas, capability matrix, hook producer or excluded shared writer gains ownership.

This ruling resolves the six design questions but does not grant a compute window. Candidate 2 remains frozen WIP until documentary recording and explicit dispatcher admission under wave1-resource-windows. No automatic restart of benchmarks, aggregates, denied publication or local tests follows. Preserve the separate publication blocker and existing check inventory.

A later fresh Oracle must review the resulting exact source, meaningful negative controls, complete operational and forced-control evidence, runtime populations and full check status. Acceptance and --no-ff integration still require their independent gates, including the full green README check set on the actual merged tree. Unavailable aggregate coverage, natural over-budget observations, cold-path failure, unrun real-Claude/B14 evidence and other package prerequisites remain visible. No synthetic result promotes a capability or formal supported-platform claim.

## Primary sources

- https://github.com/CartmanFatass/codex-hud/blob/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22/docs/cloud/P065-BUDGET.md
- https://github.com/CartmanFatass/codex-hud/blob/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22/docs/cloud/rulings/p065-metadata-exception.md
- https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/rulings/p065-replay-expiry-clock.md
- https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/rulings/p065-budget-release.md
- https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/rulings/wave1-resource-windows-20261103.md
- https://github.com/CartmanFatass/codex-hud/blob/26f6fba36948e6c96e2e109cb374c0d4dbb9ab22/docs/contracts/06-observation.md#L240-L305
- https://github.com/CartmanFatass/codex-hud/blob/dots/hyg2/docs/cloud/handoff/hyg2-fix-mjs-dispatcher-20261103.log#L83-L99
- https://github.com/CartmanFatass/codex-hud/blob/dots/runz1/docs/cloud/handoff/runz1-dispatcher.log.part05.txt#L657-L671
- https://github.com/CartmanFatass/codex-hud/blob/dots/runz1/docs/cloud/handoff/runz1-dispatcher.log.part06.txt#L35-L83
- https://github.com/CartmanFatass/codex-hud/blob/dots/runz1/docs/cloud/handoff/runz1-dispatcher.log.part07.txt#L66-L82

Method: read-only repository/tool retrieval, source and test inspection, existing-log inspection and manifest-byte verification. No file writes, branch changes, build, test, benchmark, capability probe, permission change, local-machine action or subagent was performed.