# R5-UX architecture

**Recommendation:** Keep the existing tree and execution facts, add a pure work-card projection and a separately authorized job-progress material adapter, and replace rich agent cards with at most three rows; preserve native material permissions and all execution/control boundaries.

Design consultation only. No implementation, tests, performance qualification or live-provider validation was performed. Repository files were not changed other than this answer.

## 1. Reasons and binding clarifications

- `JobDisplay` already separates lifecycle, outcome, freshness, requests and native identity (`src/collectors/job-display-types.ts:22–55`). A presentation state belongs above those facts, not in `SubagentStatus` or the executor.
- Exact-ref composition preserves native evidence and attaches helpers under their owner (`src/collectors/job-tree.ts:167–192,234–235`). Keep that topology; change its card projection, not its ownership.
- Current cards add independently wrapping summaries, actions, children and a telemetry footer (`src/render/cards.ts:710–750`). That structure cannot satisfy three rows by merely changing defaults.
- Current freshness clocks omit reports, questions and helper progress (`src/collectors/job-observations.ts:746–775`). Do not use `freshness.evidenceAt` alone as the inactivity clock.
- Dispatch settlement explicitly has no acceptance result (`src/roles/pi-dispatch-status.ts:197–236`). A report's existence and a helper's exit cannot establish review acceptance.
- Native material subjects require real SessionRefs; the existing source configuration allows only delegated result/digest (`src/core/materials/index.ts:18–29,105–112`; `source-config.ts:30–46,94–105`). Forging a Pi/Codex ref for a job would defeat the boundary.
- `SmallModel` already authorizes before formatting/hash/cache access, rechecks cache hits, and retains the active slot during cancellation (`src/collectors/small-model.ts:1118–1177,1210–1262`). Extend this boundary, not the transport or queue.
- Pi's current native reader deliberately retains metadata, not message text (`src/harness/pi/projection.ts:196–211`). Do not claim its existing snapshot supplies the required output tail.
- The existing Escape decoder works; the monitor consumes Escape to clear `keys` before handling Inspector back (`src/utils/workbench-input.ts:223–226`; `src/render/monitor-input.ts:391–409`). Fix routing/precedence, not terminal decoding.

### Orchestrator rulings obtained during this consult

These resolve ambiguities in the request; archive them with the package brief.

1. **q1:** Default inactivity threshold **10 minutes**, one minute-valued setting. Explicit failure, intervention and closure without a result → needs you. Lost/unavailable observation → stalled immediately: stalled means *not visibly progressing*, not necessarily a timed-out process. Job material gets distinct identity/provenance and **one opt-in grant per concrete recipient and job-card purpose**, covering this HUD home's facade jobs; no per-job consent prompts or inherited native permissions. External tasks require separate opt-in.
2. **q2:** Include **possible scope drift**, limited to this job's reported paths versus the brief's explicit owned-file list; no Git/diff scan. This is the orchestrator's default pending owner feedback. Awaiting acceptance may show deterministic facts alone when the model returns an empty line. Pi dispatch supplies `session_file` in STATUS and uses task-local sessions: admit that locator only under the containment/header checks below; otherwise artifact-only.
3. **q3:** The legal first review line is exactly `Verdict: accept` or `Verdict: changes-required`; no aliases or body search.
4. **q4, correcting q3:** Four states describe **active work**. A successful facade-closed job is archived **done**, subject to normal linger/history. Preserve a distinct `facadeClosed` fact: only association/receipt closure releases the awaiting-acceptance pin. Pi STATUS `closed` may be automatic shutdown and **does not** release it.
5. **q5:** Intentional card/settings golden and WP0 changes are authorized only with enumerated, reviewed replacements and reasons citing concept §15's 2026-11-09 decision. Unlisted changes require another question. Old settings files must still load.

## 2. For the implementer: core data and card states

### 2.1 Small data additions

Add `src/collectors/work-card.ts`: pure projection over a node, reduced evidence, a stored model annotation, settings and supplied `nowMs`. Return a `WorkCard` without modifying execution status:

```ts
type ActiveCardState = 'needs-you' | 'in-progress' | 'awaiting-acceptance' | 'stalled';
type CardDisposition =
  | { kind: 'active'; state: ActiveCardState }
  | { kind: 'archived'; state: 'done' };
// WorkCard also carries role/title, reason, phase tokens, deterministic facts,
// optional model line, elapsed/last-activity times, and evidence references.
```

Extend `JobDisplay` with an optional versioned `work` block for backward-compatible fixtures: `facadeClosed`, `facadeClosedAt`, `settledAt`, `outputWritten`, validated active-helper slot, continuation/episode key, last-activity evidence, and review-round facts. Keep body text out of this DTO. Missing new facts are unknown, not false/zero. The collector owns internal file locators and prepared material; rendering receives reduced facts and annotations only.

Extend `DispatchStatus` additively with optional validated `session_file` and useful producer timestamps. Invalid optional metadata disables that observation input, not the existing dispatch wait/close protocol. Never dereference `helper_pending.status_file`; derive the known helper path from validated kind and number, as the observer already does.

Add `src/collectors/job-artifacts.ts` for bounded artifact observation/parsing, plus `job-public-output.ts` for the narrowly scoped Pi public-output adapter. Share the existing collector slice accounting. Do not invoke `observeDispatch()` wholesale: its report read permits 4 MiB (`pi-dispatch-status.ts:234`).

### 2.2 State precedence

Compute deterministic state first; apply a valid model attention flag only as a display overlay. In priority order:

| Evidence | Card interpretation |
|---|---|
| Current unanswered, respondable QA; actual native approval/input request | **Needs you**. Show request/default when available; never invent a default. |
| Explicit job/native failure, blocked intervention, Jev recoverable non-answer (`needs_human`, timeout, interrupted/uncertain/incomplete, etc.), or closure/settlement without an expected result | **Needs you**, with a deterministic reason. A failed helper matters while it blocks the current owning phase, not forever after a successful replacement. |
| Valid current model `attention:true` with admitted basis | **Needs you**, marked as a model assessment; underlying deterministic state remains in Inspector. |
| Successful settled result, not facade-closed | **Awaiting acceptance**. Host absence cannot erase a persisted result. |
| Nonterminal observation unavailable/stale, or required current evidence cannot be corroborated | **Stalled** immediately: “Observation unavailable; last activity …”. Do not display `stale`/`unknown` or a running animation. |
| Current nonterminal evidence, but no meaningful new activity for threshold N | **Stalled**: “No new activity for 10m; …”. This is not a failure or automatic recovery trigger. |
| Otherwise current working/starting/waiting-helper work | **In progress**. Without public prose, use only a truthful deterministic fallback such as “Waiting for review r2.” |

A waiting-orchestrator STATUS without readable/current question details still needs attention, but says “Decision requested; inspect the job,” not “answer q1.” An eligible answer file means written/consumption unconfirmed: stop asking the user to answer it again. Preserve direct-Pi versus dispatch answer eligibility (`job-observations.ts:804–824`). Historical unanswered files do not promote the card.

For a facade job, `facadeClosed = association.closed || validated receipt.state === 'closed'`; keep provenance of that fact. It is **not** `job.lifecycle === 'closed'`, primary/helper STATUS closed, or runtime closure. If both a successful result and facade closure are recorded, use archived done. Failure/intervention remains needs-you after cleanup; closure does not turn it green. Closure without a result remains needs-you. Done means work was closed, not proof that tests or review passed.

Awaiting-acceptance facade cards are exempt from finished linger until facade closure. Change collector history pruning as well as `panel-state.ts`: an auto-closed Pi task must not be pruned as closed history. Retain existing total node cap and partial-coverage notices; pinning does not promise unlimited residency. Explicitly closed history remains bounded to 50 jobs/30 days. Native subagents have no facade-close step: completed native work maps to awaiting acceptance/result ready but retains its existing linger. Do not add an acceptance store, action or inference from opening the Inspector.

Jev keeps per-statement verdicts. Any deny/unsettled/timeout/intervention is visible attention; a completed judge result is not synthesized into “tests passed.” Oracle-through-Jev remains one oracle card. External tasks have no invented phase, report, acceptance or role; locator-only activity can become stalled, and Inspector explains its weaker coverage.

### 2.3 Meaningful activity and clocks

Keep **work activity** separate from freshness/liveness:

- Advance on a changed semantic STATUS/phase, a new current helper phase/result, a new validated public output record, changed review verdict/finding evidence, current QA transition or changed report content.
- Do not advance for polling, repeated identical STATUS, `updated_at` heartbeat alone, host alive samples, token counters alone, model replies, redraws or a bare mtime touch.
- Use valid producer event time where available; otherwise retain the first observation of changed evidence with `basis:'observed'`. Clamp future/negative elapsed values and expose clock uncertainty in Inspector.
- On restart, recover time from validated artifact/session timestamps, not panel startup. If no activity time is knowable, do not invent “stalled for 10m”; use the observation-unavailable explanation.
- Old helper activity must not mask silence in the active phase. Current helper output may advance the owner's activity while that helper is explicitly pending.

Setting: `cardStallMinutes`, integer 1–120, default 10. UI choices 5/10/15/30/60; valid file values remain minute-based. It changes only presentation, never waiting, cleanup or execution deadlines.

### 2.4 Phase strip and deterministic parsing

For Pi implementation work derive an **observed sequence**, not a workflow engine:

- `implement`: primary working before a review; a pending sonic is part of implementation. Show a compact sonic result token where useful, not its name/content/clock.
- `review rN`: validated pending `review-N`, with the reviewer result from its matching `review-N.md`. Numeric order, never lexical `r10 < r2`.
- `review rN accept|changes-required`: only the exact whole first line, with optional CRLF normalization. Missing, partial, oversized or illegal first line → “review rN, no verdict” in Inspector; card retains `review rN` without a guessed verdict.
- `fixing`: primary resumed working **after** a completed changes-required review. A negative review while the reviewer still runs does not by itself prove fixing started.
- `done`: this episode settled with a result; not “accepted.” Later review rounds replace the compact visible review slot, with history in Inspector.

Keep old review artifacts out of a continuation's current verdict unless tied to its current helper/session episode. Existing continuation suppression must also suppress old report readiness and old model annotations (`job-observations.ts:570–575`). Do not add file-writer protocol requirements to agents.

For reviewer/sonic/oracle/Jev work show only actual corresponding work phases (review, implement, propose/converge, recorded browser phase) and done if observed; never invent implement→review→fixing for every role. Native Codex/Claude subagents have **no phase strip** unless explicit compatible evidence already exists; no phase inference from prose, role name or tool calls. Native descendants remain in the tree/Inspector, not additional text rows inside a rich card.

Deterministic report extraction is deliberately small: recognized explicit test summaries (e.g. a complete Node/TAP total/pass/fail block) and an explicit changed-files section. Preserve command/run identity; never add reruns into a total or turn skipped/unknown into passed. Deduplicate enumerated paths only within that report section; truncated lists are lower bounds, missing counts are null. Display these as **reported** facts, not HUD-run checks. The model does not create/override counts, review verdict, phase or lifecycle.

## 3. Job-scoped material authority and small-model content

### 3.1 Boundary, identity and consent

Create `src/core/materials/job.ts` with discriminated job subjects/provenance and authority. Keep existing native `MaterialSubject`, SessionRef validation, source model configuration and legacy compatibility rules intact. At the request/envelope boundary introduce an explicit job variant; absence of the discriminator continues to mean the existing native path. Do not make `ref` optional everywhere or manufacture a harness/source/session.

A job identity is the tuple of **canonical HUD home, exact roster root, invocation ID, episode**, plus helper slot/session identity for contributing helper evidence. Pin home/task directory identities while reading. The episode changes on dispatch session replacement, continuation baseline or source replacement; it is stable across unchanged polls and panel restarts. A public evidence fingerprint is separate from episode identity. Cache keys use the canonical home's digest, not an absolute home path in prompts.

Use one narrow purpose, `job_card`, for progress and attention. Its only consumers are this job's card and Inspector. It does not authorize brief, recap, label, digest, cause, routing or another job. Job and native fragments are not mixed in one request in this package.

Persist a private, atomic versioned policy at `$HUD_HOME/job-materials-v1/policy.json` containing independent local material scope and recipient grant sections: fixed approved field list/version, facade-job eligibility, optional exact-root exclusions, external eligibility default false, and `{purpose:'job_card', recipientId, decision, revision, grantedAt}` entries. Unknown/missing/malformed policy denies. One Settings → LLM action grants the displayed **resolved recipient** once for eligible facade jobs in this home; saving unrelated settings never grants it. Do not serialize this permission as an ordinary card boolean. Existing backend, `agentProgress`, pause and card-summary switches remain additional gates.

Changing endpoint/account/trusted CLI profile requires a matching grant; do not silently copy consent. Use existing concrete recipient resolution (`core/materials/recipient.ts:13–67`). An unresolved CLI downstream profile remains unavailable. Root exclusions revoke access within the broad facade scope. External opt-in alone cannot supply an output locator: current external records are locator-only, so they remain metadata-only unless a separately verified public source already exists; no transcript search or external-registration schema expansion here.

`buildMaterials`/revalidation and `SmallModel.prepare` must explicitly dispatch the job variant through the job validator, then share scheduling, transport, accounting, caching and cancellation. Extend provenance persistence with a versioned job variant; preserve old native records' bytes/meaning. No permissive native-field additions to make job text fit `report`/`result` caps.

### 3.2 Source allowlist and proposed bounds

Authorize identity/scope/recipient **before outbound extraction, prompt assembly or model-cache hashing**. Local state observation is not outbound permission. Scheduling before authorization uses metadata signatures only. Read through fixed job-owned paths, not filenames suggested by a model or Markdown links.

| Input | Source and maximum model material |
|---|---|
| Goal and test-plan headings | `jobs/<job>/brief.md`: goal ≤1,000 code points, up to 12 test-plan headings ≤80 each. Exclude launch instructions, environment, arbitrary included files. |
| Owned-file list for possible drift | Only explicit owned-file entries in that same brief: ≤64 paths, ≤160 code points each; overall material budget still wins. No inferred list when the brief only describes an area. |
| Public output tail | Verified **primary** job session: last 4 public assistant text records, ≤600 code points each. Do not send raw JSONL, tool arguments/results, reasoning, user history, images, custom records, sealed payloads or raw terminal stdout/stderr. |
| Review | Latest relevant `review-N.md`: legal verdict line plus up to 8 explicit finding titles, ≤120 code points each; no full review body. Helper output is otherwise phase evidence only. |
| Question | Current `qa/qN.md`, up to 2 questions, ≤2,000 code points each; options/default/consequence remain quoted material. Answer bodies are not material. |
| Result | Current `report.md`, ≤4,000 code points, head/tail with explicit truncation. No transitive reads of paths mentioned in it. |

Limits apply cumulatively: **16 KiB UTF-8 material, at most 32 fragments**. Prefer current question for needs-you; result/review for awaiting acceptance; goal/output/findings for progress. For report text omit already parsed repetitive numeric blocks where feasible, retaining evidence locators. Truncation is in the envelope and Inspector, not silently described as complete.

Disk bounds: brief/question/report ≤32 KiB bounded excerpt each; review verdict prefix ≤512 bytes and finding-heading scan ≤16 KiB. Reuse existing QA validation limits where larger reads are already required, but never forward the larger text. Session header ≤4 KiB; tail window ≤64 KiB, ≤256 complete records, ≤64 KiB per record for this **summary adapter**. It may skip an oversized/incomplete record and report partial coverage; it is not the full native reader. Proposed session-file eligibility cap **64 MiB**; above it use artifact-only rather than scanning the whole file. No persistent raw tails.

STATUS `session_file` is accepted only if absolute, has no `..` or symlink components, realpath remains inside that invocation's dispatch task directory, is a regular same-device file, and its Pi session header ID matches the corresponding STATUS `session_id`. Use no-follow/nonblocking open, bounded reads and pre/post fstat/path checks. Direct Pi uses its job-local `sessions/` directory with bounded discovery; if multiple plausible current sessions cannot be disambiguated, no tail. Helpers may expose metadata for activity, but their prose is not an extra parent prompt input. Missing/unsafe/replaced/mismatched sources fall back to independent admitted artifacts, with explicit missing coverage.

Do not broaden native Pi's metadata-only snapshot. Implement a small versioned public-text extractor using the actual Pi record envelope and only assistant `text` blocks; malformed/unknown channels deny text. Bound it to the confirmed episode and observed branch; unresolved branch changes invalidate the tail rather than blending histories. Native Codex/Claude cards retain their existing public material adapters/permissions, not this new grant. Jev runtime JSON remains state evidence; unless a permitted report/public-output artifact exists, do not feed raw browser results, screenshots or runtime payloads to this feature.

All extra reads share the existing panel deadline, 32-file/1-MiB job slice and entry/node caps (`job-observations.ts:24–35`). Yield and carry cursors forward; reserve discovery work. Never turn 200 jobs into 200 full report/session reads every tick. Limit retained prepared bodies to at most three targeted jobs; dispose them on target/episode/root/policy changes. Normal metadata and a bounded recent-fact cache can remain per admitted node.

### 3.3 Model input/output and attention

The prompt contains evidence fragments with locally assigned IDs and coverage, the brief objective, and deterministic context describing current work. It explicitly treats every fragment as untrusted quoted data and asks for information **not already in the state/phase/counts**.

Strict reply:

```ts
{ line: string; attention: boolean; basis: string[] }
```

- `line`: empty or one sentence in UI language, ≤160 Unicode code points; plain text, no Markdown/control escapes. Rendering truncates it to one row. Empty is a valid cached result.
- `basis`: ≤4 distinct IDs from this request's admitted evidence, no freeform paths, quotes or explanations. Nonempty line/attention requires at least one basis; `attention:true` also requires a nonempty line. Inspector resolves IDs to artifact/record and bounded local evidence.
- Reject malformed JSON, extra fields, wrong language, unsupported basis IDs and out-of-bound replies. No unbounded repair loop; use the ordinary invalid-response outcome.

State-specific instructions:

- **In progress:** relate public output to the brief or remaining review finding titles; do not invent “one left” without explicit evidence.
- **Needs you:** express the decision, stated default and consequence; missing default stays missing. Deterministic failure/request explanation works without a model.
- **Awaiting acceptance:** mention only unresolved work, report/review disagreement or a concrete concern; otherwise `line:''`. Deterministic review/test/file facts form the row by themselves.
- **Stalled:** a supported possible cause only, explicitly tentative; silence alone does not prove a hung process, exhausted context or network failure.
- **Possible drift:** compare explicitly reported changed paths with the brief's explicit list; retain both sides as basis. Phrase “Possible scope drift …”, never “unauthorized change.” No repository scan, ownership claim or execution consequence. Missing/truncated scope means unassessable, not compliant.

Attention only promotes card presentation. It never changes `job.status`, timeline outcomes, wait events, permissions, acceptance or cleanup. Derived claims cannot suppress a deterministic question/failure. Invalidate an attention promotion when its basis changes/disappears, the episode changes or policy is revoked; do not leave an obsolete model allegation pinning a card. Ordinary prior notes can remain as recorded history in Inspector. No self-trigger: output/attention does not become new source material for another call.

### 3.4 Scheduling, caching and failure

Create `src/collectors/job-progress.ts`, wired beside the existing native `ProgressSummarizer`; no changes to agent behavior. Targets are visible rich **owner** cards with sentence display enabled, including questions and newly settled results, not helper cards. Native production summaries continue unchanged outside the new visibility selection.

- Reuse SmallModel's low-tier route, priority `visible`, single transport slot, timeout/output limits and existing hourly cap (60 by default). Do not raise defaults merely because capacity is available.
- At most three outstanding job-progress requests and 200 small scheduling records. Native progress retains its own three-request bound; total is therefore bounded to six pending progress requests, still one transport in flight. No new scheduler service is necessary.
- Coalesce changed eligible material; at most one request per job per 60 seconds. One request per successful material fingerprint, including empty replies. An unchanged poll, minute boundary, host heartbeat, width change or stall threshold never calls a model.
- Failed fingerprints are not retried by timer alone. New eligible material/configuration may retry after the existing ten-minute failure cooldown. Missing evidence/grant/off states consume no model budget.
- While output appends in the same episode, allow an in-flight snapshot to finish so chatty output cannot starve completion. Its annotation retains original coverage. Only currently valid basis may promote attention. Refresh newer material later. Episode/question identity/root/language/recipient/policy changes cancel obsolete work and fence late replies.
- Cache identity includes job/home/root/episode, evidence version and content fingerprint, purpose, granted scope/revision, recipient, actual model, prompt schema and language. Width, clock age and `observedAt` are excluded. Revalidate before cache hit, dispatch, response publication and durable save.
- Save job annotations with complete job provenance through the versioned derived-material path, never provenance-free AgentLog/native labels/recaps. Use private atomic writes and a bounded index (200 annotations, replace old versions). Preserve native `<dir>/cache.json`, existing generic caches, budgets and claims.
- Backend off/pause sends nothing and cancels queued/in-flight work. Previously authorized stored notes may remain locally visible while their local identity/scope remains valid; outbound revocation cancels generation and removes model-attention promotion. They never become material without renewed authorization. Local scope exclusion hides the affected derived display too.

Keep `summaryTree` exclusions for all other job-only features. The new bridge is **not** permission to restore job labels/briefs/recaps through legacy subjects. Exact-ref enriched nodes retain their native summaries, but their work card prefers the job annotation and must not display an old native turn's digest as this job's result. Existing brief dry-run remains brief/recap-only and still reports omitted job material; do not falsely advertise it as a job-card preview.

## 4. Rendering, settings and interaction

### 4.1 Rows and fitting

Replace only the ordinary rich card body, retaining the shared recap/status-card helpers in `cards.ts`:

1. **Title:** corner/selection, explicit role, task name, state word, minutes. Role and name use fixed role ink; state uses status ink. `job.name` wins over native labels.
2. **Phase strip:** actual observed phases and latest review result; omit the row entirely for nodes without phase evidence.
3. **Sentence/facts:** one physical row, never wraps. In needs-you prioritize decision/default; in awaiting acceptance prioritize adverse evidence, review, reported test counts, changed-file count, then optional model caveat. Put full sentence/facts/basis in Inspector.

No separate footer or empty placeholder row. A no-phase native card has at most two rows. Bottom corner can be drawn on the final real row. All emitted panel lines are padded to exact visual width; use `monitorText` once for external text, `t()` for UI text, `visualLength`/`truncateAnsi`, not UTF-16 `.length`.

| Width | Title and strip policy |
|---|---|
| 32 | Compact state words (`needs you`, `working`, `to accept`, `stalled`), explicit role, minutes; remove decoration before shortening task name. Strip keeps active phase and latest verdict, earlier history becomes `…`. |
| 40 | Same priorities, normally ≥8 task-name cells; two/three phase tokens when they fit. |
| 48 | Full state words where they fit; latest review number/verdict retained before prior phases. |
| 56 | Normal three-row form; previous→current→next **observed** phase tokens only. |
| 110 | Same three rows, not two columns or extra telemetry; more task/sentence and phase history fit. |

Example wide form (synthetic, not an exact-width golden):

```text
┌ imp Parser repair                  in progress 3m
│ implement → review r1 changes-required → fixing
└ Fixing timeline attribution and badge fallback.
```

ZH state words: `需你处理 / 进行中 / 待验收 / 停滞`; archived `完成`. Short EN `working` and `to accept` are variants of the same states, not new states. Use readable fixed role labels `imp`, `reviewer`, `sonic`, `oracle`, `Jev` in both languages; unknown native roles retain a sanitized short original role or localized `agent`. No arbitrary mapping of native `scout` to sonic. No-color keeps these words and state words/glyphs, so role identification never depends on hue.

Use literal minutes: `<1m`, `1m`, `63m`; ZH `<1分`, `1分`, `63分`. Active title elapsed is invocation/current native turn duration, **not** last-activity age. Awaiting-acceptance duration freezes at settlement; third-row inactivity age is separate. Archived facade jobs show minutes since explicit close (q4). Missing timestamps omit the time. Keep seconds in Inspector's detailed timestamps; add no seconds setting. Do not change the main status card/bar clock.

Cache keys use the actual displayed elapsed/inactivity minute values and state boundary, not `floor(now/1000)` (`cards.ts:781–785`). Review/state/annotation changes repaint immediately. Continue collecting at normal cadence; minutes reduce card invalidation/terminal writes, not evidence freshness. Main footer/timeline may still repaint faster, so do not claim the whole panel becomes one paint/minute.

### 4.2 Role palette

Add semantic `roleInk` maps to `Palette` and `onSelectedBand`, exposed by `theme`; no raw escape sequences in card code. Do not reuse hash-based direction assignment for fixed roles. Keep existing direction colors for timeline ancestry and unrelated native visualizations.

Proposed fixed family assignment (constants to preview and contrast-check, not a claim of measured accessibility):

| Role | Family | terminal ANSI-256 | mocha | titanium | latte |
|---|---|---:|---|---|---|
| imp | blue | 75 | `#89B4FA` | `#5EC8FF` | `#1E66F5` |
| reviewer | violet | 141 | `#CBA6F7` | `#B79CFF` | `#8839EF` |
| sonic | cyan | 81 | `#74C7EC` | `#2AC3DE` | `#087F9C` |
| oracle | lavender/indigo | 105 | `#B4BEFE` | `#8FA8FF` | `#555DB6` |
| Jev | magenta | 177 | `#F5C2E7` | `#D06FED` | `#A63C91` |

No red/yellow/green role ink. `none` is identity for every role; honor `NO_COLOR`. Derive calibrated selected-band constants where required, following `palette.ts:15–18,145–158`; test contrast against actual theme surfaces, especially latte. State ink remains info for progress, warning for stalled/requests, danger for explicit failure, success for recorded completion; role ink never replaces it. Owner preview before merge is required by notes item 1.

### 4.3 Inspector and small fixes

Inspector retains/adds: raw lifecycle/freshness and reason; native and facade identity separately; full phase/helper history; original task/name; model binding/observed model; context/rate/actions; report/question locations and bounded excerpts; review result source; reported test/file facts; last-activity basis; full model sentence, basis, coverage/generated times and safe queue/denial diagnostics. No secrets, env or raw sessions. Helper selection remains possible there and in compact topology, not a prose list inside the card.

Compact ordinary agent rows should also drop model/context/rate/tool clutter and use role/work state/minutes; preserve their existing topology/navigation. Residual historical delegation renderer is not redesigned or retired in this package.

For standalone Inspector Escape, pass explicit standalone context to the input handler and process Inspector back **before** the `keys` release branch: close details/return to `inspectFrom` (or Agents), clearing zoom as part of leaving that Inspector. Do not alter embedded key forwarding or consume a Codex Escape when the panel does not own it. Preserve higher-priority settings dirty-confirmation/help/log overlays. Test the real decoder→input path with one bare Escape, including split CSI sequences.

For Switch, derive availability from the selected current node and the existing final action fence. Pass `{open:null,recover:null}` through the existing `BarInput.buttons` slot for observation-only/non-switchable selections instead of adding a decorative disabled button (`control-bar.ts:52–69`). No invisible click target remains. Keep keyboard and double-click final fences; hiding a control is not authorization.

### 4.4 Settings migration and deletions

Retain `cardLabel`, `cardSummary`, `cardClock`, `cardCorners` with their display-only meanings; defaults true/true/true/square. Add only `cardStallMinutes` and the explicit job-content consent UI. The latter is default-deny and separate from settings preferences. Keep backend off default, existing `agentProgress` default and call cap.

Retire the rich-card presets and controls for original name, relations, action, child rows/summaries/counts, model, guardian chip, rate, context and child scope. Older JSON still loads: accept/ignore obsolete keys, preserve retained values and **all** model/backend/credentials/privacy choices; old `monitor` configuration must not resurrect telemetry. Reset Cards changes presentation only; reset LLM/all disables generation and never grants job content. Saving old settings must not implicitly enable consent.

Delete dead rich-card-only helpers (`kidLines`, action/relation/footer-meter/role-count builders and their visibility branches) after checking other consumers. Preserve shared `recapFields`, `briefFields`, width helpers and native collectors/Inspector telemetry. Delete `card-presets.ts` only after migrating its callers and approved tests. Do not delete AgentLog, ModelJobs, ProgressSummarizer, legacy execution code or native summary restoration to make the new UI easier.

## 5. Packages, tests and protected baselines

### A — Core facts and projection

Own: new `work-card.ts`, `job-artifacts.ts`, `job-public-output.ts`; additive `job-display-types.ts`, `job-observations.ts`, `pi-dispatch-status.ts`; minimal `types.ts`, `job-tree.ts` and `panel-state.ts` integration. Keep native source readers unchanged unless a shared extraction helper is genuinely needed.

Tests: table-driven precedence; all dispatch states; exact first-line verdict grammar; numeric rounds; current/historical QA and unconfirmed answers; continuation suppressing old report/review; Pi auto-close versus facade-close; pinned awaiting acceptance versus bounded history; native completion/linger; helper failure replacement; all Jev outcomes/per-statement verdicts; no false zero counts; unchanged reads/touches/heartbeats; inactivity boundary/restart/clock anomalies. Use real disk fixtures and composer, not only fabricated DTOs. Assert no observer writes/start/resume/close/Send and unchanged bar import graph.

### B — Material authority, output and scheduling

Own: `core/materials/job.ts`, request/envelope dispatch in `core/materials/{index,request,derived}.ts` and `small-model.ts`; new `job-progress.ts`; consent policy/UI plumbing in settings modules; serial wiring in `tree-page.ts`. Add explicit `job_card` purpose/type handling without weakening native validators. Keep native feature input fields unchanged.

Tests: denying getters/sentinels before text/hash; malformed policy; wrong home/root/job/episode; recipient/profile changes; sibling/helper confusion; unsafe paths/FIFOs/symlinks/device/header mismatch; oversized/incomplete records and private blocks; arbitrary Markdown pointers; mixed-grant exclusion; queued and in-flight revocation; cancellation retains transport slot; stale attention cannot pin; empty reply caches; invalid basis/language; repeated polls/minute/stall/resize cause zero calls; changed-content cooldown and bounded pending state; same-episode append does not starve; full restart restoration through **real SmallModel/store classes**, not only B17 doubles. Native `<dir>/cache.json` and denied legacy cache bytes must remain unchanged. Brief dry-run must remain no-write/no-start and correctly scoped.

### C — Rendering, settings migration and integration

Own: `cards.ts`, `job-details.ts`, `monitor-panes.ts`, `monitor-inspector.ts`, `monitor.ts`, `monitor-input.ts`, `control-bar.ts`, `palette.ts`, `colors.ts`, `i18n.ts`, card visibility/presets/settings files, final `tree-page.ts` wiring; docs/reference EN/ZH and architecture/privacy/design addenda. Settings files/tree-page are serial ownership seams, not parallel edit areas.

Tests: 32/40/48/56/110 columns, EN/ZH, every theme/look, NO_COLOR, hostile/CJK/combining text; ≤3 physical rows and exact width; persistent readable role/state; native no-phase; no helper prose/telemetry; long names/rounds/counts; sentence truncation with full Inspector recovery; correct selected ink; stable sub-minute frames and minute-boundary invalidation even with clock hidden; selection/scroll/hitboxes; standalone Esc and embedded forwarding; facade-only Switch absent and final actions still denied; old-settings migration/off/reset/consent behavior. Retain Pi footer, exact-ref production summaries and R5 afterPaint/coverage/Timeline regressions.

### Explicit baseline-change inventory

Intentional changes are acceptable under q5, but **do not blanket rebaseline**. Before C edits assertions, expand this inventory into exact existing titles/statement hashes and scene keys in its implementation brief; ask for any additional entry. Preserve unaffected assertions within affected files.

- `tests/unit/card-presets.test.ts`: the three thirteen-boolean/preset assertions → migration/no-implicit-permission assertions.
- `cards-l1.test.ts`: direction-color/card body, helper prose/selection rows, role counts/review chip, whole-note wrapping, independent obsolete booleans, telemetry footer combinations, child-summary targets/wrapping → fixed-role/three-row/Inspector/owner-target replacements. Keep topology, width, navigation and privacy checks, adapting only removed child-row expectations.
- `cards.test.ts`: clock/context footer, badge/meter fitting, child-line clicks, seconds clock, whole wrapped summaries, guardian chip, rate expiry and per-second cached card assertions → three-row/minutes/Inspector/repaint replacements. Preserve recap, generic wrapping, safe text and native switching behavior.
- `monitor.test.ts`: row model/context/clock expectations, independently composable card visibility, rich child-log hit areas; `settings.test.ts`: flat-card defaults; `settings-page.test.ts`: obsolete dependencies/presets/hidden coupled fields and changed row inventory; `settings-navigation.test.ts`: footer role-count switch; `summary-status.test.ts`: queued/writing/error/cap rows on cards → Inspector-only diagnostics. Unrelated model/privacy/settings-navigation assertions stay.
- `visual-baselines.test.ts`: old preset semantics → migration variants/new card settings semantics, while preserving exact dimensions, deterministic generation, recap independence and Inspector provenance.
- Main visual scene keys: the exact Cartesian family `panel/{en,zh}/{tab,band,tile,frame,pill}/{minimal,progress,monitor}/{32,40,48,56,80}x32` (150 scenes), and `settings/{en,zh}/{tab,band,tile,frame,pill}/active-settings/{32,40,48,56,80}x24` plus `.../saved-width-40-to-56/56x24` (60 scenes). These are replacement candidates only for changed card/settings rows; retain underlying main status-card content. Keep existing Inspector and confirmation scenes byte-identical unless a separately enumerated overlap is approved. Add new job-card and 110-column scenes rather than replacing unrelated scenes.
- `tests/integration/test-card-controls-real-tmux.sh`: obsolete card-control expectations require explicit replacement entries; execute locally when available, otherwise record NOT_RUN. Other manual scripts need no speculative baseline changes.

Use the manifest's existing per-entry reason/replacement/removed mechanisms (`tests/main-features.md:21–38`), citing the owner decision. The reviewer checks manifest/golden diffs against the expanded inventory. No production compatibility renderer solely to satisfy obsolete goldens; no removal of unrelated gate coverage. If a mixed test includes preserved assertions, retain them instead of marking the whole file changed.

Run focused builds/tests after each package, then the current integrated gate: full unit, mjs, hud-mcp, WP0 and applicable visual/material/footer tests; retain failures and known-flake isolated reruns. Compare quiet/change/discovery/outage and large-history workloads against base on the same named host, three runs, reporting n and p50/p95/p99/max, I/O/entries, RSS, pending/model call counts and render/paint separately. Existing R5 limits and applicable tick budgets remain; fixture timing is not provider/production acceptance. Update the synthetic R5 demo once its stage branch is available; owner reviews role colors and information density before merge.

## Optional hardening:

None required. Do not add a watcher service, writer change-stamp, repository diff attribution, acceptance database, external-session discovery, per-job consent dialog or another model queue.

## Scope:

**inside task**, with the explicit q1–q5 rulings above: this includes a narrow additive job-material contract and the enumerated card/settings baseline replacements, not a relaxation of native grants or merge gates. The orchestrator must record these rulings in the implementation briefs, expand the exact baseline inventory before edits, and retain the owner preview gate. Possible-drift wording remains the orchestrator's provisional choice pending owner feedback; there is no authorization here for execution, automatic repair, new native bindings or external transcript discovery.
