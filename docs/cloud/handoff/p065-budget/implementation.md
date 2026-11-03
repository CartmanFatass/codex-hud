# P065-BUDGET initial scoped implementation

**WIP / NOT ACCEPTED / NOT MERGEABLE.** This is a semantic implementation submission, not a complete performance qualification. The full new 50-warmup/1000-measured H/R matrix driver is not yet implemented pending fresh Oracle decisions recorded in `pending-design-questions.md`. No gate, supported profile or capability is promoted. Real-Claude joint 150/50 ms, user-local work, full aggregate checks and later merged-tree checks remain outstanding.

## Base and ownership

- Repository: CartmanFatass/codex-hud.
- Exact declared base: 26f6fba36948e6c96e2e109cb374c0d4dbb9ab22; tree 03bd36610d46fd220eb9c0e4fbf153a52bc3c3b9.
- Worktree: `/workspace/shared/p065-budget`; branch `dots/p065-budget`.
- All implementation/test changes stay inside the scheduling release's explicit whitelist. The manifest lists all changed files, including new files. No shared documentation is edited by this implementer.
- Local HEAD stays the exact base until connector publication. Existing repository storage lacks an ancestor object, so a history walk is incomplete; direct base/tree identity, file comparison and worktree diff are available. No history reconstruction, rewrite, main/universal update or force push was attempted.
- Dependency installation was needed only because prettier was missing. `npm ci` was run once and succeeded. Its tracked node_modules/.package-lock.json change is excluded from source publication and every source manifest. No package or dependency-lock file belongs to this submission.
- The parent explicitly assigned the P065 execution window after RUNZ1-KILL returned it. Commands are serialized. No assistant action ran on the user's local computer.

## Implemented behavior

### One original invocation budget

`src/ledger/call-budget.ts` provides the trusted internal monotonic clock dependency and one original 30 ms deadline. The same object travels from MCP receipt before argument/source work, or CLI resume before private-home/config/open/target preparation, across preparation, root authorization, intent, child writes, reconciliation/cancel and rejection audit. A trusted enclosing cap can only tighten it. Numeric legacy transaction zero remains an intentional nonblocking API, separate from an expired call.

Actual queue delay is conservatively charged into the shared 20 ms contention allowance. Actual BEGIN attempt and backoff elapsed time, including oversleep, are retained. Preparation/callback work is not called measured SQLite waiting. The original start is never reset; supplied future starts and discontinuous clocks refuse. Production uses performance.now and real delays; fake time exists only in explicit trusted test composition, not args/env/config/CLI flags.

Bounded diagnostics retain a 64-checkpoint ring, per-phase counts and adjacent-checkpoint interval totals, actual queue/wait/attempt counts, authorization-decision completion, total elapsed-to-flush and overruns. Phase intervals are not assertions about kernel-only CPU or lock time. Mandatory rollback has explicit before/after observations. Optional diagnostic/observer failures cannot change durable truth.

### Transaction ownership, expiry and uncertainty

The shared-budget Ledger path owns a transaction immediately upon successful BEGIN, before the asynchronous acquisition handoff or any clock call. It checks expiry after queueing, every acquisition/backoff, successful acquisition, local metadata pass, callback admission and immediately before COMMIT. It never retries a callback or COMMIT. Async/thenable callbacks refuse and transaction objects retire.

New requested work that expires before COMMIT is fully rolled back before a clean busy response. COMMIT success is marked known before optional observer/clock work, so a late successful result is returned and remains an over-budget sample. COMMIT exceptions become internal LedgerCommitUncertain with original cause and auditUnsafe, never LedgerBusyError/ledger_busy. The unchanged public mapper emits internal_error, without notAccepted or retry-safe promises. Rollback failure cannot mask uncertainty; it isolates and closes the unusable connection and prevents queued reuse. Even falsy callback exceptions reject and cannot preserve an earlier marker.

The internal priorDurableResult marker is honored only for an exact successful synchronous returned value after current authorization. It refuses marking if SQLite total_changes differs from transaction entry, including writes through RETURNING. Current uses are canonical intent replay, already unchanged child binding with no slot repair, and an already persisted cancellation. Such a replay closes with rollback, preserving the prior result while discarding incidental work. Marker followed by exception/thenable, new rows or rollback-dependent authorization cannot be rescued. No report request key or hidden deduplication is added. Fresh authorized keyed recovery after commit acknowledgement loss consults the durable record and never resends a ticket.

### Original local-store binding

The CLI retains the original PrivateLedgerGate from opening and binds it to the exact final Ledger object. The internal frozen closure survives independent CLI/MCP module builds without instanceof assumptions; resume requires the expected home and original binding. Missing/wrong/replaced/invalidated bindings refuse. There is no service-layer gate reconstruction or repin fallback.

After real writer acquisition, the local path performs only the approved fixed synchronous metadata pass: lstat first, at most one lstat and one realpath for the original private home, main database and two optional sidecars. It preserves UID/eUID, strict typed local_user fields, canonical absolute paths, owner/mode/type/symlink/nlink and original home/main dev+ino. Only sidecar lstat ENOENT means absent; a dangling symlink or other error refuses. Sidecars are safety-checked, not lifetime inode-pinned. Proof failure invalidates only that binding and suppresses rejection audit. Ordinary expiry does not invalidate a safe binding. No global shared-manager gate policy changed.

This is observation consistency at opening and actual acquisition, not atomic filesystem-handle attestation, complete ABA detection or protection against a malicious same-UID actor. Existing registry lock-held process I/O remains an excluded separate issue.

### Source, preparation and post-commit behavior

Source resolution and hook consumption keep existing profile/process/session/boot/native-child/premise and one-shot/tombstone checks. Matching same-boot numeric hook timestamps do not establish a cross-process clock correlation. Unknown outer timing is explicitly unavailable; it never extends the original 30 ms. A genuinely supplied correlated cap tightens the same object. Producer records/profile behavior is unchanged; no synthetic seam establishes real correlation or joint qualification.

Bounded config/brief/realpath/stat/executable/fingerprint preparation checks the same budget across awaits. Module imports and opening in the local CLI are still charged when they happen after request start. No cold cost is silently moved to startup or hidden behind a cache.

Optional advice, wake projections, hints and diagnostic failures cannot reverse known requested-operation truth. New accepted intents retain the existing one-dispatch path; replay never dispatches. Status/wait remain read-only, with wait's existing independent long-poll/client deadline. Response timing observes actual writable completion, not merely body return. Source refusal decision time precedes optional advice/serialization/flush.

## Semantic tests and negative controls

The new suites use real SQLite, explicit trusted clocks, exact native writer COMMIT fault seams, actual compiled CLI-to-MCP handoff, and synthetic authority/capability/process facts. They test both sides of 30 ms, cumulative waiting/oversleep, queue/acquisition-await/gate/precommit expiry, successful-late and acknowledgement-lost commits, rollback isolation, durable replay/old-key truth, no redispatch, no-key report behavior, local metadata operations over the actual lock interval, inode/privacy/owner/type/hardlink/UID/error changes, unchanged legacy manager behavior, and response timing. The raw test logs contain every test name.

Existing business assertions are preserved. The allowed B11, delegation, G03 and cache-advice semantic fixtures receive explicit deterministic timing so parallel test scheduling does not turn business tests into accidental performance tests. The benchmark fixture's clock remains optional with production real-clock default; old comparator drivers are unchanged. A prior full MCP run's ten real-clock budget refusals are retained and are not erased or called performance successes by the later semantic-fixture pass.

Independent controls narrowly revert original binding propagation, post-acquisition metadata observation, post-gate expiry, unsafe-audit suppression and pre-COMMIT checking. Each control must compile and fail the actual behavioral assertion. Source snapshots, patches, exact manifests and raw logs are retained. Missing-export or compilation failures are not counted as behavioral evidence. This is not yet an exhaustive negative control for every additive behavior; any remaining precision coverage is an open final-review gate.

## Evidence and open work

Raw commands retain UTC, runtime/executable, exact source file/diff hashes, timeouts, complete stdout/stderr, status/duration and compiled-output hashes. Final source bytes and their manifest accompany this report. Early exploratory logs have less metadata and are labeled by sequence, never substituted for final evidence. Every failed attempt is kept.

The host is a synthetic isolated cloud Linux x86_64 Debian 13 environment on overlay storage. nproc reports nine CPUs; accessible memory is roughly 10.45 GB. CPU-model/quota/cgroup paths were unavailable; that absence is recorded, not guessed. Node versions are v22.23.4 and v24.22.1. No claim is made about formal WSL, real harnesses or user-machine performance.

Pending fresh Oracle questions are delivered separately: exact benchmark H/R authority/capacity fixture; durable-marker implementation review; cold CLI startup boundary; induced-fault overrun qualification disposition. The new driver/helper paths remain absent until these questions are settled. All required three-series Node22/24 populations, instrumentation-overhead measurement, actual observation-store load, full per-call numeric gates and formal real-hook qualification remain unfulfilled.

Full npm test/test:mjs have not been attempted because they include previously denied AF_UNIX listening/ptrace operations. Known paths are tests/unit/herdr-bridge.mjs and tests/int/b3ar1-env-audit.py, with prior logs held by the dispatcher. No denied operation was retried or bypassed. Separate safe suites cannot make that aggregate gate green. No user-local tests, local profiles, real credentials, real home directories or capability promotion were attempted.

The dispatcher owns report/ruling archival, independent fresh Oracle review and any later merge. This package cannot be accepted until missing evidence and design questions are resolved and the explicit acceptance/merged-tree rule is met.

## Publication blocker

The first remote create_branch call for dots/p065-budget at the exact pin was denied at 19:56 UTC: the reviewer did not find explicit user authorization for external repository mutation/publication in the implementer's available evidence. The outcome is known not executed. No remote branch/source publication succeeded, no alternate route or retry was attempted, and the parent was asked for exact relevant authorization evidence. The complete denial is in publication-blocker.txt. This is a publication permission blocker, not permission to bypass the connector or to touch another branch.

## Recorded check outcomes before the final serialized-binding correction

Candidate 1 source-files aggregate SHA-256 is 02dcafce928f12a7fcec1e15579d6f08ade3871e5c5624c11fe00a196cb71aee. Its exact source snapshot and per-file manifest are retained separately. Both Node 22.23.4 and 24.22.1 completed:

- build, build:test and build:hud-mcp: exit 0.
- New semantic unit: 38/38; new MCP: 11/11.
- Focused existing unit: 57/57; focused MCP: 62/62.
- Core: 209 pass, zero fail, one opt-in benchmark skip.
- Visual: 319/319.
- Full MCP: 96 pass, zero fail, one opt-in benchmark skip.
- Format, fixtures and diff: exit 0.
- Standalone shared-writer int-ledger-run plus b45-parent-offline: 27/27, preserving the existing F05/local-user/manager/orphan/claim/ownership/lifecycle assertions. Read-only inspection found no denied listener or ptrace helper in these commands and their invoked helper paths.
- Five independent negative controls: compile success, then expected behavioral failure on both Node families. Each control has its own source manifest, snapshot, patch and raw output. The control driver exits 0 only when the test execution exits 1 as expected; each test's actual failed assertion remains visible.

The following unchanged old comparator commands are not qualification evidence:

- Direct service, both runtimes: exit 1 on unintended uncontended ledger_busy during the first declared-success population. The legacy comparator does not retain a completed JSON result for that abort. Raw stderr is retained. No successful completion or full population is asserted.
- Framed stdio, both runtimes: exit 1 on concurrency_limit at active=4/limit=4 while accumulating spawn successes. The saved JSON explicitly says complete:false and has zero completed distributions/totalSamples/totalAttempts. That is the old driver's incomplete-output limitation, not proof that no calls occurred. Raw output and the partial artifact are retained. No capacity guard or comparator was changed to force success.
- Handshake, Node24: legacy test exit 0 with six 200-sample distributions, but whoami/busy max is 109.067 ms and report/busy max is 38.422 ms. It checks p95 rather than P065's per-call bound; its exit is not a P065 pass. The reported whoami/busy p95 is 24.249 ms and report/busy p95 is 17.964 ms; these do not erase the maxima.
- Handshake, Node22: exit 1 during report/refusal on ledger_busy, after only four completed 200-sample distributions. Incomplete populations remain incomplete. No warning suppression or retry was used.

Only one comparator series per runtime was attempted. The three-series complete P065 matrix remains absent. No performance range, overrun count or unretained per-call interval is invented from incomplete legacy output.

The final narrow correction additionally rejects a serialized binding whose check closure is missing, before a service admission or rejection audit can begin. Its exact source and recheck results are recorded separately below; candidate-1 broad-check/control results are not mislabeled as all being executed on candidate 2. A fresh complete check set remains required after all Oracle-directed changes.

The status/wait upfront deadline interpretation is also explicitly pending Oracle. The current implementation is not offered as an accepted new read-only timing contract.

## Frozen candidate 2 identity and targeted recheck

Candidate 2 source-files aggregate SHA-256: ffbeda20c512181de5f7e49ecb6edc1adfd1440ffff4fcc2e54636161febd602. It comprises exactly 20 production paths and 10 test/fixture paths, listed with complete bytes/hashes in source-manifest.json; source.tar.gz and source.patch contain those scoped changes. The public error mapper, schemas, contracts, capability manifests, hooks producer, package/dependency files and excluded production paths are unchanged.

After the serialized-binding correction, Node24 build/build:test/build:hud-mcp all pass. The actual final compiled output passes 39/39 new unit and 11/11 new MCP cases on Node24 and Node22. This final targeted recheck is not a claim that the earlier broad checks, controls or comparator series were all rerun on candidate 2. All earlier and final identities are explicit in their logs/manifests.

No source commit or remote branch exists for this candidate because publication was denied. The local base remains unchanged with frozen worktree edits; this report does not label a base SHA as the implemented candidate. Fresh Oracle design disposition and a subsequent explicit execution window are needed before work resumes.

A sixth narrow candidate-2 control removes only the serialized-binding shape guard; it compiles and fails the real invalid-binding classification test on both Node families. Details are in negative-controls.md. All mandatory cleanup/check commands have ended before the lease-return message; no test/build/benchmark is intentionally left running. Implementation stays paused at the listed exact design and publication blockers, awaiting a later explicit window.
