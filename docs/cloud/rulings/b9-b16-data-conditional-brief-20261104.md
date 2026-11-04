# B9/B16 remaining display-data implementation brief

**CONDITIONAL / NOT RELEASED**

Read-only Oracle consultation, 2026-11-04. This document proposes a bounded producer package. It does not authorize implementation, allocate an executor, accept a package, change a gate, or release a later wave.

## 1. Decision and exact boundary

Use one data owner for the remaining B9/B16 producer work, with serial handoffs wherever it intersects B9-ICR or later recovery work. The bounded design is:

1. Carry the existing Codex public current-tool fact and existing estimated output-rate sample through the same committed observation as their source checkpoint. Do not calculate a new rate, reread tool bodies, or source display facts from an unpublished reader.
2. Supply viewpoint-root parent metadata from the already validated graph, without making that parent a rendered ancestor or reading its body.
3. Preserve exact Codex picker identity inputs when the existing metered native-header reader already encounters them. Do not derive a picker identity from a shortened title, reopen legacy discovery, or enable navigation.
4. Define explicit unavailable slots for brief and native result digest. The inspected generic path has no released provenance-aware producer for these outputs. General model generation, scheduling, persistence, permissions and delivery remain outside this data-only package. A typed missing value is honest partial delivery, not completion of those two product features.
5. Consume the completed B9-ICR and Inspector briefs as dependencies. Do not reopen their conflict/action design, Inspector field matrix, or TPD1 effects.

All proposals below remain conditional on the final accepted base, queue eligibility, exact whitelist/owner reconciliation and normal review. The package must not be described as delivering every Inspector sample field.

### Pinned input

- Repository: `CartmanFatass/codex-hud`.
- Read baseline: `universal-hud@26096e825baeccbce1403c8cbffa964e243f83ff`.
- NEXT is unmerged reference material only: `dots/b10b-s3f-next@60b5959d02516e73d30cd5a55913eb6988a94ea9`. This consultation neither imports its code nor accepts its interfaces.
- B10D's frozen worker candidate is not an implementation base and does not authorize production observation publication.
- Future branch, only after release: `dots/b9-b16-data`, from the then-current **accepted** `universal-hud` tree. The implementation report must state that exact commit/tree and the serial handoff boundary. This read baseline is not a promise that the future base will be identical.

Method: read-only GitHub connector file/tree inspection and reuse of recorded rulings. No repository writes, branch creation, source changes, project execution, tests, builds, probes, local-machine operations or subagents occurred. Saving this report and calculating its digest are the expressly permitted report-only exception.

## 2. Binding scope and prior work

Binding documents at the pin:

- `AGENTS.md`, `docs/cloud/dots.md`, `docs/cloud/README.md`, `docs/handoff/STATE.md`.
- `docs/cloud/rulings/queue-progress-20261103.md`.
- Completed B9-ICR: `docs/cloud/rulings/inspector-conflict-prerequisite-20261104.md`.
- Completed Inspector matrix/brief: `docs/cloud/rulings/inspector-consumer-source-field-brief-20261104.md`.
- Existing TPD1 effect disposition: `docs/cloud/rulings/tpd1-effect-boundaries-20261104.md`.
- B10D route, LEG1 conditional/freshness/owner-direction rulings, RCP1 conditional brief.
- Contracts 06/07, information design, engineering-plan complete-brief requirements, and directory guidance.

Reuse means preserving those decisions, not certifying their implementations or rerunning their reviews.

**Included:** current native action, native output-rate transport, brief/native-digest missing-data contract, viewpoint-root parent metadata, source-qualified picker inputs, bounded transport/validation/cache behavior and their direct tests.

**Excluded:** turn age/start display as a separate feature; additional Inspector proof/log/report-history/sample fields; conflict provenance or reconcile descriptor redesign; any new lifecycle classifier; status truth table, continuity, notices, capacity, wake or completion semantics; host Open composition; automatic log viewers; clipboard/navigation effects; Resume capability; generic model production/storage; legacy catalog redesign; worker publication enablement, fairness, retirement or recovery parking; schema/ledger migration, export or public v2 changes.

The rate's internal sample window timestamps are necessary provenance for the rate itself. They do not authorize a new turn-age feature.

## 3. Authoritative source-to-field map

| Requested datum | Existing authoritative producer at the pin | Existing gap | Proposed bounded destination |
| --- | --- | --- | --- |
| Current action | `RolloutParser.getLatestOpenCall()`, consumed by `CodexAdapter.evidence()`; existing `SessionEvidence.action` contains id/name/start/optional target | `ObservationView` drops it; publication-only followers cannot reconstruct it from `SessionEvidence.action` | Optional closed `ObservationView.nativeDisplay.action`, then committed node detail |
| Output rate | `TokenRateTracker.snapshot` → `RolloutParseResult.outputRate`; `parser.getRateBaseline()` is captured in the same reader result's parser state | Not projected into the universal observation; cumulative tokens alone are insufficient | Optional closed `ObservationView.nativeDisplay.outputRate`, retaining the original sample and baseline window |
| Brief text | Existing local `Briefer.land/addNotes` → `AgentLog` notes is a legacy producer, not generic authority | No released generic result provenance/consumer handoff | `details.brief` unavailable; separately reserved future contract in §7 |
| Native result digest | Existing local `ModelJobs.currentDigest/apply` → legacy `AgentLog` digest is a legacy producer | No released generic provenance-bearing result handoff | `details.nativeDigest` unavailable; separately reserved future contract in §7 |
| Viewpoint-root parent | Finalized B9 parent edge map after corroboration, multiple-parent/self/cycle/conflict handling, from one ledger/topology input snapshot | Current final loop only looks through rendered `parentKey`; a viewpoint root deliberately has `parentKey=null` | Existing `node.parent` plus a closed provenance sidecar, without changing graph traversal |
| Picker-label inputs | `MeteredCodexTopology.collect` public `session_meta` header callback, using the existing pure `identityFromMeta` rules | Only `native.title/kind` survives; title can be a leaf and is not an exact picker label | Optional source-qualified topology sidecar and immutable `node.pickerInputs`; no effect |

Important non-equivalences:

- `NativeAction` is a tool display fact, not lifecycle `ActionDescriptor`, an instruction, a control grant, or a pending/completed classifier.
- Rate is an **estimated turn-level model wallclock proxy**, not request throughput, exact inference speed, quota, a cumulative-token derivative calculated by the UI, or a rate to sum across sessions.
- Native result digest is model-written result text. `Link.taskDigest` is an immutable launch-task hash and is not that text. `Link.briefPath` is not permission to open a file. Existing safe basename/hash display remains separate.
- A native public assistant update is not an authenticated lifecycle `Report`, a brief, or a digest.
- A title/label is presentation metadata. Only full `SessionRef` and the existing qualified graph/binding rules establish identity.

### Why the committed path matters

`SessionCollection.refreshCommitted` may retain raw evidence locally, but its display observation is `commit.summary`. `evidenceFromView` reconstructs a follower without raw action/report arrays. Consequently, joining `raw.action` at paint time would produce leader/follower/restart disagreement and mix publication boundaries. These fields must live in the captured observation if they are native reader facts.

`StatusWriter.prepare/publish` already captures a detached reader summary with its checkpoint and replaces only the status/conflict projection on publication. The existing path should carry the new closed fields without a new writer, storage table or private side cache. Tests must prove this rather than assume an object spread is sufficient.

## 4. Proposed native field contract

Names below are proposed internal API names to freeze at release, not claims that the pin already exports them. Use one new pure type module, `src/core/types/native-display.ts`. No index signatures, raw JSON extension buckets, native parser objects, Dates, handles or functions cross the boundary.

```ts
type NativeUnavailableReason =
  | 'producer_unavailable'
  | 'coverage_incomplete'
  | 'sample_unavailable'
  | 'sample_window_unproved'
  | 'source_clock_invalid'
  | 'source_reset'
  | 'identity_mismatch'
  | 'display_limit'
  | 'privacy_unavailable';

type NativeActionValue = Readonly<{
  id: string;                 // exact call ID, never truncated into another ID
  name: string;               // public tool name
  startedAt: number;          // source event, ms epoch
  target?: string;            // existing allowed public display target only
  targetTruncated?: true;     // retain upstream or additional display truncation
}>;

type NativeActionField =
  | Readonly<{
      state: 'available';
      source: 'codex.public_tool_call';
      asOf: number;          // last compatible complete source boundary
      value: NativeActionValue | null; // null = positively observed no open call
    }>
  | Readonly<{
      state: 'unavailable';
      reason: NativeUnavailableReason;
      asOf: number | null;   // source time if known, never a fabricated event
    }>;

type NativeRateSample = Readonly<{
  tokensPerSecond: number;
  sampleMs: number;           // denominator after known closed wait-union exclusion
  windowStartAt: number;     // checkpointBaseline.measuredAt from this capture
  sampledAt: number;         // original snapshot time, ms epoch
}>;

type NativeDisplayData = Readonly<{
  schema: 1;
  action: NativeActionField;
  outputRate: Metric<NativeRateSample>;
  outputRateUnavailableReason?: NativeUnavailableReason;
}>;

// Additive; old producer absence means unavailable, never a known empty action/rate.
interface ObservationView {
  nativeDisplay?: NativeDisplayData;
}
```

Runtime restrictions are narrower than the generic `Metric<T>` type:

- Known rate source is exactly `codex.turn_wallclock_v1`, quality exactly `estimated`, and `asOf === value.sampledAt`; an available rate has no unavailable-reason member.
- Unknown rate has `value:null`, `quality:'unknown'` and a closed unavailable reason. Unknown is not zero. A finite zero is allowed only if genuinely provided by the authoritative tracker with a valid window.
- All event times are finite nonnegative millisecond epoch values. Durations are finite, positive where required. No `NaN`, infinity, negative rate or impossible window.
- An action call id/name must be nonempty, valid bounded strings. One latest open call is transported, using the parser's existing deterministic selection; no all-open-tools array is introduced.
- No literal `null` known-none action is produced from old-field absence, a failed read, incomplete coverage, source reset, unresolved recovery, a closed file with unknown tail, or a missing source clock. Known-none requires the complete compatible reader boundary and no open call.
- Select the native source fact once. `SessionEvidence.action` and the new observation copy must refer to that same call, but do not change legacy action/target values or public v2 serialization to enforce a new transport cap. Apply the stricter whitelist/bounds only to the new display copy. Preserve legacy optional target semantics; an additive truncation flag may be shared. A recovery-truncated target remains marked truncated; `getLatestOpenCall` preserves that runtime metadata even though the legacy tool type is narrower.
- Do not infer idle/completed or human attention from these values. The classifier is untouched.

### Rate lineage, not a new algorithm

Use the already captured `result.outputRate` and `state.rateBaseline`. Do not change `collectors/token-rate.ts`, `rollout.ts` or recovery format to implement this transport.

The existing tracker subtracts the union of closed tool waits, preserves TTFT/stalls, ignores duplicate cumulative reports for new samples, rejects backward/duplicate timestamps, resets on a falling counter and keeps its last sample across `startTurn`. That last property requires a guard:

1. The captured baseline must exist, be finite and nonnegative, and precede the sample.
2. `0 < sampleMs <= sampledAt - windowStartAt`.
3. The latest retained sample cannot be paired with a newer turn's baseline. If `sampledAt <= baseline.measuredAt`, expose unknown/sample-window-unproved, not a new current rate.
4. Source reset/compaction/identity-generation loss must not relabel a pre-reset sample as current. Only a compatible current-generation sample may reappear. If the existing source boundary cannot prove this, omit the field rather than altering recovery in this package.
5. Never recompute the value from total tokens and time since launch, from input tokens, or from the UI clock. No smoothing or minimum one-second window is introduced.
6. Retain the original sample time on no-change reads. Display age can be calculated from the consumer's captured clock; it must not create a fresh source sample or observation commit.

The existing “last” convention at 10 seconds can be reused by the consumer as a display cue. It is not a new observation validity deadline or a permission to extend the source freshness policy.

### Native/source scope versus managed-run attribution

The fields describe an exact **source session**. Publication stamps additionally bind the captured observation to the current run/binding when applicable; that stamp alone does not prove that an old tool call or a cross-turn sample began within the new run.

The consumer contract labels these as native session facts. It must not say “this run's tool/rate” from a timestamp comparison alone. If a future UI specifically requires run-attributed native fields, it needs existing exact run/reading-boundary proof; otherwise return unavailable for that use. No new run-attribution authority or timestamp-only proof is introduced here.

## 5. Identity, persistence and freshness

### Identity and publication

Every native field inherits the enclosing observation's complete identity and actual capture boundary:

`{harness, sourceId, sessionId, threadId}`, sourceGeneration, and, when managed, exact runId and expected bindingGeneration. The committed `ObservationStamp` keeps its actual seqDomain, commitSeq and inputLedgerSeq. Neither a bare session ID, current ledger high-water, label, file basename nor a copied parent's ref substitutes for these values.

Use existing `currentObservation`/stamp-mismatch checks and make the same checks at any new detail helper. A same-ID/different-source or thread is a different subject. A changed run, binding or source generation invalidates current presentation; an older observation can be shown only in a clearly retained/historical lane with its original identity/times.

Do not assign publication sequence values in the native reader. Do not infer native data from a ledger-only immediate status merge. Ledger fallback may supply the existing status, while native fields remain unavailable.

### Codec/version disposition

`src/core/checkpoint.ts` has a closed summary allowlist and an explicit reader/recovery compatibility mapping. A type-only addition will fail persistence unless its closed validators, bounds and content-digest handling are updated.

Conditional plan at this pin:

- Add the optional summary object and closed validators. Preserve old summaries that lack it as unavailable.
- Add new unknown-rate `asOf` to the existing no-change normalization. Do not erase real sample time/window/value, tool changes, target-truncation changes or source-generation changes from content identity.
- Treat changed reader-produced summary semantics as a Codex reader-version change. The next candidate at this pin is `codex-facade-5`; reserve/finalize the exact next unused value against the eventual accepted base. Keep the existing `codex-recovery-3` payload format and checkpoint schema 1 if the compatibility review confirms the addition is structurally compatible.
- Extend the exact compatibility mapping rather than allowing arbitrary reader strings. Old reader 4 summaries remain readable under the explicit old branch. New writer transition uses the existing collect-lease/CAS controlled reader-version rebuild, sourceGeneration advance, explicit gap and continuity reset. A retired older writer must not overwrite the newer result.
- Do not delete a recovery body and continue at its old offset. Do not change ledger user_version, delegation-export v1, public v2, SQLite layout, notice semantics or recovery format.
- Projection-only reads remain cheap: validation must not deserialize full recovery merely to obtain native display fields.

This is a compatibility disposition to verify, not a schema loophole. If implementation requires an incompatible checkpoint/private format or changes recovery semantics, stop for the separately recorded contract/version/ownership ruling; do not widen this package.

### Detached detail contract

Add an optional `details[key].nativeDisplay` with this closed contract:

```ts
type NativeDisplayView =
  | Readonly<{
      state: 'current' | 'retained';
      scope: 'source_session';
      stamp: ObservationStamp;
      data: NativeDisplayData;
      reason: null | 'source_stale' | 'coverage_incomplete' | 'ledger_unavailable';
    }>
  | Readonly<{
      state: 'unavailable';
      reason:
        | NativeUnavailableReason
        | 'committed_observation_unavailable'
        | 'ledger_unavailable';
    }>;
```

This is a detached, readonly view of the validated committed native data with its actual enclosing stamp. `current` describes a compatible source capture, not a promise that the retained rate sample was generated just now. Use one typed helper for normal assembly and committed-head refresh. Do not make a second classifier or store a second independently refreshed copy of native truth.

- Current requires a compatible committed observation and current source validity.
- Retained means the original compatible snapshot is kept while stale/busy/incomplete; it carries the original stamp and reason and is not described as a currently running tool.
- Unavailable has a closed reason and no fabricated value.
- Missing/degraded ledger clears all new actionable/pane/picker authority. Retained textual facts may survive only with explicit retained state.
- If coverage is partial, a previously established source fact may be retained; absence is not positive evidence of “none.”
- A failed reader does not turn action/rate into zero or renew their source time.
- Future/invalid clock or incompatible generations yields unavailable. Do not clamp a clock error into a plausible event.

The raw `node.observation` and `lastObservation` identities remain unchanged. No new history store is created.

### Memo and fast-path completeness

`sessionMemoInput` currently keys evidenceStamp, observation stamp, coverage and existing topology metadata, but the current evidenceStamp does not uniquely describe every proposed native-field change. Include a bounded canonical new-field identity/revision in the memo input or source evidenceStamp; do not rely on lastEventTime/tool-count coincidence. Keep no-change unknown times out of churn.

The committed-head refresh path in `tick.ts` must update new details and affected parent metadata, not only `node.observation/status`. Any already-rendered child's parent liveness must refresh when its parent changes. A viewpoint-parent outside the rendered node set needs the same captured identity check; never fabricate an on-demand refresh.

All retained frames are immutable. Test A → B → A, a held prior frame, in-place mutation under the non-immutable test port, and array replacement under the production immutable port. Include sidecar presence/absence, unavailable reason, stamp, source generation, picker topology revision and parent provenance in invalidation. No `Date.now()` field is added to a stable memo key.

## 6. Viewpoint-root parent and picker inputs

### 6.1 Parent: diagnostic metadata, not a changed tree

The authoritative source is the finalized unique `parents` map in `projectLinkTree`, after conflicting parents, self-edges and cycles are rejected. Do not use the first ledger link, first candidate, most recent historical link or pre-validation edge.

For each displayed node:

- Existing rendered child: preserve its current structural parent semantics.
- Selected viewpoint root: consult the finalized incoming parent edge for metadata only. Keep its rendered `parentKey=null`, depth 0, selection key and expansion unchanged.
- Do not add ancestors/siblings to nodes, known-session counts, continuation or read-plan demand. Do not open a parent reader merely to fill a label/liveness/pane.
- An unbound parent, historical/handed-over relation, ambiguous/cyclic/conflicted incoming edge or unverifiable native parent remains missing. An intent is not silently converted into a confirmed session parent.
- If the full parent identity is already established but its body is absent, return identity/harness, `name:null`, `liveness:'unknown'`, `paneLabel:null`. Unknown metadata is not a missing parent relationship.

Preserve the existing parent shape and add a closed optional provenance sidecar:

```ts
type ParentProvenance = Readonly<{
  child: DisplayNodeIdentity;
  parent: DisplayNodeIdentity;
  edge: 'delegated' | 'native' | 'intent';
  relation:
    | Readonly<{ kind: 'ledger'; ledgerId: string; asOfSeq: number; linkId: string }>
    | Readonly<{
        kind: 'native';
        parentRef: SessionRef;
        sourceGeneration: number;
        topologyRevision: number;
      }>;
  metadataState: 'current' | 'partial' | 'retained';
  parentObservationStamp: ObservationStamp | null;
  hostCheckedAt: number | null;
}>;

// Existing parent object remains the display payload.
interface LinkTreeNode {
  parentProvenance?: ParentProvenance | null;
}
```

Source generation in a native parent proof belongs to the actual parent listing, not the child's body. A ledger relation carries the enclosing actual ledger identity/sequence, not the observation's commit sequence. The enclosing tree supplies general degraded state; do not expose raw claim/owner/locator data through this sidecar.

Name comes only from an already qualified current parent label or existing safe native metadata for that exact parent. Do not reopen title caches or use a child label as the parent name. Liveness requires an already captured compatible parent observation; otherwise unknown. Pane label requires the parent's exact already-verified host/locator/occupant, using existing `projectLinkHost` semantics. No new host probe; duplicate, stale, mismatched or conflicted checks give no pane. Ledger busy/degraded must clear retained pane labels as current-host information.

### 6.2 Picker: preserve inputs, do not create navigation authority

Use the public header already parsed by `MeteredCodexTopology`, the existing `identityFromMeta` field rules and the current native topology/source identity. No second legacy scan, `children()` fallback, new full-tree traversal or extra file opening is allowed.

Proposed additive sidecar, distinct from `NativeMetadata` so the existing `{title,kind}` contract stays intact:

```ts
type NativePickerInputs = Readonly<{
  ref: SessionRef;
  parentRef: SessionRef | null; // only the header-qualified native relation
  fields: Readonly<{
    agentPath: string | null;
    nickname: string | null;
    role: string | null;
    kind: string | null;
  }>;
}>;

type NativePickerSnapshot = Readonly<{
  schema: 1;
  listingRef: SessionRef;
  topologyRevision: number;
  inputs: readonly NativePickerInputs[];
  omitted: number;             // omitted input records, not missing sessions
  complete: boolean;           // complete for this declared listing only
}>;

// Additive on NativeTopologyResult and copied CollectedLinkSession.topology:
pickerInputs?: NativePickerSnapshot;

// Optional node-side input with its sourceGeneration and listing/coverage proof:
node.pickerInputs?: Readonly<{
  input: NativePickerInputs;
  listingRef: SessionRef;
  sourceGeneration: number;
  topologyRevision: number;
  listingComplete: boolean;
}> | null;
```

Bound sidecar entries to the same selected self/immediate-child scope as the existing listing, at most 201 including self. A self input may be emitted only from a matching unique header already in that source catalog. Do not invent it from the caller's selected row.

The source-local catalog may internally index by sessionId only inside its verified source/harness context; the output boundary is always full-ref. Reject duplicate headers/ambiguous IDs and conflicting parent facts. Clear the sidecar with identity invalidation, file replacement, reset or topology revision. Reuse the collector's existing spread/copy boundary; do not alter discovery or scheduling just to carry it.

**Picker-label semantics for a later consumer handoff:**

- The existing helper chooses the full agent path, else nickname + role, nickname alone, role in brackets; it does not use the shortened native title. `Main [default]` requires independently established actual primary picker context.
- A model-generated title/kind/brief is never a picker label input.
- The complete root-Codex picker context must match source/harness/full ref. A viewpoint root is not automatically the primary native session.
- This sidecar's `complete` covers one listing, not the whole picker universe. A 200-node view, partial catalog or omitted metadata cannot establish global uniqueness. Do not scan omitted descendants to manufacture proof.
- Inputs with control sequences, malformed/oversize identifiers or a truncated exact label are unavailable for fallback. Do not truncate an identity-bearing string into a different selectable row.
- In this package no `unique:true`, effect descriptor or “Switch enabled” flag is produced. The eventual authorized TPD1 consumer must still establish the exact picker context and use its existing live unique-row check/re-read before Enter. Exact target ID remains preferred and authoritative.
- If root membership, primary status, uniqueness, source freshness or identity cannot be proved, the later narrow fallback refuses. A candidate label may be displayed diagnostically but is not a navigation target.

Native Claude topology/picker inputs remain unavailable under the existing scope. Do not infer them from filenames, matching names or Codex layout.

## 7. Brief and native digest: explicit dependency, no hidden implementation

### Existing producers are not general authority

`Briefer.land/addNotes` resolves local agents by name and writes `AgentLog` by legacy node ID. `ModelJobs.currentDigest` chooses a legacy digest by node ID/language and compares its event time to turn/start times; `apply` performs local legacy scope checks. These paths are valuable existing local behavior, but the stored note/digest does not itself contain the full generic contributor envelope required for reuse.

`core/materials/README.md` and contract 07 explicitly require:
- all original source/ref/origin/field contributors;
- purpose/recipient/positive scope and policy revisions;
- output-bound inherited provenance for derived text;
- no promotion of provenance-free legacy outputs;
- general persistence through `DerivedMaterialStore`, not `AgentLog/RecapStore`;
- source-aware material work outside collection/paint.

`DerivedMaterialStore` is a persistence boundary, not an existing generic producer for this view. Its load path revalidates contributors for a specified purpose/recipient; inventing a local-display bypass or submitting a model request in the tick is not allowed.

### Current package's executable contract

```ts
type DerivedDisplayUnavailable = Readonly<{
  state: 'unavailable';
  reason: 'derived_text_producer_unreleased';
}>;

interface DelegationNodeDetails {
  brief?: DerivedDisplayUnavailable;
  nativeDigest?: DerivedDisplayUnavailable;
}
```

For applicable session nodes, emit this bounded unavailable reason consistently, or normalize absence to it in the shared helper. Do not show empty text as a successful brief/digest. Intent rows may retain their existing safe launch metadata, but no result text is synthesized.

This package has **no general text provider parameter, storage reader, async job, hydration callback, model API or persistence writer**. Tests reject attempts to fill these slots from bare-ID legacy logs, raw assistant text, `briefPath`, `taskDigest`, an authenticated report summary, or a made-up provenance string.

A later separately released producer/consumer design would need at least:

```ts
type FutureDerivedDisplayText = Readonly<{
  kind: 'brief' | 'native_digest';
  targetRef: SessionRef;
  origin: 'native' | 'delegated';
  sourceGeneration: number;
  runId?: string;
  bindingGeneration?: number;
  language: string;
  generatedAt: number;
  coverageAt: number | null;
  text: string;
  textTruncated: boolean;
  provenance: VerifiedDerivedDisplayProvenance;
}>;
```

`VerifiedDerivedDisplayProvenance` must be an opaque validated handle to the B17-derived result's complete contributors/purpose/recipient/authorization and source boundaries, not a caller-asserted string. The future design must establish the local display authorization/revalidation boundary, target/run/turn coverage semantics, revocation/restart behavior and bounded off-tick delivery before any non-null generic text is accepted. Neither `at`, `generatedAt` nor `coverageAt` may be substituted for one another. A latest-turn digest cannot be declared current solely because its generation time is recent.

This future shape is a dependency description, **not an implementation whitelist or released API**. No changes to B17/SmallModel/AgentLog/RecapStore/ModelJobs/Briefer are allowed here. Existing authorized original-home legacy labels/digests remain on their existing separate path.

**Completion wording:** a future accepted data package may close transport/parent/picker-input work and explicit missing-data behavior. It must leave generic brief/native-digest production open until that producer is separately released and accepted. Do not mark the entire feature backlog complete from placeholders.

## 8. Privacy and unavailable behavior

### Privacy

Only explicit display fields cross this boundary. Never dump a Link, Run, reader result, parser state, native header or host state into a renderer/wire result.

Exclude raw tool arguments/output, full commands recovered from args, reasoning/thinking, private/unknown channels, request blobs, sealed tasks, credentials, claims, launch tokens/hashes, parent-owner keys, arbitrary host URLs, source home/rollout/log paths and recovery bodies. A native action target is only the existing narrowly extracted public display target, with existing safe path/control-character handling; unsafe or unclassifiable target text is omitted. The tool name can remain available when its target is withheld.

Do not treat a title or digest as automatically non-sensitive. No new text is sent to a model, remote service, telemetry, repository fixture or log. All tests/logged source values are synthetic. Logs use bounded reason codes, counts, hashed fixture identities where useful, and not user content. Internal full-ref provenance is not a claim of anonymization.

Consumers must apply the Inspector's established safe path/text handling. Without trusted display-path information, a private home prefix remains unavailable. Display escaping is not authorization, and truncating a secret is not a privacy guarantee.

### Required behavior table

| Situation | Required output |
| --- | --- |
| Old producer/optional field absent | Unavailable; no zero/empty/“idle” default |
| Native current committed data matches full ref/generation | Current native session fact with original source times |
| A fresh ledger-only status fallback | Existing status may display; native facts unavailable |
| Partial read/recovery/incomplete tail | Positive old facts may be retained with coverage; no known-none/current claim from absence |
| Run/binding/source generation mismatch | No current fact; preserve historical copy only with its original provenance |
| Ledger busy/degraded | Same-scope retained frame may remain visibly retained; clear new pane/picker authority and existing actionable descriptors per governing briefs |
| Source clock invalid/future sample | Unavailable reason; no clock clamping |
| Rate absent or sample window crosses a new baseline/reset | Unknown rate; no cumulative-token approximation |
| Parent relation valid, parent body absent | Full parent identity/harness, unknown liveness, null name/pane as applicable |
| Parent ambiguous/historical/cycle/conflict | No selected parent metadata; keep existing conflict diagnostics |
| Picker metadata omitted/partial/duplicate/context unknown | Inputs absent or diagnostic only; no narrow label navigation |
| Brief/native digest has only legacy or missing provenance | Unavailable; no legacy promotion, source read or model request |
| Optional display budget exhausted | Bounded omission reason/count; existing tree/status intact, never a false complete-label proof |
| Required field needs a new producer/contract | Stop that dependent scope and return the precise design/ownership question |

No malformed optional field may crash the view or mutate state. A malformed persisted closed summary is rejected by the established decoder; do not silently accept arbitrary extra members. The consumer shows unavailable when the established read path cannot provide a valid summary.

## 9. Resource accounting

This addition uses existing reads only. A display feature is not a second collection allowance.

### Unchanged system bounds

- Shared operation: 8 MiB file I/O, at most 200 displayed nodes, default cross-harness depth 4 and the existing shared deadline.
- Reader slice: at most 4 MiB/2,000 records/soft 20 ms, stopping at the first exhausted limit. The line rule, signatures, recovery reads and charged metadata all remain counted.
- Existing metered catalog: 20,000-header supported profile, 4,096 directory bound, existing per-call work and metadata-poll limits. No full legacy discovery fallback.
- Where the accepted worker path later applies: result at most 2 MiB, at most 16 resident readers; worker 64/8/4 MiB old/young/stack limits; at most 24 MiB aggregate owned external buffers; whole-process RSS delta at most 32 MiB steady/64 MiB peak. Main plus worker allocations count; do not sum per-thread copies of process RSS.
- One active operation, at most one coalesced pending request and one unconsumed result. Keep worker shutdown/replacement, 15-second lease TTL, renewal cadence, WAL+FULL, fencing, atomic commit/ACK and notice/continuity rules unchanged.

### Proposed optional-field sublimits

These are restrictive implementation caps under existing envelopes, not increases or substitutes for them:

1. One action and one rate sample per observation; action id at most 256 UTF-8 bytes and name at most 128. Reject oversize identity fields rather than truncate them.
2. Public action target at most 512 UTF-8 bytes, cut on a code-point boundary with a truthful truncated flag. Prior truncation survives. An unsafe target is omitted, not “sanitized” into an unverified instruction.
3. Picker input identity strings: combined at most 1,024 UTF-8 bytes per entry; no field is truncated for navigation identity. At most 201 entries per listing. Omission affects only optional inputs and records a count; it never removes an established session edge.
4. Added retained catalog strings across all sources owned by the collection adapter share a 256 KiB logical payload ceiling, not a 256 KiB grant per source or header. Account before copying; release on invalidation/disposal. Include duplicated representations and outstanding prior snapshots in the implementation's retained-memory analysis.
5. Added encoded display fields across a returned view share a 128 KiB ceiling, subordinate to the existing whole-result limit. The budget is checked incrementally before construction/encoding. Omit optional field values with closed reasons deterministically rather than allocate an oversized whole result and then truncate it.
6. A minimal unavailable marker/count must remain representable under the cap. Do not emit one unbounded diagnostic per skipped header. A fixed counter and finite reason vocabulary suffice.
7. No new process, timer, subscription, network request, SQLite query, per-node filesystem call, policy lookup, model call or extra reader is introduced. Pure derivation is bounded by the admitted node/listing set, not the full stored history.

UTF-8 payload accounting alone does not prove JS heap/RSS bounds. Retained source strings must be detached from large parser buffers/strings; transient copies, validation, canonical memo tokens, encoding, existing/prior frames and captured publication candidates all count. Measure actual allocations/heap/external/RSS under maximum-size fixtures. If the proposed caps cannot coexist with the existing whole-envelope/profile bounds, return the exact failure; do not raise a global cap, weaken the 200-node/20,000-header profile, or hide cost as “cold.”

Optional-metadata omission is honest missing display information. It must not be used to drop required graph/status/provenance or improve benchmark populations silently.

## 10. Complete proposed whitelist and ownership

No path is granted now. At release the dispatcher must freeze this exact whitelist against the accepted base and name one owner. “Same directory” or “data-only” is not disjointness.

### Production source (13 exact paths)

1. `src/core/types/native-display.ts` **new**: closed native action/rate/picker transport types only.
2. `src/core/types/observation.ts`: optional `nativeDisplay`; no classifier/recovery semantics.
3. `src/core/interfaces/session-evidence.ts`: share the bounded native action value/optional truncation flag; no new source reads or lifecycle authority.
4. `src/core/interfaces/harness-adapter.ts`: optional typed picker sidecar on `NativeTopologyResult`; no reader lifecycle/resource-policy redesign.
5. `src/harness/codex/index.ts`: same-boundary native display assembly, exact next reader version, existing baseline forwarding and shared optional-field accounting only.
6. `src/core/checkpoint.ts`: closed summary validators, compatible reader-version mapping, no-change digest normalization and bounded validation only; no recovery format/storage-layout change.
7. `src/core/link/display-fields.ts` **new**: pure bounded validation/assembly/availability and detached-copy helpers; no I/O, clocks, storage or model service.
8. `src/core/link/types.ts`: picker sidecar, parent provenance and compatible type additions.
9. `src/core/link/native-topology.ts`: capture allowed picker inputs in the already charged header path, sidecar revision/invalidation and aggregate optional retention accounting.
10. `src/core/link/index.ts`: attach validated picker input and viewpoint-parent metadata after final graph validation; preserve graph/count/read-plan semantics.
11. `src/core/link/view-model.ts`: typed native display and explicitly unavailable brief/digest slots.
12. `src/core/link/tick.ts`: same-snapshot detail propagation, fast refresh, retained/degraded clearing and affected parent refresh.
13. `src/core/link/memo.ts`: only demonstrated new-field/provenance invalidation, no general cache rewrite.

### New tests/fixtures (8 exact paths)

- `tests/unit/b9-b16-native-display.test.ts`
- `tests/unit/b9-b16-parent-picker.test.ts`
- `tests/unit/b9-b16-display-privacy.test.ts`
- `tests/unit/b9-b16-display-versioning.test.ts`
- `tests/fixtures/b9-b16-display.ts`
- `tests/int/b9-b16-display-fixture.mjs`
- `tests/int/b9-b16-display-commit.test.mjs`
- `tests/int/b9-b16-display-performance.mjs`

Reuse existing fixtures/helpers read-only. Do not weaken existing tests, change fixture populations, alter scripts or regenerate visual baselines. Any necessary existing-test edit must first be listed in a narrow explicit whitelist amendment with its unchanged assertion intent; do not silently claim all tests as owned.

### Documentation/evidence destinations

Proposed archival and implementation destinations, serialized by the dispatcher:

- `docs/cloud/B9-B16-DATA.md`: final implementation brief after accepted-base revalidation.
- `docs/cloud/rulings/b9-b16-data-conditional-brief-20261104.md`: this conditional consultation.
- `docs/cloud/handoff/b9-b16-data.md`: implementation report.
- `docs/cloud/handoff/b9-b16-data-manifest.json`: exact source/build/runtime/commands/outputs/hashes/lifecycle inventory.
- `docs/cloud/handoff/b9-b16-data-checks-node22.log`.
- `docs/cloud/handoff/b9-b16-data-checks-node24.log`.
- `docs/cloud/handoff/b9-b16-data-performance-node22.jsonl`.
- `docs/cloud/handoff/b9-b16-data-performance-node24.jsonl`.
- `docs/cloud/handoff/b9-b16-data-review-1.md`.
- If required by the normal bounded loop: `docs/cloud/handoff/b9-b16-data-fix-1.md`, `b9-b16-data-review-2.md`, `b9-b16-data-fix-2.md`, `b9-b16-data-review-3.md` in the same handoff directory.
- `docs/handoff/STATE.md` and `docs/universal-hud-engineering-plan.md`: dispatcher-only factual status lines, preserving backlog and gates.
- Only if a real fork is returned: `docs/handoff/questions/b9-b16-data.md`; recording a question grants no implementation.

Every evidence log is append-only by command/run identifier, preserving failed, interrupted, blocked and unrun stages. A reviewed manifest may reference a private raw archive where already authorized; this consultation creates/uploads no archive and grants no new destination.

### Specifically read-only/excluded paths

`src/collectors/delegation.ts`, `rollout.ts`, `token-rate.ts`, `session-finder.ts`, `subagent-tree.ts`, `hud-status.ts`, `tree-scan-store.ts`, `briefing.ts`, `model-jobs.ts`, `agent-log.ts`, all model/material stores, `src/snapshot.ts`, public v2 types/serializer, Claude readers, native recovery/recovery-index, ObservationStore, status writer/merge, publisher/reader-status, link actions/conflicts/verify/read-plan/ledger-reader, worker wire/runtime, all renderers, tree-page/index entrypoints, host/CLI/MCP/runtime/authorization, dependencies/configuration and existing benchmarks.

Read-only imports of `identityFromMeta`/picker formatting rules do not grant LEG1 source ownership. If pure helpers must move or change, stop for a named serial handoff rather than edit their file.

### Overlap reconciliation

| Package | Actual overlap/dependency | Required disposition |
| --- | --- | --- |
| B9-ICR | `link/types,index,view-model,tick,memo` overlap exactly | Prefer same data owner with explicit substage boundaries, or complete accepted ICR then a serial handoff. Never parallel writers. Reuse its relation-keyed provenance and per-conflict actions; no change to conflicts/verify/actions. |
| Inspector | New fields consumed from types/detail projection; renderer whitelist disjoint from this source list | Producer acceptance first. Consumer can prepare against missing optional fields, but no WIP interface borrowing or fabricated sample values. Final consumption uses exact accepted interface. |
| TPD1 | Later native picker consumption/effects; data source list deliberately excludes its files | Keep completed effect ruling. Existing exact-ID Switch remains; narrow no-ID fallback waits for accepted producer plus a separately named tiny consumer handoff. This package does not re-review or enable it. |
| B10D | Later collector/publication/worker integration; fields enlarge eventual view payload and costs | No `b10d-worker` imports or publication enablement. B10D rebases only in its ordered slot and requalifies real transport/accounting. If it proposes edits to these files, explicit serial ownership first. |
| LEG1 | Existing pure metadata helpers live in its `subagent-tree.ts`; discovery/header freshness semantics adjacent | Helpers read-only; no edits to LEG1 catalog/finder/tree/HudStatus/scan store. Its conditional delayed-discovery direction is not release or a freshness waiver here. |
| RCP1 | `interfaces/harness-adapter.ts`, `types/observation.ts`, `checkpoint.ts`, `harness/codex/index.ts` overlap exactly | Queue order plus explicit serial release/handoff. Data uses existing native recovery unchanged; RCP1 later preserves new fields and compatibility tests. No concurrent reader/version owner or accidental parking implementation. |
| Shared status/design docs | STATE, plan and rulings | Dispatcher serializes; implementations do not overwrite concurrent records. |

No “13 source files” count includes the separately owned B9-ICR implementation. If same owner is chosen, freeze the union explicitly and retain both briefs' scopes; do not merge their acceptance claims.

## 11. Producer-before-consumer schedule and release gates

1. Finish the applicable wave-1 work with its required verdict/report/evidence and actual merge gate. Read-only briefs do not replace this.
2. Reach the accepted B10B-S3F base and complete ordered DOC2/TPD1 wave-2 requirements. NEXT is not that base.
3. Revalidate this brief and completed B9-ICR/Inspector briefs on the exact accepted wave-3 base. Freeze names, versions, caps, exact whitelist and one owner/serial handoffs.
4. Implement/accept B9-ICR producer and this bounded data producer in their recorded order. If one owner handles both, review their complete combined diff without confusing one accepted slice with another.
5. Only then integrate Inspector's new field consumption and any separately released TPD1 picker consumption against accepted producers. Missing generic brief/digest remains an explicit known dependency.
6. Later B10D-2/LEG1/RCP1 follow the existing queue/route. Do not pre-merge universal-hud into frozen worker code as disguised early implementation.

Release requires all named prerequisites, a complete brief, exact owner allocation, supported-runtime disposition and an admitted execution window. No separate ordinary owner permission is invented for already authorized read-only planning or routine scheduled implementation, but neither broad approval nor this consultation waives queue/contract gates.

After release: one Astra-high implementer, fresh Astra-max Oracle for material design forks, final report/source/evidence verification and re-check. The dispatcher records/schedules and follows the existing at-most-two-fix-round loop. This draft grants no extra repair round.

Final integration remains fresh Oracle **accept**, verified report/evidence, `--no-ff` merge into `universal-hud`, full green check set on the actual merged tree, then push and factual status updates. Do not touch main, force-push, rewrite history or stage `node_modules/.package-lock.json`. Focused success or a green unmerged branch is not a green merged tree.

## 12. Future meaningful checks, not executed here

All tests use temporary HOME/HUD_HOME/source/TMPDIR and synthetic data. Each positive addition has a semantic assertion that fails without the implementation; missing imports or a compilation failure alone is not adequate failing-before evidence. Existing accepted invariants remain independently asserted.

### A. Native producer/commit/follower

Exercise actual synthetic Codex rollout → production reader → StatusWriter capture → ObservationStore commit → projection-only/follower read → SessionCollection/LinkTickCollector view.

- Open tool survives only as the bounded allowed action from the same complete checkpoint boundary; completion removes it; a complete no-open snapshot differs from unknown.
- A follower with no raw evidence and a process restart sees the same values/stamps as the leader.
- Latest of concurrent calls follows the current parser's order; no list-size expansion.
- Incomplete tail, unavailable source, malformed public record, recovery-truncated target, partial coverage and compaction/reset do not create current/known-none facts.
- No-op rereads preserve source times and do not publish on a display clock change. A real tool or rate change does publish and reaches fast refresh.
- Unknown fields do not change pending/activity/outcome, continuity, notices, wake/capacity, terminal state or status stateSince.

### B. Rate

Use real tracker semantics, not a hand-built constant:

- A valid finite sample and baseline travels unchanged, including estimated quality and correct ms/epoch units.
- Duplicate cumulative reports do not refresh sample time or dilute the rate.
- Overlapping waits deduct their union; an unmatched output does not freeze denominator forever.
- New turn with retained old `latest` sample is rejected until a compatible sample exists.
- Missing baseline, nonpositive/impossible sample span, negative/NaN/infinite data, future/backward timestamps, counter reset and generation change return unknown appropriately.
- Valid finite zero is distinct from absent; no sums across source/harness and no cumulative-token/time approximation.
- Existing legacy rate formatting/replay/v2 snapshot expectations remain unchanged.

### C. Identity/provenance and immutable refresh

- Same sessionId in different homes/sourceIds/harnesses/threadIds never joins.
- Old run/binding/source generation never becomes current after a new publication stamp.
- Ledger-only fallback never synthesizes native values.
- Unknown/newer reader, retired old writer, lease loss/CAS failure and crash boundaries preserve exact atomic summary/checkpoint and reject late writes.
- Summary old-version absence reads as unavailable; invalid optional member/type/string limit is rejected by the closed validator.
- New reader transition follows the existing controlled rebuild, with explicit gap/sourceGeneration/continuity behavior; no silent old-offset reuse.
- Held A frame stays unchanged after B; A → B → A produces correct new details. Test field changes not covered by old tool count/lastEventTime, fast committed refresh, picker revision and parent metadata refresh.
- No-change unknown `asOf` is excluded only where semantically correct; real value/source/window changes remain in content identity.

### D. Root parent

- Selecting a child as viewpoint root shows its already-validated external parent but keeps root depth/parentKey/nodes/counts/continuations/read demands identical.
- Parent outside loaded scope yields identity with unknown metadata and **zero extra I/O**.
- Multi-parent, cycle, self-edge, historical/handed-over, unbound and conflicting relations do not choose a parent by order.
- Current confirmed label versus missing label; exact compatible parent observation versus stale/mismatched one.
- Pane label only from the parent's exact already-verified host; duplicate/stale/wrong occupant/busy clears it.
- Native versus ledger provenance remains separately typed and tied to the captured source/sequence.

### E. Picker

- Full path differs from display leaf; nickname+role/role-only/primary naming rules preserved.
- Native title/model label cannot become exact picker identity.
- Header duplicate IDs, different sources with same ID, conflicting parent, rewrite/reset and malformed/control/oversize identity suppress the relevant input.
- Partial catalog, cap omission, 200-node truncation, unknown root/primary context never claims unique/complete picker scope.
- Immutable sidecar propagates through existing collector copy paths and memo invalidation.
- Data addition enables no effect. Future consumer tests remain separately owned and must still check the real live picker's exact/unique row.

### F. Brief/digest/privacy/resource negatives

- Bare-ID AgentLog notes/digests, recent generatedAt, link task hash, brief path and raw assistant update cannot fill a generic text slot.
- Missing generic producer is explicitly unavailable and performs zero model/store/policy/filesystem work.
- Synthetic private/reasoning/credential/claim/raw-argument/output/path sentinels are absent from persisted new fields, transport, diagnostic logs and fixture artifacts.
- Per-field, aggregate retained/encoded caps at and beyond boundary, multibyte Unicode and retained prior views are measured; no identity truncation or false complete coverage.
- Count I/O/queries/metadata calls before and after: zero extra source reads/queries attributable to display assembly; bytes are charged once, not hidden or doubled. Header extraction remains on the existing metered path.
- Failure injection preserves existing graph/status even when optional fields are invalid or exceed a cap.
- A test producing “all green” by skipping source/commit/follower stages is not accepted.

### Exact future command groups and caps

Run only after a recorded lease/admission, on the final frozen source/build. Node 22 >=22.13 and Node 24, with every required enabled proxy/runtime profile from the eventual accepted baseline; do not drop a known problematic profile. Commands below describe the new checks; no result is claimed.

| Group | Command | Outer workload cap |
| --- | --- | --- |
| Compile | `npm run build`; `npm run build:test`; `npm run build:hud-mcp` | 180 s each |
| New unit semantics | `node --test --test-concurrency=1 dist-test/tests/unit/b9-b16-native-display.test.js dist-test/tests/unit/b9-b16-parent-picker.test.js dist-test/tests/unit/b9-b16-display-privacy.test.js dist-test/tests/unit/b9-b16-display-versioning.test.js` | 600 s |
| New end-to-end | `node --test tests/int/b9-b16-display-commit.test.mjs` | 600 s |
| Existing data/projection | `node --test --test-concurrency=1 dist-test/tests/unit/b9-projection.test.js dist-test/tests/unit/b10a-data.test.js dist-test/tests/unit/b10a-memo.test.js dist-test/tests/unit/b10a-observation.test.js dist-test/tests/unit/b10a-topology.test.js dist-test/tests/unit/b10c-native.test.js dist-test/tests/unit/b16-writer.test.js` | 600 s |
| Existing reader/store | `node --test --test-concurrency=1 dist-test/tests/unit/b12-store.test.js dist-test/tests/unit/b12r-store.test.js dist-test/tests/unit/b12r-codex-recovery.test.js dist-test/tests/unit/b12m-metered.test.js dist-test/tests/unit/b12m-compat.test.js` | 600 s |
| Existing rate/material | `node --test --test-concurrency=1 dist-test/tests/unit/token-rate.test.js dist-test/tests/unit/token-rate-replay.test.js dist-test/tests/unit/wallclock-rate.test.js dist-test/tests/unit/agent-rate.test.js dist-test/tests/unit/b17-collectors.test.js dist-test/tests/unit/b17-legacy.test.js` | 600 s |
| Existing integrated projection | `node --test tests/int/b9-projection.test.mjs tests/int/b9-read.test.mjs tests/int/b10a-tick.test.mjs` | 600 s |
| New real-path measurement | `node tests/int/b9-b16-display-performance.mjs` | 1,800 s per separately admitted complete runtime series |
| Existing B9 measurement | `B9_LINK_EVIDENCE=<empty,populated,qualified,historical> node tests/int/b9-performance.mjs`, one command for each literal mode | 600 s per complete mode series |

If accepted B9-ICR exists in the release base, run its exact new unit/integration checks as well, from its own brief. That is a dependency regression, not a new conflict-design review. No nonexistent future test is claimed run at this pin.

Also retain **the full README set**, not just the focused groups:

```sh
npm run build && npm run build:test && npm run build:hud-mcp
env -u NO_COLOR -u FORCE_COLOR -u HUD_HOME HOME=$(mktemp -d) npm test
npm run test:core
npm run test:visual
npm run test:hud-mcp
npm run format:check
npm run check:fixtures
git diff --check
```

Future outer caps: 180 s per individual compiler, 1,800 s each for npm test/test:core, 600 s each for visual/hud-mcp, 300 s format, 180 s fixture check, 60 s diff check. Declare process cleanup/closeout separately under the governing lifecycle protocol; an outer timeout is not evidence that descendants stopped. If a predeclared full group cannot fit its window, return it for a revised bounded lease before launch; do not trim required populations during the run.

Known README flakes permit only the existing named isolated rerun, retaining both outputs. New data/identity/codec/ownership failures are not flakes. A denied or unsupported required facility is blocked, not passed by a narrower command. Keep full aggregate red/blocked while completing independent permitted checks.

### Performance evidence and unchanged gates

The new harness must execute the actual producer/commit/projection/collector path, not only a pure formatting helper. Keep separate populations: no-change, valid native change, optional-unavailable, busy/recovery, parent outside view, maximum picker strings/cap hits, held prior frames, zero/20/200 nodes and the supported 20,000-header catalog. Include empty/populated/qualified/historical link-evidence populations where governing B9 evidence requires them.

Use at least 200 warm-ups and 1,000 measured operations per declared steady population, three complete fresh-process series per required runtime/profile, retaining every failed/continued/incomplete/over-budget row. Startup/rebuild is separately identified, never used to reclassify repeated hot-path work.

Report source/tree/build hashes; runtime and linked SQLite version/settings; host CPU/OS/filesystem; fixture node/header/string/byte counts; warm-up/n; nearest-rank p50/p95/p99/max; all run ranges; real I/O and query counts; new encoded bytes; peak/retained heap/external/RSS; whole-operation and stage intervals. Show matched before/after, not best-run selection.

Keep the existing no-change wiring p99 <=2 ms share, B9 and whole-tick shares, and applicable compact/rich renderer gates. No new permissive helper threshold replaces them. The later worker gates remain paint p99 <50 ms/max <200 ms; selected operation p99 <100 ms/max <1,000 ms; local commit-to-paint p99 <50 ms/max <200 ms; follower p99 <C+100 ms/max <C+1,000 ms for C=1 s and 5 s, with original rolling-window/full-operation requirements. Preserve formal B14 >=10,000 samples, >=3 fresh starts and platform/SQLite/WAL/lifecycle obligations.

This package cannot qualify an unenabled worker by measuring a helper. It does not reopen the current S3F performance campaign or grant a new cold-tick exemption. WSL, real harness, Herdr/tmux/live-home and local effects remain owner-local, explicitly unrun here and never simulated.

## 13. Executor/lifecycle discipline

This report consumes no controlled-workload lease. Future implementation/checks require an explicit record naming exact source/tree/build, executor, owner, runtime/profile, commands, timeouts, UTC interval and return point. One controlled workload at a time on that executor. No parallel compilation, benchmark, source materialization or substantial archive processing during its measurement window.

A quiet process snapshot, elapsed time, conversation completion or a new shell/tool process does not grant a lease or prove cleanup. Previously held executors with unknown termination/custody remain held. “Unknown process id” does not establish exit. Do not kill unrelated processes or retry a denied workload through another wrapper.

Before launch, the selected supervisor/provider mechanism must be able to record terminal status and account for owned descendants. Preserve stdout/stderr, timeout/signal/exit and cleanup evidence. Return the lease only after its explicit terminal/owned-resource closeout; if outcome or custody is uncertain, stop new controlled work on that executor and report exactly what is known. Fresh-container admission, if later required, needs its own recorded authority and lifecycle mechanism; this report does not provision one.

## 14. Forks, stops and release disposition

### Already bounded within this conditional recommendation

- Additive internal native display/parent/picker data with closed missing-data behavior.
- Same-boundary Codex action/rate transport using existing parser/recovery.
- Exact reader-version compatibility disposition, subject to actual-base revalidation.
- No general model producer and no new navigation/control effect.
- Restrictive optional metadata caps below unchanged whole-system bounds.

### Separate design/ownership release required

1. **Generic brief/native-digest production and persistence.** Need a B17-compliant producer and local-display provenance/authorization/coverage handoff. This is not assigned here and must not enter the whitelist through a “missing-field fix.”
2. **Any incompatible summary/checkpoint/recovery or private storage change.** Return exact version/format transition and affected owners. Do not silently extend the compatible plan.
3. **Any picker fallback that requires a new root-membership/uniqueness authority, scan or changed control semantics.** Inputs alone do not provide it. TPD1 consumer ownership and effect proof remain separate.
4. **Any edit outside the 13 source paths/eight test paths, including LEG1 pure helper movement, RCP1 recovery internals, StatusWriter/ObservationStore changes, collector wiring or renderer changes.** Record a precise serial ownership amendment first.
5. **Any proposed gate/profile/freshness weakening, larger byte/reader/worker cap, smaller supported population, or cold classification exemption.** This is a contract/gate/profile question under dots' owner-reserved route, not an implementer optimization.
6. **Any new outward model data, purpose/recipient permission, navigation effect or local host probe.** No authority for it comes from this brief.

No need to ask the owner again merely to archive this read-only consultation. If a real contract/gate/profile/owner-reserved fork becomes necessary, the fresh Oracle should record the exact question, options and recommendation, then leave dependent work blocked while independent permitted work continues.

Stop on absent accepted base, unsatisfied queue predecessor, writer collision, missing producer for a claimed feature, unverifiable identity/provenance, inability to meet finite bounds, out-of-whitelist need, unsupported version transition, denied/uncertain execution or unproved cleanup. Report the precise action/target/reason, completed work and whether denied, pending or uncertain. Do not substitute a guessed source, another executor or a reduced test population.

**Release disposition: CONDITIONAL / NOT RELEASED.** The brief closes the missing read-only design/preparation item for the bounded native data/parent/picker-input slice. It does not release wave 3 now. Generic brief/native-digest production remains explicitly open. No implementation acceptance, runtime qualification, local validation or merge claim is made.

## 15. Pin-qualified evidence index

All links below refer to the inspected `26096e825baeccbce1403c8cbffa964e243f83ff` snapshot unless the linked file itself cites earlier evidence. Earlier embedded evidence remains historical, not a newer accepted base.

- [STATE and queue](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/handoff/STATE.md), [queue ruling](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/rulings/queue-progress-20261103.md).
- [B9-ICR completed brief](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/rulings/inspector-conflict-prerequisite-20261104.md), [Inspector source-field matrix](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/rulings/inspector-consumer-source-field-brief-20261104.md), [TPD1 disposition](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/rulings/tpd1-effect-boundaries-20261104.md).
- [Observation/Metric types](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/core/types/observation.ts), [SessionEvidence](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/core/interfaces/session-evidence.ts), [native topology interface](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/core/interfaces/harness-adapter.ts#L47-L67).
- [Codex capture and checkpoint](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/harness/codex/index.ts#L327-L392), [Codex native action projection](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/harness/codex/index.ts#L452-L636), [parser getters](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/collectors/rollout.ts#L1706-L1722).
- [Rate authority and semantics](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/collectors/token-rate.ts), [recovery target truncation](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/harness/codex/recovery.ts#L409-L423).
- [Closed summary codec](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/core/checkpoint.ts#L318-L336), [content identity](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/core/checkpoint.ts#L864-L902), [controlled store transition](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/core/observation-store.ts), [StatusWriter](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/core/status/writer.ts).
- [Collector/follower boundary](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/collectors/delegation.ts), [full-ref current-observation gate](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/core/link/index.ts#L73-L89), [validated parent graph](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/core/link/index.ts#L144-L270), [root/parent projection gap](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/core/link/index.ts#L303-L424).
- [Metered public header](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/core/link/native-topology.ts#L203-L249), [bounded native output](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/core/link/native-topology.ts#L342-L368), [native picker identity helpers](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/collectors/subagent-tree.ts), [navigation exact/unique checks](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/utils/session-navigation.ts).
- [Details interface](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/core/link/view-model.ts), [tick fast refresh/degraded/detail assembly](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/core/link/tick.ts), [memo fields](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/core/link/memo.ts#L52-L94), [host validation](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/core/link/host.ts).
- [B17 material boundary](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/core/materials/README.md), [derived persistence](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/core/materials/derived.ts), [legacy notes](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/collectors/briefing.ts), [legacy digest/apply](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/collectors/model-jobs.ts), [legacy log shape](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/src/collectors/agent-log.ts).
- [RCP1 ownership/version/resource brief](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/rulings/rcp1-conditional-brief-20261104.md), [LEG1 brief](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/rulings/leg1-conditional-brief-20261104.md), [LEG1 owner direction](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/rulings/leg1-owner-direction-20261104.md), [B10D route](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/rulings/b10d-route.md).
- [Observation/resource contract](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/contracts/06-observation.md), [version/privacy/compatibility contract](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/contracts/07-outbound-compat.md).
- [Workflow](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/dots.md), [full check set](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/README.md#L63-L95), [resource leases](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/rulings/wave1-resource-windows-20261103.md), [executor custody ruling](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/docs/cloud/rulings/p065-repaired-candidate-fresh-executor-supervision-20261103.md).
- [Existing production B9 measurement](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/tests/int/b9-performance.mjs), [native topology regressions](https://github.com/CartmanFatass/codex-hud/blob/26096e825baeccbce1403c8cbffa964e243f83ff/tests/unit/b10c-native.test.ts).

**End of conditional brief. No implementation or validation result is claimed.**

