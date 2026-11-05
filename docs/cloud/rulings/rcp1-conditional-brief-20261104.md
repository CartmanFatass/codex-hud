# RCP1: exact accepted continuation, bounded reader suspension and disposal

Date: 2026-11-04 UTC. Role: read-only architecture Oracle.
Repository: CartmanFatass/codex-hud.
Inspected integration image: `universal-hud@935551f0f1281de560431a6d90f9e6ea8c7571ae`.
Inspected worker image: `b10d-worker@4f2c4aced878e5750e66292ed7c552ffb421165d`.
Suggested archival destination: `docs/cloud/rulings/rcp1-conditional-brief-20261104.md`; promote an updated copy to `docs/cloud/RCP1.md` only with its eventual release record.

**CONDITIONAL / NOT RELEASED.** This is a complete conditional design and verification brief, not implementation admission, a source reservation, a compute window, package acceptance, production enablement or permission to merge B10D. No source edits, branch/worktree changes, builds, tests, probes, dependency setup, local-machine operations or repository publication were performed. Source/document copies were inspected and this requested standalone artifact was written.

## 1. Decision and scope

Choose **versioned exact accepted native continuation inside B12's existing private durable checkpoint mechanism, plus adapter-owned bounded allocation and explicit suspension/disposal**. Do not increase the 16-heavy-reader limit, retain hidden reader state outside that count, relax the section-18 guards, infer native history from an activity label, persist an incomplete raw record or introduce another service.

The distinction is:

- **Resident heavyweight work:** an open reader/parser, recovered checkpoint/index lookup, captured ReaderResult, prepared status/checkpoint objects, rollback state or incomplete-record storage that can retain native work. All such ownership counts toward the existing 16-slot/resource ceilings, including a recovered checkpoint before the first read.
- **Parked accepted work:** bounded identity, exact durable target reference, source/scope/context generations, required verification/replay metadata, scheduling/publication debt and original ages. It owns no checkpoint body, live lookup, reader closure, prepared token, full event array, raw tail or NativeStatusMemory copy.

Three problems remain separate:

1. **Completed recovery without a first native capture:** B10D's already approved one-use next-normal-opportunity ticket and authority housekeeping. RCP1 does not implement that scheduler or grant another ticket.
2. **Accepted state that today's restoration cannot reproduce:** RCP1's exact durable continuation and suspension API.
3. **An evicted owed session that leaves the structural scope:** B10D's retirement-recapture integration. RCP1 supplies recovery/disposal APIs but does not decide membership, clear debt or add a retirement loop.

There are two delivery boundaries. RCP1 provides accepted native/B12 APIs and the narrow status-writer/publisher capture seam. **B10D-2 separately consumes them in admission, scheduling, retirement and worker/entry lifecycle**, and qualifies the actual bar/panel image. API tests alone cannot close the frozen worker's liveness or hard aggregate-memory findings. LEG1 remains its own catalog/freshness package; this brief neither repeats nor resolves its F1 policy question.

## 2. Verified source and failure mechanism

The full current Git tree was retrieved with `truncated=false` (1,467 entries); the worker branch was separately checked and still points to the frozen SHA above. Relevant current source identities are:

| File | Git blob |
|---|---|
| `src/core/interfaces/harness-adapter.ts` | `dfde236a3aee635d7b679cdb6bb200f4b4371a13` |
| `src/core/types/checkpoint.ts` | `274c12ff67965086703b9f6bf86a4f2af0528248` |
| `src/core/types/observation.ts` | `e9a155817d782b103708d2ba21965683fde4da7b` |
| `src/core/checkpoint.ts` | `bc772a427ade7a6217fec1d31786fc5ddc144c7b` |
| `src/core/observation-store.ts` | `7b41af93095cc5d434ec88b4a3fb8e6fd8c4f569` |
| `src/harness/codex/index.ts` | `fe0e1253106f7fb18cabd86b1600d0b04ffc7e16` |
| `src/harness/codex/recovery.ts` | `c9a7fbbb4ec1e4a8fbbe09ecba66f9606c974eb6` |
| `src/harness/claude/reader.ts` | `1c44474f9cee866e940334f1e098bbf5e2c53cee` |
| `src/collectors/rollout.ts` | `cb7a4c4c43ac39f4b6f99c0912628ba5bd48ebe1` |
| `src/core/link/reader-status.ts` | `399a30ddcf142c18d018ff768729bd7e5a5a56d8` |
| `src/core/link/publisher.ts` | `3ea07bb2d7303383eb5fd1e1c15a02e2f1d11b77` |
| `src/core/status/writer.ts` | `ea428ac3acc0609c1b15710768ad98cc397dea31` |

The Codex adapter, RolloutParser, Claude reader, native-status translator and checkpoint implementation are byte-identical between this current image and the frozen worker. In contrast, current observation-store/checkpoint types include merged B12M APIs that the worker does not have, and the worker's publisher/collector/scheduler contain unaccepted changes. Do not substitute the worker for an accepted base or lose B12M by using its old store.

Source-supported gaps:

- `SessionReader` currently has only `read()`. Codex `open()` closes over the parser, checkpoint, recovery overlay, pending maps and a promise chain; Claude closes over analogous state and its transient buffer. Neither returns a disposal/resource-reservation API.
- `reader-status.ts` carries seven meaningful fields: `sourceGeneration`, `turnAt`, `resumedAt`, `known`, `lastEvent`, `resetContinuity`, `initialized`. The `codex-working-v1` anchor restores only part of that state. The worker's accepted-marker hook restores one marker only when the accepted native projection is working and context/rule checks pass.
- Frozen `publisher.ts:282–326` therefore correctly refuses eviction when the exact reconstructed tuple differs. The narrow empty non-working case is safe; nonempty approval pauses and ended/reused-turn histories are not covered merely by `activity !== 'working'`.
- Frozen `delegation.ts:275–307` counts readers, checkpoints and publisher readings as residency and excludes accepted partial/discard tails from quiescence. This is a real safety condition, not a mistaken counter to remove.
- Frozen admission at `delegation.ts:327–362` samples `process.memoryUsage().arrayBuffers + 8 MiB`, then clears references on eviction. This cannot prove pre-allocation aggregate limits or physical reuse before GC. Rollout uses repeated `Buffer.concat`, and Claude retains old/new rollback state during a read; both must be included in the allocation proof.
- B12 already detaches and validates prepared recovery, binds its identity to complete-record boundary/index references, publishes checkpoint/index/projection/continuity/notices atomically, and ACKs only after COMMIT. Reuse that mechanism; do not add a collector-private persistence path.
- B12M's meter covers logical decoded SQLite payload and exact lazy reads, not physical storage I/O. Its handoff explicitly leaves native-vs-lazy simultaneous allowance arbitration to the consumer. Adding independent native and recovery limits that both spend the same remaining bytes would remain incorrect.

Retained evidence: the final B10D route reports 166/200 targets still unsettled after the 30-minute run and 5,000-operation no-rescue drain. Its saved diagnostics include 16 checkpoint-only residents, distinct from accepted-history pins. These are prior measurements, not results reproduced here. Storage tails, panel content, B9/no-change shares, propagation and LEG1 remain independent acceptance obligations.

## 3. Hard dependencies and release sequence

The queue ruling permits this read-only preparation, not early execution. Release requires all of the following, in order where stated:

1. Finish the ordered wave-1 work and its actual acceptance/merged-tree gates, then DOC2/TPD1 and the queued Inspector/data work. A source-composition verdict, uploaded archive or documentation commit is not completion of those gates.
2. Revalidate this brief against the then-current **accepted** `universal-hud` commit, contracts, source versions and exact file owners. The inspection SHA above is evidence, not a standing implementation base.
3. Under a separately admitted worker assignment, incorporate current `universal-hud` into the worker branch, preserving accepted B10B-s2/later work. Complete the route's serial B12M adoption, fair ticket/authority housekeeping and retirement scheduling work. This is never a merge of the unaccepted worker into `universal-hud`.
4. Record RCP1's recovery/interface/version scope and exclusive file handoffs. The queue ruling says the broader recorded owner direction removes the old generic permission question; it does **not** remove this package release, reserved decisions, ordered prerequisites or file ownership. Ordinary in-scope design choices do not need repeated generic approval. A newly proposed weakening of continuity/freshness, numeric limits or supported profile remains outside this brief.
5. Record the private-continuation and lifecycle amendment in contract 06, contract 07's version map, design section 6 and concept section 15 through the dispatcher, without repeating or changing the already recorded fairness amendment.
6. Assign a collision-checked branch/worktree and named bounded compute window. Resolve the current interrupted-workload lifecycle hold with authoritative evidence or an explicitly admitted genuinely independent executor. Elapsed time, an empty namespace process listing and a missing execution-session ID do not prove cleanup.
7. Implement/review the native/checkpoint tranche, then the narrow shared publisher seam under exclusive ownership. Later B10D consumption, entry wiring and all end-to-end qualification stay serial with overlapping collector/link work.

LEG1 and RCP1 native/checkpoint work may run in parallel only after these releases and explicit disjoint file ownership. They still may not run competing controlled workloads on the same executor. LEG1's strict-freshness/F1 disposition blocks its production replacement and therefore the chosen B10D completion route, not this read-only RCP1 consultation. Do not make LEG1 reimplementation part of RCP1.

## 4. Conditional ownership, output paths and serialization

No ownership is granted by this document. The proposed complete source whitelist is:

**Native/B12 tranche:**

- `src/core/interfaces/harness-adapter.ts`: additive resource/lifecycle interface and the exact reader-open option.
- `src/core/types/checkpoint.ts`, `src/core/types/observation.ts`, `src/core/interfaces/observation-store.ts`: versioned private continuation/recovery/lifecycle types only.
- `src/core/checkpoint.ts`, `src/core/observation-store.ts`: validation, identity, version-safe persistence/recovery, metered admission and explicit prepared-resource release. No new lease policy, writer queue, journal mode or storage performance project.
- `src/harness/codex/index.ts`, `src/harness/codex/recovery.ts`, `src/harness/codex/recovery-index.ts`: bounded open/restore/replay/dispose and required recovery-version mappings only.
- `src/harness/claude/reader.ts`, `src/harness/claude/index.ts`: the corresponding reader lifecycle/replay implementation.
- `src/collectors/rollout.ts`: native parser allocation, exact tail-replay metadata and explicit release only. Preserve the existing unmetered legacy public behavior and field meanings.
- `src/core/reader-resources.ts` (new): bounded reusable allocation ownership, reservations and counters.
- `src/core/native-continuation.ts` (new): closed DTO validation/capture/restore helpers. No classifier and no persistent side cache.

**Shared capture seam, only after an explicit serial handoff:**

- `src/core/link/reader-status.ts`: capture/restore the exact actual native continuation before/after the existing translator; do not alter its state-selection algorithm.
- `src/core/status/writer.ts`: capture the detached candidate continuation with the same ReaderResult, include it in trusted checkpoint preparation and commit/ACK bookkeeping. Do not modify `mergeStatus` or its truth table.
- `src/core/link/publisher.ts`: supply the actual continuation to that seam, consume successful exact recovery and expose a verified accepted-parking capability. Only this seam and associated cleanup; no fairness scheduler, membership or retirement policy.

The native/B12 and shared-seam tranches have one RCP1 implementer and one package report. They are not parallel writers. The route's B10D owner pauses/relinquishes the shared paths before RCP1 edits them, and receives the accepted API and resulting diff afterward. Reconcile against the actual worker source in the later B10D integration, with the section-17/18 regressions retained. Do not cherry-pick an unaccepted worker file as an RCP1 starting point.

**New test/deliverable whitelist:**

- `tests/unit/rcp1-continuation.test.ts`
- `tests/unit/rcp1-parking.test.ts`
- `tests/unit/rcp1-resources.test.ts`
- `tests/unit/rcp1-versioning.test.ts`
- `tests/unit/rcp1-fixtures.ts`
- `tests/int/rcp1-process.mjs`
- `tests/int/rcp1-performance.mjs`
- `docs/cloud/handoff/rcp1/implementation.md` and `docs/cloud/handoff/rcp1/evidence-manifest.json`, with synthetic raw evidence archived through the approved workflow.

Use existing B12M, B12R, B16, Codex/Claude and rollout fixtures read-only. Existing assertions are not weakened or updated wholesale to make the new versions pass. If an actual compile-compatible fixture change is indispensable, obtain its precise additional path handoff before editing it.

Excluded: `src/collectors/delegation.ts`; `src/core/link/tick.ts`, `read-plan.ts`, `worker-*.ts`; `src/index.ts`, `src/tree-page.ts`; all renderers; LEG1's finder/tree/HudStatus/scan-store/catalog paths; `src/core/status/merge.ts`; ledger/runtime/CLI/MCP/host/authorization code; dependencies/configuration; all existing benchmarks and visual baselines. The queued Inspector conflict producer owns link types/index/conflicts/verify/tick/actions/view-model work, not these reader internals; remaining B9/B16 producer ownership must still be rechecked at release. P065/NODE22/RUNZ1/NEXT remain separate, not imported dependencies.

Shared contract/design/STATE/plan and this brief are dispatcher-serialized records, not extra implementer ownership. No `main` changes, force-push, history rewriting or staging `node_modules/.package-lock.json`.

## 5. Exact accepted-continuation representation

### 5.1 Capture, not reconstruction

The authoritative Codex payload is the **exact post-successful-publication continuation tuple**:

`{ sourceGeneration, turnAt, resumedAt, known, lastEvent, resetContinuity, initialized }`.

Capture from the actual memory advanced by `readerStatusSources` for that same ReaderResult and run/binding context. Do not derive it from the new/current event window, latest activity, `stateSince` or a summary. A paused or ended observation can retain every one of these meaningful fields. No monotonicity/uniqueness assumption may be added to turn timestamps or `[event.kind, event.at]` markers.

The successful publication transition presently clears `resetContinuity`. The candidate witness therefore explicitly describes that **post-ACK state**, with that one documented reset transition. It does not clear live state early. A failed, busy, fenced, conflicted or outcome-uncertain publication leaves the live baseline and obligation unchanged. No detached trial may mutate the actual memory/statistics/reader or fabricate a successful zero-record read.

For Claude, record a closed harness-tagged witness stating that its continuation is the validated checkpoint/index state plus the replay descriptor, with no additional Codex-style native-memory tuple. Prove this against the actual Claude translator and reader. Do not invent synthetic native activity history or copy full `inputs`/facts into another cache.

### 5.2 Private checkpoint choice

Use a named `accepted-native-continuation-v1` payload inside the **existing private prepared recovery bundle**. It includes:

- harness tag and continuation format version;
- existing reader/recovery compatibility version and `STATUS_RULE_VERSION`;
- exact native tuple for Codex, or the explicit Claude checkpoint-only tag;
- runId/bindingGeneration compatibility, bound by the enclosing captured context rather than a guessed latest run;
- a validated reader replay descriptor for the same complete-record boundary and observed fixed input boundary;
- a binding to the enclosing checkpoint/ref/source generation/file identity/offset/recovery references.

Do not put raw identity duplication inside a free-form 2 KiB extension: long identity strings are held in the existing validated enclosing checkpoint/context. A fixed context fingerprint may be used as B12 already uses content identities, with the full enclosing context compared at capture and restore. The tuple/replay extension itself has a proposed **2 KiB encoded ceiling**, included within the unchanged **256 KiB total inline recovery** limit, not added on top. Unknown keys, versions, non-finite/unsafe values, invalid offsets/markers, callable/binary/nested raw state and mismatched context are rejected. A legal supported case that cannot fit remains a failed qualification, not permission to truncate semantics or reclassify the case unsupported.

Prepare must detach and freeze this payload with the same captured ReaderResult before minting the opaque token. Its bytes participate in checkpoint content identity and boundary validation. The tuple cannot be patched into a blob after preparation or accepted by an unverified caller-reported hash. Public display projections/IPC/export carry no witness body. Parked state retains only the exact recovery target/reference, not this payload.

Do not embed the new commit sequence or lease generation inside the checkpoint's content hash. The atomic enclosing ObservationCommit and exact recovery target already bind sequence/domain/authority, and including each commitSeq would defeat no-op/summary-only reuse. Reused immutable continuation is valid only for that same captured native/context state; summary-only commits rebind the existing bundle through the new enclosing committed target. They do not authorize a lookup for an earlier target to read the newer commit.

### 5.3 Version and compatibility decision

This is a new recovery contract, not an optional activity hint. On the inspected base, reserve the following **candidate version map**, to be checked for collisions and formally recorded before release:

- affected native reader successors: `codex-facade-5` and `claude-reader-5`;
- new private checkpoint envelope/schema version 2 for this captured continuation;
- private prepared-format successors `codex-recovery` version 4 and `claude-recovery` version 2;
- the accepted-continuation payload version is 1.

The underlying Codex rollout-v3 facts and existing exact index namespaces need not change merely to rename them. Keep their current recovery-index versions only if their serialized interpretation is unchanged; if replay metadata changes an index DTO, record a separately validated index-version mapping before release. An incompatible index is never relabeled. Generic/legacy schema-1 readers remain a separately decoded conservative path, not silently upgraded to exact parking.

No observation SQLite table-layout change is selected: store the new versioned bundle in existing checkpoint blobs and references, preserving cheap projection reads. Update closed validators and codecs explicitly. If implementation requires new columns/tables, that is an additional bounded layout/old-writer disposition, not incidental ownership permission. Ledger schema v1, export v1, public snapshots/old `--json` and LEG1's scan version remain untouched.

Default old-format policy: **no witness synthesis**. Existing compatible legacy recovery may continue only under its conservative eligibility rules. A new reader-version cutover uses the existing lease-fenced controlled rebuild: correct next source generation, explicit `reader_version_rebuild` gap, reset unprovable continuity, offset/state/index reset together, and retired old writer protection. Do not erase a payload while preserving its old offset, retroactively write an inferred tuple, or claim old accepted history was exact. A proven lossless upgrade would need its own precise equivalence evidence; it is not required or pre-approved here. Preserve already required notice history/acknowledgement semantics through the documented version transition, and never turn controlled rebuilding into blanket deletion of accepted notices.

## 6. Publication, recovery and acceptance proof

1. A native read produces one detached result. The existing native translator advances actual memory once. Capture the continuation, checkpoint, summary source boundary and run/binding context together.
2. Trusted B12 preparation validates all parts and index references, reserves encoding/temporary memory first and freezes a single candidate. Failure leaves the old accepted state and actual debt intact.
3. Existing B16 classification runs once. Publish checkpoint/witness/index, summary, continuity, notice/dedup state and sequence through the same WAL + FULL fenced transaction, with same-instance authority and previousCommitSeq checks.
4. Only confirmed durable commit, or the existing exact legal no-op acceptance of matching content, may make the candidate parkable and advance the relevant accepted token. Transport consumption/paint ACK is not durable reader ACK.
5. If a callback throws after a confirmed commit, retain the confirmed outcome and reconcile exact durable identity. Do not roll back by assertion or emit an unaccepted-publication claim for an already accepted commit. If COMMIT outcome is uncertain, keep it unresolved and use the existing exact-head reconciliation before discard/retry.
6. `readRecoveryMetered` selects the exact full target in one snapshot and returns its validated bundle plus only its pinned lazy lookup. Wrong ref/source/store/generation/domain/commit/content/file/offset/rule/run/binding rejects; no latest-map substitution. Absence/continuation does not create restoration proof.
7. Restore the tuple **before** classifying the first real post-restore native result. For every new-format accepted state, the restored seven fields must equal the actual post-acceptance fields immediately, not after a zero-read trial repairs them. Compare all required Claude recovery state likewise.
8. Restore does not grant a lease. On ordinary reacquisition or replacement, the owner obtains new authority through existing APIs and separately verifies accepted source/context. A persisted witness never contains an authority token. A still-matching accepted semantic witness can be reused under correctly reacquired authority, while a ticket tied to an old authority generation cannot.

After restoration, use the unchanged `readerStatusSources` and `mergeStatus`. Loss of every old qualifying event, genuine context/reset changes and timestamp anomalies must produce the same intrinsic fallback as the uninterrupted control, not unconditional continuity preservation. Rule-version mismatch remains conservative. Both `stateSince` and its basis, pending episode, outcome, notices and deduplication are part of equality, not only the visible activity label.

## 7. Partial-tail, discard and no-change resumption

### 7.1 Durable boundary

Ordinary `offset`, summaries, exact ID/tool/clock state and continuation are always the **last complete-record boundary**. Durable `pendingBytes` is always `[]`. No incomplete UTF-8, CRLF fragment, private api-request blob, claim or other raw tail may enter a checkpoint, witness, log, temporary bundle, raw/base64/binary extension or IPC.

A replay descriptor holds only validated metadata: complete-record offset; observed fixed target size/position; count of incomplete bytes; `tailAtEof`; discard state/cursor; file identity/stat witness and the existing bounded signature/reset provenance. It must agree with the reader's checkpoint fields. It is not a second offset that advances summaries past a partial record.

For oversized-record discard, preserve the advancing discard cursor and one already counted `oversize_unknown`/gap state. Resumption continues discarding without rereading the whole prefix or incrementing the same gap repeatedly. Never convert an incomplete tail to complete solely because its raw buffer was released.

### 7.2 Fixed EOF without a perpetual reread loop

An accepted, fixed-EOF incomplete record may be suspended after its exact replay descriptor is durable. Release its full tail storage. A parked entry creates no work merely because it is parked; preserve its existing caught-up/partial state and normal invalidation/debt schedule.

On a later selected read, a restored reader may recognize that **the previously inspected incomplete fixed boundary is unchanged**, using current file identity, size, mtime/ctime and the same required bounded signature/source checks under contract 06's declared append-only-between-observed-resets model. In that proven unchanged case, it may return the same complete-boundary native state and truthful `partial/incomplete_tail` coverage without allocating/rereading the raw incomplete record. This is a real selected verification step whose I/O/time is charged; cached projection return alone is not such a read. It does not advance event clocks, offset or claim completion. Source successful-read freshness advances only if the existing reader's actual successful verification semantics are satisfied.

If a descriptor/check is missing, incompatible or ambiguous, use normal metered replay from the complete boundary. Growth, a changed stat/signature, inode/source replacement, truncation, compaction or branch reset invalidates the unchanged-EOF optimization. Revalidate before/after relevant reads; never concatenate old-source transient bytes with a replacement. Preserve the bounded-signature diagnostic and its limits: this is not proof against arbitrary interior rewrites that preserve every observed witness, and it introduces no full-prefix hash or new freshness waiver.

This path is an explicit reader-versioned optimization requiring the equivalence tests below. If a harness cannot establish its no-change premise within the existing model, keep the conservative path and report that its resource/progress target is unclosed. Do not assert that watcher silence proves it.

### 7.3 A sufficient replay slice and retained progress

When new source bytes make replay necessary, request the actual record+delimiter+signature+recovery work required by the implementation. A legal line contains up to 1 MiB before LF, including CR; LF may add one byte. Charge rereads, prefetched but unprocessed bytes, recovery lookups and verification. A byte shortage returns truthful `record_needs_larger_slice.minimumBytes`; elapsed soft time or recovery/record-count exhaustion is not a fabricated byte shortage.

The next eligible sufficient slice must consume the record or make real bounded discard/recovery progress. Do not repeatedly park a reader between partial unaccepted steps and restart from the same boundary. A captured unaccepted result remains pinned. Recovery-complete/first-read-pending remains a resident phase protected by the approved B10D ticket, not a new ordinary eviction victim.

An accepted catch-up/discard continuation can be suspended only when the exact durable cursor/metadata guarantee forward replay and there is no unaccepted/callback/outcome obligation. This does not declare it finished or remove it from backlog. A fixed EOF state may wait for actual source/debt work without holding a full buffer; growing maximum-record work must retain enough uninterrupted opportunity to progress. All 200 supported sessions, not just the first 16, must settle final demand without rescue input.

## 8. Explicit resource and reader lifecycle API

Names below specify the required behavior; keep the final public-internal names coherent in the implementation report.

- `ReaderResources.reserve(plan)`: synchronously admit an allocation plan before any native reader open/restore/clone/encode/read allocation. Refusal returns a fixed capacity result and changes no accepted state. It never triggers I/O, a timer or collection.
- An optional additive `HarnessAdapter.open` options object accepts the reservation and current collection grant; existing callers retain old semantics until explicitly adopted. Production RCP1-capable readers advertise that capability. An adapter without it is not quietly counted as safely disposable.
- `SessionReader.suspensionState()`: bounded metadata-only capability inspection. It identifies live/unaccepted/in-flight/replay state and bytes owned, but does not certify publication acceptance or perform a checkpoint query.
- `SessionReader.dispose(reason)`: idempotently closes admission, settles/invalidates its own active work under the owner protocol, closes owned handles and releases every parser/index/callback/buffer reference. It returns an explicit settled resource receipt. After disposal, reads fail with a fixed closed result rather than reopening. No lease release, publication, callback ACK or extra source read is implied by disposal itself.
- Prepared checkpoint/status resources need an explicit invalidation/release path for recovery handoffs, lookup closures and onCommitted callbacks after accepted parking or justified invalidation. Merely removing the reader while another prepared/result object holds its callback is not disposal.

The collector performs one atomic logical park transition: verify durable accepted identity and all candidate/outcome guards, retain compact target/debt/age, invalidate old resource handles, dispose the reader and captured/prepared runtime, then mark the slot reusable only when disposal really settles. If any precondition fails, keep the state resident and report why. There is no permissive `force=true` or caller boolean that bypasses accepted-boundary verification.

**Allocation model:** use bounded reusable backing storage or another equally explicit pre-allocation ownership mechanism. Repeatedly assigning `undefined` and decrementing a counter does not free a Buffer's backing store before GC. Prefer fixed-capacity tail storage/read scratch with cursor lengths instead of repeated whole-tail `Buffer.concat`; rollback holds cursors/immutable committed metadata rather than an unaccounted second tail copy. Every simultaneous old/new/copy/signature/serialization buffer is reserved. A released arena region is not reusable while any live view/callback/result can alias it; no raw arena view escapes in ReaderResult or a display DTO. Diagnostic counters report owned backing capacity, live suballocations, peak reservation and refusal, separately from sampled `arrayBuffers`/external/heap/RSS.

The hard cap remains **24 MiB aggregate owned external buffers**, including native tails/read/rollback/transfer allocations and relevant main/worker participants, not 24 MiB per adapter, per thread or per source. The eventual B10D owner assigns one aggregate quota with explicit partitions/peer reservations before either side allocates. RCP1 proves its component allocator against those reservations; worker/transport/main-root adoption is still required before claiming the aggregate gate. SQLite/native allocation not controlled by this arena remains visible in whole-process measurement. Preallocating the entire ceiling is not automatically acceptable if it violates RSS or startup gates.

Other unchanged bounds:

- at most 16 heavyweight resident phases, including checkpoint-only recovery, pending readers and prepared/captured runtime;
- at most 200 active-scope metadata records plus the existing at-most-16 retirement contexts, with no second unbounded parked map;
- proposed extra compact parked-descriptor storage at most 2 KiB per existing lifecycle entry and 512 KiB aggregate, counting exact keys/strings/queue references rather than only JSON lengths. Reuse bounded existing identities rather than duplicate arbitrary source strings. A supported input exceeding this proposed allowance needs an explicit bounded representation disposition, not silent truncation;
- 256 KiB inline recovery, 1 MiB legal record, existing index/page limits, 2 MiB encoded result, worker 64/8/4 MiB V8 limits;
- shared 8 MiB operation allowance, normal native slice at most 4 MiB/2,000 records/soft 20 ms within the existing shared deadline; no donation of a second native allowance;
- whole-process RSS delta at most 32 MiB steady / 64 MiB peak against the matched synchronous profile. Do not sum the same process RSS reported by its threads.

Native and B12M work must share an authoritative remaining-byte/deadline balance. Either reserve disjoint native/recovery suballowances before execution, including adequate legal-record/lazy-read progress, or charge actual native I/O into the same grant before lazy reads can spend it. An after-the-fact sum alone cannot prevent overspending. Return/refusal/throw/rollback all retain actual charges; the B12M `drain()` contract prevents double counting. Meter definitions distinguish logical decoded SQLite payload from physical I/O and wall time.

## 9. Owner, shutdown and invalidation lifecycle

The existing HUD process owns its single observation worker; that worker owns its store, publishers, native readers, prepared objects, lookups and resource manager. No token/lease/reader crosses IPC. Source-specific adapter resources are beneath that owner; disposal does not create an independent process or service.

One reader has at most one active operation. A second read is explicitly refused/coalesced by the owner, not silently appended to an unbounded promise chain. Disposal fences further calls immediately. An already issued filesystem/SQLite operation is not declared cancelled because its caller stopped awaiting it; its reservation remains charged until completion/authoritative owner termination. Late callbacks are generation-fenced and cannot ACK, republish, reacquire or repopulate released state.

Distinguish these paths:

- **Quiescent accepted parking:** preserve exact durable target and debt, and release only disposable native runtime. It may retain the existing publisher's authority bookkeeping according to the normal scheduler; it does not renew/acquire/release another owner's lease.
- **Authority expiry/loss/follower:** invalidate the old runtime and ticket, preserve debt/outcomes, and do not release or alter a competitor's lease. Later reacquisition restores through the normal exact target API. A reader's continuing existence is not authority.
- **Source/store/root/run/binding change and A→B→A:** fence by store/source instance plus source generation, scope epoch and context, not bare path/sessionId equality. Old tuples/lookups/callbacks cannot attach to a new context. Root removal still needs B9 affirmative structural evidence before retirement.
- **Retirement:** preserve captured candidates, owed ledger facts and known delivery outcomes until existing settlement/explicit invalidation. The adapter may dispose when authorized by that lifecycle; it may not decide a missing displayed row is safe deletion.
- **HUD/worker close:** stop admission, settle/account the active operation, release valid own leases best-effort and close readers then stores. Close/recovery/checkpoint costs remain in the actual interval. Keep the existing 2-second graceful owner allowance, then the owner's termination path; unresolved commit is crash recovery, not assumed rollback. At most one automatic replacement per HUD lifetime, on an ordinary opportunity only after old worker exit is established; no concurrent replacement or respawn loop.

RCP1 does not add a timer, watcher, renewal loop, background flusher, periodic disposer or global process kill. Tests own PIDs/handles and must prove termination/cleanup; never kill by name/pattern. The current project-wide restrictions on assistant-run local tests remain in force.

## 10. Required tests and meaningful negative controls

Use real temporary source files, real native readers, actual B12/B16 preparation/publication and temporary SQLite stores. Scheduler fakes alone cannot establish continuation, memory or no-starvation. Deterministic correctness clocks and real-time qualification are separate.

**A. Exact Codex continuation.** Accept >16 and then 200 nonempty approval-paused states, and ended turns whose timestamps are reused later. Park/recover/append through the real accepted path and compare an uninterrupted control with identical prior accepted state, inputs and clock. Test working with observed stateSince/no working anchor; window rollover at 60 events; near-full/multi-event append; non-monotonic timestamps; duplicate kind/time markers; a last non-resumption marker; and complete loss of old proof. Assert the immediate seven-field tuple, stateSince/basis, activity/pending/outcome, exact notice history/dedup, offsets, source generation and publication debt. Do not reset the expected tuple from the recaptured current event array.

**B. Claude equivalence.** Large exact usage-ID history, delayed tool results/open calls, fact-clock pages, duplicate messages, compact boundaries, link metadata and maximum public-parameter extraction. Restart/park recovery must match uninterrupted usage, clocks, pending state and notices without fully loading the index or retaining private materials.

**C. Partial/discard progression.** Sixteen fixed-EOF incomplete tails followed by ready sessions must permit progress beyond the original sixteen after accepted suspension. Repeat with >16/200 targets, UTF-8 and CRLF splits, partial private blobs/claims, exactly maximum legal records including LF, valid newline-free EOF, oversized no-newline records, and restarts at every discard step. No durable product contains raw sentinels, including encoded/binary nesting. Assert exact offsets, incomplete coverage, gap counted once, no repeated unchanged-EOF raw reads and one sufficient later slice's real progress. Record size/signature bytes, not just records.

**D. Rewrite/reset safety.** Append, same-size changed-stat rewrite, truncate-and-regrow, inode/path replacement, source/store replacement, compaction, branch change, source mutation during verification and source ABA reject stale replay state. No old tail is concatenated. State/clock reset matches the existing declared model; tests for undetectable bounded-signature interior changes label that model limit rather than falsely promise detection.

**E. Atomicity, identity and ACK.** Crash before/after preparation, transaction/COMMIT and callback; late former writer; wrong ref/domain/commit/content/file/offset/context/rule/version; recovery stale/continued/refused; summary-only commit invalidating an old lookup; failed ACK callback after a real commit; uncertain COMMIT. Inspect both projection and recovery and prove old complete or new complete state only. No premature notice cursor/reader ACK and no duplicate accepted notice after recovery.

**F. Parking protections.** Actual unaccepted result/prepared candidate, active read, unresolved publication outcome, pending delivery, stale accepted target and missing/old witness cannot pass accepted parking. Do not clear pending flags to manufacture eligibility. New owed ledger demand may survive otherwise accepted parking with its original age. Test one final relevant change followed by no further event, and no-demand parking that produces zero reconstruction loop.

**G. Metering/admission.** Before-allocation refusal, native+lazy consumption contention, lazy use after ACK under the current grant, exact once-only drain on errors, maximum-record restore sizing, small-page refusal without starvation, and spent slice after exact recovery. No two consumers independently spend the same remaining bytes. Preserve recordsRead/elapsed distinctions and unchanged bytes on no-op verification.

**H. Resource/disposal.** Instrument allocation ownership deterministically, including concat/copy/rollback/signature/encoding and retained callbacks. Repeatedly fill, park, restore, replace source and close under delayed/no-forced-GC conditions. A disposed slot's storage is either reusable without new backing allocation or still charged. Retained consumer result references cannot alias reused arena bytes. Assert counts and bytes on every allocation edge, not just end-of-test memory samples. Also record real external/arrayBuffers/heap/whole-process RSS with matched baseline; no `global.gc()` dependence for correctness.

**I. Lifecycle.** Open/read/dispose races; duplicate close; held read during shutdown; filesystem failure after partial work; old callback after source ABA; store closed before stale deactivator; follower/expiry/takeover; only own lease release; owner death and one replacement after actual exit. Record authoritative direct-child/descendant and handle cleanup, with unresolved operations kept unknown if the environment cannot prove them.

**J. Versioning/privacy.** Old reader/checkpoint/index formats, corrupt/missing/unknown witness, oversized extension and nested secret sentinel, new/old readers coexisting, old prepared writer after controlled rebuild, unchanged public snapshot/export/--json. Known schema is not permission to deserialize arbitrary V8 state or simply delete a raw tail and keep offset. Exact upgrade is not inferred.

**K. Later B10D integration, mandatory before enablement.** The real scheduler must consume accepted APIs for ordinary and retirement recapture, clear all heavyweight references at actual park points and account resources across main/worker/transport. Verify next-opportunity ticket produces native work without refetching exact completed recovery, then normal durable settlement; one-use/refusal/expiry/context rules; fixed continuously eligible N has at most 2N ordinary opportunities per regular traversal, with blocked targets still counted. Exercise C=1 s and C=5 s, source/root transitions, fixed EOF tails, sustained relevant ledger changes then final no-rescue demand, and retirement churn beyond 16 contexts. Require exact 200/200 final-state settlement, not 200 allocations or a low resident counter. RCP1 unit/API acceptance is not this evidence.

For each new regression retain a meaningful failing-before or controlled mutation: omit one tuple field; restore from the new instead of accepted window; accept activity-not-working alone; ignore pending/outcome guard; free reservation before a retained view is released; let native/lazy double-spend; reread unchanged EOF indefinitely; drop discard cursor; suppress a debt flag; ACK before COMMIT; accept wrong target/version. The control must reach the semantic assertion. An import/build error, denied socket, unrelated timeout or unavailable helper is not a successful negative control. Restore and identify the final source afterward. Do not mutate an in-flight qualification image.

## 11. Commands, timeouts and evidence after release

This is a future command inventory, **not permission to execute it now**. Each group needs an exact frozen source/build identity, admitted executor/runtime, temporary HOME/HUD_HOME, named owner/supervisor, UTC interval, outer timeout and explicit cleanup/return point. Run Node 22 >=22.13 and Node 24 in separately admitted groups; keep any required enabled proxy/profile context from the accepted base. No parallel controlled workloads on the same executor.

1. `npm run build && npm run build:test && npm run build:hud-mcp` — 300 s.
2. `node --test --test-concurrency=1 dist-test/tests/unit/rcp1-continuation.test.js dist-test/tests/unit/rcp1-parking.test.js dist-test/tests/unit/rcp1-resources.test.js dist-test/tests/unit/rcp1-versioning.test.js` — 600 s.
3. `node --test --test-concurrency=1 dist-test/tests/unit/b12-store.test.js dist-test/tests/unit/b12d-wal.test.js dist-test/tests/unit/b12r-store.test.js dist-test/tests/unit/b12r-codex-recovery.test.js dist-test/tests/unit/b12r-claude-recovery.test.js dist-test/tests/unit/b12m-metered.test.js dist-test/tests/unit/b12m-compat.test.js dist-test/tests/unit/b16-writer.test.js` — 600 s.
4. `node --test --test-concurrency=1 dist-test/tests/unit/codex-facade.test.js dist-test/tests/unit/claude-reader.test.js dist-test/tests/unit/claude-recovery.test.js dist-test/tests/unit/claude-regressions.test.js dist-test/tests/unit/rollout-budget.test.js dist-test/tests/unit/rollout-replay.test.js dist-test/tests/unit/rollout-live.test.js dist-test/tests/unit/b10c-native.test.js` — 600 s.
5. `node --test tests/int/rcp1-process.mjs` — 600 s, only on an admitted executor with the required already-authorized process facilities. Preserve any blocked lifecycle stage; do not retry a known denial with a different wrapper.
6. `env -u NO_COLOR -u FORCE_COLOR -u HUD_HOME HOME=<fresh temporary directory> npm test` — 900 s.
7. `npm run test:core` — 600 s.
8. `npm run test:visual` — 300 s.
9. `npm run test:hud-mcp` — 600 s.
10. `npm run format:check` — 300 s.
11. `npm run check:fixtures` — 120 s.
12. `git diff --check` — 30 s.
13. `node tests/int/rcp1-performance.mjs` — separately admitted 1,800 s per runtime series; three fresh-process repeats, each at least 1,000 measured API operations per predeclared unchanged/park-recover/changed-checkpoint/partial-tail/maximum-record population, plus separately labeled startup/rebuild/disposal. The fixed harness emits all raw rows, work/reservation counts, failures and incomplete outcomes. This component series is not B10D/B14 qualification.

The later B10D-2 release must specify its actual final-entry command group, separately and simultaneously for bar/panel, including at least 1,000 operations per declared population, the real-elapsed 30-minute run and no-rescue drain at both cadences. Predeclare the drain limit from finite input work, required native/recovery slices, scheduler phases, authority/publication behavior and debt count **before** running. The at-most-2N ordering bound alone is not a drain-time formula. A practical initial outer window may be at most 7,200 s per declared soak/drain case only if that pre-run proof fits; otherwise request a correctly sized bounded window before launch. Do not silently shorten the 30-minute soak or extend a failed drain until it happens to pass.

Record n, warm-up, nearest-rank p50/p95/p99/max, rolling windows, all repeated runs/ranges, attempts/refusals/continued/incomplete rows, regular versus inserted opportunities, accepted publication progress, oldest demand age and final exact settled-state counts. Use real monotonic timing for performance; synthetic clocks only establish correctness. Name host/CPU/OS/filesystem, Node and actual linked SQLite versions/settings, code/build/profile hashes and source fixture counts/bytes.

Evidence paths: `tmp/tasks/RCP1/<exact-candidate>/<runtime>/<run>/` for command manifest, stdout/stderr, direct and outer exits, before/after artifact hashes, allocation/reservation traces, raw timing/operation/debt rows, SQLite projection/recovery checks and authoritative process/handle custody. Archive only synthetic inputs/logs under `docs/cloud/handoff/rcp1/` or the approved research archive and link the exact content/hash. Record lost/partial artifacts honestly rather than reconstructing and labeling them original.

Retain the full README check set and current base failures. A permitted known flake is rerun once alone with both results retained; unknown/red/unrun stages remain such. A timeout, tool-session disappearance or wrapper return is not proof that owned descendants exited. Known denied facilities remain blocked until materially relevant authority/capability changes under the existing ruling.

Unchanged B10D gates include paint p99 <50 ms / max <200 ms, selected operation p99 <100 ms / max <1,000 ms, local post-commit paint p99 <50 ms / max <200 ms, and follower p99 <C+100 ms / max <C+1,000 ms, plus original rolling-window and stage-share gates. Recovery, serialization, cleanup and storage costs stay in their actual operation. No summary of API timing replaces the original full-operation interval. Formal B14 still needs >=10,000 samples, >=3 fresh starts and its supported-platform/SQLite/WAL/lifecycle obligations. WSL, real harness, Herdr/tmux/live-home qualification is owner-local, skipped and recorded here, never simulated.

## 12. Acceptance, hierarchy and stop conditions

After release, one Astra-high implementer owns this whitelist. Fresh Astra-max Oracles handle material design questions, the final source/report/evidence review and any prescribed re-check. The dispatcher schedules, records and applies the existing at-most-two-fix-round and merge rules; it does not manufacture architecture acceptance itself. No subagents were started in this consultation.

RCP1 API/capture acceptance requires all of sections 5–10A–J, version/privacy proofs, bounded allocations, complete raw evidence and the required full checks. It may report that B10D adoption/qualification is pending, but must not call the worker's resource/liveness gate closed. B10D enablement additionally needs section 10K, accepted LEG1 integration/freshness disposition, retirement recapture, current panel content, actual main/worker aggregate accounting, remaining storage/latency fixes and fresh final Oracle acceptance. Keep the worker unmerged until its original rule is met.

Stop the dependent action on missing accepted base, queued prerequisite, version/ownership collision, absent resource window, unresolved process custody, denied/uncertain operation, out-of-whitelist change, unknown restoration semantics, unsatisfied allocation bound, continual replay without finite progress, required new layout policy, or a proposed gate/profile/freshness/continuity relaxation. Preserve safe completed work and return the exact blocker; do not silently raise caps, hide partial results, clear debt, weaken section 18, invent a grace window or start a new executor to bypass a denial.

**Final disposition:** exact private accepted continuation plus bounded adapter disposal is the selected conditional RCP1 design. The necessary producer, durable identity, replay, resource and lifecycle contracts are specified here. Its implementation remains **NOT RELEASED**, and no correctness, performance, 200-session liveness, aggregate-memory, acceptance or merge-readiness claim is made.

## Source references

All current links use the inspected integration SHA; source line numbers above refer to those exact files or the explicitly named frozen worker.

- [AGENTS](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/AGENTS.md), [dots workflow](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/cloud/dots.md), [STATE/queue](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/handoff/STATE.md), [queue preparation ruling](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/cloud/rulings/queue-progress-20261103.md).
- [B10D route sections 3–8](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/cloud/rulings/b10d-route.md), [section-17/18/19 implementation rulings](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/handoff/b10d/oracle-1.md), [final worker review](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/handoff/b10d/oracle-review-2.md).
- [Contract 06](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/contracts/06-observation.md), [contract 07](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/contracts/07-outbound-compat.md), [design section 6](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/design/hud-information-design.md), [concept decision log](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/universal-hud-concept.md), [architecture](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/ARCHITECTURE.md).
- [Approved worker resource/lifecycle route](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/reviews/2026-11-02-astra-b10c-worker.md), [B12M handoff](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/cloud/handoff/b12m.md), [B12M current store](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/src/core/observation-store.ts).
- [Reader interface](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/src/core/interfaces/harness-adapter.ts), [Codex reader](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/src/harness/codex/index.ts), [rollout parser](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/src/collectors/rollout.ts), [Claude reader](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/src/harness/claude/reader.ts).
- [Native continuation translator](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/src/core/link/reader-status.ts), [status writer](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/src/core/status/writer.ts), [checkpoint validation/preparation](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/src/core/checkpoint.ts).
- [Frozen publisher guards](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/src/core/link/publisher.ts), [frozen collector admission/retirement](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/src/collectors/delegation.ts), [retained final evidence](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/handoff/b10d/performance-summary.json).
- [Recorded LEG1 conditional brief](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/cloud/rulings/leg1-conditional-brief-20261104.md), [LEG1 freshness disposition](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/cloud/rulings/leg1-freshness-disposition-20261104.md), [Inspector producer scope](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/cloud/rulings/inspector-conflict-prerequisite-20261104.md).
- [Resource-window rules](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/cloud/rulings/wave1-resource-windows-20261103.md), [interrupted-build lifecycle ruling](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/cloud/rulings/p065-interrupted-build.md), [README full checks](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/cloud/README.md), [complete-brief requirements](https://github.com/CartmanFatass/codex-hud/blob/935551f0f1281de560431a6d90f9e6ea8c7571ae/docs/universal-hud-engineering-plan.md).
