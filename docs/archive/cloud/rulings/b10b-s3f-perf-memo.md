# B10B-S3F-PERF whole-tree memo scope ruling

Date: 2026-11-03. Read-only design consultation, not an acceptance review.

## Decision

**A one-entry whole-tree memo is within the existing remediation scope, conditionally on the matched baseline and diagnostic profile justifying this mechanism.** Replace only `projectDelegation`'s whole-tree WeakMap with one last `(tree, details, capacity, result)` record. Preserve the per-node `ProjectionCache`, its complete facts comparison and disappeared-node sweep, and every existing snapshot's meaning. Do not proceed to structural plan reuse on the strength of this ruling.

This changes an internal reuse/eviction policy, not a contract, gate, supported runtime or another package's ownership. It is not evidence that the proposed optimization works. B10B-S3F remains unaccepted: R1 stays fixed, R2 remains open, R3 stays non-blocking, and the independent full-check and merged-tree gates remain in force.

## Basis and exact identity boundary

The inspected implementation is `bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60`, the brief's base. The live source on `dots/b10b-s3f` agrees at `projection.ts:323–345` (file blob `f5f4c32195e83d1da2a38c1b1161d094e1fb8e4b`). The approved performance brief was read on `universal-hud` (blob `a26109b36b43de174e1702ae5ed3090839be6908`), together with the performance ruling and relevant design, workflow, source and tests.

Design §6 requires correct node/row/card caching, bounded work, current-input invalidation and the unchanged no-change/changed gates. It does not promise an indefinitely interned whole-projection object for every live VM. The existing identity test at `b10b-projection.test.ts:224–232` covers immediate reuse. Moreover, even the current WeakMap stores only one details/capacity variant per tree, so it already does not promise historical identity for every previously seen tuple. The protected `older` behavior in the segment-3 ruling concerns keeping shown and history-hidden plans together, not keeping every historical tree in `projectDelegation`.

Required behavior:

1. With the shared cache and its current stored VM, repeated unchanged calls return the same whole-projection object. Keep all three reference checks: tree, details and capacity.
2. A new VM envelope sharing those three objects must return a projection whose `vm` is that exact incoming envelope, without changing the stored/previous projection's `vm`. Preserve the existing shallow-wrapper behavior; do not collapse different envelopes into the old VM. Do not introduce extra identity guarantees for wrapper-only calls.
3. A different tree, details object or capacity object is a miss. Build against that input and replace the sole record. Capacity-only changes, including null transitions, must not expose stale capacity through `proj.vm`.
4. For live A and B with different memo tuples, A → B → A may produce a new whole-projection object on the third call. It must be semantically equivalent to projecting A with a fresh `ProjectionCache`. The first A and B results remain independently usable. For A and B differing only in envelope identity, rule 2 applies instead.
5. Per-node `NodeProjection` identity may still be reused after complete fact equality, as today. Do not pool or retarget `DelegationProjection`, `PNode`, topology, plans, destinations or descriptors across snapshots. A new projection's `PNode.node` and relation references must belong to its own input. A retained frame's action still carries the exact descriptor object that frame saw.
6. An explicitly supplied non-shared `ProjectionCache` continues to bypass the whole-tree memo. It must neither consume a shared-memo hit nor evict/replace that shared record. Preserve cache counters and sweep behavior.

These rules retain the existing immutable-input assumption. This change does not authorize weaker invalidation or claim support for mutating an already memoized input in place.

## Two alternating VMs and the old diagnostic

`tests/unit/b10b-s2-perf.test.ts:218–219,257–258` prints an **unasserted** alternating-two-VM diagnostic. Its wording describes the present WeakMap's behavior; it is not a contractual two-entry capacity or a gated workload. Under the one-entry implementation, distinct A/B tuples miss on each alternation, so the explanatory phrase “two memoised view models” no longer describes the internal hit state.

Leave that frozen benchmark and its raw output untouched. In the new report, explicitly identify these two labels and explain that they now measure alternating live-VM reprojection rather than two whole-tree hits. Report the before/after numbers, including any slowdown. Do not call the candidate population a fully memoized no-change path, hide it, or substitute it for the actual no-change/changed gates.

A second slot is not required to satisfy an existing contract. Do not add it merely to keep that diagnostic's label literally true. If real caller evidence shows that single-entry thrashing causes an unacceptable regression, return the evidence and a bounded-policy recommendation for another consultation; do not quietly change capacity or broaden into structural plan reuse. The genuine unchanged-VM no-change gates remain unchanged.

## Bounds and diagnosis

The proposed memo owns **at most one complete projection/VM tuple**. Replacing it must drop the previous record's references, with no history list, side map or back-link retaining evicted records. A strong last-entry memo can retain its latest snapshot while idle; disclose this bounded retention rather than claiming zero idle retention. Caller-held old frames legitimately keep their snapshots alive. Do not claim that total application memory is bounded independently of how many snapshots callers retain.

Keep the existing per-node sweep, four-plan-per-projection bound, eight-row-string-per-node-projection bound, and `CARD_CACHE_LIMIT = 500` with its existing eviction policies. Do not enlarge downstream caches or weaken cleanup to compensate for misses. This ruling does not replace existing memory/profile limits with a new byte allowance.

**The source shape alone does not prove a leak.** A WeakMap value referring back to its key does not by itself permanently retain an otherwise unreachable pair. Garbage collection may be delayed, and live keys can retain associated graphs; the actual retention roots and collection cost need evidence. See the [ECMAScript WeakMap specification](https://tc39.es/ecma262/multipage/keyed-collections.html#sec-weakmap-objects).

After the strict baseline, separately profile the production-shaped fresh-clone workload. Record the allocation/retention paths and, for a claimed GC-tail improvement, correlate GC with samples and identify the affected mechanism. Distinguish inputs intentionally held live, caller-held results, transient collectible graphs and the one strongly retained last result. Compare baseline/candidate on the same host, runtime patches, dependencies and workload. A reduction in WeakMap entries is not by itself proof of lower retained bytes or faster tails. Instrumentation and any diagnostic-only GC controls must be disclosed and must not enter acceptance runs or production.

## Required regression evidence

Add focused coverage in the brief's owned tests, principally the new `b10b-s3-perf-regression.test.ts`:

- Consecutive hit identity, envelope-only correctness without old-result mutation, separate tree/details/capacity invalidation, and non-shared-cache bypass without disturbing the shared record.
- Deterministic A → B → A eviction with distinct live trees, equal rebuilds, one-fact change and return to the prior value. Compare warm and fresh-cache projections/rendering. A test asserting whole-result non-identity after eviction can fail on the baseline and pass on the candidate, but label it a new bounded-eviction policy test, not proof of a pre-existing correctness bug or of speed.
- Hold A's projection, plan, rendered frame and unread lazy rows; render changed B; then inspect/read/navigate A and request its descriptor. Verify A's original text at its captured context, topology, destination order and exact original descriptor identity. Exercise compact and rich, including equal render facts with a different descriptor in `details`. Re-render A after eviction and check equivalence without rewriting either retained snapshot.
- Churn across distinct roots and repeated keys, remove/reinsert nodes, parent/bucket changes, and conflicts including overflow. Assert deterministic latest-pass node-cache size/cleanup; inspect the source to establish the one-record bound. Do not use WeakRef/finalizer timing as a correctness assertion.
- Preserve plan option and clock-boundary behavior, including shown/history-hidden plans, collapsed/history/sort changes, selectionMap and parent-aware `put:` transitions, width/style/translator differences, and the fifth-sub-row/R1 direct-child cases. Cite existing exact tests where adequate rather than duplicate the whole suite.

Retain the complete fact and row-key tables in `b10b-cache.test.ts` and the digit-name comparator guard. Run all existing B10B suites and unchanged visual baselines, then the full check set required by the brief. Snapshot/equivalence guards are not performance measurements.

## Evidence and stopping conditions

Retain at least three unmodified strict fresh-process baseline and final-candidate runs **per supported runtime family**, with the brief's declared order, serialized measurement window, exact build/source/host/environment provenance and all attempted results. Keep every earlier failure and all four gated populations separate. Node 22 passes cannot close Node 24 failures; instrumented results cannot replace strict results.

Stop this remedy and return the precise finding if the baseline/profile does not support it, an old frame or descriptor is retargeted, complete facts or cleanup would be weakened, a real caller's performance regression requires a different cache policy, or the remedy needs an excluded file, changed benchmark/gate/runtime or broader design. If the new regression coverage finds a pre-existing snapshot problem, distinguish it with baseline evidence and return that question rather than silently expanding the optimization. A failed final review still exhausts this single additional submission; no automatic extra fix budget is granted.

No builds, tests, profiles, file writes or git mutations were performed in this consultation.

## Repository sources

- [Approved performance brief](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/B10B-S3F-PERF.md).
- [Whole-tree and per-node caches](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/src/render/delegation/projection.ts#L323-L437).
- [Design performance rules](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/docs/design/hud-information-design.md#L849-L878).
- [Projection identity and sweep tests](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/tests/unit/b10b-projection.test.ts#L140-L232).
- [Alternating-VM diagnostics](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/tests/unit/b10b-s2-perf.test.ts#L211-L265).
- [Shown-plan and frame-action ruling](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/docs/cloud/rulings/b10b-s3.md#L234-L240).
- [Standing performance evidence ruling](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/docs/cloud/rulings/b10b-s3f-performance.md).