# B10D route ruling, 2026-11-03

**Decision: keep B10D unmerged. Retain the 200-node/20,000-header supported profile and all numeric gates. Fix the dominant legacy cost with a separate bounded incremental catalog package. Make logically pinned sessions cheap through an explicitly commissioned exact-continuation/disposal package, not a higher reader cap or weaker continuity checks. Complete retirement recapture inside B10D before enabling publication.**

**The §19 one-use continuation-ticket fairness exception is confirmed for implementation under the owner’s new approval. It is only one part of this route and does not accept B10D.**

This is a read-only design consultation. I inspected the remote binding documents, retained measurements and relevant source. I made no edits, ran no probes or tests, and started no subagents.

## 1. Evidence and current state

The question’s “uncommitted diff against `6fcf08a`” description is historical. The remote `b10d-worker` branch now contains frozen WIP commit **`4f2c4aced878e5750e66292ed7c552ffb421165d`**, with parent `6fcf08aef34e2cefa8c7c5ee766b001993e88db9`. Its commit message explicitly says NOT ACCEPTED and do not merge.

Current `STATE.md` also supersedes older handoff status lines: **B12M and B10B-s2 are already merged into `universal-hud`**. Incorporating that branch into the worker work is a prerequisite, not a reason to merge the worker into it.

The final evidence is worse and more complete than the predecessor values quoted in the route question:

- Final standalone bar paint p99 is approximately **108/93/126/154 ms** for no-change/summary/new-checkpoint/mixed. The mixed paint maximum is **246 ms**.
- Final bar mixed request-to-paint maximum is **1,184 ms**. The interval including the last main-thread completion is approximately **1,185 ms**.
- Simultaneous mixed paint p99 is approximately **168 ms bar / 90 ms panel**; full-operation p99 is **253/338 ms**.
- The matched synchronous legacy stage already costs roughly **85–95 ms p50 and 116–132 ms p99**. Moving observation publication did not create that cost, but pre-existence does not waive acceptance.
- The completed 30-minute run followed by 5,000 no-rescue drain operations left **166 of 200 targets unsettled**. This is a measured liveness failure.
- The checkpoint-only recovery stall is distinct from §18’s accepted-history pins. Initial diagnostics show completed recovery retained before the first native capture, not evidence that every resident failed an accepted-reader continuity test.
- Retirement recapture remains a separate P1.
- Final evidence also reports failed no-change wiring and B9 shares, unqualified hard external-buffer accounting, and missing follower C=1/C=5 propagation qualification. Fixing the headline legacy problem alone cannot establish acceptance.

These findings are retained evidence, not measurements independently reproduced in this consultation.

## 2. Legacy collection: choose bounded incrementality

**Choose an incremental legacy catalog/index, in a separate package provisionally named LEG1. Do not move the existing complete legacy collector into the observation worker, and do not classify the 20,000-header fixture out of support.**

The source exposes specific work to remove:

- `HudStatus.buildNow()` invokes the synchronous legacy tree builder when the caller does not supply a tree.
- The synchronous finder stats every listed file.
- Even the yielding tree builder reconstructs maps and walks the complete listed population each time.
- The yielding finder’s stat cache has a 4,096-entry limit. On a 20,000-file profile, its implementation cannot be assumed to retain the whole inventory between passes.
- Existing yielding reduces individual main-thread blocking units but does not eliminate total service cost.

LEG1 should retain a bounded, source-scoped catalog of header identities, file signatures, parent relationships and affected-tree dependencies. Normal work should update affected entries and reachable legacy content, rather than rebuild the entire inventory on every no-change opportunity.

Its requirements are:

1. Preserve the existing legacy field meanings, root selection, duplicate-file resolution, parent/child resolution, charges, model/effort, task/report, activity, timeline and file-list inputs. No universal-view-to-legacy substitution.
2. Keep the complete catalog needed for the declared 20,000-header profile within an explicit count **and byte** budget. Avoid a nominally bounded cache that perpetually evicts and reloads the same supported working set.
3. Use watchers only as invalidation hints. A quiet watcher is not proof that nothing changed. Include bounded recovery for lost hints, source replacement, directory rollover, creation/removal, truncation, same-size rewrite and signature ambiguity.
4. Preserve the existing discovery/freshness obligations. Any proposed slower discovery guarantee must be separately identified for owner approval; it cannot be hidden inside “cache optimization.”
5. Keep each published legacy snapshot complete and scope-compatible. Incomplete repair keeps the last valid snapshot with truthful existing health/coverage treatment, rather than presenting partial reconstruction as complete.
6. Run repair and collection on the existing collection stream. Watcher callbacks, resize, keys and result ACKs must not create an additional unmetered collection loop.
7. Account for catalog initialization, repair, lookup, scanning, allocations and cleanup. Ordinary invalidation is not relabeled cold startup, and moving work between callbacks does not remove it from end-to-end measurement.
8. Compare legacy data and rendered legacy content against `6fcf08a` at equal inputs, observation boundaries and clocks. Exercise nonempty Git/file content and worker initialization/non-null-result states.

**Ownership:** LEG1 owns `src/collectors/session-finder.ts`, `src/collectors/subagent-tree.ts`, a narrowly scoped new catalog module if needed, `src/collectors/hud-status.ts`, and its tests. Existing scan-store compatibility must be preserved; a change to what the scan reads requires its version change. Reserve production wiring in `src/index.ts` and `src/tree-page.ts` for the subsequent integration step, coordinated with TPD1. LEG1 does not own renderers, B12 publication, B16 classification or model-job behavior.

**Cost:** medium/high implementation and invalidation-proof work. It directly targets repeated service cost and therefore both paint and operation latency.

The rejected alternatives have these costs:

- **Move the unchanged legacy collector into the worker:** high cross-module and transport cost, with no demonstrated reduction in full-operation latency. Copying the existing catalog and legacy data into the 64 MiB worker/2 MiB envelope is not justified by the retained memory evidence. It also reverses the owner-approved §11 execution choice.
- **Yield only:** useful as an implementation technique, but insufficient as the selected route. The panel already yields and still fails the full-operation gate.
- **Exclude the 20,000-header profile:** a supported-profile reduction requiring an explicit owner decision. I do not recommend it.

**Acceptance impact:** add inventory/invalidation, memory and complete legacy-parity evidence; retain all existing timing thresholds.

**Decision boundary:** this is a new cross-package implementation scope. Update design §6 to describe its cache/collection boundary after approval. No numeric contract-06 gate or supported-profile reduction is recommended. Any slower freshness/discovery policy would be an additional owner decision, not authorized here.

## 3. Reader capacity: exact cheap parking, not more readers

**Keep the 16-heavy-reader limit. Choose exact compact continuation plus explicit disposal, in a separate native/B12 package provisionally named RCP1.**

There are two different problems:

- Recovery has completed, but its slice ends before the first native capture. The approved continuation ticket addresses this scheduling gap.
- A legal accepted state contains continuity or partial-record information that the existing recovery path cannot safely reproduce. Scheduling priority cannot make that state evictable.

Raising the cap merely moves the failure boundary. It also does not establish the independent 24 MiB transient-buffer or whole-process RSS limits. Weakening §18 reintroduces demonstrated continuity defects. Declaring approval-paused or ended sessions unsupported contradicts the selected supported-profile route.

RCP1 should make the following distinction explicit:

- **Active heavyweight state:** reader/parser buffers, recovery bodies and lookups, captured results and prepared objects capable of retaining native state. At most 16; all allocations count.
- **Parked accepted state:** compact scheduling/debt identity plus an exact durable continuation reference. No retained reader closure, full checkpoint body, recovery lookup, raw tail or hidden `NativeStatusMemory` side cache.

The concrete persistence choice is an **exact accepted continuation witness**, bound to the enclosing accepted observation/checkpoint context and persisted atomically with that accepted state. For Codex this must preserve the meaningful native continuation tuple, including turn/resumption/event-marker state, instead of attempting to infer it from the latest activity label. The existing classifier remains authoritative.

For accepted partial tails, parking must use a proven replay boundary and exact recovery semantics. **Do not persist raw incomplete-record bytes.** Re-reading from the accepted boundary is allowed only with full byte/signature/deadline accounting and a sufficient legal grant. Parked EOF tails must not consume a full native buffer indefinitely or trigger perpetual no-change rereads.

Add an adapter-owned reservation/disposal contract that establishes what can be released and what temporary storage a read/restore may allocate. Merely setting a JavaScript reference to `undefined` or sampling `arrayBuffers` does not prove that the hard bound was respected.

Unaccepted captures, unresolved publication outcomes and delivery obligations remain protected. Parking is not permission to drop them, invent an ACK or publish from a displayed summary.

**Ownership:**

- Native reader/adapter and rollout owners: exact suspension/replay, allocation reservation, disposal and their tests.
- B12/checkpoint owner: private durable continuation representation, version/compatibility handling, accepted-boundary validation and atomicity.
- B16/link continuity owner: capture and consumption of the exact witness without changing the classification or notice truth table.
- B10D: consume the accepted API; do not implement another private recovery mechanism in collector code.

Keep full recovery bodies in the existing bounded durable recovery mechanism and materialize them only for active work. Compact parked metadata remains bounded by the existing active-scope and retirement bounds and still counts toward JS/RSS budgets.

**Acceptance impact:** safe parking must be demonstrated before §18 pins can be removed. Legacy/unknown formats retain conservative handling until an explicitly tested upgrade or recovery path establishes a valid witness.

**[OWNER DECISION REQUIRED: CONTRACT/RECOVERY AND CROSS-PACKAGE CHANGE]** This intentionally expands the presently authorized B10D restoration mechanism and may require versioned private checkpoint/interface changes. It is not covered by the new fairness approval. The owner should approve this package before its implementation brief is commissioned. The 16-reader, 24 MiB, 64/8/4 MiB worker and RSS ceilings remain unchanged.

### No-starvation acceptance

Use the real store and readers, not only scheduler mocks. Required populations include:

- More than 16, and then 200, accepted nonempty approval-paused sessions.
- Ended turns whose timestamps are legally reused.
- Bounded-event-window rollover, non-monotonic timestamps and duplicate markers.
- Sixteen fixed-EOF partial records followed by additional ready sessions.
- Maximum legal records and oversized-record discard continuation.
- Checkpoint-only recovery exhausting the first slice.
- Continuous relevant ledger changes, followed by one final change and no further rescue event.

Compare parked/recovered semantics with an uninterrupted control. Check exact accepted state, continuity, notice history and publication debt, not just node count or successful allocation.

At C=1 s and C=5 s, measure regular grants, inserted continuation attempts, accepted publication progress, oldest demand age and actual burst-drain time. After inputs stop, every target must reach its final required checkpoint/ledger state without an added append, heartbeat, watcher event or clock manipulation.

For each finite fixture, declare the drain bound before the run from its work and scheduler phases. Exceeding it is failure, not permission to extend the run until a favorable sample appears. Keep a real-elapsed 30-minute simultaneous bar/panel run and no-rescue drain.

A reader-count pass without exact 200/200 final-demand settlement is not a liveness pass.

## 4. Confirmed fairness exception

The owner’s new instruction is:

> 公平例外你让一个oracle确认后独立实现即可

**Confirmed: implement §19’s one-use next-normal-opportunity recovery continuation, with the following bounded interpretation.**

- Create a ticket only when an ordinary fair admission completes verified exact recovery but produces no first native result because that granted slice ended.
- Bind it to full session identity, scope/source generation, accepted recovery target and authority generation.
- It may consume the **next already-authorized ordinary collection opportunity’s single reader grant**.
- It cannot self-enqueue an operation, create a timer, obtain another root budget, add a reader grant/publication, or renew authority by itself.
- Preserve the original debt, pending-request and latency ages.
- Invalidate on incompatible scope/source/head/context, expired/lost/follower authority or completed capture.
- A consumed, refused or unusable priority attempt is spent. It cannot rearm indefinitely from the same recovered state. Resume the regular cursor afterward.
- A genuinely new later fair admission may establish new work; it must not be a disguised immediate rearming chain.

**[APPROVED CONTRACT-06/DESIGN-§6 SCHEDULING AMENDMENT]** For a fixed continuously eligible set of N, one regular traversal may consume at most **2N ordinary collection opportunities**, because each regular visit may insert at most one recovery continuation. Keep the ordinary cursor’s order. Include blocked targets in backlog/age accounting. This is a bound on opportunity ordering, not a promise that stalled I/O completes within a wall-clock deadline.

Record regular visits and inserted attempts separately. A missed deadline, refused admission or continued result remains visible and does not count as settled publication. Numeric latency/resource gates, lease TTL, renewal cadence and publication throughput do not change.

Required focused tests:

- Exact recovery consumes the first slice; the next ordinary opportunity reaches a real native read without repeating that recovery fetch.
- A spent/refused ticket cannot monopolize later opportunities.
- Scope ABA, source replacement, head replacement, expiry and follower takeover reject stale tickets.
- The regular 200-target traversal satisfies the new bound at both normal cadences.
- Native capture proceeds through actual publication settlement.
- A useless next deadline remains failed/continued work, rather than a renewed priority loop.

Admission readiness before doomed claim I/O and explicit cleanup of genuinely expired/lost checkpoint-only authority should accompany this work. They reduce waste but must not be represented as sufficient liveness fixes.

This approval does **not** authorize weakening §18, discarding valid recovery repeatedly, increasing caps, omitting retirement debt or merging the worker.

## 5. Retirement recapture is a B10D completion fix

**Fix retirement recapture before B10D acceptance. Do not defer it until after publishing is enabled.**

The final review’s counterexample is supported by the frozen source:

- `reconcileMembership()` marks an evicted owed session `retirement_recapture_required`.
- `pending()` and `collect()` exclude retiring/blocked records.
- The read planner derives its normal candidates from current roots/projected nodes.
- `publishOne()` cannot settle the absent session without a captured reading.

Thus a compatible, definitely absent session can retain debt indefinitely without any later event that makes it readable.

Integrate admitted retirement recapture into the **same bounded fair read planner**, together with in-scope work. There remains one reader grant and one publication opportunity per ordinary operation. Include retirement candidates in scheduling and age evidence; do not build a separate retirement loop.

A retirement read must:

1. Retain affirmative, current same-root structural-absence evidence from B9 before display truncation.
2. Preserve the accepted context and original debt age.
3. Obtain/retain valid authority and exact recovery through the normal APIs.
4. Capture a real reading and settle only compatible current facts.
5. Preserve known outcomes and required transport accounting before cleanup.
6. Use explicit fencing/context-invalidated outcomes when appropriate, never stale publication merely to free capacity.

Unknown structural membership remains unknown. Missing body files, node truncation, terminal status or a missing displayed row alone do not prove removal.

**Closing evidence:**

- An accepted A is evicted while owing one final ledger update.
- Real B9 inputs then remove A from the same root while its run/binding remains compatible.
- Stop all further input changes.
- A receives ordinary recapture and publication opportunities, settles that exact debt and releases its retirement context.
- Repeat beyond the retirement-context capacity under sustained membership churn and show bounded retention and progress.
- Exercise reentry before/after finalization, alternative parent paths, unknown/truncated topology, busy/fenced stores, stale generation and pending outcomes.
- Assert the one-read/one-publication limits and preservation of accepted notice history.

A direct membership-certificate hook test alone does not close production B9 withdrawal/churn coverage.

**Ownership:** B10D collector/link scheduling, membership integration and tests. This uses existing retirement authority semantics; no further contract waiver is needed. If an additional recovery API is required, it belongs to RCP1 rather than an unreviewed B10D shortcut.

## 6. Merge decision and enablement requirements

### Chosen now: keep unmerged

The current branch is NOT ACCEPTED, has measured performance/liveness failures and automatically enables worker publication for an eligible existing ledger. There is no existing production-off flag that makes this frozen image safe to treat as an accepted disabled integration.

### Publishing on

Do not merge with publishing on until:

- Required recovery/parking and retirement work is accepted.
- B12M is actually adopted, including metered lazy use after ACK and exactly-once accounting.
- Native I/O and lazy lookup budgets cannot independently overspend the same remaining allowance.
- LEG1 and current panel content are integrated.
- All required correctness, timing, propagation, resource and no-rescue progress evidence passes on the final image.
- A fresh Oracle accepts the package and the merged-tree check set is green.

Storage tails remain a blocker. The 888 ms `publishPrepared` wrapper is not solved by making legacy collection incremental. If it persists, commission a separately scoped B12 storage investigation/optimization; do not weaken WAL + FULL, change TTLs or combine publication APIs without the appropriate separate decision.

Likewise, no-change wiring, B9, serialization and adoption failures remain in the acceptance list. The chosen architecture is not a prediction that all gates will pass.

### Publishing off

This is a possible **separate owner-approved integration package**, not my recommendation now. It would require a fresh acceptance verdict for the disabled configuration, actual-entry tests proving the current read-only behavior and zero production workers/publication, and no startup/latency/resource regression. Setting the internal collector’s `publish` default to false is insufficient while entries still automatically open the worker.

Such a merge must remain explicitly unqualified for worker enablement. It cannot be called B10D accepted or used to bypass the open findings. Carrying unused code provides too little immediate benefit to justify that additional configuration now.

## 7. Package order

Keep unrelated queued work moving.

1. **Finish the existing disjoint queue:** B10B-S3F, RUNZ1 and HYG2, then DOC2/TPD1 and the queued Inspector/data work according to STATE. B10B-s2 is already merged; do not recreate it.
2. **Record this ruling and the confirmed fairness amendment.** Seek owner approval for LEG1’s new scope and RCP1’s recovery/interface expansion. Other route choices remain recommendations until approved.
3. **Begin the next authorized worker work from the current base:** merge `universal-hud` into the worker branch, preserving B10B-s2 and later renderer/TPD1 changes. This is not a merge of B10D into `universal-hud`.
4. **Implement B10D’s bounded scheduling/accounting fixes:** adopt B12M, implement the approved ticket and authority housekeeping, and complete retirement recapture. Keep these overlapping collector/link changes serial.
5. **After approval, implement LEG1 and RCP1 as separate owned packages.** They may run in parallel only with explicit disjoint ownership: LEG1 catalog/tree files; RCP1 native reader/checkpoint/store files. Their B10D consumption and entry wiring follow serially.
6. **B10D-2 integration and qualification:** consume accepted APIs, use actual current bar and B10B-s2 panel content, and resolve remaining measured performance failures within their proper ownership.
7. **Fresh final Oracle review, then merge only by the existing rule.** No provisional “accept except liveness.”
8. **B14 remains the formal production qualification.** Remote evidence names its host and reports at least three runs; local-only WSL, Herdr and real-harness work is skipped and recorded, never simulated.

B10D-2 must provide separate and simultaneous bar/panel populations, at least 1,000 local operations per declared population, all failed/continued/incomplete rows, all three gates and original full-operation intervals, rolling windows, actual committed panel-content propagation, follower C=1/C=5 results, bounded-memory evidence and the completed soak/drain. Those measurements do not replace B14’s ≥10,000 samples, three fresh starts and supported-platform obligations.

## 8. Decision register

- **Confirmed under new owner approval:** one-use recovery continuation; explicit N→at-most-2N opportunity-ordering exception. Record in contract 06, design §6, concept §15 and STATE.
- **Owner approval still required:** LEG1’s cross-package legacy-collection scope; any proposed discovery/freshness-policy change.
- **Owner approval still required:** RCP1’s exact durable continuation and reader allocation/disposal interfaces, with version/compatibility requirements.
- **No proposed change:** supported 200-node/20,000-header profile; paint/operation/propagation thresholds; stage shares; 16-reader cap; memory, transport or queue ceilings; 15-second lease TTL; WAL + FULL; fencing; atomic publication and durable ACK; B16 notice/classification semantics.
- **No acceptance granted:** B10D remains unmerged and NOT ACCEPTED until the named blockers are closed.

### Sources inspected

- [Current state](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/handoff/STATE.md)
- [Approved worker route](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/reviews/2026-11-02-astra-b10c-worker.md)
- [Contract 06](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/contracts/06-observation.md)
- [Design §6](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/design/hud-information-design.md)
- [B10D rulings](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/handoff/b10d/oracle-1.md), [final review](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/handoff/b10d/oracle-review-2.md), [report](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/handoff/b10d/report.md), [measurement summary](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/handoff/b10d/performance-summary.json)
- [Frozen collector](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/src/collectors/delegation.ts), [publisher](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/src/core/link/publisher.ts), [read scheduler](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/src/core/link/tick.ts)
- [B12M handoff](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/handoff/b12m.md), [B10B-s2 handoff](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/handoff/b10b-s2.md), [TPD1 ownership](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/TPD1.md)