# Project test map — TEST-SLIM-0 draft

**Status: proposal for orchestrator approval, not an implementation or a new merge gate.**
Snapshot: `f1d086e`, branch `test-slim-0`, 2026-11-10 audit follow-up. R6A-A5 is included;
R5UX-P3B and PIROLE-PR4 are not. The external TEST-SLIM-0 `inventory.json` and `proposal.md`
contain the census, per-case consolidation dispositions, timing provenance and execution slices.

## 1. Scope and ownership rules

This is a product-boundary map, not a catalogue of package briefs. A row has one owning
file and named test; distinct failure conditions become named table rows there, not new
per-package fixtures. A test can own several related observations. The title below is the
current source title (template variables mean generated rows); a future slice preserves
individual row identities and assertions when it consolidates. Other tests may exercise a
path as integration support; that does not create a second owner or justify deletion.

Current scope is concept §15's 2026-11-07 fixed-role facade, herdr CLI execution, owned Jev
and main-session chaining. Contracts' supersession headers apply. Old ledger/run/claim,
retirement and automatic-control machinery is **compatibility coverage, not a requirement
for the new path**. Do not remove it merely because it is historical; the owner must decide
any supported-profile change. WF1 remains deferred. No synthetic test qualifies a real
provider, browser account, parent-exit durability profile or WSL performance target.

**Frozen overlaps:** WP0 `main-features.json`, every file it maps (including mixed files),
and visual baselines remain byte-for-byte unchanged. An owner below in such a file is a
routing pointer only: list overlap, do not fold, move, retitle or regenerate it in TEST-SLIM.
`run-main.mjs` checks carrier mappings, executed assertion titles, assertion-statement
hashes and visual frame hashes; keeping only similar coverage is insufficient.

## 2. Layers

| Layer      | Purpose and boundary                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pure`     | Deterministic projection, parsing, layout and policy from supplied values; no process or native state.                                                                                                                                                                         |
| `contract` | Real public module entry and its persistence/authority/transport boundary, with the shared synthetic ports; assertions concern user-visible facts and refused effects. Real private filesystem operations stay real for path/permissions/atomicity contracts.                  |
| `process`  | Only process, signal and lifecycle invariants: process stamps, inherited descriptors, parent death, exec/argv/environment, groups and cleanup. Use only processes created by the fixture. A slow functional lifecycle test does not become perf merely because it exceeds 5 s. |
| `e2e`      | Three small synthetic product scenarios E01–E03 compose the real facade, panel collection and packaged host. Extend these; do not replicate the entire failure matrix at this layer.                                                                                           |
| `visual`   | Existing pinned terminal frames, display widths, control targets and EN/ZH appearance. Baseline bytes are frozen; logic around them belongs to contract/pure owners.                                                                                                           |
| WP0        | Inherited main behaviour and its pinned assertions/frames, unchanged by TEST-SLIM. Run by its existing runner and opt-in rules, not a replacement for the product map.                                                                                                         |
| `perf`     | Opt-in latency, cold-cost, large-scale, RSS and throughput experiments in `tests/perf/`, run serially by `npm run test:perf` with host/Node/revision metadata. Never part of `npm test` or the merge gate. Small correctness residues remain in the default contract owners; frozen WP0 performance overlaps keep their existing routing.                                      |

## 3. Product behaviours and their owners

Paths are relative to `tests/unit/`, except `tests/hud-mcp/…`. Each named case executes
the stated boundary; compound provenance/cache, settings, snapshots and protocol
behaviours have separate owners. Frozen owners are routing pointers, never edits.

### Bar and statusline

| ID  | User/contract behaviour                                                                       | One owning test                                                                                                                    | Layer      |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| B01 | Bar fits the requested terminal width without losing essential identity                       | `bar-layout.test.ts` — the alert survives every pane width                                                                         | `pure`     |
| B02 | Statusline preserves compact native output and explicit detail selection                      | `statusline-native-details.test.ts` — both product bins preserve compact golden bytes and consume explicit details in either order | `contract` |
| B03 | Role counts distinguish unavailable, partial and genuinely empty exact-root observations      | `role-summary.test.ts` — role summary valid zero and partial coverage stay distinct from unavailable                               | `contract` |
| B04 | Role status publication happens during collection, never paint                                | `role-summary.test.ts` — role summary same collected panel snapshot is painted, with no publication during paint                   | `contract` |
| B05 | Output health and diagnostic reasons remain visible without inventing freshness               | `hud-diagnostics.test.ts` — normal state stays quiet; binding, collection, bridge and model failures have distinct reasons         | `contract` |
| B06 | Statusline observations remain aggregate-only and do not mutate durable inputs                | `statusline-observer.test.mjs` — fixture uses actual private ledger and rendering changes no durable contents/settings/transcript  | `contract` |
| B07 | Agent output rates use incremental rollout evidence rather than rereading history             | `agent-rate.test.ts` — an agent's rollout gives its rate as the main session's is taken, reading only what was appended            | `contract` |
| B15 | Clock-only terminal updates emit only their changed row and resize invalidates the full frame | `frame-diff.test.ts` — clock-only updates write one row instead of the whole nested terminal panel                                 | `pure`     |
| B08 | Agent context uses the newest token report, not an older prefix report                        | `agent-context.test.ts` — the last token report wins, even when the file starts with an older one                                  | `contract` |
| B09 | A model badge selects a whole fitting form rather than cutting its text                       | `model-badge.test.ts` — a model badge is the widest whole form that fits, never a cut one                                          | `pure`     |
| B10 | The public snapshot preserves missing-versus-zero fields rather than inventing data           | `snapshot.test.ts` — a field with no data is absent, not zero                                                                      | `contract` |
| B11 | Snapshot files publish privately and atomically only when content changes                     | `snapshot.test.ts` — the file is written atomically, privately, and only when something changed                                    | `contract` |
| B12 | Snapshot bar segment coordinates match the exact visible text columns                         | `snapshot.test.ts` — each segment names the columns its own text occupies on the line                                              | `pure`     |
| B13 | Quota display selects its actual tightest window without inventing a reset                    | `resources.test.ts` — the quota field is one reading, the tightest window, and never invents a reset                               | `pure`     |
| B14 | Agent counts agree across title, status card, bar, notifications and snapshot                 | `agent-counts.test.ts` — the title row, the status card, the bar, notifications and the snapshot say the same of one session       | `contract` |

### Panel

| ID  | User/contract behaviour                                                                                       | One owning test                                                                                                                                                             | Layer      |
| --- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| P01 | Home needs-you and Work states follow current producer evidence, not labels                                   | `work-card-p2.test.ts` — P2 real producer precedence: active, waiting current QA, failure stays Work but never Home needs-you, and stale                                    | `contract` |
| P02 | Current questions outrank work; historical, answered and replacement-episode questions do not revive activity | `work-card-p2.test.ts` — P2 current unanswered QA outranks working; historic QA and a written answer do not request another answer, and per-worker observation loss stalls  | `contract` |
| P03 | Review acceptance requires matching settled written evidence and a resumed primary for fixes                  | `work-card-p2.test.ts` — P2 review evidence is exact, matching, settled and written; CR fixing requires resumed primary and latest round survives compacting                | `contract` |
| P04 | Inactivity uses producer time and meaningful progress, never touches or heartbeat                             | `work-card-p2.test.ts` — P2 exact ten-minute threshold and meaningful progress ignore heartbeat, model, counters and identical artifact touch                               | `contract` |
| P05 | Continuation cannot reuse old output, helper timing or phase evidence                                         | `work-card-p2.test.ts` — P2 a replacement episode cannot reuse an old primary output or impossible settle time; execution status remains the producer status                | `contract` |
| P06 | Cards reveal only granted native sentences and retain complete existing Inspector detail                      | `work-card-p2.test.ts` — P2 exact native enrichment preserves only its existing sentence grant; right arrow reveals full native detail and direct text remains ungranted    | `contract` |
| P07 | Home and Work navigate the same selected lane; passive folding does not act on work                           | `work-card-p2.test.ts` — P2 navigation uses human-needed then stalled Work order, stays stable after reorder, fold/expand and Inspector return are passive                  | `contract` |
| P08 | All visual modes keep exact cells and separate name hitboxes from role/state/time                             | `work-card-p2.test.ts` — P2 every visual mode keeps cells exact, all four active states plus done, no telemetry, and name rectangles exclude role/state/time                | `contract` |
| P09 | Workboard admits contained current QA/review files; unsafe sources are not permission                         | `workboard.test.ts` — workboard unsafe source files and replaced ancestors: symlink, FIFO, escape never admitted; source removal and dispose clear eligibility              | `contract` |
| P10 | Daily decisions fold by local day and retain one-way decisions without rereads                                | `workboard.test.ts` — workboard daily calls: three plus earlier, two-hour fold, one-way pin, local-midnight rollover without rereads                                        | `contract` |
| P11 | Inspector opens only on explicit interaction and preserves native/job details                                 | `monitor.test.ts` — keyboard motion only previews; Inspector remains closed until explicitly opened                                                                         | `contract` |
| P12 | Settings keyboard and mouse edit a draft with explicit Save and Back actions                                  | `settings-page.test.ts` — settings keyboard and mouse edit a draft, with explicit save/back actions                                                                         | `contract` |
| P13 | Forwarded keyboard bytes survive split reads without reinterpretation                                         | `key-forward.test.ts` — every key keeps its exact bytes: letters, arrows, Ctrl, Alt, and a character split across reads                                                     | `contract` |
| P14 | Changes distinguishes dirty, stale, unknown and failed Git evidence                                           | `monitor.test.ts` — stale, unknown, prunable, and failed reads are never displayed as clean                                                                                 | `contract` |
| P15 | Activity history acknowledges only observed receipts and never hides new arrivals                             | `activity-journal.test.ts` — a captured receipt cannot hide later arrivals, even after restart or out-of-order acknowledgements                                             | `contract` |
| P16 | Pinned fixed-time EN/ZH terminal frames match reviewed goldens                                                | `visual-baselines.test.ts` — visual baselines: fixed-time EN/ZH textual frames match reviewed goldens                                                                       | `visual`   |
| P17 | An inherited delegation destination stays selected when the view model is rebuilt                             | `b10b-s3-selection.test.ts` — a destination stays selected across a tick that rebuilds every object of the view model                                                       | `pure`     |
| P18 | Inherited panel selection follows agent identity rather than a changed row position                           | `panel.test.ts` — the selection follows the agent, not the row                                                                                                              | `pure`     |
| P19 | Unsaved settings confirmation defaults to staying and owns visible decision input                             | `settings-confirmation.test.ts` — unsaved confirmation defaults to staying, owns clicks, and offers three explicit decisions                                                | `contract` |
| P20 | Chinese labels use terminal display width in settings                                                         | `i18n.test.ts` — the settings page lays Chinese labels out by display width                                                                                                 | `pure`     |
| P21 | Draft saves retain independent preferences and publish a complete settings document                           | `settings.test.ts` — partial saves retain previous preferences and publish a complete JSON document                                                                         | `contract` |
| P22 | Painted activity keyboard and mouse targets identify the selected observed row                                | `activity-hub.test.ts` — keyboard/mouse action target IDs match selected rows; snooze duration uses frame time                                                              | `contract` |
| P23 | Panel session detail exposes recorded plan and tool results without inventing a verdict                       | `panel.test.ts` — the session view shows plan steps and recorded tool results                                                                                               | `contract` |
| P24 | Git project identity follows the session repository rather than a reference-read repository                   | `git-root.test.ts` — another project read for reference is not the session repository                                                                                       | `contract` |
| P25 | Only first-level agents receive cards; descendant activity and counts retain their actual hierarchy           | `cards-l1.test.ts` — only the L1 agents have cards; the summary counts them, at work while a subtask is, and their subtasks as one figure                                   | `contract` |
| P26 | Timeline merges observed rollout events and agent-log changes once in newest-first order                      | `timeline.test.ts` — the timeline is the rollout's events and the agent log's status changes in one list, newest first, kept once                                           | `contract` |
| P27 | Workbench focus, selection and scrolling stay independent across panes                                        | `workbench.test.ts` — focus, selection, and scrolling are independent across panes                                                                                          | `pure`     |
| P28 | Native session switching selects the exact UUID through the verified picker                                   | `session-navigation.test.ts` — switches exact agent UUID and returns to main through the verified picker                                                                    | `contract` |
| P29 | A completed first-level timeline stage retains duration, finished descendants and its latest result           | `timeline-stages.test.ts` — an L1's stage is a line off the main session's rail at its end: how long it took, the subtasks it saw finish, and, its newest, what it returned | `contract` |
| P30 | The actual standalone panel leaves its alternate screen and exits when its input closes                       | `b11-cli.test.ts` — hud panel starts the actual panel and closes when its input closes                                                                                      | `process`  |
| P31 | Standalone panel input and cleanup never use an inherited tmux pane or fallback                               | `b11-cli.test.ts` — standalone panel never uses inherited tmux ${explicitPane ? 'pane' : 'fallback'} for input or cleanup                                                   | `process`  |
| P32 | Native-call payloads cannot inject terminal escapes into existing rendered projection                         | `native-call-display.test.ts` — native payload with terminal escapes is sanitized in existing render projection                                                             | `contract` |
| P33 | Supplemental native calls preserve native panel rows, selected identity and model-summary rows                | `native-call-display.test.ts` — supplemental calls keep the existing native panel, selection and model-summary rows                                                         | `contract` |
| P34 | The panel displays ledger delegation independently of absent or unrelated Codex selection                     | `b11-cli.test.ts` — hud panel displays ledger delegation ${unrelatedSession ? 'with an unrelated Codex session' : 'without a selected Codex session'}                       | `contract` |

### Collectors and harness adapters

| ID  | User/contract behaviour                                                                                            | One owning test                                                                                                                                | Layer      |
| --- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| C01 | Claude usage deduplicates message IDs and excludes private content from public evidence                            | `claude-reader.test.ts` — Claude usage is deduplicated by message.id and public evidence excludes private content                              | `contract` |
| C02 | Codex incremental parsing from an offset does not replay earlier records                                           | `rollout-replay.test.ts` — incremental parsing from an offset does not replay earlier lines                                                    | `contract` |
| C03 | Pi ordinary sessions are observed without taking host control                                                      | `pi-ordinary-collector.test.ts` — ordinary collector and actual panel expose Pi source/session usage and coverage without capability promotion | `contract` |
| C04 | Background and native child topology stays distinct from visibility or completion                                  | `d1-claude-topology.test.ts` — D1 native edge requires observed Agent call, exact metadata and positively identified child                     | `contract` |
| C05 | Bounded scans continue fairly; quiet refreshes do not reread unchanged bodies                                      | `adaptive-scan.test.ts` — within-file yielding preserves tree, ledger, saved bytes, unicode and partial-record resume                          | `contract` |
| C06 | Shared status truth-table projection preserves independently sourced state dimensions                              | `status-merge.test.ts` — ${row.id}: ${row.title} (${name})                                                                                     | `pure`     |
| C07 | Native wake transport failure neither retries nor acknowledges unread work                                         | `native-wake.test.ts` — host wake transport failure never closes, retries or turns acceptance into read acknowledgement                        | `contract` |
| C08 | Derived summaries retain the complete source union and reject unauthorized relabelling or cloning                  | `materials.test.ts` — T-07-6: derived summaries retain source union, reject parent relabelling, cloning and unauthorized union members         | `contract` |
| C09 | Credential files are private, bounded regular files; symlink, FIFO and unsafe mode refuse                          | `hud-credentials.test.ts` — credentials are private regular bounded files; unsafe modes, symlinks and FIFO are refused                         | `contract` |
| C10 | Collector lease expiry and rollback fence old renew/release/publish authority                                      | `b12-store.test.ts` — B12 lease expiry fences old renew/release/publish; generation persists across release/restart and clocks fail closed     | `contract` |
| C11 | General summary cache hits reauthorize source provenance before returning any text                                 | `materials.test.ts` — T-07-6 cache: reauthorize before hit; missing, mismatched or unknown provenance never gives a general hit                | `contract` |
| C12 | Bounded model material retains marked head and tail, leaving short text unchanged                                  | `model-jobs.test.ts` — a long text keeps its head and its tail, the cut marked; a short one is left alone                                      | `pure`     |
| C13 | Finished-agent summary jobs digest the public final answer once and feed the brief/log                             | `model-jobs.test.ts` — a finished agent is digested once from its whole final answer, into its log, and the brief uses the digest              | `contract` |
| C14 | Concurrent model requests reserve a shared hourly budget without losing calls                                      | `model-runtime.test.ts` — real processes atomically reserve the shared hourly budget without losing calls                                      | `process`  |
| C15 | Model cache writes merge across panels and live readers see external completions                                   | `model-runtime.test.ts` — independent concurrent cache writes merge and a live panel reloads another panel cache                               | `contract` |
| C16 | Collector commits bind source/ref/sequence and durable continuity without creating a ledger                        | `b12-store.test.ts` — B12 one source/ref/seq CAS; durable restart continuity and gaps; no ledger created; private/read-only files              | `contract` |
| C17 | Native wake delivers only result/request pointers and ignores ordinary events                                      | `native-wake.test.ts` — native wake forwards result/request pointers only and ignores ordinary events                                          | `contract` |
| C18 | Panel model credentials are selected only for the exact authorized HTTPS host                                      | `hud-credentials.test.ts` — panel key selection is exact HTTPS host from environment or own credentials only; custom/no-key path is off        | `contract` |
| C20 | Claude binding uses explicit realpath-scoped roots consistent with the effective configuration home                | `claude-binding.test.ts` — Claude source roots are explicit, realpath-scoped and checked against effective CLAUDE_CONFIG_DIR                   | `contract` |
| C21 | Codex binding needs one verified complete source reference and invents no managed identity                         | `codex-facade.test.ts` — Codex source is explicit and verified; binding needs a unique full ref, with no managed identity                      | `contract` |
| C22 | Pi binding verifies the current process command line and session header without managed authority                  | `pi-binding.test.ts` — pi binding verifies exact current cmdline and header, preserving source and null managed authority                      | `contract` |
| C23 | Claude native child edges require an observed Agent call and exact child metadata                                  | `d1-claude-topology.test.ts` — D1 native edge requires observed Agent call, exact metadata and positively identified child                     | `contract` |
| C24 | Worktree input refuses truncated or unknown records rather than reporting clean                                    | `worktrees.test.ts` — truncated and unrecognized records fail instead of pretending clean                                                      | `contract` |
| C25 | Jev/native job trees keep one invocation per job and exact helper/native descendants                               | `r5-job-tree.test.ts` — R5 mixed real-file tree has one invocation per job, exact helpers, native descendants and residual native-v2 relation  | `contract` |
| C26 | Delegation projection counts observed markers and reports only sourced backend/spend facts                         | `b10b-projection.test.ts` — counts are by marker over every node but the viewpoint root; backends and spend follow                             | `pure`     |
| C27 | Public assistant reports retain exact words rather than inferred progress                                          | `agent-report.test.ts` — public assistant updates and replies retain exact words, not inferred progress                                        | `pure`     |
| C28 | Agent log entries require an observed rollout event time                                                           | `agent-log.test.ts` — observed entries come from the rollout times only; no time, no entry                                                     | `contract` |
| C29 | Explicit model task routes preserve configurable tiers and global overrides                                        | `small-model.test.ts` — API task routes, configurable tier models, and global overrides                                                        | `contract` |
| C30 | Model accounting separates generated, cached, failed, limited and unknown-billing facts                            | `model-telemetry.test.ts` — per-feature accounting separates generated replies, cached consumers, failures, limits and unknown billing         | `contract` |
| C31 | Explicit model probes use bounded synthetic prompts without saving settings or secrets                             | `model-probe.test.ts` — explicit test uses three resolved routes and bounded synthetic prompts, without saving settings or secrets             | `contract` |
| C32 | Direct native calls are discovered without a ledger and display raw state without task/report gates                | `native-call-display.test.ts` — direct calls are discovered without ledger and render raw state without task/report gates                      | `contract` |
| C33 | Missing native hosts leave source-scoped relations visible as unavailable without launch or writes                 | `native-call-display.test.ts` — source identity is scoped, and missing host leaves relation visible without launching/writing                  | `contract` |
| C34 | Resuming the same official native ID selects the live connection and excludes prior-connection events              | `native-call-display.test.ts` — same official ID resume selects the live connection and excludes prior-connection events                       | `contract` |
| C35 | An idle native observer creates no relation storage                                                                | `native-call-display.test.ts` — no relation storage is created by an idle HUD                                                                  | `contract` |
| C36 | Bar/panel entrypoint source order keeps native observation after root parsing and outside legacy delegation gating | `native-call-display.test.ts` — entrypoints keep native observer latency outside root parser budgets and native activity navigation            | `contract` |
| C37 | Child details retain public pre-spawn parent instructions, excluding sealed, private and post-spawn text           | `subagent-charge.test.ts` — a child keeps the plaintext its parent wrote before the spawn                                                      | `contract` |

### Role facade and jobs

| ID  | User/contract behaviour                                                                 | One owning test                                                                                                                          | Layer      |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| F01 | Exactly six fixed role tools expose strict schemas                                      | `role-facade.test.ts` — role tool schemas are the six static tools                                                                       | `contract` |
| F02 | Routing is override then session then default, frozen for an existing job               | `roster.test.ts` — resolution order is override, then session, then default, and a prior result stays put                                | `contract` |
| F03 | Create keys replay once; changed input conflicts and ambiguous launch never relaunches  | `role-facade.test.ts` — same key replays one job and a changed request conflicts                                                         | `contract` |
| F04 | Send intent survives crashes without automatic resend                                   | `role-facade.test.ts` — a crash between send intent and the prompt is not resent                                                         | `contract` |
| F05 | Read and wait report current observations; timeout is not completion                    | `pi-dispatch-facade.test.ts` — PR4 real extension artifacts: QA consumed:false, independent waiters, helper remains within one job, collector read-only | `contract` |
| F06 | Question replies are eligible, bounded, idempotent and job-owner scoped                 | `pi-dispatch-facade.test.ts` — PR4 QA response rechecks the owner under the mutation lock | `contract` |
| F07 | Close/reap acts only on conclusively owned resources and preserves unresolved cleanup   | `pi-dispatch-facade.test.ts` — PR4 missing pinned release never falls back to the current checkout or activated release | `contract` |
| F08 | Continuation suppresses old settlement across restart and sends the primary once        | `pi-dispatch-facade.test.ts` — PR4 continuation suppresses old DONE; no replacement; explicit close is idempotent | `contract` |
| F09 | STATUS requires matching role, output_written and a regular nonempty artifact           | `pi-dispatch-status.test.ts` — success needs output_written and a nonempty regular artifact                                              | `contract` |
| F10 | Dispatch questions and helpers never become primary success or hidden permissions       | `pi-dispatch-status.test.ts` — a helper failure does not fail the primary                                                                | `contract` |
| F11 | Lightweight wait CLI preserves native wait errors separately from observation deadlines | `role-wait.test.ts` — native herdr ${mode} is distinguished from an observation timeout                                                  | `contract` |
| F12 | A Jev facade read exposes a terminal runtime error as a typed observation               | `role-facade.test.ts` — hud_read carries the runtime error code                                                                          | `contract` |
| F13 | Explicitly closed Jev jobs stay closed through replay and a racing create               | `role-facade.test.ts` — a closed jev job stays closed                                                                                    | `contract` |

### Pi-owned execution and herdr

| ID  | User/contract behaviour                                                                | One owning test                                                                                                                                       | Layer      |
| --- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| X01 | Launch persists ownership intent before effects and reads remain passive               | `pi-owned-orchestration.test.ts` — owned launch: intent/outer transaction precede effects; structured argv; passive reads write nothing               | `contract` |
| X02 | Lost replies never duplicate an admitted owned launch step                             | `pi-owned-orchestration.test.ts` — owned crash matrix: lost ${step} reply ${window}; same-key retry has zero duplicates                               | `contract` |
| X03 | Reused pane, session, process stamp or unknown inventory cannot authorize mutation     | `pi-owned-orchestration.test.ts` — ownership: stale SESSION ignored; reused tab/label, foreign pane/session and unknown inventory refuse mutation     | `contract` |
| X04 | Helpers and nested sonic share bounded reservations and exact owned cleanup            | `pi-owned-orchestration.test.ts` — nested sonic: primary ${role} splits down, read-only grant, shared numbering, closed pane                          | `contract` |
| X05 | Worker startup verifies pinned loader, model and effort before a prompt                | `pi-owned-orchestration.test.ts` — real pi loader worker ${role} startup and two-entry ownership                                                      | `contract` |
| X06 | Explicit close and finite reaper clean a process tree idempotently, never foreign work | `pi-owned-orchestration.test.ts` — finite reaper executable exits when primary never exits; autoclose and explicit close are one idempotent operation | `process`  |
| X07 | Panel opens once from proven native TUI identity and fences replacement generations    | `panel-control.test.ts` — panel intent precedes split, unique tokens, duplicate open is idempotent, display-only paths and exact env                  | `contract` |
| X08 | Panel lifetime ends on native owner loss without closing unrelated panes               | `panel-control.test.ts` — panel lifetime ends on main exit, replaced generation, terminal HUP/loss, lost identity and manual close                    | `process`  |
| X09 | Real process stamps, signals, inherited pipes and scoped cleanup remain honest         | `run-process.test.ts` — dead command and group leader with a living member never prove scope gone                                                     | `process`  |
| X10 | Portable sourced waiters preserve exact exit, control bytes, environment and EOF       | `run-light-leader.test.ts` — portable waiter topology completes, preserves stdin, and controls scope under ${JSON.stringify(shell)}                   | `process`  |
| X11 | Herdr mismatch, missing CLI or disabled integration degrades without mutations         | `b7-herdr.test.ts` — B7 schema mismatch, missing CLI, disabled integration degrade without mutations                                                  | `contract` |

### Job materials and consent

| ID  | User/contract behaviour                                                                    | One owning test                                                                                                                               | Layer      |
| --- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| M01 | Authorization precedes extraction, hashing, cache lookup and publication                   | `job-materials.test.ts` — job authorization precedes extraction, formatting, material hash getters and cache lookup                           | `contract` |
| M02 | Public-only fragments stay bounded and bind exact source/branch provenance                 | `job-materials.test.ts` — job material is public-only, bounded, source-bound and unchanged warm refreshes read zero bodies                    | `contract` |
| M03 | Revocation at every callback/send/settlement fence prevents all new text release           | `job-materials.test.ts` — synchronous compose and queued/running lifecycle revocations cannot cross the send fence                            | `contract` |
| M04 | Pending budget expiry resumes reductions without transport, charge or failure side effects | `job-materials.test.ts` — natural late expiry is job pending without cap/cache/failure effects, and fresh-budget retry succeeds               | `contract` |
| M05 | Source replacement and local-root revocation invalidate live and restarted derived notes   | `job-materials.test.ts` — stored job annotations reject contributing artifact replacement and local-root revocation without rewriting records | `contract` |
| M06 | Consent lock recovery never revives a revoked recipient or widens host credentials         | `job-materials.test.ts` — consent locking: a stale second writer cannot resurrect a revoked recipient while granting another                  | `contract` |
| M08 | General material grants deny wrong-source/recipient/purpose before reading text            | `materials.test.ts` — T-07-1/3: absent, invalid, unknown, missing-purpose, wrong-source and recipient grants deny before text is read         | `contract` |

### Jev

| ID  | User/contract behaviour                                                                    | One owning test                                                                                                                                      | Layer      |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| J01 | One send key is persisted before browser action and never replayed after uncertainty       | `jev-runtime.test.ts` — one click is persisted before it happens and is not repeated                                                                 | `contract` |
| J02 | Oracle recovery reconciles existing sends and requires explicit release before resend      | `jev-oracle.test.ts` — oracle: an attempted key reconciles the surviving send target and never clicks                                                | `contract` |
| J03 | ChatGPT prepares exact prompt, mode and attachments before the single Send click           | `jev-chatgpt.test.ts` — chatgpt target: proves the menu, fills the exact prompt and binds one Send click                                             | `contract` |
| J04 | Studio confirms current prompt proof and collects only the bound final response            | `jev-aistudio.test.ts` — T11: a single facts sample preserves exact prompt proof through same-document URL settlement                                | `contract` |
| J05 | Browsing rejects stale decisions and executes only a validated selected operation          | `jev-agent.test.ts` — a stale decision is consumed before any mutation                                                                               | `contract` |
| J06 | Judge loading, refusal and deadlines remain bounded without inventing page readiness       | `jev-judge.test.ts` — a page that stays loading spends maxLoadMs and does not call the model                                                         | `contract` |
| J07 | A decision network failure neither executes an action nor echoes cause text                | `jev-decisions.test.ts` — a network failure does not execute and does not echo the cause text                                                        | `contract` |
| J08 | Browser/wait leases serialize sends and never break a live foreign nonce                   | `jev-ask-lease.test.ts` — two processes contend for the browser lock and one click wins                                                              | `process`  |
| J09 | Owned runtime survives client loss, respects lease takeover and exits on its own lifecycle | `jev-oracle-boundary.test.ts` — T7/T8: runtime survives its client process-group exit, retains work and recovers an orphan only after lease takeover | `process`  |
| J10 | A custom Chrome account endpoint never joins the default in-flight start gate              | `jev-runtime-chrome.test.ts` — a custom account endpoint does not join the default in-flight gate                                                    | `contract` |
| J11 | HUD JSON and explicit private credential locations win; legacy runtime TOML is ignored     | `jev-ask-config.test.ts` — HUD JSON maps paths and non-location defaults; runtime TOML is ignored                                                    | `contract` |
| J12 | ChatGPT prepare polls attachment uploads rather than treating zero progress as completion  | `jev-chatgpt.test.ts` — ${finishes ? 'T13' : 'T14'}: real prepare polls ${shape} upload despite p=0                                                  | `contract` |
| J13 | Studio binds the virtualized user prompt before collecting its final model response        | `jev-aistudio.test.ts` — R1: real Studio facts bind a virtualised user before scrolling to the final model response                                  | `contract` |
| J14 | Invalid page judgments stay unsettled and needs-human requires an actual supported kind    | `jev-judge.test.ts` — needs_human stops only for a real kind, and an invalid judgment stays unsettled                                                | `contract` |
| J15 | Decision distributions reject probability sums outside the declared tolerance              | `jev-decisions.test.ts` — validateChoice accepts a full distribution and rejects a sum outside 0.02                                                  | `pure`     |
| J16 | Provider credentials never appear in enumerable or inspected properties                    | `jev-decisions.test.ts` — provider api keys stay out of enumerable and inspected properties                                                          | `contract` |
| J17 | A browser lease cannot unlink a live foreign nonce                                         | `jev-ask-lease.test.ts` — a live lock is busy and a foreign nonce is not unlinked                                                                    | `contract` |
| J18 | An idle in-process owned runtime leaves after grace once its work is released              | `jev-runtime.test.ts` — an in-process runtime leaves after grace once work is released                                                               | `process`  |
| J19 | Chrome probes and sleeps share the finite production startup deadline                      | `jev-runtime-chrome-start.test.ts` — R3F chromeStart bounds every probe and sleep by the 30 s deadline                                               | `contract` |

### Release, activation and packaging

| ID  | User/contract behaviour                                                                                                                 | One owning test                                                                                                                                            | Layer      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| R01 | A fresh apply selects a verified standalone release; explicit restore to absence removes its selector and retains the release directory | `runtime-install.test.mjs` — fresh apply and explicit initially-absent restore stay standalone with punctuation in prefix                                  | `contract` |
| R02 | Private immutable runtime closure refuses links, drift, unsafe metadata and unlisted payload                                            | `runtime-package.test.mjs` — manifest validates complete bounded payload and exact locked production identities                                            | `contract` |
| R03 | Owned shims preserve PID/PPID, argv, stdin, fd3, signals and native exit                                                                | `runtime-install.test.mjs` — fix1 ${command} runs in original PID with direct parent, argv, stdin, fd3 and exit code                                       | `process`  |
| R04 | Pi package preserves other UI, exposes six proxies and never routes /hud through a model                                                | `pi-package.test.mjs` — REAL package entry start -> reload -> shutdown preserves synthetic p10k fields; exactly six proxies and no footer or message calls | `contract` |
| R05 | Pi tree/reload transitions require exact live generation proof and one-use fencing                                                      | `pi-package.test.mjs` — tree continuity ${variant}: live exact-generation proof, preference and one-use fencing                                            | `contract` |
| R06 | Claude hook accepts exact commands, not prose, prefixes or unsupported operations                                                       | `claude-plugin.test.mjs` — exact command grammar; prose and prefixes pass, unknowns and operation failures stay blocked                                    | `contract` |
| R07 | Jev closure and snapshot assets are packaged in every supported runtime                                                                 | `jev-runtime-package.test.mjs` — derived root Jev runtime closure is selected by every root packaging list                                                 | `contract` |
| R08 | Neutral environment aliases preserve raw-value precedence without importing identity or secrets                                         | `hud-env.test.ts` — E2 raw alias ${neutral}: presence wins without mutation or fallback                                                                    | `contract` |
| R09 | Interrupted activation retains exact generation-bound recovery evidence                                                                 | `runtime-install.test.mjs` — fix3 ${phase} interruption retains exact generation-bound recovery evidence                                                   | `contract` |
| R10 | Unlisted payload files, links, devices and hard links never enter a runtime bundle                                                      | `runtime-package.test.mjs` — unlisted files, links, devices and hard links cannot enter the bundle                                                         | `contract` |
| R11 | Claude MCP child environment never mutates its parent and relocates pinned scripts                                                      | `claude-plugin.test.mjs` — MCP env is child-only; cached relocation with spaces resolves the pinned scripts                                                | `contract` |
| R12 | The non-TypeScript Jev snapshot asset remains selected beside the derived closure                                                       | `jev-runtime-package.test.mjs` — explicit non-TS snapshot asset stays selected beside the derived closure                                                  | `contract` |
| R13 | Runtime installer help/default/preview remain read-only, leaving prefix and home empty                                                  | `runtime-install.test.mjs` — help/default/preview are read-only and launch nothing                                                                         | `contract` |
| R14 | Explicit A-to-B-to-A rollback retains both immutable releases and source bundles                                                        | `runtime-install.test.mjs` — A to B to A rollback preserves both immutable releases and source bundles                                                     | `contract` |
| R15 | Migration previews exactly, copies only allowlisted presentation settings and restores original bytes                                   | `migration.test.ts` — preview is exact/read-only and only allowlisted presentation changes are copied                                                      | `contract` |
| R16 | Statusline preview is read-only; explicit installation preserves unrelated settings and exact restore bytes/mode                        | `statusline-settings.test.ts` — preview read-only; explicit apply preserves other settings and restore returns exact bytes/mode                            | `contract` |
| R17 | Product root help discovers statusline without a ledger and both render aliases agree                                                   | `product-cli-routing.test.ts` — root help discovers statusline without opening a ledger; render aliases agree                                              | `contract` |

### R6b retirement audit (P/T/W)

| ID | User/contract behaviour | One owning test | Layer |
| --- | --- | --- | --- |
| R18 | Drain inspection is read-only; live stamps block and incomplete/unreadable evidence is UNKNOWN, never permission to clean up | `r6b-drain.test.mjs` — audit checks real live, dead and reused process stamps without signals or writes; audit inventory malformed, truncated, unreadable and missing is UNKNOWN and nonzero | `process` |
| F14 | Historical v1/direct Pi receipts remain readable, but mutation and same-key relaunch refuse before writes | `pi-dispatch-facade.test.ts` — PR4 legacy receipts drain read-only; every mutation and relaunch is refused before writes | `contract` |

R6B-1 dead-code exception: external Pi prototype conformance and its fake launcher/dispatcher,
the six disconnected transport experiments with their five tests/demos/four fixtures, and
`scripts/workbench/*` / `tests/workbench/*` retire with their code (architect §2 P/T/W).
They are not current product guarantees. The historical `check-cloud.mjs` runner drops those
selections and the app-server demo selection; default-suite legacy app-server tests remain
until slice L. Product UI `workbench*.test.ts`, WP0 and visual baselines are unchanged.
The mixed role-facade delegate_status compatibility case retires; its Jev schema assertions
remain under “role create accepts judge statements and rejects extra statement fields”.

Owner drain runbook (not run against owner data by this package):

```sh
node scripts/audit-r6b-drain.mjs --slice pi --home "$HUD_HOME"
node scripts/audit-r6b-drain.mjs --slice transports --home "$HUD_HOME"
node scripts/audit-r6b-drain.mjs --slice workbench --home "$HUD_HOME"
node scripts/audit-r6b-drain.mjs --slice runtime --home "$HUD_HOME" --prefix "$HUD_PREFIX" --clients "$R6B_CLIENT_PATHS"
```

Use explicit canonical paths. `--clients` is a comma-separated list of complete client
config paths (a path containing a comma is unprovable here); optional `--inventory` takes
the small process-stamp JSON described in the script header. A stamp is evidence about
that process only, not a complete inventory or proof of pane/tab/browser closure. Confirm
all relevant homes/workspaces and cached clients with the owning release. Every FAIL or
UNKNOWN is nonzero and blocks automated drain approval: resolve it through that release's
inspection, never by asserting `closed`, replaying a stored executable, killing by name,
or deleting old releases. The script deliberately cannot attest complete client scope,
herdr resources, copied fixture children, ledger scopes or browser handles, even when the
readable process/config checks pass. Retain rollback and job-pinned releases. Slice L's
activation/resource checks remain an owner gate, separate from this source-only removal.

### Ledger

| ID  | User/contract behaviour                                                                       | One owning test                                                                                                                                              | Layer      |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| L01 | Private ledger schema, migrations and transactions preserve integrity and refuse unsafe paths | `ledger-write.test.ts` — ledger transaction rollback, callback lifetime and async-callback rejection                                                         | `contract` |
| L02 | Concurrent requests have one complete intent and slot; stale commits cannot win               | `ledger-processes.test.ts` — ledger processes: concurrent identical request keys replay one complete intent and slot                                         | `process`  |
| L03 | Read-only export preserves complete references and never mutates database/WAL bytes           | `hud-link-export.test.ts` — hud consumes producer JSON byte for byte, preserving full refs, scopes, history and path opt-in                                  | `contract` |
| L04 | Historical reconciliation separates exit, outcome, cause, attribution and capacity            | `b21-termination.test.ts` — B21 no attributable accepted report means unknown outcome; native exit fields stay independent                                   | `contract` |
| L05 | MCP owner loss seals dispatch, closes private descriptors and reaps its own child             | `b19-lifetime.test.ts` — B19 real hud-mcp ${mode}: EOF/reparented parent with inherited pipe exits and subreaper reaps it                                    | `process`  |
| L06 | The ledger schema stays byte-identical to the frozen SQL contract                             | `ledger-schema.test.ts` — ledger schema v1 is byte-for-byte the frozen contract SQL block                                                                    | `contract` |
| L07 | Read-only ledger access never creates missing stores or migrates unsupported versions         | `ledger-read.test.ts` — ledger read never creates missing ledgers or migrates uninitialized/newer versions                                                   | `contract` |
| L08 | Run artifacts create private exclusive files and recover without truncating them              | `run-artifacts.test.ts` — run artifacts create private files exclusively and recover read-only without truncation                                            | `contract` |
| L09 | Per-owner/global capacities compose and refusal never leaks a key or slot                     | `b21-capacity.test.ts` — B21 per-owner and global limits compose; same-key replay wins at capacity, refusal has no idempotency/slot leak                     | `contract` |
| L10 | Notification events enforce their strict payload whitelist atomically                         | `b21-notify.test.ts` — B21 events.v1.1 strict whitelist: each new kind accepts valid payload and rejects extra keys, text, enum and stamp defects atomically | `contract` |
| L11 | Private launch policy keeps finite defaults and rejects invalid inputs                        | `b22-policy.test.ts` — B22 policy copies finite A5 defaults and rejects invalid private launch policy                                                        | `contract` |

### hud-mcp

| ID  | User/contract behaviour                                                                                        | One owning test                                                                                                                                                    | Layer      |
| --- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| H01 | MCP tool-call schemas reject target ambiguity, bad bounds, keys and unknown identity arguments                 | `tests/hud-mcp/skeleton.test.ts` — eight MCP schemas, target XOR, numeric bounds, request keys, unknown identity arguments                                         | `contract` |
| H02 | An authenticated exact session root scopes role calls without requiring a legacy ledger                        | `tests/hud-mcp/role-source.test.ts` — ordinary Claude /clear and /resume rebind next calls; inherited env never freezes the caller                                 | `contract` |
| H03 | Native one-shot authority rejects missing, duplicate, wrong-tool, wrong-process and foreign source evidence    | `tests/hud-mcp/native-source-without-ledger.test.ts` — native one-shot evidence still rejects missing-late, duplicates, wrong tool, process, boot and child source | `contract` |
| H04 | Jev tools validate inputs and share runtime job/session identity                                               | `tests/hud-mcp/jev-tools.test.ts` — Jev schemas accept actual API parameters and reject forged ownership                                                           | `contract` |
| H05 | Legacy claim/handshake and resume controls retain their supported compatibility isolation                      | `tests/hud-mcp/handshake.test.ts` — B45 whoami ${transport} claim binds exact independently observed launch and report                                             | `contract` |
| H06 | Stdio framing rejects malformed JSON, ignores notifications and serializes replies                             | `tests/hud-mcp/skeleton.test.ts` — stdio framing rejects malformed JSON, ignores notifications and serializes stub replies                                         | `contract` |
| H07 | Delegate configuration refuses unknown fields, missing sources and incompatible templates/timeouts             | `tests/hud-mcp/skeleton.test.ts` — delegate.json valid load, roles, unknown fields, mutually exclusive templates, missing source and bad timeouts                  | `contract` |
| H08 | Native hook resolution works without a ledger and never consults the poisoned legacy scope reader              | `tests/hud-mcp/native-source-without-ledger.test.ts` — native hook emits no scope and resolves without a ledger, even with a poisoned legacy scope reader          | `contract` |
| H09 | Native transports preserve official turn acknowledgements/results without task adjudication                    | `managed-codex-adapter.test.ts` — native Codex: continuous turns return raw ACKs and native results, no task adjudication                                          | `contract` |
| H10 | Native control persists direct relations without rewriting official payload or read state                      | `managed-core.test.ts` — only direct relations persist; official payload and read state remain unchanged                                                           | `contract` |
| H11 | Native wait timeout or abort never interrupts or closes native work                                            | `managed-core.test.ts` — wait timeout and abort never interrupt or close native work                                                                               | `contract` |
| H12 | Managed capability selection requires exact harness evidence and runtime tuple                                 | `managed-capability.test.ts` — managed capability ${harness} requires its exact evidence and runtime tuple                                                         | `contract` |
| H13 | CLI literal argv and explicit shell forms stay distinct and cannot override resume intent                      | `b11-cli.test.ts` — B11 explicit argv and shell forms are distinct, literal overrides and cannot replace resume                                                    | `pure`     |
| H14 | CLI cancellation stays durably accepted even if its following status refresh fails                             | `b11-cli.test.ts` — B11 cancellation remains durably accepted when the subsequent status refresh fails                                                             | `contract` |
| H15 | Local resume preserves parameters, replays once and rejects stale expected runs or active slots                | `b11-cli.test.ts` — B11 local resume preserves all parameters, rejects stale/active, replays once through B4                                                       | `contract` |
| H16 | CLI help precedes home access and argument validation without a ledger                                         | `b11-cli.test.ts` — B11 ${command} --help succeeds before HUD_HOME access or argument validation without a ledger                                                  | `contract` |
| H17 | Local resume/wait parsing rejects incomplete or ambiguous intents before submission                            | `b11-cli.test.ts` — B11 strict local resume and wait parameters reject incomplete or ambiguous intents                                                             | `pure`     |
| H18 | CLI wait recovers registration races and lost hints through read-only real-ledger state                        | `b11-cli.test.ts` — B11 wait registration race and lost hint recover using the real ledger, without writes                                                         | `contract` |
| H19 | CLI notification draining respects captured high-water, strips bodies and leaves the caller cursor independent | `b11-cli.test.ts` — B11 notify drains multi-page high-water, strips bodies and leaves the caller cursor independent                                                | `contract` |

### Product scenarios

| ID  | User/contract behaviour                                                                   | One owning test                                                                                                                                            | Layer |
| --- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| E01 | Synthetic fixed-role job traverses create/read/send/respond/close through the real facade | `role-facade.test.ts` — create read send respond close against the fake herdr                                                                              | `e2e` |
| E02 | Production panel collection paints the same work snapshot without paint-time publication  | `role-summary.test.ts` — role summary actual collection ${scenario} publishes outside paint and finish disposes handlers                                   | `e2e` |
| E03 | Built pi package loads, reloads and shuts down without owning another extension's UI      | `pi-package.test.mjs` — REAL package entry start -> reload -> shutdown preserves synthetic p10k fields; exactly six proxies and no footer or message calls | `e2e` |

### Performance

| ID  | User/contract behaviour                                                                  | One owning test                                                                                                                         | Layer  |
| --- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Q01 | Quiet/changed/scroll/resize rendering keeps declared host-labelled latency bounds        | `tests/perf/work-card-p2.test.ts` — P2 measured quiet/change/large-history/scroll/resize rendering, three runs on named host; `tests/perf/{workboard,job-progress}.test.ts` own their render timings                       | `perf` |
| Q02 | Large association/history scans remain bounded and fair without deleting durable records | `tests/perf/r5-job-bounds.test.ts` — R5 5000 associations: per-refresh caps, bounded projection, fair cursor continuation, no durable deletion; closed-history workload     | `perf` |
| Q03 | Cold owned launches report distribution and semantic write counts on a named host        | `tests/perf/pi-owned-orchestration.test.ts` — cold fake/real-loader n=20; `tests/perf/pi-dispatch-facade.test.ts` — PR4 cold launch samples; `tests/perf/role-wait.test.ts` — cold RSS              | `perf` |
| Q04 | Delegation projection/rows and selection interaction retain distinct latency budgets     | `tests/perf/{b10b-perf,b10b-s2-perf,b10b-s3-perf}.test.ts` — projection, rows, selection and frame-diff latency; `tests/perf/status-merge.test.ts` — pure merge microbenchmark | `perf` |
| Q05 | Ledger and MCP stress retain declared throughput, checkpoint and latency envelopes       | `tests/perf/{ledger-perf,b12-store,b12d-wal,b6-performance,b18-budgets,b19-drainer,handshake-benchmark}.test.ts` and `tests/perf/b21-process.test.mjs` — ledger, export, WAL and MCP stress; `tests/perf/materials.test.ts` — material build cost                                     | `perf` |

## 4. Shared stand-ins and fixtures

### One fake herdr: `tests/fakes/herdr.mjs`

`herdr-model.mjs` owns the single inventory state machine and exports `createHerdr` and
`herdrState` for in-memory use. `herdr.mjs` supplies the CLI/socket front ends;
`panel-herdr.mjs` and `pi-owned-herdr.mjs` are compatibility adapters. The owned profile's
journal admission and real synthetic worker hooks live in `herdr-owned.mjs`, not in a
second inventory parser. Existing role-facade argv/protocol semantics are retained. Union:

- tab creation/list/get/rename/close and pane split/down/right/get/list/close, stable owned
  IDs, labels, workspace and origin, structured environment and args-json forwarding;
- run/start, type/send/Enter, wait, bounded stdout/stderr, exit/timeout/missing executable,
  command log and exact call counts; caller PATH and metacharacters remain data;
- persisted synthetic state, lost reply before/after effect, malformed/partial/unknown
  inventory, reused IDs or foreign occupants, late registration and replaced generation;
- current command/foreground/session/editor proof, transient shell readiness, stall
  recovery, native TUI eligibility and token registration; explicit clock/barrier controls;
- optional owned synthetic worker launch and process stamps/cleanup, only for process
  owners. An in-memory port uses the same scripted state machine for contract tests;
  retain a thin subprocess adapter for argv/stdio/timeout and lifecycle proofs.

Do not make the fake reproduce real herdr scheduling or infer absence from incomplete
inventory. Each profile rejects unsupported commands; unknown state never becomes idle,
closed or safe to mutate. The owned profile refuses run/rename commands rather than
bypassing journal admission. Role CLI calls serialize their private state file and persist
script consumption even for before-effect failures; a deadline-lost effect keeps its lock
until it settles. A killed lock holder remains unresolved until fixture cleanup, never
silently displaced. Real herdr/tmux probes stay local and separate.

### One fake pi family: `tests/fakes/pi.mjs`

The shared module exports owned-worker and package-host profiles, not one executable
pretending these boundaries are the same protocol. `pi-owned-worker.mjs` and
`fixtures/pi-package-host.mjs` are thin compatibility adapters. R6B-1 removed the dead
external `pi-role.mjs` / `pi-dispatch.mjs` adapters and their shared launcher/dispatch profiles,
including their two protocol-only cases and two prerequisite-refusal rows in the mixed
`test-stand-ins.test.ts`; owned-worker/package-host and all herdr cases remain. Consumer-local API/context stand-ins migrate in their owning
area slices; no consumer assertions are replaced here.
`tests/fakes/pi-package.mjs` is **not a fake protocol**: it re-exports the unchanged real
installed-package and loader discovery as a separate prerequisite; package availability
is never fabricated.

- exact model/effort/role arguments, request and helper contracts, launch acknowledgement,
  private session header and lazy SESSION creation, editor text and one Enter, logs;
- primary/helper STATUS, output_written/artifact, QA timestamps, continuation baselines,
  stale/invalid/unknown snapshots, lost acknowledgements and failed reaping;
- managed worker tools, helper limits/reservations, startup/quit/stall/grace and closed
  verdicts, controlled failure before/after each admitted side effect;
- package SDK event registration, six tool proxies, command routing, UI setStatus/footer
  ownership, other-extension sentinel fields, reload/tree/fork/shutdown and canceled races;
- fake events, clocks, promises and counters without provider/network calls, plus an
  **optional real installed extension-loader adapter** for the pinned worker loader proof.

`pi-owned-loader-worker.mjs` and `pi-package-host.mjs` are real-loader/host fixtures, not
interchangeable fake protocols. Keep their real loader code path. `pi-owned-release.mjs`
and `pi-package-release.mjs` stage release fixtures; the latter builds when invoked, so
reuse already-built bytes once per suite rather than silently building per scenario.

### One temporary HUD home: `tests/fixtures/hud-home.ts`

`hudHome({ env?, files?, after? })` returns a private temporary root, distinct
HOME/HUD_HOME/CODEX_HOME/CLAUDE_CONFIG_DIR, source/session/task/job directories, a bounded
relative-path seed writer and idempotent cleanup. `after` registers cleanup before seeded
effects. Every HERDR_* variable, colour/settings override, live/provider opt-in and
credential variable is removed from the copied child env; no real home, secret or session
is copied. There is no mutable singleton. Domain routing/settings/clock/process builders
remain in their owning slices and can build on this fixture. Cleanup removes only the
fixture root; synthetic process owners must terminate their own children before cleanup.
Share builders and immutable seed bytes, not authority.

Domain capabilities retained by current inline setups (not silently normalized by this builder):
permissions/umask, symlink and FIFO/oversize cases,
atomic replacement and inode pins, private SQLite/WAL, JSONL incremental cursors,
request/receipt/STATUS/QA/report files, role/runtime package staging, fake executables on
isolated PATH, bounded process groups, cancellation/teardown and restore of test mocks.
Retain specialized unsafe-path and process fixtures on top; do not normalize away the
unsafe state under test. The static inventory detects 192 unit/mjs files with `mkdtemp`
at this snapshot; that is a temporary-root indicator, not proof all 192 override HOME.

### Other shared fixtures

- `hud-data`, `b10b-delegation`, `b10b-big`, `work-card-p2`, `workboard`: reuse deterministic
  trees, clocks, semantic Work facts and layout variants. Native and facade evidence
  remain separate; a display fixture is never authority to send a prompt.
- `b17`, `b21`, ledger and run fixtures: preserve real private SQLite transactions and
  signed/stamped reconciliation facts; share constructors, not accepted decisions.
- Jev fake CDP/page fixtures: one scripted CDP boundary and recorded synthetic DOM facts
  for ChatGPT/Studio, lease/record builders and deterministic judgments. Preserve real
  DOM extraction and actual no-second-click fences; do not stub the operation asserted.
- Release fixtures: one immutable prepared closure with per-case private copies for
  corruption/activation. Never edit hard-linked dependencies or working build outputs.
- Visual/WP0 fixture bytes and manifests: read-only. Do not merge generators or regenerate
  baselines in these slices. Historical package-specific fixture names may be adapters
  during migration, but contain no duplicated state machine.

## 5. How to plan a package's tests

1. Find the user/contract behaviour ID above before specifying any new test.
2. Read its owning case and the shared fixture's supported capabilities.
3. Extend that case with a named row for the genuinely new input, boundary or refusal.
4. If the owner is WP0/visual-frozen, record the overlap and ask for an allowed adjacent owner.
5. Add a map row only when no existing behaviour owns the new invariant.
6. Choose the cheapest layer that runs the real code and boundary under assertion.
7. Extend the shared stand-in; never copy it or start a fresh per-package fake.
8. Keep only E01–E03 for product composition; signals/lifecycle need their real-process owner.
9. Put scale/cost/latency distributions in opt-in perf, with a small correctness row left here.
10. Name affected owners, unique-coverage evidence and frozen overlaps in the brief and review.

## 6. Evidence and approval gates for consolidation

The inventory has 400 scoped files: 320 compiled unit, 43 direct mjs, 22 hud-mcp,
4 mutation drivers, 5 performance scripts and 6 MCP benchmark/trace support scripts.
It counts 138,126 lines in that scope (136,315 default-suite lines), not the audit's
broader 173k including other integration/fixture trees. Historical unit timing is 4,493
expanded cases, 1,332.547 summed seconds and 350.680 wall seconds. Static declarations
are not execution counts. The gate failed one P2 timing assertion; these are historical
observations, not a passing current baseline.

Later slices need a Node built-in lcov baseline and before/after per-test unique source
line/branch diff, canonicalized from all emitted trees to source paths. No unique covered
source line or branch may disappear without the orchestrator's explicit dead/display-only
exception. Exact commands, cost, failure handling, proposed savings and immutable overlap
rules are in the external `proposal.md`; no test is removed on title similarity alone.
