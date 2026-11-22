# B10B-s4 Inspector consumer: conditional source-to-field brief

Date: 2026-11-04 UTC. Fresh read-only Oracle architecture consultation for CartmanFatass/codex-hud.

**CONDITIONAL / NOT RELEASED.** This is the remaining Inspector **consumer** brief, not implementation, a test-window release, acceptance, a merge verdict, or permission to use an unaccepted branch. The current queue still blocks it. No source, test, branch or repository document was changed during this consultation. This standalone requested brief is the only write.

## 1. Decision and scope

Implement a pure Inspector over the accepted delegation view, with exact delegation-key selection and a preserved legacy Inspector. Cover the design §4.11 heading/facts, Link, Run, Reports, Candidates, current-versus-previous observation, root Slots/Coverage, Open-disabled explanations and the MVP Resume diagnostic. Consume the accepted B9-ICR conflict view and its captured descriptor; do not re-create that producer. Reuse the accepted row-action/input path; do not implement TPD1 effects again.

The change must not manufacture a `SubagentTreeNode` to make a delegation key fit the legacy renderer. A synthetic conflict row deliberately has no node and must remain a relation, not an attributed child/run. A missing optional display field is missing information, not permission to read a source, infer a value or copy an older run's facts into the current run.

The eventual acceptance statement must distinguish **the bounded Inspector consumer** from the still-dependent end-state design. In particular, the current producer does not carry every sample field in §4.11. The source-to-field matrix below is the exact missing-input inventory. A later dispatcher must either supply accepted producer additions before claiming those fields, or record a fresh Oracle's explicit disposition of those specific deferred fields in a consumer-stage release. The dispatcher does not choose that scope itself. This brief does not silently mark the full end-state sample complete.

No change to contracts, capabilities, numeric gates, B14 real-resume gate, queue order, conflict qualification, capacity semantics, B16 status merging, observation publication, host verification or CLI authorization is proposed.

## 2. Inspected source and evidence limits

- Integration: **universal-hud@2e2d94821c017a3d832cb275253931c7f1251f3f**, read through the GitHub connector on 2026-11-04. The full recursive tree returned `truncated=false`.
- Candidate reference only: **dots/b10b-s3f-next@60b5959d02516e73d30cd5a55913eb6988a94ea9**. Its S3 actions, selection, frame and control-bar interfaces remain unmerged. It is not the implementation base.
- [AGENTS][AGENTS], [dots workflow][DOTS], [STATE][STATE], [queue ruling][QUEUE], [README checks][README], [architecture §8][ARCH], [design][DESIGN], [contracts 03/06][C03] [C06], the concept decision log and the [complete-brief requirements][PLAN] were read. The [B9-ICR prerequisite][ICR] and [TPD1 effect-boundary ruling][TPD1] remain binding and unchanged.
- `monitor-inspector.ts` is blob `e60c880ebe5a67c4d287547ca992acee113b0bf0` in both inspected refs. It still resolves the selected ID only through the legacy tree (`findNode`, lines 44–50 and 110–113).
- The integration data interfaces remain `core/link/types.ts` blob `90ed9be1f038a0b456c7e4e0887fc35ed02463e3`, `view-model.ts` blob `f96f5f3ab26827aaaff08f3edbae6abd8c357e69` and `tick.ts` blob `6421e4ee875a58f780bbe50c0e0721fe1cbfe771`. The newly archived ICR document does not itself add `conflictDetails` to these sources.
- This consultation inspected source and documents only. No tests, builds, benchmark, dependency installation, source materialization, subprocess probe, local-machine session, host action, clipboard action or subagent was started. Tests below are future requirements, not passes.

## 3. Source-to-field matrix

In this table, `view` means the **same accepted DelegationView captured for the rendered frame**, `pn` is its selected real planned node/relation, `node` is `pn.node` when present, and `detail` is `view.vm.details[node.key]`. Sources are immutable pins. Future fields must arrive through an accepted typed read-model, not an ad hoc renderer cast or raw ledger query.

| Display | Authoritative input and present availability | Consumer rule / missing dependency |
|---|---|---|
| Selection and identity | `view.plan`, `view.dest`, `tree.selectionMap`, `PNode.key`, `node.identity`; full session identity includes harness/sourceId/sessionId/threadId. [S3 selection][SEL] [projection][PROJ] [identity][IDENTITY] | Resolve the already-reconciled canonical row key, not label, array index, short ref or bare session ID. A conflict row is selected through its actual `PNode.relation`; never parse its display key backwards. Preserve intent→session mapping and existing hidden/put-away selection behavior. |
| Heading: name, harness, kind, marker, words | Existing `pn.proj` and its marker; `node.native.title/kind`; selected relation label/role. [projection][PROJ] [facts][FACTS] | Reuse escaped presentation facts and existing marker semantics. Do not sanitize already-painted ANSI a second time. Do not convert a native title into a picker label or control identity. No new status classifier. |
| Heading actions | Accepted `rowActions` / `selectedActions` from the same frame, with existing typed action helpers. [actions][ACTIONS] [frame][MONITOR] | Header and bar use one action description and the same descriptor object. A grey Open is inert; a grey Resume remains a diagnostic control. Do not add run/host/clipboard effects to a renderer. |
| Workspace, model, effort, context, cost | Only `node.observation` current values; `Metric.quality/value/source/asOf`; `workspace` provenance. [observation types][OBS] | Unknown metrics are omitted, valid zero is retained, estimated remains estimated. Ctx uses actual `used/window/percent`, not a denominator inferred from model. Observed workspace and frozen `currentRun.launchCwd/workspaceSnapshot` are separate facts. A declared project origin stays labelled declared. No Git or filesystem read. |
| Activity, pending reason, state age, last evidence | `detail.status` and its provenance/source, existing marker continuity; `stateSinceBasis`, `lastEvidenceAt`, freshness and clock-anomaly fields. [VM][VM] [OBS][OBS] | State residence and evidence age are distinct. Event/observed/unknown bases remain distinct; unknown/future/anomalous time is not a fabricated age. Last evidence must not be relabelled transcript “last activity” when that provenance is absent. |
| Turn age, output rate, current tool/action, brief text, native digest | Not present in current `ObservationView`/`DelegationNodeDetails`; current native metadata is title/kind only. [OBS][OBS] [VM][VM] [types][TYPES] | These are separately owned B9/B16 additions in STATE. Omit unavailable values and record them as missing inputs; do not read legacy data by bare ID, reopen a brief path, fetch transcript bodies, or calculate rate from cumulative tokens. A sample's `Out ~42 tok/s` is not a default. |
| Link identity/state, role, label, backend, predecessor | Exact selected `pn.relation.link`, with `node.links` identifying membership; `Link` fields. [PROJ][PROJ] [lifecycle types][LIFE] | Link state and run state/handshake are independent. Show handed-over predecessor as history, never as a second current parent. A backend is not proof of binding method. No raw owner key or caller internals. |
| Parent | `node.parent` when actually projected; or the exact selected relation's explicit `link.parentRef` for a short diagnostic identity. [types][TYPES] [tree assembly][TREE] | A supplied parent name/liveness/verified pane may be displayed. A ref alone does not supply name/liveness/pane. Viewpoint-root `node.parent` is currently absent because assembly fills it only from a rendered parent (`index.ts:412–424`); the queued root-parent producer remains separate. Do not invent it from same cwd, pane or a display name. |
| Link binding proof / `mcp · receipt+transcript` sample | Current relation has `verification: not_observed/corroborated/conflict`; `Link` does not expose bound_by/capabilities/proof IDs. [TYPES][TYPES] [LIFE][LIFE] | Show the exact available verification category, not the stronger sample claim. Binding methods and capability/proof detail need accepted producer fields. Do not parse record IDs or infer mcp authority from backend. |
| Per-run handshake | `node.observation?.runHandshake` only when that observation is current for the selected run. [OBS][OBS] [current-observation validation][TREE] | Show state plus reason when provided. Link `bound` does not imply this run's handshake is bound. With no current handshake input, omit or label unavailable; do not reconstruct from link.state/launchPhase. A ledger-only handshake needs a separate producer addition. |
| Parent offline and wake | `detail.parentOffline`; `detail.wake`, attempts, unavailable reason. [VM][VM] [tick assembly][TICK] | Offline `continue` does not imply child ended or Open disabled. Show registered/degraded/unconfirmed wake; suppress none/absent as specified. During degraded retention do not present a stale wake as current registration. |
| Run facts | `node.currentRun`: exact runId/runSeq/operation/mode/supervisionStrategy/state/start/end/heartbeat; `node.execution`. [RUN][RUN] [OBS][OBS] | Render only the node's attributed managed current run. Never substitute `relation.currentRun` for a synthetic conflicted child. Keep requested termination cause, observed exit/signal/scope evidence and attribution separate. Native exit requires `exitSource`; shell status belongs only in More and is never native exit. Unknown exit is not 0. |
| Run reconcile information | `node.execution.reconciliation.cause/missing`; `detail.reconcile`. [VM][VM] [TICK][TICK] | Show cause/missing literally and safely. Only the supplied descriptor is command authority. Existing VM lacks the full reconciliation evidenceIds/observedAt; do not reconstruct them from strings/events. No command generator import into rendering. |
| Log paths | The current VM has no complete trusted HUD-home/log-path field. TPD1 owns fixed-run both-stream path presentation on explicit Log. [TPD1][TPD1] | Preserve Log action and its truthful path result. Do not invent `~/.hud`, use CODEX_HOME/hud, mine a descriptor for an unrelated path, or read logs while painting. A persistent Run log-path line needs accepted structured path metadata or an explicit separately scoped presentation handoff. Automatic tail panes remain deferred. |
| Reports, current run | `detail.latestReportForRun` and `detail.reportHistory`, which `tick.ts:571–679` filters to the current run from accepted report.received facts. [TICK][TICK] [LIFE][LIFE] | Reports section always exists for a managed current run. With a readable, adequate current snapshot and no accepted report, show `none yet`; it means this run, not the whole link. Under busy/unavailable retention, label retained information and the ledger reason rather than asserting an up-to-date absence. Display report status/summary/time/path provenance; a report is not proof the process ended. |
| Previous observation / previous report | `node.lastObservation` is explicitly historical-capable; its own identity, observation stamp, optional currentRun and latestReportForRun. [TYPES][TYPES] [OBS][OBS] | When current observation is null, say no current observation. Label a retained summary “Previous run” only if its own matching identity/stamp proves a different run; otherwise say retained/previous observation and do not invent a run number. `reportHistory` is **not all-run history**. Do not assign old completed/failed/model/context facts to the new run. Full historical run pagination needs accepted producer data. |
| Candidates | Bounded `tree.candidates` with full ref, linkId, kind, recordId, asOf/observedAt/reason. [TYPES][TYPES] [TREE][TREE] | Show only as suspected/unconfirmed facts. Exact full-ref or exact relevant-link membership determines selected-node scope; never label-match. A root-wide list is explicitly labelled tree-wide, not attributed to the root. Candidates never become edges, confirmed counts, actions or a real child run. Use retained metadata only. |
| Conflict display/actions | Accepted ICR relation-keyed `conflictDetails`, primary, bounded record summaries, full counts, unavailable reason and descriptor. Currently absent; prerequisite not implemented. [ICR][ICR] | Consume the producer's exact complete relation identity and snapshot provenance. At most five record rows, `+N more` for retained-but-not-shown records and a separate producer omission count. No new earliest-record choice, run lookup, evidence verification or fallback to a later actionable record. |
| Root Slots | `vm.capacity` plus `vm.limits`, exact occupant runId/linkId/holder/state/since. [CAP][CAP] [LIMITS][LIMITS] | Only a viewpoint root with readable ledger and non-null capacity. Display active/limit and mine/mineLimit directly, including valid zero and default limits. Match names/reports by exact link/run; unknown outsiders remain held outside this tree. Never infer owner from process metadata or recompute occupancy from visible rows. |
| Root/selected Coverage | Node/tree Coverage; `tree.counts`, `continuation`, `truncation`, `ledger`, and `view.proj.omittedConflictRows`. [TYPES][TYPES] [TREE][TREE] [PROJ][PROJ] | Different units, scopes and subsets are kept separate, as §7 below requires. Do not copy the summary chip's summed arithmetic into the Inspector. |
| More identities and stamps | Exact link/run IDs, full known SessionRef components, run.operation, ledgerId/asOfSeq; observationStamp/commit domain/sourceGeneration; actual run expectedGeneration. [IDENTITY][IDENTITY] [OBS][OBS] [RUN][RUN] | Separate ledger and observation stamps. Never compare cross-domain sequences. Binding generation is not occupant generation or reader generation. Missing occupant-generation evidence stays missing; do not invent it from arbitrary locator JSON. T4 fields remain excluded. |

**Privacy boundary:** Only explicit whitelisted display fields are rendered, never JSON-dump a Link, Run, locator, report or observation. Exclude claims, tokens, credentials/hashes, raw transcript, parent-owner keys, launch-correlation internals, heartbeat sequence/monotonic fields and arbitrary host URLs. Paths follow existing safe display/redaction rules; without a trusted display-path input do not reveal or guess a private home prefix. A trusted descriptor's intentional copy text is handled under its existing action contract, not by exposing arbitrary object members in More.

## 4. Canonical selection and render wiring

1. Use the same frame's `DelegationView` that supplies the agents rows, bar and input. Add only an optional view/context handoff through `renderMonitor → paneRows → inspectorRows`; direct legacy callers remain valid. Do not build a second incompatible tree from `input.tree` or call a second collector.
2. `preview=agent` with a non-null delegation view chooses a typed delegation branch. Resolve `state.tree.selectedId` in the captured planned destinations. A node row uses its `PNode`; a synthetic row uses its exact relation. Do not assume `proj.byKey` includes synthetic conflict rows; it does not.
3. Preserve S3 reconciliation before rendering: canonical keys survive reorder and intent binding; hidden selections follow existing nearest-destination/put-away rules. No new trouble-stop target is introduced. A put-away summary is an aggregate with no borrowed child command; it may show a short aggregate description only. A truly missing target gets a bounded unavailable diagnostic, not the first similarly named legacy agent.
4. Non-agent previews (file, worktree, diagnostics) and the legacy agent branch stay byte-identical when delegation is absent. Preserve More/Less, details scrolling, tabbed/stacked layouts, focus, Escape/back, timeline return and viewport accounting.
5. Keep existing click-to-select behavior. This package does **not** adopt the optional compact click-to-open change mentioned by S3. Enter/Space/v inspect only and emit no action.
6. Header action labels are the same Open/Switch/Log and Reconcile/Resume words as the bar. Their row-local hit spans must be transformed to frame coordinates only while the row is visibly drawn, clipped to actual text, and excluded when scrolled away, behind a modal or dropped for width. Disabled Open has a dead hit target; Resume's diagnostic remains intentionally reachable. A word that is merely body text must not become a control.
7. Header actions reuse the existing action helper and retained frame target. If current state or a newly received VM differs, a click still identifies the target the user saw; it may be refused downstream but never retargeted. Header/bar/key Reconcile must carry the **same descriptor object**, not reconstructed equivalent strings. Any adjustment to input is limited to this captured-row/header plumbing, not dispatch effects.
8. Rendering is pure: no clock calls, I/O, process, clipboard, focus, collection, schema write, parsing of arbitrary evidence payloads, model call, or action during repaint/selection/notification. The supplied `nowMs` is the frame's clock.

## 5. Open-disabled reasons

Expose a small pure explanation from the **same action eligibility facts** used by accepted `rowActions`; do not create a competing enabled predicate. Only rows whose applicable action is Open display an Open explanation. Headless Log, native Switch, roots/aggregates with no Open and plain unsupported rows do not acquire an Open capability through this section.

For a disabled Open, report the strongest directly known blocker, with additional source facts below if useful:

- `supervisor lost` only when the accepted reconciliation/status says supervisor_dead; an old heartbeat alone does not establish it.
- Other `uncertain` state from the accepted status/reconciliation, with the provided reason. Do not turn it into ended or auto-resume.
- Conflict / no attributed managed target when that is explicitly the selected row's fact.
- `ledger_busy` or the exact unavailable reason when the display is retained/degraded; never portray retained checks as freshly verified.
- `occupant mismatch` only for `occupantMatches=false`; `null` is unknown, never equal to another null. A “checked Ns” suffix is allowed only for a finite, nonnegative, non-future checkedAt and the frame's clock.
- `locator stale` only for state=stale.
- Otherwise `not verified` for missing/unknown host, absent currentState, missing check or absent trusted production composition.

No pane label is taken from an unverified locator. `currentState.label` is the existing trusted display source. Binding generation must never be substituted for occupant generation. Parent offline/continue is independent and does not itself disable an otherwise verified child Open.

The source gate presently consumes verified host currentState and the B16 uncertain state key. If the eventual accepted base exposes contradictory gate facts, return that exact issue rather than making the explanation say “disabled” while the actual control is enabled. Any correction must preserve the existing contract's fail-closed meaning and receive the normal fresh Oracle review.

TPD1's production HostAdapter remains null until its separately owned host-observation/composition prerequisite is accepted. Synthetic positive render tests do not qualify production focus; this consumer never supplies a fake host or bypasses that boundary. [TPD1 §3][TPD1]

## 6. Resume and conflict consumption

### Resume

Use S3's applicability, not the constant `detail.resumable=false` as an appearance gate: a managed terminal current run with a report of any accepted status, with no Reconcile descriptor, has the grey Resume diagnostic. An alive reported run, ended run without a report, native/plain node, put-away row or synthetic conflict does not gain Resume. Reconcile has precedence.

The Inspector displays the existing exact translated diagnostic:

- EN: `resume not verified on this machine · ask the parent to delegate_resume`
- ZH: `本机 resume 入口未验证 · 请原父调用 delegate_resume`

R/header/bar activation returns the same diagnostic action. No resume command, clipboard call, request key, process, run transition or capability verification is added. B14 remains the real-resume gate. [S3 Q3][S3]

### Conflicts

The consumer waits for an accepted B9-ICR producer and its final typed interface. Use `PNode.relation` to obtain the exact relation identity; require metadata belongs to the same enclosing ledger identity/sequence. If missing, stale, ambiguous or mismatched, show retained aggregate facts plus the unavailable reason and offer no command. A conflicted real node with no uniquely selected relation cannot choose one by array order just to offer Reconcile.

Show the producer's ordered retained records and its primary selection. Do not sort them anew to pick an action, use currentRun of a newer relation, skip a native/no-run primary, parse an opaque record ID, or treat the first visible row as primary. At most five records are visible initially. The counts for additional retained records versus records omitted by the producer remain separately labelled. `no run attributed` remains true for synthetic rows; capacity occupation is a separate fact. No per-record buttons for later records are introduced.

Feed the producer's one immutable descriptor into the existing RowActions path for both surfaces. When null, neither body text nor a diagnostic invents a `hud run reconcile` string. Busy/identity-change clones must not show a presently usable old command. This tests consumer refusal; clearing/qualifying/choosing the underlying descriptor remains the producer's responsibility. TPD1 continues to own all actual copy and feedback behavior. [ICR §§4,8][ICR]

## 7. Non-overcounting Coverage and Slots

### Coverage units and overlap

The decisive current source fact is `knownUnloaded = knownOmitted + retained nodes with loaded=false`, while `omitted = knownOmitted` ([index.ts:479–480][TREE]). **omitted is already included in knownUnloaded.** The existing compact summary chip sums knownUnloaded, omitted and omittedConflictRows; the Inspector must not copy that formula. Changing that existing summary is outside this brief and needs its own scoped disposition if pursued.

Render facts in separate labelled rows, only when incomplete/nonzero/unknown:

1. **Node coverage:** `node.loaded`, node.coverage.state/reason/skipped/gaps. Counts in skipped are skipped records by category, not missing sessions. Retained observation coverage is identified as that observation's coverage, not silently merged into tree coverage.
2. **Tree knowledge:** `counts.knownUnloaded` as known identities not loaded. `counts.omitted` as the **included subset** not represented in the bounded B9 tree. Example: “3 known not loaded · including 1 omitted by tree budget”, not “4 missing”. If a future accepted producer changes this definition, revalidate wording from its contract rather than retaining arithmetic by habit.
3. **Unknown descendants:** a boolean “children unknown”, not `+1` and not an estimated numeric total.
4. **Continuation:** existing key/reason metadata, with nodes/depth/bytes/unloaded/native_topology reasons. Entries can overlap unloaded nodes and each other by scope; never sum them into missing sessions. `truncation.continuation` counts continuation entries not retained.
5. **Metadata truncation:** independent candidate records, conflict-record summaries and continuation entries. `truncation.conflictRecords` is a producer aggregate across attached bounded conflicts, not guaranteed unique missing records across relations; label it metadata entries not listed, never unique children. Per-relation ICR omitted count is separate and is not added again to the tree aggregate.
6. **Renderer cap:** `proj.omittedConflictRows` counts relation display rows that did not fit the renderer's 200-node cap. It is neither unique children nor omitted B9 nodes, and is not added to either knownUnloaded or omitted. Multiple claims for one child may be multiple omitted rows but one conflict count.
7. **Outside-tree conflicts:** count/describe exact conflict relations whose parent is absent from the rendered real-node tree separately from cap-omitted rows. If giving a child count, explicitly deduplicate by full childKey and label it children; if giving a relation count, label it relations. Never infer one unit from the other or add them to “missing sessions”. No fake navigable row or trouble-stop parent is created.
8. **Ledger:** exact state/reason, with busy retention explicitly described. A null ledger high-water mark remains null, not zero; capacity unavailable is not zero occupancy.

A root-only supplemental pass may derive outside-tree counts from already retained metadata, without extra reads. Reuse the projection's canonical real-node index and memoize by immutable input snapshot when needed; do not rescan all relations on every clock-only repaint or keep an unbounded history cache. Keep any derived counters separate from existing graph/count semantics. No source budget is raised to make Coverage look complete.

### Slots

Use capacity.active/limit and mine/mineLimit directly. `limits.source=default` produces the default note; invalid/unavailable configuration reason remains explicit. Present own occupants in existing projected bucket order when exact current node/run data permits; otherwise use a stable, truthful run/state entry. An uncertain occupant says reconcile first; a still-alive visible reported occupant says close pane only when that exact run's report/mode are known. Neither label clears its slot.

Other holders may be grouped under a visible parent's name only when an exact relation parent identity resolves in the same snapshot. Otherwise use held outside this tree. No `ownerKey` is present in the HUD capacity projection; do not derive one from processes or label collisions. Slots is read-only aggregate information: commands appear only in the corresponding selected occupant's own Inspector, never as bulk controls here. [capacity implementation][CAP] [design §4.11][D411]

## 8. Complete conditional ownership proposal

No source ownership is granted now. On the eventual accepted base, the following is the complete renderer-only whitelist, subject to the release revalidation below:

1. `src/render/delegation/inspector.ts` (new): typed selected-subject resolution, pure field/section formatting, bounded candidate/report/conflict presentation, root Slots/Coverage and small per-snapshot derived display caches.
2. `src/render/monitor-inspector.ts`: delegate only the agent-preview branch when a captured delegation view is present; retain legacy/file/worktree/diagnostic code and existing text helpers.
3. `src/render/monitor-panes.ts`: optional captured-view parameter forwarding to Inspector, no unrelated pane changes.
4. `src/render/monitor.ts`: supply its actual retained view to that route; header row-control visibility/coordinate plumbing and only necessary compatible type additions. Preserve TPD1 copy-feedback input/forwarding untouched.
5. `src/render/delegation/actions.ts`: expose the existing Open-disabled explanation through the shared pure action facts, and consume accepted ICR relation descriptors. Preserve ordinary row applicability and existing typed actions; no effects or command creation.
6. `src/render/monitor-input.ts`: only Inspector header hit routing/captured-frame target alignment through existing action helpers, keeping key/bar parity and legacy paths. No new action types, dispatchers, timers or external effects.
7. `src/render/i18n.ts`: only the new consumer labels, explanations and section wording, EN/ZH. Reuse existing Resume wording and TPD1 feedback keys.

New tests, with synthetic fixtures/helpers kept within this exact test set:

- `tests/unit/b10b-s4-inspector.test.ts`
- `tests/unit/b10b-s4-actions.test.ts`
- `tests/unit/b10b-s4-coverage.test.ts`
- `tests/unit/b10b-s4-legacy.test.ts`
- `tests/unit/b10b-s4-performance.test.ts`
- `tests/fixtures/b10b-s4-inspector.ts`

Existing fixtures/tests are reusable read-only. No blanket snapshot/baseline update is permitted. If the final implementation needs another file, return the precise missing ownership item before expanding.

Read-only boundaries: `core/**` (including ICR's eight files), `collectors/**`, `tree-page.ts`, HostAdapter/integrations, worker/wire, status/observation merge/publication, ledger/MCP/writers/schema, CLI/bin, control-bar effects, projection/facts/rows/selection semantics, package/dependency/config files, contracts/design/status and existing visual baselines.

Ownership collisions are explicit:

- S3/NEXT owns overlapping renderer/action/input files until its actual accepted integration. No parallel consumer implementation now.
- TPD1 overlaps monitor/i18n, so its preceding accepted implementation is a prerequisite and its copy feedback remains intact. The new header is a consumer of its existing typed effect route, not a second implementation.
- B9-ICR owns core/link producers and must be accepted first for the conflict consumer. Other B9/B16 producer additions must have one owner; this renderer does not absorb them.
- DOC2 owns the design update and precedes this package. Do not rewrite its design decisions in consumer code.
- B10D-2 remains later; no worker/collector wiring or permission is inherited. P065, wave-1 evidence and ledger-audit work remain outside this brief.
- Dispatcher records are serialized: suggested final brief `docs/cloud/B10B-s4.md`, this source-map ruling under `docs/cloud/rulings/`, eventual report/reviews and evidence under `docs/cloud/handoff/b10b-s4/`, and factual STATE/plan updates only at real milestones. Recording this text does not release the package.

## 9. Future acceptance evidence

Every changed behavior gets a meaningful failing-before assertion through production-used render/input code. Tests of a disconnected formatting helper alone are insufficient.

### Required cases

1. A delegation selection with an **empty legacy tree** renders the healthy heading/Link/Run/Reports; a native session and an intent render only their truthful fields. Same short IDs and display labels across two sources/harnesses do not cross-select. Binding/reorder retains the canonical target.
2. Synthetic conflict selection renders relation metadata without a node or attributed run. Current run B with historical-primary run A uses only the producer's A descriptor. Missing/ambiguous/unknown-time/native/no-run primary stays unavailable. More than five retained records and producer omissions have correct separate labels. Old fixtures without conflictDetails fail closed.
3. Current observation null plus retained old observation gives explicit historical labelling, not current metrics or a new-run completed report. Retained observation with unknown run provenance does not get an invented run number. Current-run reportHistory is not treated as all-link history.
4. Reports of completed/failed/blocked/interrupted are rendered with their own accepted identities. None-yet is scoped to the current readable run. Busy/unavailable retention never claims fresh report absence, zero capacity or valid Open.
5. Open explanations cover supervisor_dead, ordinary uncertain, stale locator, explicit mismatch, unknown check, invalid/future checkedAt, missing host, degraded ledger and available verified host. Parent offline/continue does not impersonate supervisor death. Different generation fields remain different. No missing reason is replaced with optimism.
6. Managed terminal+reported of each report status shows the exact bilingual Resume diagnostic; alive+reported and ended+unreported do not. Reconcile precedence remains. Header/bar/R diagnostic emits no copy. Rendering, Enter/Space/v and repeated clock ticks emit no action.
7. Header/bar/key Reconcile return object-identical descriptors from the seen frame. Render A then change state/VM to B before click; never retarget to B. At narrow widths/scrolled-away header/modal/zero height, there is no invisible hitbox or key action from an absent control. Grey Open cannot invoke an action; grey Resume can emit only its diagnostic.
8. Coverage fixture: 3 knownUnloaded containing 1 omitted, 2 omitted conflict relation rows for one child, unknownDescendants=true, and each truncation category nonzero. Assert no summed “missing sessions” total; relation rows versus children versus metadata stay distinct. Include outside-tree conflict and confirm it creates neither a row nor a new n/N stop.
9. Root Slots shows total/mine/default limits, valid zero, outside holders and exact-run uncertain/close-pane notes. Visible row count does not determine occupancy. Non-root never receives root aggregate controls. Unreadable ledger hides Slots with an explicit Coverage diagnostic rather than showing 0/0.
10. Candidates with matching labels but different full refs stay unconfirmed and correctly scoped. Truncated candidate metadata stays explicit. Candidate/raw report/control-looking text never produces commands, ANSI injection or extra controls.
11. More keeps ledger/observation stamps and all three generations separate; sensitive/T4 fields placed in a fixture do not appear anywhere. Unknown numbers stay unknown, quality-qualified zero stays zero. Paths and arbitrary external strings are sanitized once, with CJK/wide/combining/control characters covered.
12. Legacy absent/null delegation, file/worktree/diagnostics, all five looks, color/no-color, icons-off, compact/rich, EN/ZH, normal/narrow/extreme/zero dimensions, scrolling, More/Less and Escape/back stay correct. Require byte-identical legacy frames where no consumer fields are involved and exact terminal-cell widths for new frames.

### Meaningful isolated controls

On separately built controls only: force legacy-only lookup (delegation/empty-legacy test fails); sum knownUnloaded+omitted (Coverage subset test fails); substitute lastObservation into current facts (new-run isolation test fails); choose first actionable conflict record instead of supplied primary (fixed-primary test fails); rebuild descriptor from a new VM (object/target capture test fails); execute a Resume copy path (zero-effect test fails). A missing import/build failure is not a useful negative control. Do not mutate integration or leave control sources active for final checks.

### Commands, timeouts and evidence location

These are future commands after explicit release, with the accepted runtime/supervision protocol, exact source/tree/build/runtime identities, synthetic temporary HOME/HUD_HOME/TMPDIR, stdout/stderr and direct/outer statuses, UTC/monotonic boundaries and authoritative owned-process cleanup. No new wrapper or lease is authorized by this table. Reconcile timeout caps with the then-current recorded supervisor before launch.

| Command/group | Outer cap | Required result |
|---|---:|---|
| `npm run build`; `npm run build:test`; `npm run build:hud-mcp` (each) | 180 s each | Fresh successful outputs for the exact candidate; a reached tsc invocation is not a pass. |
| `node --test dist-test/tests/unit/b10b-s4-inspector.test.js dist-test/tests/unit/b10b-s4-actions.test.js dist-test/tests/unit/b10b-s4-coverage.test.js dist-test/tests/unit/b10b-s4-legacy.test.js` | 300 s | All semantic/render/input cases above pass on production-used paths. |
| Accepted S3 action/input/selection/width/legacy and TPD1 dispatch/feedback regression files, exact names recorded from accepted base before running | 600 s | No changed action, stale-frame, selection or effect regression; do not invent unmerged paths. |
| `node --test dist-test/tests/unit/b10b-s4-performance.test.js` | 600 s per complete series | Required full-scope metrics and memory evidence, not best-run-only data. |
| Each declared isolated control command | Matching positive cap | Meaningful assertion fails, then final candidate rebuilt and restored. |
| `npm test` | 1,800 s | Both compiled unit and subsequent mjs stages complete; an unrun later stage is not passed. |
| `npm run test:core` | 1,800 s | Full result, no suppressed failures. |
| `npm run test:visual`; `npm run test:hud-mcp` (each) | 600 s each | Complete green aggregate on the candidate. |
| `npm run format:check` | 300 s | Exact candidate format check green. |
| `npm run check:fixtures` | 180 s | Synthetic fixture hygiene green. |
| `git diff --check` on committed base→candidate and pending delta | 60 s | No whitespace defect; source identity matches reviewed tree. |

Use Node 22 ≥22.13 or Node 24 under the governing runtime protocol; preserve any separately required dual-runtime qualification. Keep README's permitted one named-flake isolated rerun, with both outputs. Do not classify a new consumer identity/count/command failure as a flake or replace the full suite with focused tests. A denied facility remains blocked; do not evade it. Keep all failed/incomplete/unrun stages.

Evidence belongs under `docs/cloud/handoff/b10b-s4/`: implementation report and exact file delta, source/parent/commit/tree manifest, raw command logs and statuses, deterministic rendered-cell fixtures/screenshots where applicable, check summary, performance JSON with complete populations, and cleanup/custody evidence. Public records contain synthetic data only. The final Oracle receives the brief, branch, report, raw evidence and applicable rulings, not implementer conversation.

### Performance and bounds

Keep current gates: 200 rendered nodes (including synthetic rows), B9 metadata bounds, worker payload/8 MiB shared work budgets where applicable, no-change p99 ≤2 ms, compact changed ≤10 ms, rich changed ≤15 ms and broader HUD gates. No new cold-tick exemption or helper-only replacement gate.

Measure the actual `renderMonitor`/Inspector/row-input path with Inspector closed and open, current and historical observations, busy recovery, max bounded reports/candidates/conflicts, root Coverage/Slots, all representative widths and retained-frame churn. Report p50/p95/p99/max, warm-up, n, host and source/runtime/build identity; at least 1,000 samples after 200 warm-ups and three complete runs under the governing protocol. If a new performance harness cannot exercise the production path within the existing fixture/boundary, return that design issue rather than tuning the gate.

Do not add mutable scratch data that escapes into old views or an unbounded cache keyed by historical identities. Clock-only repaint must not repeat a large metadata scan, command construction or source read. Keep hidden Inspector work out of the hot path where the pane is absent. Actual Herdr/tmux, Windows clipboard, logged-in CLIs and formal WSL/B14 qualification remain owner-only; no fake/cloud result substitutes.

## 10. Release checklist and stop conditions

Implementation remains blocked until all of the following are recorded:

1. Actual accepted B10B-S3F merge into `universal-hud`, with the required complete green merged-tree evidence. NEXT submission, a composite source review, local strict subsets, elapsed time or an archived ruling are not substitutes.
2. Completion of the ordered preceding queue work, including DOC2 and TPD1. Refresh their actual accepted source and scope; preserve TPD1's named deferred production effects.
3. Acceptance/integration of the B9-ICR producer before enabling conflict consumption, plus a final typed source-to-field check for the remaining data additions. Missing fields in §3 must be either supplied by accepted producers or explicitly listed in a fresh Oracle-approved, dispatcher-recorded bounded consumer-stage scope; they may not disappear from the end-state backlog.
4. A final exact accepted-base pin and complete whitelist reconciliation with S3/TPD1/B9/B16/B10D ownership, including explicit producer→consumer sequencing for eligible wave 3. This draft is not permission for overlapping writers or an unaccepted combined WIP tree.
5. A separately admitted bounded executor window with source/runtime/evidence and lifecycle cleanup pins. Shared-executor uncertainty or another active package's window is not cleared by read-only design work.

Then follow the dots hierarchy: one Astra high implementer on the dispatcher-approved package branch; a fresh Astra max Oracle for a design fork, final review or permitted re-check; dispatcher records raw checks and performs only the rule-based merge. At most the existing two fix rounds; unresolved cross-contract/profile/gate issues follow the owner-question route. No new agent was started for this consultation.

Stop and report the exact blocker on an absent accepted base/producer, identity ambiguity, unavailable field needed for a claimed deliverable, required source read or writer, out-of-whitelist edit, ownership collision, inability to retain bounds, denied/uncertain execution or proposed contract/gate/profile change. Preserve independent permitted work; do not invent a pass or expand this package.

Final acceptance still needs the fresh Oracle's verified accept verdict. Integration still needs the authorized history-preserving `--no-ff` merge and full green checks on that actual merged tree before push and factual STATE/plan promotion. Never touch `main`, force-push, rewrite history, stage node_modules or simulate local-only work.

## Sources

[AGENTS]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/AGENTS.md
[DOTS]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/docs/cloud/dots.md
[STATE]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/docs/handoff/STATE.md
[QUEUE]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/docs/cloud/rulings/queue-progress-20261103.md
[README]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/docs/cloud/README.md
[ARCH]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/docs/ARCHITECTURE.md#L766-L810
[PLAN]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/docs/universal-hud-engineering-plan.md#L58-L71
[DESIGN]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/docs/design/hud-information-design.md
[D411]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/docs/design/hud-information-design.md#L615-L665
[C03]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/docs/contracts/03-lifecycle.md
[C06]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/docs/contracts/06-observation.md
[ICR]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/docs/cloud/rulings/inspector-conflict-prerequisite-20261104.md
[TPD1]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/docs/cloud/rulings/tpd1-effect-boundaries-20261104.md
[LEGACY]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/src/render/monitor-inspector.ts#L44-L113
[TYPES]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/src/core/link/types.ts
[VM]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/src/core/link/view-model.ts
[TREE]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/src/core/link/index.ts
[TICK]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/src/core/link/tick.ts
[HOST]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/src/core/link/host.ts
[FACTS]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/src/render/delegation/facts.ts
[OBS]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/src/core/types/observation.ts
[RUN]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/src/core/types/execution.ts
[LIFE]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/src/core/types/lifecycle.ts
[IDENTITY]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/src/core/types/identity.ts#L39-L44
[CAP]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/src/core/capacity.ts#L44-L74
[LIMITS]: https://github.com/CartmanFatass/codex-hud/blob/2e2d94821c017a3d832cb275253931c7f1251f3f/src/core/link/limits.ts
[PROJ]: https://github.com/CartmanFatass/codex-hud/blob/60b5959d02516e73d30cd5a55913eb6988a94ea9/src/render/delegation/projection.ts
[SEL]: https://github.com/CartmanFatass/codex-hud/blob/60b5959d02516e73d30cd5a55913eb6988a94ea9/src/render/delegation/selection.ts
[ACTIONS]: https://github.com/CartmanFatass/codex-hud/blob/60b5959d02516e73d30cd5a55913eb6988a94ea9/src/render/delegation/actions.ts
[MONITOR]: https://github.com/CartmanFatass/codex-hud/blob/60b5959d02516e73d30cd5a55913eb6988a94ea9/src/render/monitor.ts#L636-L653
[INPUT]: https://github.com/CartmanFatass/codex-hud/blob/60b5959d02516e73d30cd5a55913eb6988a94ea9/src/render/monitor-input.ts#L95-L117
[S3]: https://github.com/CartmanFatass/codex-hud/blob/60b5959d02516e73d30cd5a55913eb6988a94ea9/docs/cloud/rulings/b10b-s3.md

The NEXT links above document reference interfaces only. Every implementation claim and final check must be rebound to the actual accepted integration base at release.
