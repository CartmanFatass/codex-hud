# R5-UX implementation plan: passive Home and Work

**Recommendation:** Add a bounded, workspace-scoped artifact observer and one pure workboard projection beside the existing job pipeline; ship Home with a transitional Work landing first, replace that landing with lanes/cards second, then enable optional sentences through the already-approved job-material authority.

This is a design, not implementation or acceptance evidence. I inspected `home.png`, `work.png`, `mono.png`, `handoff.png`, their mapping/key notes, the earlier card consult and q1–q5 rulings, the panel/job code, and the installed pi-roles producer. Only this answer file was written. The pre-existing `node_modules/.package-lock.json` modification was not touched.

## 1. Reasons and binding decisions

1. **Packages are not an existing facade entity.** `JobAssociation` records invocation, caller root, task label, cwd, backend and report location—not package, queue position or acceptance (`src/roles/association.ts:49–80`). Dispatch receives `$HUD_HOME/jobs/<job>` as its task directory (`src/collectors/job-observations.ts:415–416`; `src/roles/pi-dispatch.ts:144–156`). A caller root is not a package. Names and cwd cannot join these identities.
2. **There are usable passive artifacts, but not a complete workflow history.** Pi writes QA with explicit question/options/default/context labels and plain-text answers; the producer does not write a structured decision or consumption receipt (`/home/fires/Fishpref/pi-roles/extensions/qa.ts:27–39,96–105`). Primary/helper STATUS and numbered artifacts provide execution/round evidence, not merge evidence (`/home/fires/Fishpref/pi-roles/README.md:169–190`). This external source is inspection evidence; implementation must not import the installed package or require its modification.
3. **The current observer is bounded but still repeats directory enumeration.** File bodies are signature-cached, yet completed observations restart on every collection and traverse QA/helpers again (`src/collectors/job-observations.ts:258–335,578–628,778–837,917–971`). Home needs directory-membership caching and incremental probes, not another full-tree scan beside this one.
4. **Collection and painting already have the correct separation.** `PanelJobPipeline.refresh` commits a generation-fenced snapshot; `compose/afterPaint` are pure and preserve exact-ref native identity (`src/tree-page.ts:164–205,210–263,532–541`). Keep this boundary and the existing final action fence. Local display is not model permission (`docs/contracts/07-outbound-compat.md:21–61`).
5. **The panel needs a real navigation/layout change, not another card preset.** Today it has four pane tabs, status-foot allocation, and agent-specific selection/scrolling (`src/render/monitor.ts:95–151,804–843,919,1001`). Enter and `v` currently share `inspect`; prefix 2 is Timeline (`src/utils/panel-command.ts:62–99`; `bin/codex-hud-keys:75–91`). These must be separated deliberately.
6. **The later display-only scope wins.** Concept §15 explicitly supersedes seen/overturn/default clocks and puts terminal needs-human on Home (`docs/universal-hud-concept.md:862–899`). The earlier card architecture, four active states, facade-close distinction, option B, and material grants remain binding except where these later entries supersede them. Carry forward `tmp/tasks/R5-UX/architect-1.md` §§2–5 and `tmp/tasks/R5-UX/qa/q1.answer.md` through `q5.answer.md`; do not reopen their decisions.

### Additional rulings obtained for this plan

Recorded through `ask_orchestrator` in this task's `qa/q1.answer.md` and `qa/q2.answer.md`:

- Discover **immediate `tmp/tasks/` children of the explicitly bound workspace** only. Scratch/mockup/consult directories may appear as small task-directory lanes. No heuristic facade-to-package joins. Without written order/title/merge evidence, use start-time ordering, written titles or IDs, and unknown phase.
- Home **needs you and its tab badge count only terminal needs-human jobs**. Worker QA and ordinary failures belong on Work and its summary, not Home's needs-you tier. The earlier q1 mapping is superseded for Home.
- Preserve Timeline, Changes and diagnostics as secondary read-only views.
- Package 1 may ship Home plus a **transitional Work landing** using current cards, provided every Home jump works. Package 2 supplies approved lanes/cards and the shared 110-column peek. Clearly label this staging in the package report/docs.
- Prefix `1` Home, `2` Work, `3` Changes, `4`/`v` Inspector, new `t` Timeline. Separate Enter activation from Inspector. Remove Resume/Reconcile, status-level and generation-toggle affordances from Home/Work. Keep backend toggles in Settings and recap/brief accessible through a secondary Inspector view.

## 2. Passive data model and exact sources

### 2.1 Three identities; no fabricated joins

Add `src/collectors/workboard-types.ts` for panel-internal immutable DTOs:

```ts
type LaneIdentity =
  | { kind: 'task-directory'; workspace: string; directory: string }
  | { kind: 'invocation'; home: string; root: string; jobId: string }
  | { kind: 'native'; refKey: string }; // existing exact native identity

type WorkTarget =
  | { kind: 'lane'; laneId: string }
  | { kind: 'worker'; laneId: string; workerId: string }
  | { kind: 'decision'; laneId: string; decisionId: string };

type EvidenceRef = {
  sourceId: string; relativePath: string; section?: string;
  revision: string; at: number | null;
  timeBasis: 'producer' | 'file-mtime' | 'unknown';
};
```

`WorkboardSnapshot` contains lanes, owner workers, decision records, coverage and a semantic revision. Each record carries its evidence references. Selection keys are stable within their source identity; revisions are not selection keys. No DTO contains environment, raw sessions, entire reports, execution commands, or implicit permission. UI preferences—selected target, folds, scroll anchors—are separate ephemeral state, not decisions or seen receipts.

A task-directory lane belongs to the **workspace**, not to an inferred main-session root. Show that scope in source details. On an embedded root change, discard the old projection and re-establish the workspace independently. An all-roots standalone panel may show facade invocation lanes from its existing all-roots snapshot; it must not crawl every job cwd for task directories. Without one explicitly bound workspace, omit workspace task discovery and explain that coverage in Inspector.

A current facade job has its own invocation lane unless there is an exact recorded package link. There is no such package-link field in today's association schema: **the first cut normally cannot combine a repo task directory with a facade invocation**. Do not add a writer field or parse a task label, request key, arbitrary Markdown mention, cwd, branch name or directory prefix as that link. Helpers have the owning lane/card because STATUS slot ownership is explicit. Existing exact native-ref enrichment still deduplicates native and facade workers; a matching-looking session string is not a SessionRef.

### 2.2 Source/degradation table

| Screen item | Source available today | Required degradation |
|---|---|---|
| Task-directory package | Immediate safe directory under bound `<workspace>/tmp/tasks/` | Directory ID is usable even without a worker. Do not classify scratch directories as production packages. Inspector calls it a task directory. |
| Package title | First nonempty heading in that directory's bounded `brief.md` | Directory ID if absent/unreadable. Do not ask a model to invent a title. At 110 show the written title; narrow lane headings use ID. |
| Facade invocation title | `JobDisplay.name` from association `task_label` | Invocation ID if empty. Keep full original label in Inspector. |
| Order/start | Validated STATUS `started_at`, association `created_at`, existing native start timestamp | Ascending known starts, stable ID tie-break; unknown starts last, ID order. Label it observed/start order, not a contractual queue. Directory mtime is not creation time. |
| Queue/dependencies | **No generic source today.** This repository's `docs/handoff/STATE.md` is a project-specific prose queue, not a HUD protocol | Do not parse it, numeric-sort R labels into a queue, fabricate `after R6`, or show unobserved future lanes. |
| Package phase | Admitted STATUS/current-helper/round evidence and explicit parsed design/review artifact facts | Say observed design/build/review/fixing only when evidence supports it; concurrent incompatible worker phases → mixed, no synthetic percent. No prescribed future steps. |
| Accepted/merged | Reviewer verdict is a review result; facade closure is work closure, **neither proves repository merge** | No green merged bar or merged age without an independently recognized explicit record. First cut has no generic merge-record adapter. Show closed/done or review accepted, not merged. |
| Answer call | `<task>/qa/qN.md` + sibling `qN.answer.md`; same layout under admitted facade job directory | No substantive answer → no decision row. Empty/stale/unsafe answer never becomes a silently defaulted decision. Consumption is unconfirmed. |
| Review call/strip | `review-N.md` paired with `.dispatch/review-N/STATUS.json` where present; a primary reviewer may have its validated role output | Only exact first line `Verdict: accept` or `Verdict: changes-required` (CRLF allowed). Otherwise no verdict decision. Do not search body or equate helper exit with acceptance. |
| Design call | Fixed local candidates `design.md`, `notes.md`, `architect-N.md`, plus a validated primary architect output within that directory | Only a recognizable decision/recommendation section becomes a bounded design-note row. Unstructured notes remain an artifact link. An architect recommendation is labelled a design note/recommendation, **not** an orchestrator adoption. |
| `instead` / `why` | QA's worker default/context; explicit alternative/rationale in a design note | Absent/uncertain fields vanish. QA context is labelled source context, never claimed to be an answer author's reason. No semantic inference of reversibility. |
| One-way | Explicit affirmative field in an answer/note, e.g. whole labelled line `One-way: true` | No producer is currently guaranteed. Normally absent. A prose mention or a question about one-way is not a positive field. |
| Needs-you reason/time | Terminal Jev result with explicit `needs_human`; per-statement `needs_human` on an ended judge run; `run.endedAt` | Generic “Ended needing a human” if no safe explicit reason. Missing end time omits waited age; never substitute poll time. No login/captcha claim from a generic failure. |
| Home worker row | Facade backend harness, role, task label, model/effort; observed model/thinking when available and identified as observed. Direct task STATUS supplies role/model/thinking; native tree supplies its existing metadata | Unknown fields absent; no role guessing. Direct task task-name comes from brief heading/ID. Jev's judge provider is not a fabricated CLI harness/model. Helpers are not separate Home rows. |
| Card sentence | Existing authorized native annotation, then option-B job annotation in package 3 | Before authorization/valid output, title + actual strip/facts only. No raw output tail used as a substitute sentence. |
| Calls/day summary | Distinct admitted answer, review and design-note records dated today | Local calendar day, not last 24 hours. Count recorded artifacts, not all orchestrator decisions. Omit zero package counts; show partial/lower-bound coverage when collection is incomplete. |
| Delegated/sent-back/failed totals | Distinct owner invocation starts, legal changes-required rounds, explicit failed terminal observations with known dates | No helpers double-counted as delegations; do not infer failure dates from a poll. Omit unavailable totals, and the whole dim line at narrow widths. |

**Important current gaps:** `JobDisplay` has no general ended-at, facade-closed distinction, body excerpts, review rounds, package, or meaningful-activity clock (`src/collectors/job-display-types.ts:22–55`). Extend its reduced observation facts additively as in the earlier consult; do not pretend the current DTO already supplies them.

### 2.3 Needs-human is narrower than recoverable/error

The existing observer recognizes:

- Jev runtime lifecycle `queued | running | completed | failed | closed | interrupted`.
- Ask outcomes `answered`, `failed`, `uncertain`, `needs_human`, `timed_out`, `wait_failed`, `incomplete`, `already_attempted`, `target_pending`, `clicked`, `resend_needs_confirmation`.
- Browse `done | blocked`.
- Judge per-statement `pass | deny | unsettled | timeout | needs_human`.

Evidence: `src/collectors/job-observations.ts:432–515`; `src/jev/runtime/types.ts:60–77`. The Jev writer records actual settlement at `run.endedAt` (`src/jev/runtime/executor.ts:205–225,971–977`); the current collector only uses it in its closed-at fallback. Add a separate reduced ended-at and runtime-terminal fact while reading that already-open file.

Home admission requires **recorded run termination plus explicit human-required evidence**. `blocked` by itself has no human-kind in the current browse result (`executor.ts:826–847`), so keep it on Work, not automatically in Home. Timeout, interruption, deny, failure, closure without output and uncertain send likewise do not prove an owner intervention. Pi's six dispatch states contain no needs-human terminal state (`src/roles/pi-dispatch-status.ts:7`); `waiting_orchestrator` is not one. A publish job's `failed` record therefore cannot reproduce the mockup's “registry login expired” Home item unless the actual source explicitly records human-required termination. This missing item is an honest first-cut degradation, not a reason to change workers.

Keep the approved four **Work** states, including its deterministic failure/QA explanation, default 10-minute stall threshold and facade-close rule. Separate `homeNeedsHuman` from Work's broader attention projection; never derive the Home badge by counting Work `needs-you`. A model attention flag remains a Work/Inspector assessment and cannot become a terminal needs-human fact.

### 2.4 Artifact parsing contracts

Implement small, deterministic parsers in new `src/collectors/work-artifacts.ts`, shared by facade and workspace observations:

- QA filenames use the existing bounded numeric grammar. Parse the producer's headings/labels; retain question, options, default, context and a bounded answer excerpt. Never follow the `Answer: write ...` text as a path: derive the sibling path. Current facade answer eligibility remains unchanged (`job-observations.ts:804–824`). For the decision feed, require a substantive nonempty answer and a current question/answer pairing; uncertain stale pairs stay in diagnostics, not the feed.
- `≠` comparison: normalize whitespace and harmless enclosing punctuation. Exact equality → routine. Resolve default and answer to **unique explicit options** only when their complete text or an unambiguous leading option token identifies a choice; two different resolved choices → departure. Otherwise unknown → routine, no `instead`. Arbitrary free-text inequality, “yes” to a multi-part question, quotation of an alternative, or “not A” is not a comparison. No model calls here.
- Answer title = first substantive answer paragraph, whitespace-flattened, bounded and visibly clipped; expandable source text supplies the detail. Do not add generated short/mid/full prose variants to reproduce synthetic wording.
- A legal review produces one stable call per source round, and the same reduced verdict feeds its card strip. Findings/counts only from explicit recognizable headings or reported summary; a partial scan cannot certify a total. Numeric round ordering. A new round is not “fixing” until primary work resumes after changes-required. A primary reviewer can produce a review call without pretending to be a helper.
- For design files, admit one bounded note record per recognized section with a stable section key; if no suitable sections, a recognized top-level `Recommendation:` is one note. Keep this grammar small and fixture-tested. Do not scrape every bullet, code block or quoted historical decision. Optional alternative/rationale/one-way fields must belong to that same section. Deduplicate identical **source identity** only, not similar prose across files. Counts describe recorded calls; repeated summaries are not proof of independent choices.
- Source event time is producer time where genuinely available, otherwise file mtime with `timeBasis:'file-mtime'`. A content-identical touch changes neither semantic revision nor activity/order in the running panel. After restart, a file-only record necessarily has file-time precision; expose that limitation instead of adding a decision database.
- Review/history evidence may remain as dated calls across a continuation, but only episode-compatible evidence enters the current card strip/result. Preserve the current continuation suppression (`job-observations.ts:570–575`). Replacing a source directory/session invalidates current-worker facts and pending annotations.

Direct pi-roles STATUS requires care: `parseDispatchStatus` checks expected `task_dir`, slot, role and output path (`src/roles/pi-dispatch-status.ts:58–79`). Facade primary output is `report.md`; standalone architects may use `architect-1.md`—this task does. Do not apply the facade's fixed report expectation to every task. Validate the known primary output as a regular, contained, immediate artifact; helper paths are derived from the validated slot. Never dereference arbitrary `helper_pending.status_file`, `.dispatch/current.json` contents, Markdown links or SESSION shell text. `SESSION.txt` may explain launch provenance but is not a package queue or a command to execute.

## 3. Collection, lifecycle and cost

### Modules and responsibilities

- **`work-artifacts.ts`**: bounded parsing/reduced evidence only; no model or execution imports.
- **`task-observations.ts`**: new workspace-only directory discovery, task STATUS/artifact observation, and directory/file signature indexes.
- **`job-observations.ts` + `job-display-types.ts`**: expose missing reduced lifecycle/activity/round facts, reuse the artifact parser, and cache QA/helper membership. Preserve execution/answer semantics.
- **`workboard.ts`**: pure lane/worker/call projection over task snapshot + existing job/native/legacy observations; exact identity dedupe, tiers/counts, coverage. No I/O, timer, permissions or mutations.
- **`PanelJobPipeline` / `tree-page.ts`**: own observer lifetime and shared collection accounting. Publish a workboard sidecar; do not inject task-directory workers into `SubagentTree` as fake native sessions or facade jobs. Existing tree aliases remain authoritative for Inspector/native navigation.

A direct task worker is a display-only subject, identified by workspace/task directory/slot/session episode. Its Inspector uses the reduced artifact facts; it acquires no native Switch action or model permission. This is how directly dispatched pi-roles tasks become visible without changing their producer.

### Bounded, change-driven operation

1. Pin the explicitly bound canonical workspace and HUD home. Refuse symlink escapes, nonregular inputs and ancestor replacement; use the observer's no-follow/nonblocking, pre/post-stat pattern. All reads remain inside admitted roots.
2. Cache `(dev, ino, size, mtime, ctime)` file signatures and directory identity/mtime/ctime membership stamps. Re-enumerate a directory only on membership stamp change or initialization. Directory stamps detect additions/renames, **not in-place file edits**: separately probe already known files in a bounded round-robin queue.
3. Cache misses for known optional files until their containing directory changes. Cache parsed reductions, not a second full copy of source bodies. Skip JSON/Markdown parsing and projection reconstruction on unchanged signatures/content.
4. Carry discovery and per-source cursors across slices; reserve discovery work so a hot job cannot starve newly created task directories. Completed observations must not restart a QA/helper enumeration when membership is unchanged. Rotate probes across selected/current workers and cold/history records; selection may prioritize but cannot monopolize the slice.
5. Commit each source update coherently; a partially read QA pair cannot replace a valid decision. Retain last good source facts as stale on read failure. Budget deferral is partial/pending, not an invented worker failure. Deletion/invalid replacement must remove current eligibility after confirmed observation; absence during an unfinished enumeration is not deletion.
6. Root/workspace changes and disposal clear directory handles, pending work, selection anchors for the old scope, and generation-fence late promises. `compose`, `afterPaint`, render, click hit-testing and navigation use retained snapshots only.

### Proposed budgets, inside existing limits

These are implementer design allocations, not relaxed performance gates:

| Resource | Bound |
|---|---|
| Combined job/task artifact refresh | Existing **128 directory entries, 32 file operations, 1 MiB bytes**, and the same panel deadline; do not allocate that budget independently to each observer |
| New artifact work per opportunity | At most 8 of those file operations and 256 KiB, plus at most 64 metadata probes; stop at a **10 ms soft sub-deadline** or the existing remaining deadline, whichever is earlier |
| Discovery | Preserve the job collector's reserved discovery work; reserve a small task-directory turn from the same entry budget; continue cursors rather than restart from the first name |
| Resident work | At most 200 owner/helper worker projections combined; at most 200 lanes and 1,000 reduced decision records globally; existing facade closed history stays 50 jobs/30 days |
| Per task | At most existing 100 QA pairs/512 QA entries and 64 helpers/256 helper entries; bounded immediate root enumeration, never recursive search |
| Reads | STATUS ≤64 KiB; QA question ≤64 KiB, answer ≤16 KiB; review first line ≤512 bytes and heading scan ≤16 KiB; brief/design/report extraction ≤32 KiB per file |
| Retained new text | ≤2 MiB total bounded local excerpts, plus small facts/indexes; cap file metadata cache at 2,048 entries; evict bodies before current identities |

A scalar soft deadline cannot preempt one filesystem operation or JSON parse; report overruns, preserve existing gate semantics, and do not claim a hard 10 ms guarantee. Reserve enough fair job budget for larger existing Jev records rather than repeatedly denying them behind artifact reads. Stamp probes and cache hits must also be accounted, not hidden as zero-cost “no I/O.”

No separate watcher, background service, persisted call store, worker change stamp, subprocess scan or repo-wide Git query. This deliberately uses available file evidence; no request to the orchestrator to emit better metadata.

On an unchanged warm refresh: bounded metadata probes only, **zero body rereads, zero directory enumeration, zero reparses, zero model calls**. Pure unchanged projection reuse is O(1); minute/tier-boundary processing is bounded by resident records. A changed projection is at most O(P + W + D), with O(D log D) sorting only when ordering facts/day membership change. Generate strings only for visible rows. Retain the existing ≤2 ms unchanged-render target and changed render design share ≤15 ms p99/≤40 ms max (`docs/design/hud-information-design.md:853–889`). Measure actual full collection/paint/commit-to-paint separately; allocations are not a substitute for contract 06 gates.

### Day/tier rules

Use injected `nowMs` and local calendar date. Home's tiers are terminal needs-human, worth-a-look, other recorded calls. Worth-a-look consists of proven `≠` and explicit one-way. Newest first within tiers; recent tiers show three non-pinned records and `+N earlier`; ordinary records older than two hours go behind `N older today`. **All admitted one-way records remain unfolded and pinned for that day**, including when older than two hours; they do not consume the ordinary three-record allowance. A viewport can scroll them, but they cannot disappear into a fold.

Day rollover expires today's pin and recomputes counts without rereading unchanged files. Bright age ≤15 minutes is a clock cue, never a seen state. No timestamp means no fabricated “today” count or waited age. At capacity, prioritize admitted current-day one-way facts over routine history and expose partial coverage; no promise of complete unbounded history. “Nothing needs you” is affirmative only with complete relevant job coverage, not during startup/outage.

## 4. Panel integration and rendering

### 4.1 Top-level navigation and retained features

Add explicit `mainTab: 'home' | 'work'` and separate Home/Work target/scroll/fold state to `MonitorState`. Keep secondary focus/Inspector state separate from the main tab. A package/decision ID must never be assigned to `tree.selectedId`; map only a real worker target to its current native/job node when appropriate.

`renderMonitor` continues to return `MonitorFrame`; callers must keep `frame.state`. Add pure `render/home-view.ts`, `render/work-view.ts`, shared `render/workboard-rows.ts`, and `render/work-card.ts`. Reuse width/flow helpers, row/control rectangles, palette, i18n, `frame-diff`, and the key-anchored scrolling mechanics of `agents-view.ts`. Extract a small generic viewport helper if needed; do not build a second terminal UI framework or transplant delegation's execution-aware planner.

- **Home:** needs-you, worth-a-look, recorded calls, package progress, owner-worker rows; no main-session model/context/quota footer. At 110, inbox left and packages/peek right, workers below. The peek uses **the actual Work lane/card renderer**, not a second interpretation.
- **Work:** lane header, owner cards, calls; helpers contribute phase results only. At 110, cards left/calls right; card-only lanes may split cards across both columns. Logical navigation remains lane-header → workers → decisions regardless of two-column geometry.
- **Inspector:** `v`, prefix `4`, or a labelled Inspector control opens the selected worker/card; add source-aware decision/task detail sections without making them execution subjects. It retains full sentence/basis, model/effort, raw state/freshness, phase history and coverage. Preserve native detail/Changes/diagnostics. Add a main-summary preview for retained recap/brief.
- **Timeline/Changes:** secondary read-only views via prefix `t`/`3` and labelled navigation from Work/Inspector. Do not delete their collectors, formats or tests.
- **Legacy delegation:** preserve read-only historical information and exact action fences. Adapt admitted legacy display subjects into lanes or a clearly identified historical section; do not drop them when facade jobs appear. Keep `delegation/` identity/projection/Inspector utilities needed by remaining consumers. Its old agents-scene branch may be retired once Work represents those rows; no wholesale R6 deletion here.

Remove `planFoot` allocation/drawing from the new panel layout, the footer hitboxes/wheel handling and status-level controls. Delete `status-foot.ts` only if no consumers remain; do not delete shared `status-block.ts`, main statusbar fields, snapshot publisher, notifier, recap/brief backend, native summaries or dry-run. The open panel replaces the bar process and still publishes snapshots (`docs/ARCHITECTURE.md:1009–1012`): footer removal must not accidentally stop that lifecycle.

### 4.2 Keys, mouse and hand-off

Use existing APC command transport; update both `panel-command.ts` and `bin/codex-hud-keys` (the shell has its own command table):

| Key after configured prefix | Meaning |
|---|---|
| `1` / `2` | Home / Work |
| `3` / `t` | Changes / Timeline |
| `4` / `v` | Inspector |
| Enter | New activation command: Home target → Work; Work → no action |
| arrows / j,k / h,l | Move or expand/collapse as the approved key map specifies |
| `n` | Next Home-eligible human-needed card, then stalled card, in Work order |
| `?`, `,` | Help, Settings |
| Escape | Close overlay/Inspector, then return to its saved main-tab target |

Bare keys operate when standalone/panel-owned. Embedded non-command input and paste still forward to the main harness unless an existing overlay owns them; do not capture bare `1`, `n`, `?` or Escape from a harness that owns the keyboard. Split Enter from `inspect`: `v` must not accidentally become the Home activation key. Keep Space's Inspector behavior where already supported, explicitly documented. Fix standalone Escape by handling Inspector return before clearing `keys`; preserve dirty-settings/help/log overlay priority (`monitor-input.ts:391–409`).

Home activation passes a `WorkTarget`: needs-you/worker → owning card, decision → same source decision, package → lane header. Unfold the containing lane and any needed decision fold, clamp viewport to its tail and preserve Home's cursor. A deleted target falls back to its surviving lane or a no-longer-available notice, never to a same-named job. Mouse: first click selects, second expands; hint click activates. Work Enter is inert, not session switching or recovery. Use the same frame/`nowMs` for hitboxes and display.

Remove `R` recovery, footer `r`, and generation toggle controls from Home/Work; do not replace them with disabled buttons. No reply/seen/overturn controls or silent receipts. Native Switch is navigation only and may remain when its actual final action is available; facade-only/direct-task selections receive `{open:null,recover:null}` and no hidden hitbox (`control-bar.ts:52–69`; `job-details.ts:62–68`). Preserve final dispatch-time validation even when buttons are absent.

### 4.3 Cards, narrow widths and visual semantics

Carry forward the earlier card consult's deterministic facts, clocks, episode handling, optional model line and settings migration. Default collapsed cards are at most three physical rows: title / actual phase strip / optional sentence or deterministic result facts. No blank sentence placeholder, context meter, tok/s, model badge, helper prose or separate telemetry footer. A native card without phase evidence is shorter. Right-arrow expansion may show the complete sentence as an explicitly expanded detail block, not silently increase every card's default height.

Use the approved minute clocks from the earlier consult, not a fresh mtime as a state-start clock: invocation/current turn age, frozen successful duration at settlement, done age since explicit facade closure; Home's waited time is independently since terminal human-required end. Stall activity ignores unchanged heartbeats, model completions and redraws. Successful Pi auto-close remains to-accept until facade closure; direct tasks have no fabricated facade-close fact and must not claim accepted/merged.

Home worker rows obey the **brief's superseding rule**, not the PNG's older sentence rows: harness, role, task, model, effort, state glyph and age. Shorten task first, harness to `pi/cdx/cc`, then model short name. Preserve effort and role; absent data consumes no space. At 44 columns, use bounded short forms rather than dropping harness as the original mockup did. Needs-you rows keep the factual reason; cards' optional model sentences stay on Work.

At 44/56 use a single column, compact phase labels and 10-cell phase bars where meaningful; at 110 use the shared stage axis only for lanes with supported phase evidence. Unknown/mixed phases have no pretend proportional completion. Keep current phase and latest verdict before oldest completed tokens. Calls use **`calls` / `决定` everywhere**, including 110 columns. One-way text wraps rather than being silently cut; routine text can shorten and expands on selection.

All external text goes through `monitorText` once; all UI words through `t()`; every physical line is exactly the requested visual width. No `.length` fitting, external ANSI, FE0F additions or raw terminal escapes (`docs/ARCHITECTURE.md:807–852`). Reuse `hangLines`, `visualLength`, `truncateAnsi`.

Fixed role inks live in `palette.ts`/selected-band variants and `theme`, not hash-based direction colors. Latest approved preview governs the actual palette; state colors remain independent. To-accept is bright neutral, stalled grey/bold, human-required yellow, explicit one-way red. Historical direction colors remain for Timeline. No-colour preserves words/glyphs, cursor and rule weight; selected reverse/emphasis follows the approved mono behavior, never color alone.

Extend the existing `icons=text` fallback to the **whole new layout**: ASCII brackets/rules/spines/arrows, `>` working, `?` needs-you, `+` to-accept/done, `~` stalled/departure with distinguishing words, `<` sent-back, `.` routine, `!` one-way. Measure fallback strings, not assumed one-cell constants. CJK ambiguous-width terminals use this fallback; do not introduce font detection or a wcwidth fork. Retain old sub-44 safe rendering tests in addition to new 44/56/110 acceptance baselines.

### 4.4 Render-on-change

Key projection caches by source semantic revision/episode and relevant settings. Key row/card caches by projection, width, language, look/icons/theme, selection/fold state and **displayed minute buckets**. Include threshold crossings even when clocks are hidden: 10-minute stall, 15-minute brightness, two-hour fold, local midnight. No per-second card cache key and no width/clock event becomes model input. Preserve `frame-diff`; paint nothing when rendered cells are unchanged. Secondary Timeline or main-session diagnostics may still update faster—do not claim the entire process only paints once a minute.

## 5. Ordered, independently mergeable packages

Use these as implementation briefs. Each has its own fresh independent review and green applicable integrated gate; no package may depend on a future baseline waiver. Before editing protected assertions, the dispatcher enumerates exact assertion titles/hashes and scene keys expected to change, using the q5 manifest mechanism. This plan identifies families, not permission to blanket rebaseline.

### P1 — Passive records, Home and navigable transitional Work

**Goal:** useful passive Home, honest package/invocation separation, and working hand-off before card redesign.

**Create:** `collectors/{workboard-types,work-artifacts,task-observations,workboard}.ts`; `render/{home-view,work-view,workboard-rows}.ts` (Work initially a landing); source/detail helpers where needed.

**Change:** `job-observations.ts`, `job-display-types.ts`, optional additive observation fields in `pi-dispatch-status.ts`; `tree-page.ts`; `render/{monitor,monitor-input,monitor-panes,monitor-inspector,job-details,control-bar,agents-view,i18n,palette}.ts`; `utils/panel-command.ts`, `bin/codex-hud-keys`; only the settings/navigation surface needed to remove the footer; reference EN/ZH, architecture/privacy notes.

**Contract boundary:** read-only local artifact observation and panel navigation only. No MCP/worker schema changes, new native identities, model extraction, execution imports or new durable records. Preserve existing native/facade/legacy composition and summaries. Direct task Inspector is display-only. Footer removed but summary backend/view retained. Work initially uses current cards under stable lane headers and decision rows; no claim of final Work visual acceptance.

**Test headings required:**

- **Unit—real disk sources:** all QA/default cases; legal/illegal review first lines; numeric rounds; design recommendation versus adoption; no optional fields; same-name/different-workspace isolation; no guessed joins; standalone/embedded/all-roots scope; unsafe paths and replacement; direct custom output path; incomplete/malformed input; unknown timestamps/order/phases.
- **Unit—bounded collection:** unchanged zero-body/zero-enumeration; in-place edits versus atomic rename; missing-file creation; fair cursors beyond limits; shared 1 MiB/32-file deadline; cold start, outage, source removal/root switch/dispose; no writes/model/execution calls. Assert all facts and costs through the live pipeline, not DTO-only tests.
- **Unit—integration/input:** Home badge terminal human only, QA/failure excluded; partial suppresses empty success; three-row caps/folds/day rollover; Home→worker/decision/lane; new Enter versus v; prefix transport parity; standalone Esc; embedded forwarding; no seen mutation; facade Switch absent/final fence intact; recap and publisher retained.
- **Visual baseline:** Home and transitional landing at **44/56/110 × EN/ZH × colour/no-colour**, busy/calm/empty/partial/missing-title/missing-phase/no-one-way/long-CJK, plus ASCII. Baselines must encode honest invocation lanes rather than fake package joins.
- **Regression:** existing R5 observation/tree/panel/production-summary/dry-run/Timeline suites, Pi footer and frozen snapshot/bar import-graph checks.

Expected protected families: control-bar/monitor/input/panel-command/prefix-keys, status-foot/settings navigation, Home-replaced panel scenes and affected overlay headers. Reuse the earlier card inventory only for assertions genuinely changed here; ordinary card content is not yet rebaselined.

### P2 — Work lanes, compact work cards and final visual integration

**Depends on P1. Goal:** replace the transitional body with the approved lanes/card design and shared 110-column Home peek.

**Create:** pure `collectors/work-card.ts` and `render/work-card.ts` (or move equivalent pure code out of P1 rather than duplicate it).

**Change:** P1 workboard/render modules; `cards.ts`, `panel-state.ts`, `job-details.ts`, `monitor*`, palette/colors/i18n; card visibility/presets/settings modules; necessary additive job activity/round facts; visual fixtures/demo and reference docs. Extend `job-artifacts` functionality only if it is not already in `work-artifacts`; one parser, not two.

**Contract boundary:** presentation states do not mutate execution status, wait semantics, acceptance or sources. Preserve facade-close distinction, 10-minute threshold, explicit counts, no guessed phase progression. Direct tasks without material grants have no sentence. Delete the replaced ordinary agent-rich rendering path and dead card-only telemetry/helper builders; keep shared wrapping/recap helpers and native collectors. Remove `card-presets.ts` only after caller migration. Old settings still load; no settings migration grants content.

**Test headings required:**

- **Unit—four states/activity:** approved precedence, current versus historic QA, failures versus Home human admission, no-heartbeat progress, immediate observation-loss stall, threshold boundary, restart, continuation/review mismatch, Pi auto-close versus facade-close, pinned to-accept and bounded closed history, native linger, direct-task uncertainty.
- **Unit—lanes/navigation:** helpers internal, stable target after reorder, decisions without workers, invocation/native-only lanes, multiple workers/mixed phases, fold/scroll/clamp, next-flag ordering, Inspector return, two-column hitboxes, selected card cache and minute invalidation with hidden clocks.
- **Visual baseline:** final Home/Work/handoff/Inspector at **44/56/110 × EN/ZH × colour/no-colour**, including 110 ZH absent from mockups; all four states plus done, no sentence/strip, long labels/models/effort, multi-line one-way, no calls, partial coverage, ASCII and all supported looks/themes. Check exact width and default ≤3 card lines. Keep sub-44 regressions.
- **Performance:** quiet/change/large-history/scroll/resize, cards offscreen not formatted, role ink/selected contrast, ≤2 ms unchanged rendering target measured rather than inferred.

Protected replacement inventory: the earlier consult §5 card/settings families (`cards*.test.ts`, `card-presets`, `summary-status`, settings/monitor and visual scenes), plus explicitly enumerated lane/viewport/control replacements. Remove old agents-layout goldens only with reviewed new coverage; leave unrelated Timeline, material, statusline and bar assertions intact. Owner preview of role inks/density remains required.

### P3a — Job material authority and public-output adapter

**Depends on P1's reduced identity/evidence contract; may develop in parallel with P2 in disjoint files. Merge after P2 if that avoids settings/entrypoint conflicts.**

**Goal:** the already-approved default-deny job authority and bounded public extraction, with no enabled sentence scheduler yet.

**Create/change:** `core/materials/job.ts`, explicit job variant in materials request/envelope/derived persistence, `collectors/job-public-output.ts`, `small-model.ts` authority dispatch, narrow policy/consent helpers and focused tests. Integrate the consent Settings row serially after P2's settings migration. Do not edit pi-roles or invent a SessionRef.

**Contract boundary:** exactly the earlier consult §3 and q1/q2 rulings: purpose `job_card`, canonical home + exact root + invocation + episode, one opt-in per concrete recipient/purpose for this home's facade jobs, external eligibility separate/default off, native grants unchanged. Auto-discovered workspace task directories are **not facade jobs and do not inherit this grant**. First-cut direct-task sentences remain absent; do not silently broaden material identity to every `tmp/tasks` file.

**Tests:** authorization before extraction/prompt/hash/cache; bad/missing policy; recipient change; source replacement; unsafe session locator/header/branch; private/unknown content excluded; ≤16 KiB/32-fragment material and bounded disk reads; queued/in-flight/cache revocation; real SmallModel/store restart; denied old caches unchanged. **Visual baseline:** consent/denied Inspector/settings at **44/56/110 × EN/ZH × no-colour/colour**; Home/Work otherwise byte-identical. This package is independently useful as a tested, inert authority boundary; it need not activate generation to merge.

### P3b — Option-B sentences and final end-to-end closure

**Depends on P2 + P3a. Goal:** only authorized, change-driven job sentences enrich Work cards/peek and Inspector.

**Create/change:** `collectors/job-progress.ts`; serial `tree-page.ts` wiring, visible target selection, work-card annotation path, Settings consent wiring if deferred, material/privacy documentation and production tests.

Keep the earlier consult's strict `{line, attention, basis[]}` schema, valid empty result, explicit reported-path possible-drift check, same-episode anti-starvation, revocation/publication fences and provenance. The only material inputs are the approved bounded brief goal/headings/owned paths, verified public assistant text, review verdict/finding titles, current QA and report. **Home answer bodies/design notes are not added to that grant.** A future model comparison of QA decisions is not part of P3b.

Reuse SmallModel's queue/transport/hourly cap; ≤3 outstanding job-progress requests, ≤1 per job/minute and only when eligible input changes, 200 scheduling records. No call from a redraw, resize, age bucket, fold or unmodified poll. The shared visible lane/peek projection determines targets; the same card in two surfaces is one target. A model failure leaves deterministic cards; it neither replaces states nor promotes Home's human badge. Native summary restoration and brief/dry-run exclusion remain intact.

**Test headings:** real authorized end-to-end collection→material→SmallModel→stored provenance→Work/Inspector; empty/malformed/bad-basis replies; off/pause/default-deny and cancellation; stale attention, continuation/root/language/policy changes; unchanged fingerprint no calls; bounded fair scheduling and append-heavy output; restart/revocation through production classes. **Visual baseline:** sentence/basis/no-grant/error/empty/attention at **44/56/110 × EN/ZH × colour/no-colour**, with full Inspector recovery of truncated text. Final synthetic demo mirrors the approved visual but visibly degrades unavailable package/merge/needs-human facts.

### Parallelism and gates

- P1 is the first integration seam and should not overlap entrypoint/navigation ownership with another implementation.
- After its DTOs freeze, P2 and P3a's **core material/extractor work** can run in parallel. `tree-page.ts`, settings files, i18n, golden JSON and `tests/main-features.json` have one owner at a time; integrate serially.
- P3b follows both. Pure fixture preparation can run alongside any package; no separate speculative feature branch is needed.
- Each package runs focused builds/tests plus current merged-tree **`test:unit`, `test:mjs`, `test:hud-mcp`, WP0**, applicable visual/material/footer checks, formatting and fixture hygiene. Record original failures and isolated known-flake reruns. Use temporary HOME/HUD_HOME and synthetic data. No blanket assertion/hash replacement; q5 requires exact reviewed replacement entries and reasons citing the superseding concept decision.
- Compare base/head on a named host over at least three runs: quiet/change/discovery/outage/large-history, sample counts, p50/p95/p99/max, bytes/entries/stat probes, RSS, pending requests/model calls and collection/render/paint separately. Retain existing contract 06/B10C gates; cold catch-up is separate. Mock filesystem/provider/tmux tests prove simulation only. Live tmux/font/provider evidence is PASS/FAIL/NOT_RUN separately and cannot be fabricated from fixture success.

## 6. Risks and cuts

1. **The approved visual is richer than today's record.** Most facade lanes will be invocation lanes; there is no generic queue, merged marker, package join or publish-login needs-human source. Cut those unsupported claims, not the identity rules. The screen remains useful with ID/title, observed phase, worker facts and calls.
2. **Free text is not a workflow protocol.** Conservative comparison and design-note extraction miss some decisions. That is the approved trade-off. Cut semantic parsing, prose-to-phase inference and full-document scraping; unknown means routine/absent.
3. **Task directories include scratch work and old files.** Bounded discovery and source labels make this honest. Do not invent package classification or build a repository-specific STATE parser to make the synthetic R0–R7 lanes appear.
4. **Current job freshness is not activity.** Existing `fresh()` omits meaningful report/QA/helper changes; raw STATUS mtime can be a heartbeat (`job-observations.ts:746–775`). Implement the earlier consult's semantic activity reduction; do not use a clock shortcut that falsely stalls or perpetually refreshes work.
5. **UI-only navigation can accidentally retain execution buttons.** Test old `R`, double-click and stale controls against the new target union, not just visible labels. Keep the final action fence. Avoid importing facade executors into the new observation modules.
6. **Footer deletion can erase retained product behavior.** Remove the layout, not publication/recap/native summaries. Keep secondary read-only access and its regression coverage.
7. **More sources can consume the whole tick.** Share—not multiply—budgets, cache membership, expose partial coverage and retain cursors. Do not promise unlimited one-way pins or a full history scan per tick.

### Optional hardening

None required for this task. A general queue/merge adapter, a model-based answer comparator, persistent decision history, filesystem watcher, support for arbitrary task roots, and material grants for auto-discovered direct tasks are deferred product additions, not implementation prerequisites. Each would add a new parser/authority/lifecycle and acceptance surface; do not smuggle them into these packages.

## Scope

**inside task**, incorporating this consult's q1/q2 rulings and the earlier q1–q5 card/material rulings. The plan changes panel-local observation, layout and navigation, not worker/orchestrator behavior, execution APIs, native permissions or production gates. The orchestrator must carry the exact protected-baseline replacement inventory and the accepted transitional-Work limitation into the implementation briefs. Broader package joins/queue semantics, new writer fields, external-task model grants or gate changes would **need orchestrator** authorization rather than an implementer guess.

## Orchestrator rulings during the consult

### q1

Yes to all three, with these limits:

1. Packages: discover the immediate children of tmp/tasks/ under the explicitly bound repository/workspace only, read-only and bounded (stat-stamped, no recursion beyond the files the data mapping names). Each is a task-directory package with explicit provenance. No joins by name or cwd: a facade job joins a package only through an exact recorded link; otherwise it gets its own invocation lane. No invented queue order, titles or merged phase: order by start time when nothing better exists, and the id is the title when none is written. Note that tmp/tasks also holds non-package scratch dirs (mockups, consults); show them as they are, they will look like small lanes, and that is acceptable for the first cut.
2. Confirmed: the later display-only entries supersede card q1's mapping. Home "needs you" = only jobs that ended needs-human (terminal). A worker waiting on the orchestrator (QA), and plain failures, are the orchestrator's business: they show on the Work card and in the summary counts, not in Home's needs-you.
3. Keep Timeline/Changes/diagnostics as secondary read-only views reachable from Work/Inspector or the existing keys. Delete only what the new layout replaces outright (the bottom status card, the old agents scene layout if Work supersedes it).

### q2

Accept both.

(1) Staging accepted: package 1 ships the passive collector + Home + a minimal read-only Work landing (lane headers, decision rows, today's cards as they are) so every Home→Work target works from the first merge; package 2 replaces the landing body with the approved lanes/cards and the 110-column peek. Package 1's notes and docs must say the Work body is transitional.

(2) Mapping accepted: prefix 1 = Home, 2 = Work, 3 = Changes, 4 and v = Inspector, t = Timeline. Home Enter jumps to Work; Work Enter does nothing; v inspects. Resume/Reconcile (R), status level (r) and generation toggles are not offered on Home/Work (display only); backend toggles stay in Settings. Remove the footer layout only: the publisher, recap/brief backend and summaries stay, recap/brief reachable as a secondary Inspector view. Update docs/reference.md key tables and the in-panel help with the new map.

