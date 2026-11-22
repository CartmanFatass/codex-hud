# Inspector prerequisite: conflict provenance and fixed-run Reconcile

Date: 2026-11-04 UTC. Fresh read-only architecture consultation for CartmanFatass/codex-hud.

**CONDITIONAL / NOT RELEASED.** This is one concrete prerequisite brief for the queued wave-3 B9/B16 additions and B10B-s4 Inspector, provisionally called **B9-ICR**. It is not a new independent implementation lane. No implementation, test window, branch, package acceptance, merge, supported capability or later-wave release follows.

## 1. Decision and present eligibility

Prepare the **conflict-record provenance and copy-only descriptor producer** before specifying the Inspector's conflict actions in code.

The current source cannot safely implement the design's “first record, earliest since” behavior by adding a button alone:
- A synthetic conflict row deliberately has no LinkTreeNode and no node-keyed details.
- B9 exposes aggregate conflict count, recordIds and a minimum since, but not the individual records' times and exact target provenance.
- The node-only descriptor producer cannot fill that gap. Conflicted nodes suppress currentRun, and conflict-only rows are absent from its iteration.
- A relation's latest currentRun is not necessarily the historical run named by an accepted conflict evidence record.

The selected preparation is useful and nonduplicative: TPD1's existing map expressly excludes per-conflict descriptors and Inspector content, while its completed effect-boundary ruling settles dispatch/clipboard/host concerns, not this data contract. The saved DOC2 work is also different.

The queue ruling permits conditional later briefs now. Production work remains ineligible until actual B10B-S3F integration and the ordered intervening work are complete. Keep wave 1, DOC2/TPD1 and wave 3 in their existing order. Within an eventually eligible wave 3, the dispatcher must explicitly schedule the producer and its Inspector consumer based on their recorded dependency and ownership; this document does not allocate that slot or declare the whole wave disjoint.

**Output of this consultation:** a bounded data contract, source ownership proposal, tests and eventual release checklist. Do not reopen B10B performance, TPD1 effects, ledger-audit repair, P065 qualification or the composite review.

## 2. Evidence and source pins

Integration read at **universal-hud@d17a8affb89bcf16a78cb9b2beee3300b975266a**. NEXT reference read at **dots/b10b-s3f-next@60b5959d02516e73d30cd5a55913eb6988a94ea9**, unmerged and not an implementation base.

Both complete recursive tree listings were returned with truncated=false (1,459 and 1,463 entries respectively). No Inspector/B9/B16 brief or ruling was found by path inventory in either pinned tree. Integration contains the existing TPD1 map and the completed effect-boundary ruling. This is a statement about those inspected trees, not every unpublished branch or another executor's files.

The following blobs are identical between integration and NEXT, so NEXT has not already supplied the missing producer:
- core/link/types.ts: 90ed9be1f038a0b456c7e4e0887fc35ed02463e3
- core/link/conflicts.ts: 9614be8761bd9570a4953601f9156044a43124dc
- core/link/verify.ts: 8010a2ca30bfbee473c3dbcb9261e2141578c0ca
- core/link/index.ts: 8df16b067d890ca5715bd3e4c5ac86d5a7282544
- core/link/actions.ts: eb08dd96b3aef30fff78648c0f16ccc4fd3c5fed
- core/link/tick.ts: 6421e4ee875a58f780bbe50c0e0721fe1cbfe771
- core/link/memo.ts: 75f5904e8eb59c70bbf41c50c99684e8c24a26b6
- core/link/view-model.ts: f96f5f3ab26827aaaff08f3edbae6abd8c357e69
- render/monitor-inspector.ts: e60c880ebe5a67c4d287547ca992acee113b0bf0

Full path prefix for that list is src/. Snapshot identity is documentary evidence only, not acceptance.

### Source findings

1. [LinkRelationProjection and LinkTreeNode][TYPES] expose link/currentRun/parentKey/childKey and an aggregate conflict. Node details' reconcile field is defined in [view-model.ts][VM]. It is not relation-keyed.
2. [projectLinkTree][TREE] finds max runSeq per link, collects conflicts, marks duplicate parents and entire cycles, suppresses conflicting edges, and gives a conflicted rendered node currentRun=null. It derives aggregate recordIds/since while the originating edge or record still exists. That is where provenance is available without another read.
3. [ledgerConflicts][CONFLICTS] propagates accepted unresolved conflict evidence to affected links sharing the exact full SessionRef; resolution is scoped by runId plus the named evidence. An affected relation can therefore refer to a conflict originating on another historical run or outside a scoped reader's returned run/link rows.
4. [verifyLinkEvidence][VERIFY] has the qualified run, original evidence IDs and timing at the point it reports contradictory accepted receipts or qualified transcript facts. Later parsing recordId strings is neither needed nor a safe substitute.
5. [LinkTickCollector][TICK] builds reconcile descriptors only inside its node loop. The busy-view clone clears node descriptors but currently knows nothing about any future relation descriptors. Its immutable collector home already provides the correct HUD_HOME context.
6. [reconcileDescriptor][ACTIONS] and [createActionDescriptor][LIFECYCLE] are the existing trusted command path. Reuse them. Their explicit target validation, fixed local_user/copy_only subject and quoted HUD_HOME are not to be reimplemented by rendering.
7. NEXT's [rowActions][ROW_ACTIONS] returns no buttons when pn.node is absent. The [S3 ruling Q3][S3] explicitly assigns the missing per-conflict descriptor to later data work. [The projection][PROJECTION] constructs conflict keys from the relation, counts children separately from relation rows, and records omittedConflictRows.
8. [Design §4.8][DESIGN_CONFLICT] requires each conflict record's identity, parent, run and state, at most five displayed before “more”, and a command for the first/earliest record only. [§3.7][DESIGN_ACTIONS] and [contract 03][CONTRACT03] require the same captured ActionDescriptor in Inspector and control bar, no command reconstruction and no automatic execution.
9. [The current Inspector][INSPECTOR] still searches the legacy SubagentTreeNode tree using selectedId. Replacing it with a made-up legacy node for a conflict would lose the very attribution ambiguity the design requires.

## 3. Bounded goal and exclusions

The future data slice supplies enough immutable metadata for the Inspector to:
- list the retained conflicting records with truthful parent/run/time provenance;
- identify one deterministic earliest record when that ordering is actually knowable;
- obtain a trusted descriptor fixed to that record's exact run, or an explicit reason that no command can be offered;
- retain counts and omissions without fabricating a child run, a confirmed edge or a navigable row.

It does **not** implement Inspector rendering or controls, clipboard, CLI execution, host focus, a new capability, local resume, worker scheduling, collection of additional sources, or any ledger transition.

Other wave-3 additions remain separate: action/brief/rate fields, native digest, viewpoint-root parent and picker-label inputs. This brief neither completes nor releases them. B16 state merging, continuity, ObservationCommit and real resume after B14 are unchanged.

This is an additive read-model transport, not a new ledger schema or contract authority.

## 4. Conditional data contract

### 4.1 Preserve existing facts, add a separate Inspector view

Keep existing LinkConflict.count/recordIds/since, relation attribution, node/edge selection, counts, selectionMap, continuation and truncation semantics unchanged. Do not “fix” ordering by changing the legacy aggregate or qualifying additional evidence.

Add an optional, readonly **conflictDetails** member to DelegationViewModel. Its logical lookup key is the complete relation identity, formed collision-safely from linkId, parentKey and childKey. Do not use label, a bare session ID, array position, the synthetic row string parsed backwards, or childKey alone as the identity.

Each relation entry has:
- the exact relation identity and snapshot ledgerId/asOfSeq;
- a bounded ordered list of conflict record summaries;
- the full known record count and explicit number not represented in the list;
- the chosen primary record identity, if the earliest record is provable;
- reconcile: ActionDescriptor or null;
- an explicit unavailable reason when there is no descriptor.

Each record summary contains only:
- opaque recordId and a small provenance kind (link, native, accepted evidence, qualified transcript);
- original known since and its event/observed basis, or null/unknown;
- the exact parent SessionRef when known, otherwise null;
- exact linkId when known;
- the runId explicitly stored by the record, if any, separately labeled as a recorded target; a minimal verified run identity/state summary only when it resolves in the same trusted snapshot, otherwise null;
- a reason when provenance or target is absent/ambiguous.

No claims, secrets, raw receipt payloads, transcript bodies, prompts, environment dumps or mutable reader/SQLite handles are carried. Display names are optional presentation from already available metadata, never a lookup key or authority. Preserve all SessionRef components when carrying a parent.

The optional field keeps old fixtures and older additive consumers valid: absent means unavailable, never “no conflicts”. A new capable producer must populate the field consistently, including an explicit empty collection when no conflicts exist. Consumers fail closed on absent metadata.

This is a logical API, not a license for repeated large copies. Equivalent immutable records may be shared/deduplicated internally. Retain the existing per-conflict 200-record bound, use full scalar counts, and prove bounded storage under the existing whole-view/worker payload and memory limits. Do not create an unbounded all-history record array, increase the 200-node or 8 MiB limits, or raise the B10C result payload ceiling of 2 MiB. If a complete descriptor cannot be established within existing bounds, expose partial/unavailable; do not scan or relax a limit.

### 4.2 Capture provenance where it is known

Carry a small internal provenance sidecar through existing conflict formation. Add metadata when the existing code decides a record contributes to a conflict; do not run a second, weaker verifier.

- **Ledger conflict evidence:** retain the original evidence ID, observedAt and stored run/link relationship. An effect on another link does not retarget that evidence to the affected link's currentRun.
- **Accepted launch receipts:** retain the exact run already admitted by independentRefs/proofRef and the original evidence identity/time.
- **Qualified transcript facts:** retain the run selected by existing claim/call/correlation/source checks and original event time. Candidates stay candidates; they obtain no command.
- **Ledger topology edges:** capture their actual link and same-snapshot current run when creating the edge. Use its existing boundAt/createdAt timing source, without borrowing an unrelated conflict's minimum timestamp.
- **Native topology edges:** preserve their exact full parent/child identities and existing known timing provenance, but no managed run, link or command is invented.
- **Cycles and duplicate parents:** carry the records that made the conflict while preserving the existing no-edge/no-attribution behavior. Do not pick a winning parent.

Where a scoped reader supplies an outside-target evidence record but not its exact run row, display the stored opaque identity and a missing-target reason. Do not issue a wider SQL query, traverse another source, or use the in-scope affected relation's latest run as a replacement.

If one opaque record ID occurs with inconsistent target provenance, retain ambiguity and offer no descriptor for it. Never overwrite with last-wins semantics. Exact duplicate facts deduplicate as today.

### 4.3 Earliest record is not “first usable command”

Order records by their original since ascending. Resolve equal known times with a locale-independent comparison of the complete opaque record identity; tie-break deterministically by full provenance identity only if needed. No Date.now(), locale setting, label or input-array order may change the chosen target.

Select the earliest record before presentation truncation. Track the minimum while traversing the metadata already being examined; do not trust a lexicographically sorted/truncated recordIds array to contain the earliest record.

If a contributing record's time is unknown, required provenance is lost through earlier truncation, or conflicting duplicates prevent proving the earliest choice, primary is unavailable. Display available facts honestly. Do not fabricate an old time or treat an omitted/unknown record as later merely to make a button active.

If the proven earliest record is native, has no managed run, has an out-of-scope/missing target, or fails template validation, reconcile remains null. **Do not skip forward to the first actionable record.** That would change the specified target. Later records remain information for the Inspector, not automatic fallback targets.

A historical evidence record keeps its historical run. A new run on the same link does not rewrite an already emitted descriptor. Reconcile can inspect a fixed historical run through its existing CLI semantics; this does not authorize resume or alter current ownership.

### 4.4 Create descriptors only with the trusted action context

Keep projectLinkTree pure. It must not read HUD_HOME, open paths or create commands from presentation text. The collector/view-model assembly supplies its fixed home and the exact producer-selected target to the existing reconcileDescriptor.

Return only operation=reconcile, subject=local_user, delivery=copy_only. Retain the helper's reason/template and validation. Never substitute label/report/path text, add flags that clear slots/force termination, infer entry verification from a host heartbeat, or expose a resume descriptor.

The relation descriptor is the sole command object for both eventual consumers. Inspector and control-bar input must carry that same captured object. New consumers must not call the helper independently or look up “the newest run” at input time.

A descriptor does not prove control, binding, a current child run, resolution, or a free slot. Keep conflict attribution and every capacity fact unchanged.

### 4.5 Snapshot lifetime and degraded reads

Construct the addition from the same already-read snapshot and finalized conflict membership as its enclosing view. Its ledger provenance must match that view. Never pair current labels/relations with an older target map.

On a new view, create new immutable output as necessary; do not mutate objects retained by an older frame, lazy row, input action or cache entry. A frozen prior view and its captured descriptor must remain byte/value-stable after later ticks.

Every degraded path must remove the new actionable descriptor:
- ledger_busy's retained display clone;
- ledger unavailable, identity change or reader replacement;
- missing/mismatched snapshot provenance;
- removed/resolved relation or newly ambiguous primary.

Retaining historical display records during busy is permissible when marked stale/unavailable. Retaining the old command as presently available is not. Freshness-only/no-change operations must not reconstruct commands or incur new I/O.

Reader replacement must not expose the new field as actionable while the replacement ledger has not been read. Do not alter unrelated recovery/refresh behavior to solve this.

Memoization must cover any newly exposed provenance changes. Use existing ledger token and evidence/source-version identities where sufficient; add only the bounded primitive input needed for a demonstrated stale-cache case. Do not create a second state cache, whole-history serialization on every redraw or new periodic activity.

## 5. Ownership proposal

This is the **complete conditional whitelist for this producer slice**, to be revalidated on the eventual accepted base. No source file is granted now.

Existing source paths:
1. src/core/link/types.ts: internal typed conflict provenance only, without changing LinkConflict's existing semantic facts.
2. src/core/link/conflicts.ts: carry bounded source provenance alongside the existing combination/resolution logic; do not change which conflicts count.
3. src/core/link/verify.ts: preserve provenance at already-qualified conflict construction points; no change to qualification or candidate admission.
4. src/core/link/index.ts: attach provenance for graph edges/cycles and pass finalized conflict membership to the collector; preserve graph/status semantics.
5. src/core/link/actions.ts: a pure bounded relation-action assembly helper reusing reconcileDescriptor. No new command template.
6. src/core/link/view-model.ts: optional readonly conflictDetails transport.
7. src/core/link/tick.ts: exact-snapshot assembly, immutable view propagation and clearing on every degraded path.
8. src/core/link/memo.ts: only a narrowly demonstrated new-field invalidation requirement, if existing identities do not already cover it. No general cache rewrite.

New additive tests and test-only shared helpers:
- tests/unit/b9-icr-provenance.test.ts
- tests/unit/b9-icr-actions.test.ts
- tests/int/b9-icr-tick.test.mjs
- tests/int/b9-icr-fixture.mjs
- tests/int/b9-icr-performance.mjs

The new fixtures may reuse tests/int/b9-fixture.mjs and existing typed fixtures read-only. Existing tests/assertions and performance fixtures remain unchanged. If a needed edit falls outside this exact list, stop and return the missing ownership item rather than widening the list silently.

Explicitly read-only:
- src/core/link-ledger-read.ts, src/core/lifecycle.ts, core/types lifecycle/observation, identity validators and all ledger/writer/schema paths;
- all src/render/**, src/tree-page.ts, src/collectors/**, worker/wire code, HostAdapter/integrations, CLI/bin, packages, B16 merge/publication/storage code;
- package/lock/configuration files, shared fixtures, visual baselines, contracts, design and status documents.

Dispatcher records, serialized with other documentation:
- proposed eventual brief docs/cloud/B9-ICR.md;
- this conditional ruling, suggested docs/cloud/rulings/inspector-conflict-prerequisite-20261104.md;
- eventual report/review/evidence manifest under docs/cloud/handoff/b9-icr/;
- factual STATE/plan updates only after their actual gates. Saving this brief does not fill in “accepted”.

### Ownership collision check

- NEXT's current four-path release is render facts/projection and two tests, so it does not implement this producer.
- TPD1's completed four-source-path addendum is tree-page/monitor/control-bar/i18n plus tpd1 tests. This slice does not reopen those effects.
- DOC2 owns design documentation, not these source paths.
- P065 is ledger/MCP budgeting; this slice does not touch its source/tests, inherit its new clock or consume its unaccepted remedy.
- HYG2/RUNZ1/MCP-ANCESTOR/NODE22-PROXY are not a license to alter the core/link producer.
- **B10D is a real future collision, not merely a naming concern:** its route explicitly serializes overlapping collector/link work. The source of truth for this slice includes tick.ts and link plumbing. Do not run an overlapping B10D continuation or absorb worker changes. The queue keeps B10D-2 after the queued Inspector/data work.
- The remaining B9/B16 additions must either share this single data-package owner or obtain an explicit disjoint whitelist. Do not appoint parallel writers to core/link/types.ts or tick.ts.

Shared executors still require a separately admitted quiet window. Read-only connector research is allowed while another package runs; builds, tests, source materialization and archive processing are not bundled here.

## 6. Required semantic evidence, not executed results

Every new behavior gets a test that reaches the actual production assembly and fails meaningfully without it.

### Provenance and target cases

1. Two authoritative parents claim the same exact child. Both conflict relations retain facts, no child run/confirmed edge is fabricated, both entries identify the same earliest record and exact command target.
2. Reverse input order and give IDs inverse lexical order to timestamps. The oldest timestamp wins, not array position, first relation, latest run or lexical ID.
3. Equal timestamps produce a stable locale-independent tie; repeated calls and EN/ZH consumers do not change it.
4. More than 200 records with the earliest fact late in input order. Counts and omissions remain correct; earliest is computed before truncation if provable, otherwise descriptor is absent with reason.
5. Earliest native or missing-target record followed by a valid managed record yields no fallback command.
6. Same link has run-a historical evidence and current run-b. The record retains run-a. Existing status/current-run projection remains run-b where valid; no display attribution is reassigned.
7. A scoped reader includes target-wide outside evidence but omits that target run. Missing target stays missing; no extra read, guessed run or command.
8. Contradictory receipts, qualified transcripts, a ledger cycle and mixed native/ledger parents preserve existing proof rules. Unqualified candidates, wrong-source/old-generation facts and copied claims gain no descriptor.
9. Duplicate exact records deduplicate; conflicting provenance for an opaque ID becomes ambiguous rather than last-wins.
10. Named same-run conflict resolution removes only that record; wrong-run and unrelated resolutions do not. A resolved primary leads to a newly constructed view, never mutation of the old action.

### Collector and failure cases

11. Real SQLite reader/LinkTickCollector path emits the same typed data as the pure helper, with one existing read snapshot and no additional writer, filesystem, source/body read or per-record query.
12. Available -> busy -> still busy -> recovered; unavailable; identity change and replaceReader; relation disappearance. Current new-field descriptors are absent whenever ledger availability/provenance is insufficient.
13. Capture and freeze view A; create changed view B and A-again. The old records and command remain unchanged. Fresh/warm/no-change values agree and no orphaned keys accumulate.
14. Mutable input-envelope compatibility, immutable snapshot optimization and source-generation changes exercise the actual memo route. Newly changed provenance may not stay stale behind an unchanged display label.
15. A malicious label/report/log string resembling a shell command cannot enter the descriptor. Preserve exact quoted HUD_HOME and run identity; rejected ID/path shapes remain rejected. Do not spawn or execute the rendered command during this package.
16. No-regression assertions cover existing counts, omittedConflictRows consumer behavior, absence of a 201st display row, graph/cycle suppression, currentRun, capacities, reports, B16 states, selectionMap and old no-new-field fixtures.

### Meaningful controls

Use isolated, separately built test controls, never mutations on the integration branch:
- suppress new descriptor production: the positive real collector assertion fails;
- choose relation.currentRun instead of evidence run: historical-run assertion fails;
- choose first actionable instead of earliest: native/missing-primary refusal fails;
- retain descriptors in the busy clone: degraded-view refusal fails;
- mutate the old result in place: retained-frame immutability fails.

An absent import, TypeScript error or environment failure is not a passing negative control. Restore and verify the final candidate identity before later checks. These controls do not themselves release execution.

## 7. Conditional verification plan

Use the eventually accepted base's scripts, supported Node 22 >=22.13 and Node 24, fresh compiled output and existing dependency setup permissions. All commands below are **future required checks**, not claimed runs.

Each bounded group needs a dispatcher lease, explicit source/tree/runtime identities, temporary HOME/HUD_HOME/TMPDIR, complete stdout/stderr/direct and outer statuses, UTC/monotonic boundaries and authoritative owned-process cleanup. Preserve all failed/incomplete/unrun stages. No new process launcher, runtime install, capability probe or local session is authorized here.

Proposed outer workload caps for this eventual slice, subject to the active supervision/window mechanism:
- npm run build; npm run build:test; npm run build:hud-mcp: 180 seconds each.
- node --test dist-test/tests/unit/b9-icr-provenance.test.js dist-test/tests/unit/b9-icr-actions.test.js: 300 seconds.
- node --test tests/int/b9-icr-tick.test.mjs: 600 seconds.
- node --test tests/int/b9-projection.test.mjs tests/int/b9-read.test.mjs tests/int/b10a-tick.test.mjs: 600 seconds.
- node --test dist-test/tests/unit/b9-projection.test.js dist-test/tests/unit/b10a-data.test.js dist-test/tests/unit/b10a-memo.test.js: 300 seconds.
- Each declared behavioral-control command: the matching positive command's cap.
- node tests/int/b9-icr-performance.mjs: 600 seconds per predeclared complete series; existing node tests/int/b9-performance.mjs: 600 seconds per series. Do not combine simultaneous loads.

Full unchanged README check inventory on the exact final candidate:
- npm test: 1,800 seconds. This includes the separate mjs stage; if an earlier stage stops, later stages remain unrun.
- npm run test:core: 1,800 seconds.
- npm run test:visual: 600 seconds.
- npm run test:hud-mcp: 600 seconds.
- npm run format:check: 300 seconds.
- npm run check:fixtures: 180 seconds.
- git diff --check for actual base-to-candidate committed delta and pending delta: 60 seconds.

These proposed timeouts bound workloads; they do not replace the accepted supervisor's closeout, termination or cleanup deadlines. Reconcile them with the then-current recorded protocol before execution rather than inventing a wrapper.

Run the full session with synthetic temporary homes. The README illustration unsets HUD_HOME before npm test; use the accepted isolation setup across every check, not only that one command. Never use real homes or local-only Herdr/tmux/CLI tests.

Known README flakes retain only their existing one isolated rerun, with both outputs. A new ordering/cache/descriptor failure is not a flake. If a required aggregate would repeat a denied facility, leave it blocked, complete independent permitted groups and report the exact missing evidence. No skipped or focused subset is a green aggregate.

### Performance and memory

The addition is on the tick/view-model path. Report host, source/runtime/build identity, complete n, warm-up, p50/p95/p99/max, populations and all failed samples.

The new bounded harness must exercise real production conflict assembly and collector transport, not only string formatting: zero/normal/max-sized views, many records with truncation, contradictory qualified facts, native conflicts, available/busy recovery, unchanged/warm and changed views, retained prior views and maximum-size metadata. Reuse existing authoritative fixtures without changing their inputs to improve results.

Preserve existing B9/whole-tick gates and the design's no-change rule; do not assign a new permissive microbenchmark gate. The existing B9 measurement uses 200 warm-ups and at least 1,000 samples; record at least three full runs per governing population/runtime protocol, not the best run. Its output alone is not full-worker or supported-WSL qualification.

The B10C timing split, no-change limit, shared bytes/deadline, 2 MiB result ceiling and memory limits remain binding wherever that accepted path applies. The new data cannot be charged to a later idle interval or hidden behind “cold” classification. Do not enable the unaccepted worker to measure it. Preserve separately required S3 and full HUD checks on the actual accepted combination; this producer-only consultation does not start another B10B performance campaign.

Formal WSL/B14 and actual host/local effects stay owner-only and separately recorded. No fake, source inspection or cloud result substitutes.

## 8. Inspector consumption contract, not an implementation grant

The eventual B10B-s4 brief should consume this producer after its own acceptance, not clone its selection logic.

For a synthetic conflict selection, use its exact relation identity, render all retained conflict facts without attributing a run to the child, display at most five record rows with accurate extra/omitted counts, and use the producer's one primary descriptor for both header/control-bar actions. Missing metadata yields a diagnostic and no command. Neither the first visible row nor the first usable run substitutes.

Coverage remains separate:
- counts.knownUnloaded, omitted and unknownDescendants describe tree knowledge;
- tree.truncation describes retained metadata;
- omittedConflictRows describes relation rows excluded by the renderer's 200-node cap;
- conflicts whose parent is outside the tree are not fabricated navigable rows or trouble-stop targets.

Do not add these distinct counts together as if they were unique missing sessions. Do not restore the rejected “omitted-conflict parent is a stop” behavior from S3. Root Coverage may explain them without offering another record's command.

Inspector Open-disabled reasons, Resume diagnostic, healthy Link/Run/Reports/Candidates sections, previous-run labeling, native picker inputs and root parent still need their complete consumer/data briefs. B9-ICR is one prerequisite, not a claim that Inspector is ready or complete.

## 9. Release, acceptance and stopping conditions

Before any implementation:
1. Record actual B10B-S3F merge into universal-hud and the applicable accepted/green merged-tree evidence. No NEXT/local-subset/composite-construction substitute.
2. Finish the ordered preceding queue work, including DOC2/TPD1. Refresh their actual source/ownership and the current queue ruling.
3. Revalidate the proposed interface and eight-path whitelist against the exact new accepted base; identify one data-package owner and resolve any B10D/B9/B16 overlap.
4. Record the scoped final brief and the producer/consumer sequencing for eligible wave 3. No unaccepted dependency, cherry-pick or speculative combined WIP tree.
5. Admit a new bounded executor window with clear source/runtime/evidence/cleanup pins. No new permission can be inferred from this design text.

Stop on missing provenance that cannot be represented truthfully, required reader/schema/contract changes, unsupported new target authority, inability to keep bounds, an out-of-whitelist edit, a writer collision, denied/uncertain execution, or a proposed gate/profile relaxation. Return the exact issue to a fresh Oracle; preserve successful work and prior failures.

The package's future final review must verify actual source plus full evidence and return accept or fix required. Integration still requires the authorized history-preserving --no-ff merge and full green checks on that actual merged tree before push and status promotion. Never main, force-push, history rewrite or node_modules staging.

**Current stopping condition reached:** the missing prerequisite has a concrete bounded design, dependency/ownership map and check plan. No runtime investigation is needed to rediscover the loss of per-record provenance.

The next independent read-only preparation, if requested after this artifact is recorded, is the **remaining Inspector source-to-field matrix and conditional consumer brief**: delegation-key entry, Open-disabled reason wording, Resume diagnostic and non-overcounting Coverage, expressly excluding TPD1 effects and this conflict producer. It can proceed without waiting for owner-local tests, but is also not an implementation release.

## Sources

[TYPES]: https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/src/core/link/types.ts#L74-L141
[VM]: https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/src/core/link/view-model.ts
[TREE]: https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/src/core/link/index.ts
[CONFLICTS]: https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/src/core/link/conflicts.ts
[VERIFY]: https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/src/core/link/verify.ts
[TICK]: https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/src/core/link/tick.ts
[ACTIONS]: https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/src/core/link/actions.ts
[LIFECYCLE]: https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/src/core/lifecycle.ts#L525-L568
[ROW_ACTIONS]: https://github.com/CartmanFatass/codex-hud/blob/60b5959d02516e73d30cd5a55913eb6988a94ea9/src/render/delegation/actions.ts#L58-L82
[S3]: https://github.com/CartmanFatass/codex-hud/blob/60b5959d02516e73d30cd5a55913eb6988a94ea9/docs/cloud/rulings/b10b-s3.md#L89-L117
[PROJECTION]: https://github.com/CartmanFatass/codex-hud/blob/60b5959d02516e73d30cd5a55913eb6988a94ea9/src/render/delegation/projection.ts#L451-L558
[DESIGN_CONFLICT]: https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/design/hud-information-design.md#L453-L553
[DESIGN_ACTIONS]: https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/design/hud-information-design.md#L231-L252
[CONTRACT03]: https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/contracts/03-lifecycle.md#L107-L147
[INSPECTOR]: https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/src/render/monitor-inspector.ts#L114-L142

Additional binding/verification sources:
- [AGENTS](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/AGENTS.md), [STATE/queue](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/handoff/STATE.md), [dots workflow](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/cloud/dots.md).
- [Preparation authority](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/cloud/rulings/queue-progress-20261103.md), [complete-brief requirements](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/universal-hud-engineering-plan.md#L58-L72).
- [Completed TPD1 boundary ruling](https://github.com/CartmanFatass/codex-hud/blob/18c2303dfb23f3fd73bf476738997a9042eebc0b/docs/cloud/rulings/tpd1-effect-boundaries-20261104.md), [TPD1 prerequisite map](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/cloud/rulings/tpd1-prerequisite-source-action-test-map-20261103.md).
- [B10D serial order](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/cloud/rulings/b10d-route.md#L225-L238), [resource windows](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/cloud/rulings/wave1-resource-windows-20261103.md).
- [Contract 06 provenance/budgets/worker limits](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/contracts/06-observation.md), [concept decision log](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/universal-hud-concept.md#L604-L654).
- [Read-only snapshot and scoped conflict evidence](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/src/core/link-ledger-read.ts#L63-L186), [memo input](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/src/core/link/memo.ts).
- [Real B9 projection regressions](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/tests/int/b9-projection.test.mjs), [busy collector regression](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/tests/int/b10a-tick.test.mjs), [B9 measurement](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/tests/int/b9-performance.mjs).
- [README checks and flakes](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/cloud/README.md#L49-L96), [actual npm scripts](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/package.json).
- [NEXT restricted ownership](https://github.com/CartmanFatass/codex-hud/blob/d17a8affb89bcf16a78cb9b2beee3300b975266a/docs/cloud/B10B-S3F-NEXT.md#L99-L127).

Method: read-only GitHub branch/file/complete-tree retrieval and local reading of supplied prior rulings. No build, test, benchmark, process probe, runtime/dependency operation, source change, repository mutation, branch/worktree creation, local-computer session or subagent was performed. Local copies of inspected text were retained for this consultation; the only deliverable is this requested standalone conditional brief. All check expectations above remain unexecuted.

