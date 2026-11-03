# DOC2 prerequisite ruling: comparator, cold-render evidence, and amendment map

Date: 2026-11-03.
Disposition: prerequisite consultation complete; DOC2 implementation remains blocked.
Identity: this is a distinct, newly issued Oracle ruling. It is not a reconstruction, recovery, or quotation of the earlier unavailable Oracle result.

## 1. Decision

1. Keep the current, narrowly bounded factsEqual comparator strategy: generate one straight-line comparator from the complete internal nodeFacts schema, with the S3 identifier guard, and compare primitive values. Do not require a static unrolled replacement as a DOC2 prerequisite.
2. Keep the existing synthetic all-200-nodes-changed rendering measurement report-only. Do not add a cold-render numerical gate through this documentation package. This does not exempt actual production work, all-node invalidation, first-use compilation, or any other applicable cost from existing design and contract timing.
3. Record the specified B10B-s2 and B10B-s3 design clarifications only after the accepted B10B-S3F result actually merges into universal-hud. Reading or archiving its rulings now is permitted prerequisite preparation, not release of DOC2.
4. No contract, numerical gate, supported runtime/profile, implementation ownership, queue order, or merge condition is changed by this ruling. No new owner decision is necessary for the preserve-existing-gates disposition here. A later proposal to introduce a cold-render gate must be separated and routed as a gate change, rather than smuggled into these amendments.

## 2. Scope, source identity, and limits

The integration snapshot inspected was universal-hud at 48abc4fc5e4b71ef36af720a69cad344ad71ea34. The segment-3 source and rulings were inspected on dots/b10b-s3f at bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60.

Inputs included AGENTS.md; docs/cloud/dots.md and README.md; DOC2; the queue-progress ruling; STATE; run-2; the relevant B10B-s2/S3 rulings and briefs; design sections 2–6; ARCHITECTURE §8; concept §15; contract 06's applicable timing provisions; the comparator, projection, panel, line, card, selection, action and control-bar source; and their existing regression/benchmark definitions.

This was a GitHub read-only consultation. No application code or repository document was changed; no git mutation, implementation, build, test, benchmark, local-only probe, or subordinate review was started. The only output write is this requested standalone ruling artifact. References to tests below describe inspected assertions, not newly executed passes. Existing reported failures remain failures.

All design-document line numbers below refer to the pinned integration snapshot. Source references explicitly name the integration or S3 pin. Revalidate line positions and the implementation basis when DOC2's eventual accepted base exists.

## 3. factsEqual / new Function

### Decision and reason

Retain the current generated comparator within its present internal boundary.

The real production path is projection.ts:385–418. It calls nodeFacts on the selected node/detail/relation and compares the resulting complete facts object with the cached facts. nodeFacts constructs a fixed object whose property names are written in facts.ts; it does not spread arbitrary view-model keys into that schema. Its values are primitives. factsEqual generates the comparator once, lazily, using the first such object's keys.

The distinction matters: the implementation does not derive executable text from an agent's report, label, file name, field value, or an arbitrary JSON schema. Only the module-owned property names are inserted into a fixed expression of the form a.name === b.name. Values are passed as arguments. The S3 FACT_NAME guard permits ASCII identifier names beginning with a letter, underscore or dollar, with digits allowed afterward; it rejects punctuation, paths, quotes, whitespace and leading digits before construction. The older integration version's letters-only guard is the issue widened in S3, not an unresolved instruction to rewrite the comparator.

Keeping this strategy preserves the single constructor's field list and the already-reviewed straight-line property comparisons. A static unrolled comparator could be a valid separately tested implementation, but it would introduce a second manually maintained field list or a different generation arrangement. Neither is needed for this docs-only task. This consultation supplies no new performance comparison proving one alternative faster.

### Boundaries that the design note must preserve

- The compared schema is closed, complete and internal. The single cached comparator assumes every production operand has that same schema.
- Every fact that can change the node projection participates in comparison. Do not replace this with stamp-only equality or remove fields to improve the benchmark.
- The identifier guard precedes code generation. No external text or fact value becomes generated source.
- Comparator creation remains once per module instance, not once per node or frame. There is no new fallback, interpreter, public schema API or supported no-code-generation runtime in this decision.
- Subsequent field additions must keep the existing field-coverage and warm-versus-cold equivalence tests meaningful. A future dynamic schema or external-key input would invalidate this rationale and need its own review.
- The comparator's first-use cost is real work. A warm benchmark does not prove that cost absent or formally qualified.

Evidence: integration facts.ts:141–247; S3 facts.ts:230–249; S3 projection.ts:385–418; integration b10b-cache.test.ts:402–478; S3 b10b-s3-facts.test.ts:1–44. The latter tests valid digit/underscore/dollar names, rejects invalid names, and checks the real facts comparator. The cache tests check the fact table's coverage, change every fact independently, and require warm projection results to equal a cold projection after a meaningful input change.

### DOC2 recording

Add a short, dated implementation clarification adjacent to design §6 item 2. Keep the existing three-layer cache design. Explain that the node projection compares the complete primitive facts assembled by nodeFacts, and that the current one-time generated comparator uses only internal, identifier-checked property names. Do not falsely describe the function as generated from TypeScript types at build time, and do not turn this implementation choice into an immutable public API requirement.

Suggested substance in the document's language:

（DOC2 裁决 2026-11-03）节点投影的复用还逐字段比较 nodeFacts 构造的完整原始值事实，不只比较几个 stamp。当前 factsEqual 仅从本模块固定、经标识符校验的字段名一次生成直线比较函数；外部文本和字段值只作数据，不进入生成代码。新增事实须同步通过逐字段失效与 warm / cold 等价测试。

This records the implementation boundary, not a source-code change or a waiver of performance acceptance.

## 4. Cold-render measurement and existing gates

### Decision

Do not create an additional cold-render numerical acceptance gate in DOC2. Preserve the existing report-only diagnostic population, record precisely what it measures, and leave all current gates intact.

### What “cold” means in the inspected benchmark

It is not a new Node process, application startup, storage cold catch-up, or a measurement of the first comparator compilation.

- Segment 2 alternates fresh clones of two 200-node fixtures whose node facts all differ. Projection, planning and rendered row/card work are recomputed. It prints both every-row and 60-visible-row versions.
- Segment 3 likewise alternates all-node-different clones and prints the 60-visible-row measurement through the whole panel/renderMonitor path.
- Both use 200 warm-up iterations and then 1,000 measured iterations. Fixture cloning is in the prepare callback before the timed interval.
- The benchmark labels these populations “not asserted.” They are distinct from the gated fresh-view-model population in which one of 200 nodes differs, and from the no-change population.

Therefore a warm all-node-cache-miss render diagnostic must not be called a cold-start qualification. Nor may its visible-only or whole-render number replace a different gated boundary. The 14–18 ms statement in run-2 is historical cloud-host reporting, not a newly verified result or a universal threshold.

### What stays binding

The package gates remain the specified strict B10B_PERF=1 populations: no-change p99 ≤ 2 ms; production-shaped changed tick p99 ≤ 10 ms compact and ≤ 15 ms rich, with S3 selection reconciliation and a key press inside the prescribed rendered-row/frame-diff measurement. Preserve sample count, nearest-rank calculation, warm-up, workload, every-row versus visible-row distinction, supported-runtime evidence, ranges over at least three runs and all failed runs.

Design §6's rendering shares, including rendering-total p99 ≤ 15 ms and max ≤ 40 ms, are not deleted or redefined by the absence of an assertion in one diagnostic test. Contract 06's B10C timing boundaries likewise remain: paint p99 < 50 ms / max < 200 ms; selected observation operation p99 < 100 ms / max < 1,000 ms; local commit-to-paint p99 < 50 ms / max < 200 ms, with the stipulated populations, sample counts, rolling windows and retained failures. The contract also retains the separate follower boundary.

If all nodes really invalidate on an ordinary production tick, the work remains inside the applicable production timing. Calling that tick “cold” cannot remove it. Actual startup/cold-catch-up must be preclassified and separately reported; work performed inside an incremental operation cannot be retrospectively relabeled to hide it. No first-use, GC, scheduler, cloning/IPC or other relevant production cost is waived by this consultation.

The existing S3F performance/full-check blockers are not closed by preserving the diagnostic's status. Node 22 passes do not remove Node 24 failures. Remote measurements do not constitute final WSL qualification.

### DOC2 recording

Add a narrowly scoped dated note beside §6's benchmark/phase-reporting rule, preferably item 14, without changing any threshold, table trigger, or existing normative sentence.

Suggested substance:

（DOC2 裁决 2026-11-03）B10b 基准另报预热后“200 节点事实全部变化”的渲染诊断；这是缓存全失效人群，不是进程冷启动。s2 的全行 / 视口及 s3 的完整 renderMonitor 视口测量分别标明，当前只报告、不新增数值断言。此处不豁免真实增量 tick 的成本，不改变本节份额或契约 06 门禁；不得把普通慢 tick 改称 cold，或用这些数值替代既有受门禁人群。

A future cold-specific gate would require a distinct disposition defining the workload, timing boundary, first-use versus warmed-cache-miss semantics, sample count, platform/runtime matrix and threshold. DOC2 neither proposes nor implements that change.

## 5. Required design-document amendment map

Each record below is limited to the substance already requested by DOC2 or the two prerequisite decisions above. Mark changes with the original ruling and date, for example （B10b-s2 裁决 2026-11-03）, （B10b-s3 裁决 2026-11-03）, or （DOC2 裁决 2026-11-03） for this consultation. Preserve the document's Chinese prose, semantic distinctions and synthetic examples.

### A. Omit content absent from the delegation view model

Authority: B10B-s2 Q2, lines 30–44.

Targets: §3.4's micro-card explanation at line 205; §3.5's card anatomy/example at 213–225; the affected delegation-panel examples and their immediate explanations in §4.3, §4.5, §4.7, §4.8 and §4.13.

Record that the present delegation view reads only its VM. Do not borrow the root's brief/action/rate from legacy MonitorData. Omit absent brief, action, output-rate and native-digest lines rather than printing empty placeholders or inventing text. A pending enum gives the pending word, not an invented natural-language request. Reconciliation shows the known cause and distinct known missing items, not a fabricated “no receipt”; slot held belongs on the delegation line. Root/native micro-cards can have no lines when they have no focus fact.

Keep the prescribed stop-in-pane sentence, actual report summaries, provenance-backed exit facts and terminal timing notes. Do not erase future data requirements in §1/§7 or claim B9/B16 have supplied these fields. Stage-C Jev and future Inspector designs must remain labeled as such rather than being rewritten as newly implemented features. The foot status card is separate and unchanged.

Source map: S3 lines.ts:266–336; cards.ts:275–438; panel.ts:274–295. Existing checks: b10b-s2-lines.test.ts:211 onward and b10b-s2-cards.test.ts:264 onward. The missing-data examples and samples must be checked against Q2, not populated from today's legacy tree.

### B. One delegation-line grammar and shedding order

Authority: B10B-s2 Q3, lines 46–69.

Targets: §3.4 line 205 and §3.5 line 215, with the contradictory sample strings and adjacent explanations in §4.5, §4.7 and §4.8. In particular, §4.5 lines 392/400 must not retain a special 80-column “run 1” rule.

Grammar:

role · host · time [· run N] [· heartbeat age] [· $cost] [· in dir] [· slot held] [· close pane]

Only known elements appear. Use one time: reported age, handshake/handshake claimed, or bound age as ruled. Host is verified pane text or headless while applicable; omit the host once the run is terminal. run N appears only for N > 1, at every width; heartbeat appears from 80 columns for the specified live states and only when known. Directory identity follows the ruled normalized-worktree/cwd comparison; uncertainty is not equality.

Shed in this order: directory, cost, heartbeat, the time word, the complete time, run number, host, then shorten role. slot held and close pane are protected. Samples must not independently reorder cost and time or invent ages. For example, the ruled unshed headless line is “reviewer · ⊟ headless · bound 2m · $0.12”, subject to actual available width.

Source map: S3 lines.ts:91–211, especially LINE_STEPS and delegationElements. Existing checks: b10b-s2-lines.test.ts:38–210, including widths 32/40/48/56/80.

### C. Summary counting, coverage and drop order

Authority: B10B-s2 Q4, lines 71–91.

Targets: §4.2 line 301; §4.4 line 318; directly affected summary/sample explanations, including §4.5 line 353 and §4.7 line 440.

Display order is counts, slots when full, one coverage chip, listed workers/jobs, put-away count, spend. Counts and applicable chips stay. Drop put-away text first, then workers/jobs, then spend. There is no rate to shed in the present delegation view.

Counts include every node except the viewpoint root, including natives and put-away history, with the existing marker/count notation. The §4.4 example becomes “2▸ 1✗ 1✓”; do not retain the legacy subtasks/failed/rate summary. Worker/job figures describe listed delegated sessions/intents/deduplicated conflict children and jobs, not natives or the root, and exclude put-away subtrees while hidden.

N not loaded sums knownUnloaded, omitted and omittedConflictRows. tree partial applies only when that sum is zero and coverage is incomplete/unknown; those two chips are exclusive, not two simultaneous candidates to display. Preserve ledger-unavailable/busy precedence, slots ordering and the existing unavailable-warning delay.

Source map: S3 panel.ts:109–204; projection.ts:509 onward. Existing checks: b10b-s2-summary.test.ts:49–221. Do not change count semantics merely to make a sample string fit.

### D. Root and native cards

Authority: B10B-s2 Q10, lines 149–163.

Targets: §3.5 lines 223–225; §4.4 line 318; the corresponding assertion at §3.3 line 174 that still promises a “2 working · 1 done” card count line. Keep §4.3 consistent with an always-present root card when the VM has a root.

Rich always draws that viewpoint-root card, including a root-only or native-only VM. Its body is omitted when Q2 supplies nothing; header and foot remain. A native directly under the viewpoint root gets its own card; deeper natives are sub-rows of the nearest card. Show at most five sub-rows, then one ruled +N count line, with children-unknown handling. Do not retain a separate “2 working · 1 done” or role-count line.

Preserve the existing accordion ordering and protected selected/trouble cards. Do not promise byte identity with the old delegation-present native view: legacy byte identity applies when the delegation VM is null/undefined.

Source map: S3 cards.ts:5–11, 60–69, 181–206 and 543 onward. Existing checks: b10b-s2-cards.test.ts:48–144 and 176–230. This is a layout clarification, not a new data-layer feature.

### E. Headless Log includes ended runs

Authority: B10B-s3 Q1, lines 31–51.

Target: §3.7's action table at lines 243–246, read consistently with §4.9 lines 553–565.

Change “活跃 headless” to managed headless runs, active or ended, with or without a report. ⇢ Log and L remain log actions. o does nothing on a Log row. Do not add Log to visible runs, the root, natives, plain sessions, synthetic conflict rows or put-away rows.

The table's disabled-Open and “supervisor lost has only one action” wording must be mode-qualified so it does not contradict this ruling: a headless uncertain row may retain Log alongside an available Reconcile; a visible uncertain row has disabled Open. This permits reading a log, not focusing an unsafe visible host or executing recovery.

Source map: S3 actions.ts:58–109. Existing checks: b10b-s3-actions.test.ts:50–119, 166–207 and 218 onward. Log-file existence and actual dispatch remain the dispatcher's responsibility, not proof supplied by a drawn button.

### F. Trouble navigation means the first sorting bucket

Authority: B10B-s3 Q7, lines 193–213, and the post-review “omitted conflicts as stops: not ratified” decision at 300–316.

Targets: §2's navigation descriptions at lines 125 and 131.

Define n/N stops by marker rank 0, not the broader row-anatomy trouble flag: flag/stop-in-pane, a live failure, conflict, and uncertain/supervisor-lost/stale/unknown question states. Exclude the viewpoint root's own marker, not-loaded, starting, ended failure and ordinary completed/ended states.

Walk the actual screen destinations, wrapping in each direction; no stops means no action. A real hidden stop is represented by its nearest destination ancestor without unfolding, reordering or filtering. The root can represent an actual hidden descendant if it is that ancestor; excluding its own marker is not the same as forbidding all such representation. Omitted conflict claims outside the projection have no stop and must not manufacture one at a parent or the root. Leave the distinct compact-row anatomy meaning of trouble in §3.4 intact.

Source map: S3 selection.ts:123–158. Existing checks: b10b-s3-keys.test.ts:146–297.

### G. Reconcile belongs to ↻, not ⇢

Authority: B10B-s3 “Also noted”, lines 246–255, read with Q1 and Q3.

Targets: §3.3 row 2a at line 158; §4.8's supervisor-lost paragraph at line 481; the Inspector/control-bar caption at line 494. Apply the same mode qualification in §3.7 noted in E.

Replace obsolete “⇢ 只有 Reconcile” / “⇢ 的词是 Reconcile” text with ↻ Reconcile. ⇢ is disabled Open for the visible uncertain row or Log for the managed headless row. Preserve all safety restrictions: no unsafe focus, input, automatic fg or resume. Reconcile consumes a trusted descriptor/copy-only action; repainting never performs it.

Do not use this correction to claim synthetic conflict descriptors or pending Inspector/TPD1 dispatch are implemented. Their data/dispatcher work remains separately queued.

Source map: S3 actions.ts:58–109; monitor-input.ts:108 onward and 330 onward. Existing checks: b10b-s3-actions.test.ts:218–244, 299–306, 344–384 and 386 onward.

### H. The §4.13 control-bar example keeps its action word

Authority: B10B-s3 defaults item 3 and the later “Default 3, button words” refinement at lines 300–306. Use the later refinement, not only the earlier named-level shorthand.

Target: §4.13 line 692 and its immediate explanation at line 715.

The selected visible run's 48-column control is ⇢ Open, not a bare ⇢ with avoidable blank space. Reflow the synthetic example within its stated width using the established control-bar shedding rules. Words remain at all levels except the constrained none fallback; at that fallback prioritize row words over the older-button word, and if needed lose the recovery word before the Open/Log/Switch word. This does not require words to fit at every arbitrarily narrow width or authorize a key when the control is not drawn.

Source map: S3 control-bar.ts:353–370, 455–505; actions.ts:82–83. Existing checks: b10b-s3-bar.test.ts:121–215 and b10b-s3-actions.test.ts:386 onward.

### I. Comparator clarification

Target: §6 item 2 at line 852. Record §3 of this ruling only. No source edit, static-comparator replacement, gate change or additional public API.

### J. Diagnostic population clarification

Target: §6 item 14 at line 876, with the note referring back to item 6. Record §4 of this ruling only. Do not modify the numerical budget table, remove any rendering-share requirement, broaden the no-change definition, or declare the all-node diagnostic formally qualified.

## 6. Actual prerequisite and acceptance consequences

DOC2.md:7 explicitly requires work after B10B-S3F merges, so the S3 rulings are on the base. The queue-progress ruling confirms that submission, a pushed branch, an improved benchmark or a read-only design consultation is not that merge.

This prerequisite is not satisfied at the inspected integration pin:

- STATE:101–117 still records S3F as not accepted/unmerged, with R2/full-check gates open and its follow-on in progress rather than accepted.
- GitHub's comparison of S3F bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60 to integration 48abc4fc5e4b71ef36af720a69cad344ad71ea34 reports “diverged”: integration ahead by 76 and behind by 23; merge base f1e2a8408fbc6ddef181978e8a2d9fd5831242e9. The inspected S3F head is not an ancestor of that integration head.
- The S3 ruling and S3 implementation are available on the S3F branch for consultation; the S3 ruling is not present in the inspected integration tree.

Accordingly, do not create a DOC2 implementation from the unaccepted S3F/PERF/NEXT branch, cherry-pick its interfaces/rulings as a substitute prerequisite, or label this consultation package acceptance. Preserve the current wave order and the applicable finish-wave-1-first disposition. Later follow-on reviews may resolve S3F, but this ruling does not prejudge them.

Before DOC2 implementation begins, the dispatcher must establish the real accepted S3F integration result under the existing rules: applicable Oracle accept/report verification; --no-ff integration; complete green merged-tree checks with only the permitted known-flake handling and both logs retained; push and factual STATE/plan updates. Then pin DOC2's actual universal-hud base and reconcile this amendment map against that accepted source. Merely copying this report into the repository does not accomplish those steps.

DOC2 owns only docs/design/hud-information-design.md for the content amendments. Archive this ruling separately through the dispatcher's recording role. Serialize shared design/status edits. No benchmark, source, fixture, contract, reference-document, data-layer or dispatcher implementation is authorized by this prerequisite consultation.

For eventual DOC2 review:

1. Every changed passage maps to A–J and its dated ruling; no unrelated prose cleanup or global reformatting.
2. Samples remain synthetic, width-consistent and faithful to the eventual accepted behavior. No missing data is fabricated and future features are not declared shipped.
3. Keep DOC2's explicit format:check and check:fixtures requirements, plus the applicable repository-wide workflow/check/merge obligations. This consultation runs none and waives none.
4. A fresh DOC2 review Oracle checks each edit against the source ruling and accepted base. Design-document completion is not a substitute for S3F acceptance, TPD1 dispatch, Inspector/data work or B14 qualification.

## 7. Immutable source index

Integration sources below are at 48abc4fc5e4b71ef36af720a69cad344ad71ea34; S3 sources are at bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60.

- [AGENTS.md](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/AGENTS.md)
- [dots workflow](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/cloud/dots.md)
- [DOC2 brief](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/cloud/DOC2.md)
- [Queue prerequisite ruling](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/cloud/rulings/queue-progress-20261103.md)
- [STATE](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/handoff/STATE.md#L101-L135)
- [Run-2 questions](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/cloud/handoff/run-2.md)
- [B10B-s2 rulings](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/cloud/rulings/b10b-s2.md)
- [B10B-s3 rulings](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/docs/cloud/rulings/b10b-s3.md)
- [Pinned design document](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/design/hud-information-design.md)
- [Contract 06 timing](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/contracts/06-observation.md#L258-L290)
- [Concept decision log](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/docs/universal-hud-concept.md#L590-L649)
- [Integration facts comparator](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/src/render/delegation/facts.ts)
- [S3 facts comparator](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/src/render/delegation/facts.ts#L230-L249)
- [Facts field-coverage tests](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/tests/unit/b10b-cache.test.ts#L402-L478)
- [S3 identifier-guard tests](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/tests/unit/b10b-s3-facts.test.ts)
- [S3 projection source](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/src/render/delegation/projection.ts)
- [S3 lines source](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/src/render/delegation/lines.ts)
- [S3 cards source](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/src/render/delegation/cards.ts)
- [S3 panel/summary source](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/src/render/delegation/panel.ts)
- [S3 selection source](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/src/render/delegation/selection.ts)
- [S3 action source](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/src/render/delegation/actions.ts)
- [S3 control-bar source](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/src/render/control-bar.ts)
- [Segment-2 benchmark](https://github.com/CartmanFatass/codex-hud/blob/48abc4fc5e4b71ef36af720a69cad344ad71ea34/tests/unit/b10b-s2-perf.test.ts)
- [Segment-3 benchmark](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/tests/unit/b10b-s3-perf.test.ts)
- [Segment-3 acceptance](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/docs/cloud/B10B-s3.md#L93-L114)
- [S3F final re-check](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/docs/cloud/handoff/b10b-s3f-recheck-2.md)
- [S3F later performance disposition](https://github.com/CartmanFatass/codex-hud/blob/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60/docs/cloud/rulings/b10b-s3f-performance.md)
- [Pinned ancestry comparison](https://github.com/CartmanFatass/codex-hud/compare/bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60...48abc4fc5e4b71ef36af720a69cad344ad71ea34)

Final disposition: archive this new ruling unchanged. The read-only prerequisite questions are resolved on the inspected evidence; DOC2 implementation is not released, and B10B-S3F remains a real accepted-merge prerequisite.

