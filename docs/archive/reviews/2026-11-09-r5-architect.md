# R5 — unified tree and retained summaries

**Recommendation:** Add a bounded, read-only job collector and a pure `SubagentTree` composition step before summaries/rendering; retain legacy displays until R6 and suppress duplicates only on explicit shared identity.

Reviewed source: `9488e16`. Design only: no implementation, performance, real-herdr/browser/harness, or production validation is claimed.

## 1. Reasons and resolved forks

- Association v1 already supplies invocation identity, explicit root and frozen role/phase/backend (`src/roles/association.ts:45–71`). Its root namespace is the source ID, not a harness name (`src/roles/selection.ts:82–101`).
- `SubagentTreeNode` carries existing cards/stages/labels/digests (`src/types.ts:451–525`). The panel applies summaries immediately after building that tree (`src/tree-page.ts:1127–1145`). This is the integration point.
- `NativeCallCollector.merge` produces the old `LinkTreeProjection`, including synthetic, display-only native source namespaces (`src/collectors/native-calls.ts:208–308`). Extending it would not feed the existing summary pipeline and would prolong the retired execution vocabulary.
- **Do not poll `hud_read` from a collector.** Its Jev path can start a runtime, resume interrupted/recoverable work and write receipts/associations (`src/roles/jev-adapter.ts:120–154`; `src/roles/facade.ts:1767–1808`).
- Dispatch parsing is reusable, but its whole observer scans QA/helpers and can read a 4 MiB report (`src/roles/pi-dispatch-status.ts:99–143,146–228`). It is not suitable as an unrestricted per-job tick operation.
- Jev records distinguish state, closure, result and phase (`src/jev/runtime/executor.ts:205–226`). `completed` can be recoverable, not answered (`src/jev/runtime/types.ts:60–77`). Closure must not imply success.
- Generic materials require real SessionRefs and positive grants (`src/core/materials/index.ts:18–29,105–187`). Universal nodes cannot inherit historical Codex permission (`src/core/materials/request.ts:59–124`).
- Production cache location is already `<dir>/cache.json` (`src/collectors/model-runtime-store.ts:89–96,200–211,300–318`). Preserve it and the production classes, not merely tests using the B17 double.

### Binding orchestrator answers

Recorded in `tmp/tasks/R5/qa/q1.answer.md` and `q2.answer.md`:

1. Optional observation-only association metadata is allowed; old schema-1 records remain valid. Only the facade writes native bindings, from evidence it already obtains. No binding means no dedupe claim. External tasks require explicit CLI-written observation records, not automatic discovery. The six-tool MCP surface is unchanged. New facade nodes use `SubagentTree`; legacy displays stay until R6.
2. No job-scoped material authority in R5. New nodes get summaries only through explicit native refs and existing grants. Unbound nodes retain observed labels/state/questions/results; enabled summary slots say unavailable using existing wording. Production Codex restoration and generic materials remain intact. Job-material authority is a follow-up.

These resolve the older native-v2 deletion proposal for R5. Do not build a host, subscription protocol, workflow, permission format or new change-stamp writer.

## 2. Projection and merge

### Modules

Create:

- `src/collectors/job-display-types.ts`: reduced, immutable observation DTOs; executor imports are type-only.
- `src/collectors/job-observations.ts`: bounded discovery/read scheduling, validation, signatures, last-known snapshots and coverage; no writes.
- `src/collectors/job-live-observation.ts`: panel-only narrow read ports for explicitly recorded herdr agents and an already-running Jev socket; no arbitrary mutation methods or launch fallback.
- `src/collectors/job-tree.ts`: pure composition of native tree, scoped job snapshots, residual legacy view and `nowMs`; returns composed tree, residual legacy view, selection aliases and coverage.

Panel order: bind root → collect native/legacy evidence and refresh job snapshots → compose → apply summary displays → logs/timeline → schedule permitted model work → render. Apply the same composition after legacy publication: `src/tree-page.ts:1180–1185` currently re-merges only native calls and could otherwise resurrect duplicates.

Keep collector snapshots immutable. Preserve unchanged record objects where practical: labels schedule using `recordStamp` (`src/collectors/model-jobs.ts:1117–1124`). Root/source changes advance a generation and fence late observation/model results.

### Identities and attachment

- Facade display ID: `role-job:<job>`, stable across binding, closure, continuation and preset changes. Cache scope also includes canonical HUD home and root.
- Helper ID: `role-job:<job>:dispatch:<validated-slot>`. Session replacement invalidates its evidence/material generation, not its parent job identity.
- External ID: `external-herdr:<root-hash>:<record-id>`; equal slugs under different roots cannot collide.
- Native descendants retain full source-qualified identity. Preserve original Codex display/log/cache IDs; namespace only newly attached foreign subtrees.
- Parent is exclusively the association's exact root. Do not join by bare session ID, cwd, role, label, pane name or timing.
- Validate association/receipt job and root agreement; Jev additionally requires matching executor runtime ID and runtime `session.namespace/sessionId`. Contradictions are diagnostics, never reparenting.
- Valid association plus absent receipt yields a metadata-only unknown node. First-seen invalid association yields a bounded diagnostic, not a fabricated node. Previously valid records becoming unreadable retain stale last-known nodes.

Add optional observation metadata to association v1: complete native `SessionRef`, explicit source locator, optional transcript locator and evidence kind; optional bindings per helper slot; actual created/closed timestamps when known. Preserve these across rewrites. Nothing may read them to authorize launch/send/resume/close.

Pi STATUS `session_id` alone does not identify a source. Combine it only with the actual source known from the existing launch contract; otherwise omit the binding. No new runtime calls or transcript searches solely to fill metadata. Only the facade produces these bindings, per q1.

### Display shape and source ownership

Add an optional `job` field to `SubagentTreeNode`, containing:

- kind/ID/root, role/phase and pinned backend/executor/harness/model/effort;
- separate lifecycle, outcome and freshness;
- pending-request descriptors and report/result metadata;
- explicit native binding, coverage and summary-unavailable reason;
- bounded local Inspector excerpts, where requested.

Do not copy environment variables, request keys, fingerprints, prompts/input blobs, credentials, CDP addresses or arbitrary runtime JSON into this DTO.

| Source | Owns | Does not establish |
| --- | --- | --- |
| Association | Invocation, parent, role, pinned binding | Running, success, consumed answer |
| Receipt | Launch/close facts, executor IDs, continuation baseline | Progress merely because state is open |
| Pi STATUS | Dispatch state, helper relation, settlement/output flags, actual model | Host liveness merely because the file exists |
| Herdr read | Matching recorded agent/pane and native status | Parent, native source, report acceptance |
| Jev job record | Runtime state/phase/result/closure/provider | Current runtime liveness |
| Bound native reader | Public reports/actions/errors/usage and native descendants | Another job's identity or model permission |
| QA/report artifacts | Artifact and answer-file evidence | Work correctness or answer consumption |

`name` uses `task_label`, falling back to role plus short ID. Role/phase use existing slots; backend/model/effort use badge/details slots. For oracle jobs the target model and Jev decision model are separate facts. Native observed model changes may be shown explicitly, not silently overwrite launch binding.

`rolloutPath` is set only for an explicitly bound Codex rollout. Never pass Pi/Claude transcripts or Markdown reports to Codex readers. Stages require real turn/settlement evidence, not refreshes, helper creation, sequence increments or changing mtimes. Missing clocks/meters remain absent.

Oracle-through-Jev enriches one oracle node; no executor child. A direct `jev` role invocation gets its own node. Do not independently scan all Jev runtime jobs and invent associations for non-facade API jobs.

## 3. Native descendants and legacy dedupe

Use existing source-aware native readers/topology under an explicitly bound child. Share Codex's yielding source listing/parent-map cache across roots rather than rescanning per facade job. Claude uses its existing native topology; Pi helpers come from dispatch STATUS. Unknown topology remains partial.

Dedupe rules:

1. Same facade ID across sources → one invocation node, merged by field ownership above.
2. Exact receipt executor runtime-job ID → runtime data enriches that node; no additional Jev row.
3. Exact **complete** native ref shared with native/legacy evidence → facade node replaces the duplicate session row and retains its native descendants/evidence/provenance.
4. Helper/native duplicates require the same explicit full-ref proof. Slot names alone prove nothing.
5. Same native ID without source, matching labels/cwd/model, a reused pane, or legacy synthetic display refs → keep both, with no dedupe claim, per q1.
6. Two facade IDs remain two invocations even if a native session was reused. Ambiguous current descendant ownership is diagnosed, not assigned arbitrarily or duplicated under two parents. Reject cycles.

Keep `NativeCallCollector` and legacy renderers until R6. Composition suppresses only an admitted duplicate row whose replacement is actually present; preserve its children, relations, failures and history. Keep selection aliases and original identities for legacy actions. New job/helper/external selection must never invoke Codex `/subagents` or old Open/Resume using its display ID.

Fix mixed-mode composition: currently native-only rows append, but full delegation views replace ordinary rows. Facade nodes must remain visible with a ledger present and after `afterPaint`. Use one Agents pane, viewpoint root and selection; no second Jobs pane, duplicate root or duplicate summary row. Residual legacy rows keep their current renderer/details/actions, not a new facade LinkTree type.

## 4. Pending requests, results and presentation

### Requests

Represent supported Pi questions with job, exact `qN`, path, observed state/time and respondability. Helpers answer through the owning facade job, never a synthetic helper job.

- Dispatch QA keeps existing nonempty/nonstale answer-file rules; direct-Pi fallback keeps its existing semantics. Factor parsers, do not silently change `hud_respond`.
- Old unanswered files are pointers, not proof the primary currently waits (`src/roles/pi-dispatch-status.ts:208–215`). Highlight current waiting only with matching status evidence; retain historical/unattributed pointers in Inspector.
- An eligible answer is “written, consumption unconfirmed”; the facade returns `consumed:false` (`src/roles/facade.ts:1494–1512`). Unreadable QA is unknown, not zero requests.
- Do not infer a helper from a question number. Only dispatch evidence can associate them.
- Claude/Codex native prompts and Jev browser interventions remain external handoffs, not respondable questions (`src/roles/facade.ts:1456–1469`).
- No response UI, QA writes, wake acknowledgement or parent-cursor consumption. Inspector may show IDs and response syntax as information.

### Results and effective status

- Report existence is not a successful verdict. Show locator/bounded excerpt in Inspector, never raw report text as a model card summary.
- Pi settlement follows existing observer semantics, including continuation suppression. Preserve failure through cleanup; record closure independently from completed outcome.
- CLI `open` is not running. Require current working evidence. Idle without completion evidence is not a successful task; a report alone does not prove checks passed.
- Recoverable Jev results retain their exact status (`uncertain`, `needs_human`, `timed_out`, `wait_failed`, `incomplete`, etc.), not generic green completion. Never resume them from observation. Answered results survive close.
- Keep last-known source state separate from effective `SubagentStatus`: stale working maps to `unknown` for counts/logs, with previous working shown in Inspector. Persisted terminal outcomes remain history with separate source-availability diagnostics.

Reuse existing status/action/model/summary slots, glyphs and theme roles. Raw text belongs in Inspector. External text passes `monitorText`; panel words use `t`; width handling uses `visualLength`/`truncateAnsi`. No new colors/settings/pane/expansion model. If required fields cannot fit those slots, return a presentation question instead of redesigning them.

## 5. Explicit external herdr tasks

One new CLI subcommand, no MCP change:

```text
hud observe-herdr --root <namespace/session-id> --id <slug> \
  --agent <agent> --pane <pane-id> --tab <tab-id> [--workspace <id>] \
  --label <short-label>
hud observe-herdr --root <namespace/session-id> --id <slug> --remove
```

It writes/removes observation metadata only: no launch, adoption of execution, model call or herdr mutation. Root is required and parsed by the existing roster parser; no cwd fallback. Identical registration is idempotent; conflicting target under the same root/ID fails rather than silently changing identity. Removal never closes the task/tab.

Store schema-1 records at `$HUD_HOME/assoc-external/<root-hash>/<id>.json`: root, ID, explicit agent/locator, label, registration timestamp. Maximum 4 KiB; directories 0700/files 0600; atomic rename; safe path components and no symlinked storage. Do not overload facade JOB_ID or invent a role invocation. No native-ref CLI argument: q1 reserves native bindings to the facade.

A task qualifies only with this record. Query only its recorded agent; never list all tasks and infer parents. Compare returned locator fields; mismatch/reuse is unavailable, not a new occupant adopted into the old row. Where the existing API supplies a stable instance discriminator, pin/compare it; otherwise document limited observation evidence and do not dedupe on it. Show external label/backend/status/location, not an assumed role, phase, report or response capability.

## 6. Freshness and resource bounds

### Freshness

Separate observation time, successful-read time, evidence/event time and live-sample deadline. Same-content reads do not reset event/settlement ages (`docs/contracts/06-observation.md:25–29`).

- **Current:** valid identity/evidence; live execution additionally has a successful matching herdr sample or non-starting Jev read. Terminal persisted outcomes need no live executor.
- **Stale:** a previously valid required source fails, becomes malformed/mismatched/unreadable, or its live deadline expires. Keep original last-known fields/timestamps, not active counts/spinners.
- **Unavailable:** no valid sample yet. Show metadata/reason, never running, success or zero usage by default.

Proposed live cadence: 5 seconds; live samples expire after 15 seconds; a failed attempted read makes that source stale immediately. These are observation constants, not execution timeouts. Quiet STATUS mtime is not a heartbeat: long thinking with current host evidence remains distinguishable from host loss. Re-reading an old working file does not prove liveness.

Herdr outage does not erase dispatch outcomes, Jev results, roots or summaries. Runtime absence does not erase a saved answer. Neither becomes job failure/closure. Root change/dispose cancels reads and fences late callbacks.

For Jev corroboration, a tiny non-starting wire adapter may call existing read with `resume:false`, `waitMs:0`; use an observer-private cursor if needed. Never import facade, `jev-adapter`, runtime factory or executor. Missing socket is an observation failure, not startup permission. File-only consumers label uncorroborated live state as last-known.

### Proposed bounds

These are implementation constants to test/measure, not claimed results or replacement performance gates:

- Incremental shallow `opendir` cursors: at most 128 discovery entries per refresh, including separately budgeted root-directory discovery in all-roots mode. Never `readdir(...).slice(...)`. Dispose handles on root change/exit.
- At most 200 retained new projection nodes, including helpers, accounted with the existing universal/legacy composition budget. Do not alter original Codex-only tree behavior to impose this new limit. Partial scanning reports incomplete/unknown omission totals.
- Closed history: at most 50 jobs, no older than 30 days; use known closure time, otherwise closed-record mtime explicitly as observational age. Do not reset age on reads. Prune **display memory only**, never receipts, indexes, send evidence or answers.
- Prefer known live/pending work over closed history; round-robin refresh with reserved discovery work. Do not materialize an unbounded history to sort it. Overflow never proves completion.
- At most 32 changed metadata files and 1 MiB metadata per slice, charged within existing shared panel I/O/deadline accounting. Per-file caps: association 16 KiB, external 4 KiB, receipt/STATUS 64 KiB. Runtime record up to one 1 MiB slice; oversized means unavailable, not partial JSON success.
- Existing helper/QA maxima remain: 64 helpers/256 helper entries, 512 QA entries/100 pointers. They consume the global incremental budget across ticks. Factor single-file parsing/state projection; do not call the full synchronous dispatch observer for every job.
- Selected Inspector question/report body reads: at most 32 KiB, explicit truncation. Availability uses metadata/bounded prefix checks, not full-report reads each tick. Model reads retain existing independent purpose caps and permission checks.
- No repaint I/O. Signature-cache files and yield between asynchronous batches. Live queries single-flight, at most two outstanding and four starts per refresh, bounded to 250 ms and bounded output. Paint/collection uses cached samples rather than waiting serially for backends. Retry at ordinary cadence, not a busy loop.

Current records have no per-root change stamp. Do not claim the older native-v2 “one stat” target. Measure actual quiet/changed/discovery costs and preserve applicable gates.

## 7. Roots, summaries, dry-run and production restoration

### Roots and footer

Collector root selection is independent of Codex `SessionFinder`. Preserve embedded Codex binding/root/cache IDs. Add standalone `hud panel --root <namespace/session-id>` as an observation selector, never control identity; retain current no-argument/all-delegations behavior. All-roots mode attaches each job under its recorded root, never ambient Codex. Missing native root data gives a metadata-only root, not a fabricated Codex footer/recap.

Keep existing Claude/Pi observations and Pi footer behavior. Footer is already capture-only with identity/freshness checks (`src/harness/pi/footer.ts:138–189,192–252,305–388`); no need to replace its provider or import panel observers into it. R5 adds no facade/runtime/herdr imports to `src/index.ts`; test the entrypoint graph and preserve main bar behavior.

### Summaries

Create `src/collectors/job-materials.ts` as a narrow bridge from explicitly bound native readers' public fields to existing `MaterialPlan`/authority. Display job ID and material SessionRef remain distinct.

- Original native nodes retain the production legacy-compatible path unchanged.
- Bound facade material is delegated-origin; identity is not permission. Existing grants must cover exact ref/field/purpose/recipient. Current source configuration has a narrow delegated-result digest grant (`src/core/materials/source-config.ts:25–34,55–62`), not blanket label/cause/brief permission. Unsupported purposes remain unavailable; no config-schema expansion.
- Unbound jobs/helpers never enter legacy fallback. Association labels and results stay local; enabled summary slots say unavailable. Do not forge refs, relabel task text as parent charge, or authorize a report merely from its path.
- When existing source-aware authority is available, use approved envelope fragments, normal SmallModel scheduling and `DerivedMaterialStore`. Never persist generic results into provenance-free AgentLog/labels/recaps. Attach model output to the job display only after binding/turn/language generation revalidation.
- Causes require actual native public error evidence. Herdr unavailability is not an agent error; Markdown/STATUS is not rollout material.
- Filter ineligible job material before brief/progress formatting. A denied job must neither leak nor cause all eligible Codex material to be refused through a mixed legacy request. Mixed eligible output retains full provenance, never old recap/log storage.
- Dry-run shares panel composition and material eligibility, marks omitted coverage, calls no model/executor mutation and writes no state. Legacy Codex material/budgets stay unchanged. Unbound labels/questions/results must not appear in “what would be sent.”

Preserve SmallModel, legacy bridge, ModelRuntimeStore, cache locations, budgets and coordination. Production-path restoration tests must use real classes with synthetic local transport, not only B17 doubles: save/reconstruct labels, notes, digests and response-cache hits; cover off, language/root changes, and denial leaving the original cache untouched.

## 8. Serial milestones and exact file ownership

Tests accompany each milestone. New names are proposals; no deletion is authorized. The implementer returns a fork if additional ownership is needed.

### M1 — records and external registration

- Change `src/roles/association.ts`, `src/roles/facade.ts` (optional evidence-derived metadata only), `src/cli/hud-main.ts` (routing).
- Create `src/roles/external-association.ts`, `src/cli/observe-herdr.ts`, `src/collectors/job-display-types.ts`.
- New tests: `tests/unit/r5-association.test.ts`, `tests/unit/r5-external-association.test.ts`.
- Extend `tests/unit/role-facade.test.ts`, `tests/unit/pi-dispatch-facade.test.ts` for additive metadata only.

Exit: old records work; registration is private/idempotent; no execution/MCP changes or inferred native bindings.

### M2 — observation and composition

- Create `src/collectors/job-observations.ts`, `src/collectors/job-live-observation.ts`, `src/collectors/job-tree.ts`.
- Change `src/types.ts`, `src/roles/pi-dispatch-status.ts` (factor parsing without changing waits), `src/collectors/native-calls.ts` (last-known retention/composition only).
- Change `src/collectors/subagent-tree.ts` only for shared multi-root listing reuse; if cached scan content changes, change `src/collectors/tree-scan-store.ts` and bump version.
- New tests: `tests/unit/r5-job-observation.test.ts`, `tests/unit/r5-job-tree.test.ts`, `tests/unit/r5-job-bounds.test.ts`.
- Extend `tests/unit/pi-dispatch-status.test.ts`, `tests/unit/native-call-display.test.ts`, `tests/unit/jev-native-display.test.ts`.

Exit: mixed fixture has one node per invocation, helpers/native descendants, truthful stale state and bounded work, no backend startup.

### M3 — panel and existing presentation

- Change `src/tree-page.ts`, `src/cli/panel.ts`, `src/cli/hud-main.ts` (serial continuation).
- Change `src/render/monitor.ts`, `src/render/monitor-panes.ts`, `src/render/monitor-inspector.ts`, `src/render/monitor-labels.ts`, `src/render/cards.ts`, `src/render/panel-state.ts`, `src/render/i18n.ts`.
- Create pure `src/render/job-details.ts`.
- Limited mixed-selection/root suppression changes permitted in `src/render/delegation/panel.ts`, `src/render/delegation/selection.ts`.
- New tests: `tests/unit/r5-panel.test.ts`, `tests/unit/r5-imports.test.mjs`.

Exit: Codex/Pi/Claude roots, afterPaint races and mixed selection work; no unintended control/navigation; legacy remains readable.

### M4 — summaries, dry-run and preservation evidence

- Create `src/collectors/job-materials.ts`.
- Change `src/collectors/model-jobs.ts`, `src/collectors/briefing.ts`, `src/collectors/progress-summary.ts`, `src/collectors/brief-dry-run.ts`, and their wiring in `src/tree-page.ts`.
- New tests: `tests/unit/r5-job-materials.test.ts`, `tests/unit/r5-production-summary.test.ts`, `tests/unit/r5-brief-dry-run.test.ts`, `tests/int/r5-job-performance.mjs`.
- Update `docs/ARCHITECTURE.md`, `docs/reference.md`, `docs/reference.zh.md`; orchestrator owns STATE/handoff updates.

No planned edits to material contracts/config schema, SmallModel/cache implementation, facade tool schemas, Jev execution code, Pi footer implementation, installers, `core/link` types, WP0 manifest/assertion/scene hashes, or DEBT1 files.

## 9. Required tests, risks and validation

1. Mixed tree: native descendants, CLI, Pi helpers, oracle/Jev, direct Jev role, external and legacy records. Assert parentage/IDs/counts/selection, not only snapshots.
2. Same session string across namespaces, duplicate labels, preset change, continuation, null executor IDs, missing/skewed receipt. No guessed joins/rekeying.
3. Exact-ref dedupe versus missing-source non-dedupe; helpers; reused native session across two invocations; cycle/conflicting-parent refusal; suppression only with admitted replacement.
4. Atomic-update skew, malformed/oversized/FIFO/symlink records, disappearing STATUS/QA/report, permission failure. Last-known stale survives; no arbitrary path reads or false zero requests.
5. Pi working/waiting-helper/waiting-orchestrator/idle-grace/closed/failed; historical question, empty/stale/eligible answer; unconfirmed consumption; continuation retaining old report. No false DONE.
6. Jev answered/failed/interrupted/closed and all recoverable statuses; runtime absent with saved answer. Repeated observation produces zero launches/resumes/Send/close/writes and does not consume parent cursors.
7. Slow/unavailable/malformed herdr, locator mismatch, recovery; quiet old STATUS with current host versus lost host. No false running, success, failure or fallback launch.
8. Late callbacks after root/ref/turn change or dispose; afterPaint dedupe; mixed legacy selection; facade IDs cannot reach `/subagents`/Resume/Open.
9. Thousands of records, maximum helpers/questions, many closed jobs, selected report, directory churn. Assert entry/read/byte/concurrency/memory caps, continuation fairness, coverage and zero durable deletion.
10. 32/40/48/56 columns, EN/ZH, compact/rich, color/no-color, CJK/control-character text. Existing glyph/layout rules, no fabricated meter or raw report summary. Preserve Pi footer/non-Codex root tests.
11. Material sentinels: unbound/delegated-denied before text/hash; explicitly granted ref; revocation while queued/read/publish; stale language/root/turn output; no parent-permission or legacy-note laundering. Denied job does not disable eligible native brief.
12. Real production classes restore summaries and `<dir>/cache.json` across instances/restart using synthetic local transport. Off sends nothing; generic denial leaves legacy cache intact. Existing B17 tests and WP0 stay unchanged.
13. Dry-run equals panel-eligible material for the same fixture/time/settings, writes nothing and starts no backend/model; explicitly reports omitted job summaries.

Run builds/focused tests, then current STATE merge checks: full `test:unit`, `test:mjs`, `test:hud-mcp` and `bash tests/run-main.sh`, compared with base. Include applicable materials/native-display/footer/visual checks. Preserve failures and isolated known-flake reruns; do not relax baseline assertions. DEBT1 remains separate.

Measure quiet/changed/discovery collection and repaint separately: p50/p95/p99/max, sample count, reads/bytes/entries, RSS and observer concurrency, on the same named host against base, at least three runs. Include outages and large history. Fixture timing is not formal WSL or live-provider acceptance.

Main risks are incomplete binding evidence limiting dedupe/descendants, deliberately unavailable ungranted summaries, legacy/new selection masking, accidental expensive dispatch polling, mutating Jev convenience reads and cross-file skew. Tests target those mechanisms. Real harness/herdr/browser/footer validation remains a labelled local handoff, not a synthetic-test claim.

## Optional hardening:

None required. A per-root writer-maintained change stamp or job-scoped material authority could reduce polling or broaden summaries, but adds producer/contract work and is outside R5.

## Scope:

**inside task**, subject to the two recorded orchestrator rulings. No legacy retirement, new MCP tools, invented identity, new model permission or executor startup from observation.
