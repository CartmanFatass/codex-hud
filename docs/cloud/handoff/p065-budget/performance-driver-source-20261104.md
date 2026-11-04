# P065 performance driver: source-only implementation

Date: 2026-11-04. Implementer report. This is source publication, not runtime evidence, acceptance, performance qualification or merge permission.

## Source and authorization

Repository: CartmanFatass/codex-hud. Branch: dots/p065-budget.

Exact parent checked before preparation and again before publication: 4151debed76b3eca68265d74811b215e62c43546.
Parent tree: f2aeb9b9868326ba250ade7c4a13962d4db3ed21.

The assigned source-only continuation permits exactly two new source files plus this additive handoff report. It prohibits executing a compiler, formatter, test, holder, benchmark, npm command or local checkout workload during this tranche. The user has authorized this project branch's writes and delegated project decisions to Oracle. Publication uses the GitHub connector, a tree based on the exact parent tree, one normal child commit, and a non-force expected-head branch update.

Binding reading included AGENTS.md, docs/cloud/dots.md, docs/cloud/README.md, architecture invariants, P065-BUDGET sections 7/9/10, the scheduling-release ruling sections 5/7/9 and six-design-dispositions sections 2–6 plus Recording at universal-hud c9f64e5534a855b636bf70398aa4b66d9d0d4374. Relevant production, fixture, CLI, framing, heartbeat, observation-store, transaction and authority APIs were inspected through the connector.

No source/test changes from another package or unaccepted branch were imported. The pinned fixture remains unchanged: tests/unit/p065-budget-fixture.ts, blob 4264874ef20ebbae2fabe80fe505785c8a89c191.

## Changed files

1. tests/int/p065-budget-benchmark.mjs, new standalone driver.
2. tests/int/p065-ledger-holder.mjs, new owned IPC helper.
3. docs/cloud/handoff/p065-budget/performance-driver-source-20261104.md, this new report.

No fixture, existing test, production path, rejection-audit path, shared contract/status document, package/build script, dependency lock, main branch or earlier evidence is changed. No branch deletion, force update or history rewrite is used.

## Default measurement plan

The default invocation is:

    node tests/int/p065-budget-benchmark.mjs OUTPUT.json

It accepts no reduced-population or hidden qualification option.

The predeclared matrix has 126 cells:

- Six tools: status, spawn, resume, cancel, whoami and report.
- H/R profiles 1/1 and 2/10.
- Eight operational conditions per tool/profile: first-use, success, refusal, short writer lock, long writer lock, queued expiry/read delay, observation-storage load, and response loss.
- Three additional forced controls per write-capable tool/profile: callback overrun, successful late COMMIT, and uncertain COMMIT acknowledgement.
- Every cell retains 50 primary warmup calls and 1,000 primary measured calls. This is 6,300 primary warmups plus 126,000 primary measured calls. Additional canonical recovery attempts are retained and do not replace primary calls.
- Warmups remain in raw evidence and in explicitly labeled all-attempt numerical results. Measured distributions are also separate. No outcome-conditioned resampling discards busy attempts.
- H=2 operational waves issue both real framed calls before awaiting either response. Forced synchronous controls are sequentially isolated so one deliberately blocked event loop cannot masquerade as another caller's injected control.
- A fresh approved fixture is used for every H-sized wave. Fixture setup and initialization are recorded separately. No direct state/slot/claim/binding repair is used to restore workload populations.

The complete matrix is intentionally not shortened to fit a host. The 3,600-second outer bound produces an incomplete failed result if the host cannot finish it. Actual execution time is unknown in this source-only tranche.

## Composition and authority

Each H participant has its own HudMcpServer, PassThrough input, asynchronous Writable output, independently registered caller/context and service SQLite connection. The Writable callback is the actual serveStdio flush acknowledgement. Each frame is decoded, its ID/protocol checked and text/structured results compared. A separate real SQLite read connection obtains current scope premises without illegally nesting a read inside another connection's transaction.

The driver reuses the approved p065WorkloadFixture. R counts valid nonterminal runs, distinct slots, issued/armed/redeemed claims and registered synthetic supervisor identities seeded through real APIs. Limits remain the explicitly permitted synthetic 12/12 configuration, not changed production defaults. Before/after/peak active counts, foreground run IDs, fixture population, caller/context IDs and setup times are retained.

Process/source/capability/launch facts remain visibly synthetic test seams. H is not a claim of actual harness OS processes; the two framed compositions share one OS process. The holder is a separate real process. No real home, logged-in harness, credentials, Herdr, tmux, socket listener or ptrace operation is introduced.

Refusal populations provide an explicitly mismatched physical source identity to the real authorization/read path. They do not reinterpret a legitimate session switch as invalid. Status remains read-only, has zero instrumented write transactions, reports P065 write timing as not applicable, and still has the full response p95 gate. No writer is introduced to manufacture a status busy population.

For whoami forced target-COMMIT controls, the fixture actor API creates a legitimate new MCP registration/context on the same independently supported synthetic child process/session. Existing handshake recovery remaps the binding through its normal transaction. Existing binding/claim rows are not rewritten by the driver.

## Independent holder

The helper requires an owned IPC channel, a random ownership marker, canonical private temporary sandbox/home paths, matching UID, a real existing private ledger file and a bounded command protocol. It cannot open an arbitrary user ledger.

It opens the same ledger SQLite file, constructs createHeartbeatWriter from each registered run's actual stored supervisor and initial heartbeat, and emits real monotonically valid heartbeat CAS traffic. Background failures, lost CAS, waits and successful sequences are retained. Its independent DatabaseSync connection holds a genuine BEGIN IMMEDIATE lock with busy_timeout=0 and a bounded release timer. Readiness must be acknowledged before the measured wave.

The storage-load condition uses the accepted ObservationStore acquire/renew/publish/readProjection interfaces. Observations use a separate source-local database under the same temporary root; device identity is verified against the ledger. No observations are written into the ledger and no B10D interface is imported. Published sequence/bytes and actual operation intervals are retained. Qualification requires observed heartbeat and observation overlap, not merely a configured load label.

IPC readiness/commands have deadlines. The parent owns the exact ChildProcess object/PID, sends bounded termination and escalates only for that owned process. The helper releases locks and closes stores on shutdown/disconnect. A helper-close failure forces owned-process cleanup before its fixture is deleted. No kill-by-name or unrelated-process cleanup is used.

## Timing, faults and durable truth

Production monotonicClock and real SQLite are used. No fake clock, future timestamp, altered deadline or subtraction of injection time is used.

Every primary/recovery call is appended as started before dispatch, then flushed/incomplete, then completed with durable assertions. Evidence includes actual server outcome, separate client delivery outcome, source budget diagnostics, all checkpoints, original authorization interval, response/flush interval, queue/wait/backoff totals, lock attempts, transaction/callback/COMMIT/ROLLBACK intervals, actual configured busy_timeout, numerical flags, injection point/duration and semantic results. Uncompleted calls are retained.

Instrumentation wraps the actual transaction and SQLite exec calls. It records success/failure of BEGIN, COMMIT and ROLLBACK. Backoff instrumentation delegates unchanged to the production method and records its real duration. Target fault selection uses the real requested-operation callback result, not a fabricated successful body.

- Callback-overrun controls stall synchronously for 40 ms after the real target callback and before its COMMIT checkpoint. They require busy, rollback and absence of requested durable work.
- Successful-late-COMMIT controls execute real COMMIT first, then stall its return for 40 ms. They require the original successful result and real durable rows. The sample remains a numerical failure.
- Uncertain-COMMIT controls execute real COMMIT and then throw acknowledgement loss. They require the actual internal-error mapping, durable readback, no clean not-accepted promise and no initial dispatch for spawn/resume. Canonical recovery occurs only after independent durable inspection and on a fresh connection when the original connection was isolated.
- Actual response loss discards already-flushed bytes at the client. A separate observation of those actual server bytes preserves success/refusal/busy classification rather than labeling every lost response successful.
- Canonical spawn/resume/cancel/whoami recovery and read-only status are checked without new accepted work or duplicate launch. A lost/uncertain report is inspected durably and never automatically resent, because report has no idempotency key.

Concurrent assertions use wave-level conservation plus per-call durable identity/SQL traces. They do not misattribute the other H=2 participant's mutation to a refused call.

## Cold and first-use evidence

First-use matrix cells use new stores, service caches and server/stream compositions. Genuine reusable module initialization is separately timed; per-request preparation still happens inside the actual server budget.

Two additive fresh-helper-process CLI probes, one per baseline profile, retain the first and second request. They import the real compiled CLI initialization, then start the original production CallBudget before privateHome and runCommand. Lazy independently built MCP configuration/delegation imports remain charged inside that original request. A trusted capability-refusal seam prevents any real harness launch. The probes retain preparation/budget outcomes and assert zero new acceptance/launch.

These additive probes are refusal-path cold evidence, not positive capability or real-harness qualification. Their four calls do not substitute for any 50/1,000 MCP population. They do not claim OS page-cache eviction, successful cold acceptance, or completion of all independent CLI safety tests.

## Output and qualification

OUTPUT.json contains source/runtime/host identity, predeclared populations, empirical nearest-rank n/p50/p95/p99/max, over-30 count and maximum, actual-outcome splits, per-stage distributions and the qualification components. OUTPUT.json.samples.jsonl retains call lifecycle records. OUTPUT.json.support.jsonl retains fixture, helper, initialization, queue predecessor, traffic, cold CLI and wave-conservation evidence. Existing output paths are refused instead of overwritten.

Identity records include source commit/tree, tracked/untracked source checks, hashes of compiled JS/JSON graphs and both driver sources, exact Node and SQLite, OS/kernel/CPU/vCPU/quota/memory, filesystem/device/mount, sanitized environment, process launch/module initialization, command, timestamps and available resource/interference information.

Results are explicitly separate:

- Population completeness.
- Operational numerical qualification, including ordinary contention, queue/cold/refusal/interference and operational recoveries.
- Forced-control semantic completion.
- Inclusive all-samples numerical status.
- Legacy overallQualified, which cannot be true if inclusive numerical status is false.
- Explicit acceptanceChecks, combining complete operational qualification with expected forced-control semantics and no recorded infrastructure failures.

Every applicable call must meet the 30 ms original wall bound and 20 ms cumulative wait bound. Full-response p95 must be strictly below 50 ms, also split by actual outcome. A percentile does not replace the per-call bound. Natural slow samples cannot be reclassified as forced controls. Missing timings, failed fixture prerequisites, missing overlap/populations, unexpected outcomes or fault semantics fail/invalidate qualification. Correctly forced overruns remain failed inclusive numerical samples.

## Verification performed and not performed

Performed:

- Read-only connector inspection of the pinned source and binding documents.
- Source authoring and manual static inspection of imports, API shapes, authorization, per-call timing, fault points, owned cleanup, output preservation and qualification composition.
- Expected-head/tree check before guarded publication.
- Exact source/report readback is required immediately after publication; the parent receives its verified commit/tree and blob identities separately.

Not performed, by explicit tranche restriction:

- No syntax/compiler/type check.
- No formatter.
- No unit/integration/aggregate test.
- No holder or driver execution.
- No benchmark, cold probe, capability probe or negative-control execution.
- No npm/dependency operation.
- No local checkout/worktree workload or local machine action.

There are no performance numbers or passed runtime checks in this report. Manual static inspection is not a syntax/runtime pass.

## Remaining gates and handoff

The source-only continuation has no identified need to alter the frozen fixture or an excluded source path. Runtime feasibility and semantics remain unverified. A later isolated authorized execution must build the exact tree, inspect every output population, and retain three series on each exact supported Node 22 and Node 24 runtime. A timeout, contamination or other incomplete run is not a pass and cannot be repaired by reducing the declared populations.

Fresh Oracle source review, meaningful negative controls, required focused/aggregate checks, and the independent final acceptance process remain. Historical AF_UNIX-listen and PTRACE_TRACEME blocks remain unchanged; this work does not authorize retrying them, changing aggregate scripts, bypassing restrictions or using the user's local computer. Existing HYG2/RUNZ1/S3F full-check blockers remain visible when applicable.

Real-Claude same-call joint 150/50 timing, real-harness/capability cells, Herdr/tmux, formal WSL and B14 supported-platform requirements remain separate and unverified. No synthetic result promotes them. No merge or acceptance is requested by this report.
