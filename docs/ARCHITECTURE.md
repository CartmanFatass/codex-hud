# How codex-hud works

This guide is for anyone changing the code, people and coding agents alike.
It explains how the HUD is put together: which process does what, where the
data comes from, how a frame is drawn, and the rules every change has to keep.
For what the user sees and can configure, read [the reference](./reference.md).
This guide covers the code behind it.

File and symbol names are given without line numbers, which change too often to
be worth keeping. To find one, search for the symbol, or run
`codegraph explore "<symbol>"` if the repo is indexed.

---

## NATIVE-TREE update: one Home, native session lanes

`buildWorkboard` projects every native descendant into one lane per main session beside package lanes. A direct child is a normal card, its child indents two cells, deeper descendants stay flat with `↳ parent`. Native cards use `nativeWorker`, the same `projectWorkCard`/`renderWorkCard` and fixed `currentWorker` lifetimes as HUD jobs (done 10 minutes; failed/stopped 30). `a` reveals expired cards in place without breaking parent/child order. `v` uses `boardInspect` and the thin-job Inspector; `o`/Enter opens its transcript. One resource facts row retains available context %, estimated tokens/s and cumulative tokens spent; no missing value is invented.

Codex collection remains incremental and bounded. `ClaudeNativeTree` reads the selected session's `subagents/agent-*.meta.json` and JSONL: at most 401 directory entries, 200 agents, four changed/replaying agents per refresh (8 KiB metadata and up to 1 MiB transcript each), with stat-signature reuse and a rotating cursor. Transcripts replay forward from byte offsets; unchanged, caught-up transcripts cost no body read, including metadata-only updates. Complete JSONL records retain every public Agent/Task call id, not ordinary tool ids, so old starts still establish nesting after long transcript growth. Split UTF-8/JSONL records carry across passes (up to 4 MiB per record; oversized records are skipped with incomplete coverage). Shrink, inode replacement or a same-size transcript rewrite clears prior evidence and replays from the start. Metadata supplies agent type/description, `finished` and the parent tool-use identity. Replay, unmatched nested parents, deferred/failed reads and capped discovery mark the tree incomplete. Unmatched nested cards are withheld while candidate transcripts are replaying; after replay, still-unmatched cards appear at top level rather than hiding live work indefinitely. There is no watcher or process. pi has no native subagents; its helpers are HUD jobs.

`hud panel` resolves Claude display selection in the caller's CLI before splitting: with `HERDR_PANE_ID` set, `claudeCallerSession` asks `herdr pane current` with a one-second budget. A Claude id-kind UUID locates an existing transcript under the configured Claude projects directory, trying the cwd slug (`/` and `.` become `-`) then at most 256 immediate entries without recursion. Explicit selection wins; unavailable evidence retains the unbound jobs view. The CLI carries the selected source/harness into the panel. The statusline writes no binding, and no pane-keyed file is read or written. Native lanes conservatively keep base cadence: job-only backoff still requires `nativeCalls.emptyAndComplete` and positively empty native trees; active/incomplete native evidence never authorizes 5-second quiet polling.

Claude completion is provisional: growth after a completed transcript reopens it as running, clearing its settlement time. A fresh metadata signature with `finished: true` or, after catch-up, the last public assistant `message.stop_reason: end_turn` with no unmatched tool calls settles it again. Open tool ids and the last public stop survive bounded read steps; private records cannot settle an agent. Partial/replaying transcripts project unknown, not a premature final. Settlements from transcript evidence retain their own timestamp across warm and metadata-unchanged reads. The last public reply retains at most 8,000 head/tail characters for final-result input (the report input remains 600); it requires no second tail read. A new settlement is eligible for one fresh successful final sentence under the existing per-agent floor and shared cap; unchanged settlements remain frozen.

`JobSentences` now owns native names and current/result/cause sentences too, using the same master/key/language gates, per-agent two-minute floor, three pending handles and `SmallModel` queue/cap/cache. It reuses `ModelJobs`' public material reducers (`labelSource`, `finalAnswer`, `errorMaterial`, `headTail`), not its old schedulers. Native input is bounded collected public task/charge (400), name/role (80 each), report (600), action (200), final result (8,000 head/tail) and error output (2,000); a settled Codex agent can read one safe 32 KiB tail. The response carries a short name and one keyword-marked sentence, stored with job sentences; output never changes lifecycle/activity evidence. Existing caches/logs are not deleted.

Deleted: the old Agents layout, its control bar/cards/Inspector histories and session-switch controls, `AgentLog`, `ProgressSummarizer`, separate `ModelJobs` scheduling, and `card-visibility`. Settings `agentLog`, `cardLabel`, `cardSummary`, `agentsPane` and other old card-only preferences load as ignored keys and disappear on save. All `renderMonitor` callers now use the workboard frame; without a sidecar the native tree is projected into Home. This update supersedes the historical renderer/model descriptions below.

## R5UX-P1 update: passive Home and Work

> **ONE-PAGE / M4 update: Home and Work are merged into Home; Project is the second tab.** This section supersedes the older stacked-monitor description of
the panel's job and agent panes wherever the two disagree: §4.5, §6.2 and the `renderMonitor` note under
"Off the live path". Those passages remain as the historical and secondary renderer description, not as the live
behaviour.

The panel's live path is one passive pipeline: `TaskObservationCollector` reads task artifacts, `buildWorkboard`
(`collectors/workboard.ts`) turns them into a `WorkboardSnapshot` (`workboard-types.ts`), and Home (`render/home-view.ts`, viewport `render/work-view.ts`, shared rows in `render/workboard-rows.ts`) renders it.
`tree-page.ts` builds the snapshot in `PanelJobPipeline.workboard` and always passes an explicit
`MonitorData.workboard` to `renderMonitor`, in standalone and embedded mode alike. There is no second, implicit
source for those tabs.

**What is read.** `TaskObservationCollector` (`collectors/task-observations.ts`) lists only the immediate
`tmp/tasks` children of the workspace it was explicitly bound to (`CODEX_HUD_CWD` / the selected workspace). It
never joins a facade job to a task directory by cwd or name, and facade jobs and task lanes stay separate
invocation lanes. With no bound workspace it reports the `workspace_not_bound` coverage diagnostic and crawls
nothing. A source list is capped at 200 entries; beyond that the lane reports `lane_capacity` rather than growing.

**Read-only.** The new task/artifact observation modules import no execution path: no watchers, no writes, no model calls, no
execution or Herdr imports. Existing job observation retains its existing bounded liveness sampler. Symlinked, FIFO, escaping or replaced-ancestor paths are refused.

**Budgets.** Collection is bounded at every level, and the whole pipeline shares one allowance:

| Bound | Value |
|---|---|
| Resident task/invocation sources | 200 total |
| QA pairs per source | 100 |
| Resident artifact metadata / text | 2048 / 2 MiB |
| Pipeline files / bytes / directory entries | 32 / 1 MiB / 128 (`JOB_BOUNDS`) |
| One artifact slice | 8 files, 256 KiB, 64 metadata probes, 10 ms |
| Per-file read caps | `STATUS.json` 64 KiB, answers 16 KiB, `qa/*` 64 KiB, other artifacts 32 KiB |

**Cost of a warm refresh.** Membership is cached by stat signature and cursors are persistent and round-robin. An
unchanged warm scan does zero body reads, zero directory enumeration and zero re-parses. A retained failure is shown
as stale, not as a fresh fact. QA reductions are cached per coherent dependency pair; a bounded persistent pair cursor
validates only changed/pending pairs. Pending membership, initial file reads and pair reductions persist across all
retained sources, independently of which source got a turn; ordinary warm signature rotation is not pending work.
Switching the root or disposing the pipeline resets the cached state.

**Timestamps stay honest.** Source and decision timestamps keep the basis they were read with: file mtime for
observed files, the producer's own stamp where a producer wrote one. No deadline, queue position or merge fact is
invented when the files do not state it; unknown phase or order is shown as unknown.

**Thin jobs on Home.** `collectors/thin-jobs.ts` (`readThinJobs`, newest 20 in scope) gives each job directory
under `$HUD_HOME/jobs` one lane with one worker and its answered questions as decisions; `PanelJobPipeline.workboard`
prepends them to the lanes, workers and decisions. Only files the thin layer and pi-roles write are read: `job.json`
(role, cwd, `created_at`), `brief.md` (task = its first heading, else its first line), `STATUS.json` (state, model,
`thinking`, `started_at`, `settled_at`/`ended_at`), `qa/qN.md` and `qN.answer.md` (through `answerRecord`, so `≠` and
`instead:` appear only when the answer is a different option from the worker's `Default if unanswered`). Unchanged
files cost one `lstat` per refresh. States are shown as the owner's words: `working` (also `waiting_*` and no STATUS),
`idle` (`idle_grace`), `done` (`closed`) and `failed` (also a non-zero `dispatch_exit_code` with no STATUS). A job
that is working and has an unanswered question is **need you** (the question's first line, minutes since it was
asked); a question left on a finished job was settled by its default and is not shown. Jobs group by their display-only package labels. Fixed lifetimes live together in `render/work-visibility.ts`: running/asking jobs stay; done jobs hide after 10 minutes, failed/stopped jobs after 30 minutes. Decisions hide after 30 minutes, departures after 2 hours. There are no lifetime settings.

**Home display and keys** (`render/workboard-input.ts`). The top band is titled Home with the asking count when there are questions, and the models on/off word on the right, which a click or `b` toggles. Rows are needs-you question cards (or `✓ Nothing needs you · N running`), package lanes with cards, then current **Decided for you** rows. Lanes require visible jobs, the decisions section requires visible decisions. `+N older · a` names hidden items (translated); while they are shown it reads `N older shown · a hide`. `a` toggles them in place, newest first: older items are wholly muted, bandless one-row titles with no older prefix, and a lane whose jobs are all old has a muted header too. It uses `tree.showAll`; there is no History tab. The scan bounds the data to its newest 200 jobs.
Enter/click toggles cards and decisions through `boardExpanded`, and lane headers through `boardFolded`. Home selects `boardNewest` from shown cards by max(activity, settlement), with start as the activity fallback and stable input order breaking ties. This one job or native card defaults expanded; the others default folded. `boardToggled` records owner choices for the panel lifetime, so a later newest card cannot overwrite an explicit fold/open. The separate question slab and decisions stay folded by default. These fields are display-only, not saved. Expanded cards retain complete model sentences, keywords and factual detail; expanded questions retain context/options, and decisions retain question/alternative.
`1` returns Home; `2` opens Project; Left/Right and Tab/Shift-Tab switch Home ⇄ Project. `3` opens the repository/worktree Changes summary. Up/Down move, `n`/`N` select trouble without leaving Home, `o` opens job files and `v` inspects. Footer: `↑↓ move  ⏎ expand  o open  v inspect  a all  , settings  ? help  ←→ tab` (whole hints drop from the right when narrow). Help lists both tabs and Changes. The top-row models word and `b` toggle the model master switch; `S` is removed.
There is no Work tab, target, scroll, control or row path; only `homeTarget`/`homeScroll` remain. The Inspector and retained secondary views keep their own focus/scroll.

**Facade closure.** The additive facade closure is separate from the Pi dispatcher closure. Helpers are not owners:
a helper's records never become a task's or a job's authority.

**The retired secondary renderer.** `renderMonitor` keeps its no-sidecar path to the stacked secondary layout for
legacy, secondary and fixture callers only (owner ruling q4). Production always supplies the workboard sidecar, so
the live panel never reaches this path. It keeps its secondary chrome and keys, without the removed status foot, and its cards are the same
compact work card the live pages draw — no old rich-card body, no second card renderer and no flag that brings the
old content back. It gets no new features; its removal is scheduled after P2.

**Scope of P2 / ONE-PAGE.** Home draws the approved lanes and compact work cards through the shared lane/card renderer. The four active card states, their precedence, the stall threshold and the
facade-close rule are presentation only: execution status, wait semantics, acceptance and sources are unchanged. The
snapshot publisher remains. CLEANUP-VIEWS removes Timeline, activity/history and diagnostic pages and their producers; Changes remains as repository/worktree summary only (owner correction). Model generation now follows §5;
no recap, overview or facade-only sentence generator is wired into this pipeline.

## Owned pi workers (PIROLE PR3; not selected for new jobs until PR4)

`integrations/pi/worker.ts` composes only `harness/pi/role-extension`. It does not load the ordinary HUD package,
register the general facade tools, open a panel, or install a footer. Herdr's separately loaded reporter owns only
Herdr state. Worker resources, helpers and the finite reaper are pinned to A1's manifest digest. The worker and
reaper derive that inventory from their own release-relative modules and verify the staged bundle; source-checkout
execution fails closed. Task-serialized hashes are never an inventory trust root.

Private job layout (`J = $HUD_HOME/jobs/<id>`, directories 0700, files 0600):

- `brief.md`, `report.md`, `impl-notes.md`, `checks/<name>.log`, `SESSION.txt`, `STATUS.json`, `sessions/`, `qa/qN{,.answer}.md`;
- `.dispatch/runtime.json`: launcher-authored, write-once under resource admission before agent start; only the
  endpoint/process stamp and caller-tab protection, never secrets or model arguments. Helpers and the reaper load
  this same bounded binding and verify the endpoint; no environment fallback;
- `.dispatch/<slot>/{contract,launch,owner}.json`, each helper's `STATUS.json`, and the single helper reservation
  `.dispatch/current.json`; a helper reviewer's sonic has a child reservation under its review slot.

The actual model, effort, session and role file must match before startup evidence permits a first prompt. Pi 1.5.0
persists new sessions lazily: the worker records the native header's type/id/cwd without writing a native session.
Before prompt submission only, an absent exact session file is accepted with that header, process argv and exact
Herdr session reference. A specifically stalled first prompt may use the same header plus complete editor evidence
for one journalled Enter; acknowledgment then requires that exact prompt in the exact persisted session. Unknown,
unreadable or mismatched evidence never authorizes Enter or another start.

Only `agent_settled`, deferred and generation/idle/queue/helper/QA/output guarded, completes a run. `agent_end`
may precede a retry. STATUS v1 is single-writer and semantic-change-only. Successful implementers publish DONE in
fixed cache-TTL grace (unknown TTL zero); continuation cancels the old timer, model TTL can shorten but never extend
it, and warming never renews it. Clean one-shots and **unused successful implementer grace expiry** are eligible for
one finite detached post-exit reaper attempt. Implementer expiry uses `idle_grace_expired`; quit/shutdown in grace,
failure, a used continuation and `HUD_KEEP_TAB=1` keep the tab. Normal reap remains the only tab cleanup authority;
automatic and explicit close are idempotent, and helpers never close the parent's tab.

Every non-sonic role can call blocking sonic; only the implementer can call the fresh closing reviewer. Sonic has
no helper tools. Calls share numbering and limits (10 sonic, 3 reviews, failed reservations count). Implementer
helpers use the recorded right pane. Other callers split down from their own pane in the owned tab; split intent
lives in the nested journal before dispatch, a lost reply remains unresolved, and cleanup/reap covers the pane.
A helper reviewer's sonic borrows its held reservation with a child mutex, never the job mutex or right pane.
When that reviewer ends, its reserved child is cleaned first using the same remaining cleanup budget. An unknown
child outcome keeps the outer reservation held and returns `helper_unresolved` with the child slot; only explicit
reap may resolve the remaining resources, and neither helper kind can allocate another slot.
Read-only callers pass a report-only write grant, with inherited QA/scratch exceptions; the guard is not a sandbox.

QA uses exclusive q1–q9999 allocation across slots, bounded answer reads, a 2-second abortable cadence only while
outstanding, and the inherited 1200-second deadline. Timeout records “default instructed”, never “default acted on”.
Check logs end in `exit=<code>`; reviewers never rerun full suites. Round 1 reports missing/failing/stale full-suite
evidence as a finding; round 2+ notes expected stale full-suite logs after fixes without rerunning them. Reviewers
rerun missing/failing/stale focused checks and run the round's focused tests (plus earlier-finding regressions on
re-checks). The main session still owns the full acceptance gate and chaining.

## Project tab (M4)

`ProjectCollector` (`collectors/project-board.ts`, separate from the bar's existing `project.ts`)
collects full facts only when `projectShown` says Project is the visible main page, with no modal. On Home,
`collect('home', …)` returns after the same cached STATE/ticket reads, before spec, roles, keys, custom agents,
git and job scans. The panel disables `HudStatus`'s legacy bar git refresh; Project and Changes own their
on-demand git probes. `tree-page.ts` retains the snapshot and passes `MonitorData.project` into the pure `render/project-view.ts` rows and
shared `renderWorkboardFrame` viewport. Project has separate cursor/scroll/fold state; Control plane
and native agents start folded. File rows emit `open-files`, the generalised former `job-files` action;
the existing `openEditorPane` opens `$EDITOR` (default vim) in a focused herdr tab in the panel's workspace,
closing it on editor exit; a failed workspace lookup falls back to a right-hand split.

Sources: STATE.md's `## Waiting for the owner`, `## Next`, `## Slices`, `## Now (...)` heading and
`Milestone:` line (docs/handoff first, root fallback), docs/spec.md, up to twelve review candidates,
current-tree working thin jobs from the
existing workboard, role assignments, convention and instruction files, and native Claude/Codex agent
files. `roles/roster.ts` is extracted from the thin MCP's registry: `hud_roster` and Project use the
same role validation/override/assignment/convention logic without starting the MCP. Project supplies
cached, bounded readers; the MCP keeps its original reader semantics. Missing milestone means no spec
row. The local to-tickets adapter supplies Tickets after Progress (see below).

**Progress** sits between Waiting for you and Working tree. STATE's mtime dates the header; the Now heading
supplies the summary. The Slices ledger (`- state · milestone · ID · description (optional commit)`) counts only
working/blocked/try/todo/accepted/dropped; comments and unknown states do not count. A cumulative-rounded,
full-width stacked bar uses the six theme roles, and its wrapped legend retains zero counts. Milestone chips
come from the top-level bold `M…` bullets in spec §5; the first token of STATE's Milestone line selects the current
chip, otherwise all ids stay unmarked. Summary and chips open STATE.md.

Working/blocked ledger entries and linked worktrees become slice blocks, matched by worktree basename. The
collector joins the newest job by canonical cwd, considering only the newest 64 job directories by mtime;
only job.json/STATUS.json bodies are read (64 KiB each), through the existing signature cache. Directory names
are cached, directory mtimes are ranked, and report/brief paths are metadata-only checks. File bodies outside
those 64 jobs are not loaded for this lookup. The existing main-checkout editing rows remain unchanged.
`projectRows` gets the overlaid **unfiltered** workboard from `renderWorkboardFrame`, so it reuses Home's actual
worker/card detail and model sentence (including shared keyword painting/word cutting) without new collection
or model requests, even for a job Home hides. The master switch controls the model overlay. A slice opens its
report, else brief, else STATE; no job means just its first row. Next shows up to four joined bullets and a
remainder count. The latest commit remains under Working tree, since there is no landed-commit list.

Drift is display-only: a working ledger entry without a linked worktree (not blocked), an unlisted worktree,
or a worktree with a non-active ledger state gets an attention `!` and reason. The Progress header counts marks;
no ledger, job or worktree is modified. All Progress rows use the existing Project fold/file actions.

**Tickets** uses only `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, as published by Matt's local-file
`to-tickets` skill; no GitHub/Linear API is used. Discovery takes at most 16 feature names and 64 ticket
files per feature, using the same bounded directory/signature cache and 64 KiB reader. Oversized or malformed
tickets are skipped. Each file needs `# <NN>: <title>` (number matching the filename), `**Blocked by:**`
and nonempty `**Status:**` lines. `**What to build:**` is prose, not state. Acceptance counts come from
`- [ ]` / `- [x]` (also uppercase X) checkboxes. Status done/closed/complete is case-insensitive; otherwise
at least one box with all checked means done. Dependencies resolve within the feature, by number first,
else case-insensitive title; comma/semicolon/`and` lists and `None (can start immediately)` are supported.
Any unfinished or unresolved dependency blocks an unfinished ticket; otherwise it is ready. Unknown status
words remain dim beside that derived state. A completed ticket stays done even if it names a blocker.

Features sort by their newest valid ticket mtime, tickets by number; completed features start folded. Their
existing Project fold keys toggle that default, with no saved setting or render-time state mutation. Ticket
rows use the existing `open-files` action. Counts stay right-aligned; linked-job text drops below 64 columns.
The newest-64 job loop above also matches an exact `job.package` to the feature and a filename or standalone
`<NN>` token in task/brief-path/collected task text or the job's bounded `brief.md`. Only matching-package
candidates read a brief body; without tickets the progress-board lookup remains metadata-only. The newest
matching job by `created_at` supplies role, recorded STATUS state and age (settlement, else start/creation).
This is a display join, never ticket completion evidence. It adds no job-directory scan, git probe, model
call or write. Nothing is drawn when there are no valid local tickets; the existing `projectShown` gate
prevents full ticket/job collection behind a modal; Home reads tickets without the job overlay.

**Home spare rows** use `homeProgressRows` from the same Project row kit and `progressBarRows`/`progressSegments`.
`renderWorkboardFrame` first builds all question, job/native card, decision, older-item and notice rows, then
budgets the compact block against `height - 2 - rows.length` (not the scroll window). It appends summary,
current milestone and bar only with at least three spare rows; the shared legend gets space before feature
counts/open tickets. Tickets shrink first, then the legend drops, then the block disappears. No slice-in-flight
rows are copied. Non-card selection reuses `boardAnchor`; Enter/click routes to Project's progress or feature
fold row and unfolds the destination. A resize removing the block clears its anchor, preserving card navigation.

Files and directory membership use stat-signature caches, reads stop at 64 KiB, directory discovery
stops at 128 names per source (job directory membership is enumerated to rank the newest 64), and obsolete
cache entries are pruned. Git status, last commit and `worktree list --porcelain -z` share one five-second gate
using `worktreeGit` and its
filter neutralisation, at most every five seconds; failure is unknown, not a fabricated clean tree.
Credentials are reduced immediately to name/presence booleans (empty RHS is absent), never cached as
text or exposed as openable files. Known provider names match the credential loader (Mistral, OpenAI,
Gemini, TypeSafe); other declared names are included. Browser setup is only a cheap `jev-runtime/runtime.json`
file check, not a live-health claim. This collector makes no model requests, starts nothing and writes nothing.

## 1. The mental model in one screen

codex-hud wraps the OpenAI Codex CLI in a tmux session. Codex runs unchanged in
one pane. The HUD runs next to it, in one of two forms, and only reads what
Codex writes to disk.

```
 F12 opens (panel)                             Default (bar)
 +-------------------------+----------+        +-----------------------------------+
 | %main: shell -> codex   | %tree    |        | %main: shell -> codex             |
 |                         | node     |        |                                   |
 |                         | dist/    |        +-----------------------------------+
 |                         | tree-    |        | %hud: node dist/index.js (1 line) |
 |                         | page.js  |        +-----------------------------------+
 +-------------------------+----------+
   panel is 48 cols by default; Codex keeps >= 41 columns
```

| | The bar | The panel |
|---|---|---|
| Entry | `src/index.ts` | `src/tree-page.ts` |
| Size | 1 line (`HUD_PANE_HEIGHT`) | a column, usually 32–56 wide, 48 unless a width is asked for |
| Loop | 1 s tick + chokidar watchers | `settings.refreshMs` collect (default 1 s), no watcher |
| Renders with | `render/header.ts` → `layout/` engine | `render/monitor.ts` `renderMonitor` |
| Writes | `display/state/<session>.json` snapshot, notifications | the same snapshot and notifications, on its collect tick; scan cache, agent logs, model cache, settings |

At any time **only one of the two is running**. The launcher starts with the compact bar, never the panel.
`codex-hud-toggle` (F12) swaps one for the other; `/hud` also opens the panel. The two processes never talk to each other directly. They share state
through tmux user options (`@codex_hud_*`), the snapshot file whichever of them is running wrote, and files
under `$HUD_HOME/display/`.

Data flows one way:

```
 $CODEX_HOME (written by Codex)                codex-hud
 ─────────────────────────────                 ─────────
 logs_2.sqlite ─┐
 shell_snapshots├─► SessionFinder ─► RolloutParser ─► HudStatus ─► HudData ─► bar / panel facts
 sessions/*.jsonl┘                                           
 sessions/*.jsonl ─► buildSubagentTree ─► SubagentTree ─┬─► AgentLog.observe ─► agent log
                                                         ├─► readAgentTokens (context %, tok/s)
                                                         ├─► ModelJobs / ProgressSummarizer (optional LLM)
                                                         └─► renderMonitor ─► panel frame
 git worktrees ─► WorktreeCollector ─► Changes summary
```

Collection does all the I/O. Rendering is pure: given the same data, `nowMs`
and settings, it returns the same lines.

---

## 2. Repository map

```
bin/                 bash launcher and tmux helper scripts (+ Windows .ps1 wrappers)
src/index.ts         the bar process
src/tree-page.ts     the panel process (collect → render → paint, input routing)
src/types.ts         shared types: HudData, SubagentTree(Node), RolloutState …
src/settings.ts      HudSettings: defaults, validation, load/save of hud-settings.json
src/settings-runtime.ts  applies settings + env to the display config
src/snapshot.ts      machine-readable snapshot (codex-hud --json); bar or panel
src/notify.ts        tmux / desktop notifications (bar or panel)
src/collectors/brief-dry-run.ts  removal notice for `codex-hud brief --dry-run`
src/collectors/      everything that reads disk, sqlite, git, or calls a model
src/render/          pure rendering: bar modules, panel panes, cards, theme, i18n
src/utils/           tmux input, key forwarding, session navigation, profiling …
tests/unit/          node:test suites (*.test.ts compiled; *.mjs run against dist/)
tests/fixtures/      synthetic HudData builders, recorded rollouts, README demo scenes
tests/integration/   tmux shell suites (tests/run-integration.sh)
docs/                reference (EN/ZH), fixed issues, reviews, this file
```

### Off the live path

These files are not used by either running process. Before deleting one,
check that no test uses it.

| File | Status |
|---|---|
| `render/workbench.ts`, `render/subagent-tree-view.ts`, `render/sparkline.ts` | The old panel renderer. Only tests import them (`workbench.test`, `panel.test`, `resources.test`, `subagent-status.test`, `test-subagent-tree.mjs`). |
| `render/lines/*` | The old multi-line bar. Live code uses only `formatTokenCount` (from `lines/activity-line.ts`). A few `.mjs` tests import the line renderers. |
| `src/test-render.ts` | A standalone mock renderer that nothing runs. `npm run test:render` runs `dist/index.js`. |
| `bin/codex-hud-tree` | Runs `dist/tree-page.js`. Its comment says tmux display-popup uses it, but nothing in the repo calls it. |
| `dist/utils/tmux-copy.js` | A stale build output with no source file. `tsc` never cleans `dist/`. |

---

## 3. Launch and the tmux session

### `bin/codex-hud`, step by step

1. **Early flags.**
   - `--help`, `--self-check`, `--list`.
   - `--kill` kills every session for this directory.
   - `--json` prints `$HUD_HOME/display/state/<session>.json`.
   - `brief --dry-run` reports that periodic briefs and recaps were removed.
2. **Session identity.**
   - The prefix is `codex-hud-<md5(PWD \0 realpath CODEX_HOME)[:8]>`.
   - A session is named `<prefix>-<YYYYmmddHHMMSS>-<pid>`.
   - `--attach` and `--new-session` are consumed. Every other argument goes to Codex.
3. **Dependencies and build.**
   - Needs tmux and node. It refuses if `codex` resolves to the wrapper itself.
   - Runs `npm install` if `node_modules` is missing.
   - Runs `npm run build` if `dist/` is missing or any `src/**/*.ts` is newer than `dist/index.js`.
4. **Reuse.** By default it starts a new session. It attaches to the newest
   matching session only with `--attach` or `CODEX_HUD_AUTO_ATTACH=1`.
5. **`create_session`.**
   - Runs `tmux new-session -d` with mouse on, `escape-time 0`, `status off`
     and `allow-passthrough on`.
   - Sets `CODEX_HOME` with session scope only, never `-g`.
   - Starts Codex with `send-keys` in the first pane:
     `cd <cwd> && CODEX_HOME=… codex <args>; tmux kill-session`. When Codex
     exits, the session goes with it.
   - Saves the bar's full command line in `@codex_hud_hud_cmd`, so the toggle
     can recreate the bar later.
   - Installs the input policy (§7).
   - Starts with the compact bar; the panel opens explicitly with F12 or `/hud`.
6. **Attach and cleanup.** An `EXIT` trap kills the session only if this run created it.
   In Herdr, `attach_session` marks only the outer foreground attach process
   with `HERDR_AGENT=codex` and relays the designated main pane's OSC title
   using session-scoped tmux options. Herdr's native detector handles status
   and notifications while retaining its native Codex session identity.
   `bin/codex-hud-herdr.mjs` is a read-only observer: it compares the main pane
   against `pane.get` and records transport failures or state mismatches.
   A successful API response alone is not proof that a lifecycle report applied.
   The observer is independent of the replaceable bar/panel, never clears native
   state on detach, and does not modify global tmux options. Deferred session
   creation starts no observer. `CODEX_HUD_HERDR_BRIDGE=0` disables this integration. See
   [Herdr context and status bridging](./herdr-context-fix.md).

The bar and panel get their context from environment variables:
`CODEX_HOME`, `CODEX_HUD_CWD`, `CODEX_HUD_MAIN_PANE` (Codex's pane id),
`CODEX_HUD_SESSION_START`, `CODEX_HUD_TMUX_SESSION`, `CODEX_HUD_TOGGLE_CMD` and
`CODEX_HUD_TREE_WIDTH`.

### Other scripts in `bin/`

| Script | Job |
|---|---|
| `codex-hud-toggle` | Swaps bar and panel under a `tmux wait-for -L` lock. The new pane is created and checked alive before the old one is killed. Flags: `--ensure-single` (the panel exited, bring the bar back), `--focus-tree`, `--click X` (bar click, resolved through the snapshot), `--command NAME`. |
| `codex-hud-keys` | Installs the prefix key and rebuilds the shared `codex-hud-prefix` key table. |
| `codex-hud-command` | Sends a panel command as `ESC _ codex-hud:<cmd> ESC \` into the panel pane's input. Opens the panel first if a command needs it. |
| `codex-hud-paste` | Pastes from the system clipboard, falling back to the tmux buffer. |
| `codex-hud-resize` | Keeps the bar's height through window resizes. |
| `codex-hud-fonts` | Install MesloLGS NF. |
| `install.sh`, `uninstall.sh` | Write and remove the marked `# codex-hud alias` lines in shell rc files. |
| `*.ps1`, `bin/windows/` | Windows: route to WSL Ubuntu, install, and set up profile shims. |

### tmux user options

These are the only state the scripts share:

- **Panes and mode:** `@codex_hud_main_pane`, `@codex_hud_pane` (the bar), `@codex_hud_tree_pane`, `@codex_hud_mode` (`single` or `tree`).
- **Recreating the bar:** `@codex_hud_hud_cmd`, `@codex_hud_session_start`, `@codex_hud_statusline`.
- **Bar height:** `@codex_hud_height*`, `@codex_hud_auto`, `@codex_hud_focus_main`.
- **Context:** `@codex_hud_cwd`, `@codex_hud_codex_home`.
- **Global:** `@codex_hud_prefix_key`.

---

## 4. Collecting data

### 4.1 Finding the session (`collectors/session-finder.ts`)

`SessionFinder` decides which rollout file is "this Codex". It tries three
sources, in order:

1. **Daemon binding** (`collectors/daemon-binding.ts`). Since Codex 0.159, one
   daemon writes every rollout. The finder follows Codex's tmux pane
   (`CODEX_HUD_MAIN_PANE`):
   1. the pane's pid;
   2. the `codex` child process in `/proc`;
   3. its connection in `$CODEX_HOME/logs_2.sqlite`;
   4. the latest thread start, resume or fork on that connection.

   This is the only source that sees `/resume`. It needs `node:sqlite`
   (Node 22 or later), reads only, and fails quietly. The thread found is
   mapped to its root with `rootThreadOf`.
   Timing is anchored only by explicit `codex_tui::app::startup` rows:
   retained activity after startup logs are pruned cannot identify a connection.
   Every ten seconds the binding rechecks the pane's PID and process start time;
   a replacement or reused PID clears the connection, log cursor and thread.
2. **Shell snapshot scan.** Looks for files named
   `shell_snapshots/<threadId>.<nanos>.<ext>` created after launch (with 15 s
   of slack) from the same tmux server.
3. **Fallback scan.** Root rollouts under `sessions/` for this cwd: today and
   yesterday first, then the last 30 days, bounded by `CODEX_HUD_SESSION_START`.

> With the 0.159 daemon, the `TMUX_PANE` in a shell snapshot is the daemon's
> pane, not Codex's. Never bind a session to a pane from that value.

### 4.2 Parsing the rollout (`collectors/rollout.ts`)

A rollout is JSONL, one record per line. The record types used:

- `session_meta` and `turn_context`;
- `response_item`;
- `event_msg`, whose payload types include: task and turn started and
  complete, `token_count` (usage and `rate_limits`), `plan_update`,
  `context_compacted`, `item_completed`, approvals and goals.

`parseRolloutFile` reads incrementally:

- **Byte-exact offsets.** Offsets survive CRLF and a missing final newline
  (issues 008 and 009). Never count characters.
- **Truncation and rotation.** A shrunk file or a changed inode resets the parse (issue 004).
- **Bounded memory.** Each read takes a bounded snapshot, and buffers are capped.
- **Approvals from evidence.** Pending approvals are inferred from the records, not assumed.

`RolloutParser` keeps the parse state between reads and merges each new batch
into it. A tool call that completes in a later batch is still matched
(issue 003). `generation` and `needsReplay` signal a full re-read.

Parses go through `utils/parse-queue.ts`, which runs one parse at a time per
file (issue 002). `utils/file-signature.ts` (size, mtime, inode) gates whether
a file is read at all.

### 4.3 From the rollout to `HudData` (`collectors/hud-status.ts`)

`HudStatus.buildNow` merges these into one `HudData` (`types.ts`):

- the parsed rollout;
- `codex-config.ts` (`config.toml`, re-read every 30 s in the panel);
- `project.ts` and `git.ts` (`git status --porcelain=v2`, cached, refreshed
  every 3 s and kept off the frame path);
- `codex-goal.ts` (`goals_1.sqlite`);
- `context-usage.ts` (`BASELINE_TOKENS` = 12000);
- `token-rate.ts`: a turn-level wallclock proxy, with TTFT/stalls included and
  the union of known tool waits excluded; not exact per-request telemetry.
  `observeTokenRateRecord` feeds identical evidence to the main parser and the
  agent tail reader. There is no rolling window, smoothing or speed cap; unchanged
  cumulative counters do not refresh a measurement;
- `quota-forecast.ts` (a least-squares fit of the usage window).

The bar renders `HudData`; the panel retains its facts for notices and snapshots. The panel passes the tree it already built into `HudStatus.build`, so that build does not scan the rollouts again. A git refresh calls `onChange` only when the status itself changed.

### 4.4 The agent tree (`collectors/subagent-tree.ts`)

`buildSubagentTree` scans at least the last three days, extending back to the
current root's creation directory. If its rollout is missing, known child
rollouts determine the older boundary. This also works after a HUD restart,
without an existing in-memory tree. Priority paths remain eligible outside
the date window. For each rollout it
reads only the first line, up to 1 MB. From those lines it builds a parent
map and the tree under the current root thread. The panel lists those files
with `findRolloutsInDaysYielding` and passes the list in: that path stats new
files, files that grew, the main rollout and the current tree's rollouts,
and two quiet files a tick. `findRolloutsInDays`, used by the bar and by tests, stats every file
and does not read or write that cache. An empty list means do not scan.

**Vocabulary.** Every view uses the same counts, from `agentCounts`:

| Term | Meaning |
|---|---|
| L1 agent | depth 1, an agent the main session started |
| subtask | an L1's descendant, at any depth |
| review | a nickname-less "guardian" thread Codex starts to review approvals; `ThreadKind` `review` |

Iterate with `eachThread`. Do not walk the tree by hand.

**Other parts:**

- `resolveStatus` turns rollout evidence into running, completed, failed and so on.
- `agent-stages.ts` builds each L1's stages: intent, result and peer messages.
  It reads plaintext message headers and uses each `task_complete` answer as a
  stage result.
- **Scan cache.** `tree-scan-store.ts` keeps per-rollout results in
  `$HUD_HOME/display/scan/`, so a restart does not rescan everything. When
  anything the scan reads changes, bump `SCAN_VERSION`. Otherwise stale cache
  entries survive the upgrade.

### 4.5 Read-only role jobs in the panel (R5)

*Superseded where it disagrees with [R5UX-P1 update: passive Home and Work](#r5ux-p1-update-passive-home-and-work);
kept as the historical/secondary description.*

The panel alone owns `JobObservationCollector` and `PanelJobPipeline` (`tree-page.ts`).
Each refresh reads bounded association/receipt/STATUS, helper/QA and external-registration
files under `$HUD_HOME` (default `~/.hud`), separately from the original Codex cache home.
Collection shares the panel deadline/byte allowance and charges its bytes, entries/files and
elapsed time to panel accounting. Painting only uses the retained snapshot. Herdr evidence
is a bounded, single-flight `herdr agent list --json`, at most every five seconds; Jev
liveness uses runtime.json plus PID/cmdline evidence, never runtime IPC or startup.

`composeJobTree` enriches an exact complete-ref native match without replacing its native
id, rollout, evidence or production summary path. Otherwise it adds `role-job:<job>`,
dispatch-helper or explicitly registered external nodes. The same pure composition runs
after legacy publication, from the original native tree, so duplicates cannot reappear.
Mixed legacy rows retain their renderer/actions; ordinary rows share one Agents pane and
selection. Job/helper/external and metadata-root ids are fenced at action dispatch.

An embedded panel shows only the bound exact source/session root. Standalone `hud panel`
retains all-delegations mode; `hud panel --root <namespace/session-id>` selects observations
only, not control identity. All-roots collection runs once and partitions the snapshot by
exact root. Missing native roots use metadata-only `job-root:<root-hash>` containers,
without an invented rollout or native footer. Discovery/projection limits can leave
partial coverage; absence never proves success or no pending work. Global collection and
projection uncertainty is retained across publication and feeds the existing `tree partial` /
`not loaded` notice; it suppresses the affirmative empty-state text until coverage is known.

There is no job-material bridge. Job-only branches are excluded before native label,
cause, digest or progress prompts are built. Native nodes enriched with `job` keep
that native eligibility/SmallModel/cache path. The authority layer stays deleted;
thin-job sentences use a separate bounded job-local collector (§5.6), not a facade-material bridge.

### 4.6 Per-agent data the panel adds

| Module | What it keeps |
|---|---|
| `claude-native-tree.ts` | Signature-cached metadata and bounded forward JSONL replay; public task/name, action/report and retained Agent/Task nesting. No agent-log writer. |
| `agent-context.ts` (`readAgentTokens`) | Each running agent's context fill and output rate (`AgentTokens {usage, rate}`). It reads incrementally from the rollout tail, at most every 3 s, and re-reads after a shrink or inode change. `task_started` resets the rate's baseline; tool-call/output pairs exclude the union of tool waits. It shares the wallclock proxy with the main parser. |
| `worktrees.ts` | Changes summary: branch/HEAD, ahead/behind, staged/unstaged/untracked counts, and worktree path/branch/dirty state. Bounded round-robin probes only while Changes is focused; missing/stale status is unknown. No file lists, previews, diffs or commit-subject probes. |

---

## Jev decision providers

`GeminiDecisionProvider` shares TypeSafe's keyed question builders/answer parser, converting state to Gemini input and statements to `noul`. `GEMINI_API_KEY` comes through `readHudCredentials` from the environment or `$HUD_HOME/credentials.env`. OpenAI is the default primary; Settings → Models → Decision API saves `config.json`'s `decisions.primary`, never a second persisted copy. It applies to the next job/CLI invocation; running jobs and explicit profiles stay pinned. Automatic fallback is the first other keyed provider in Gemini → OpenAI → TypeSafe order; explicit fallback wins unless identical to primary. One fallback call covers missing credentials, quota/rate-limit, auth, 5xx or timeout; malformed answers and safety refusals do not fail over. Gemini's free tier is 200 RPM / 50,000 TPM / 10,000 RPD; quota replies cool it down process-wide in memory for Retry-After/retryDelay or 60 seconds, then it is retried. Safety 400 becomes refusal. TypeSafe stays explicitly selectable. The display-text service below remains separate and never sends the Gemini key to a chat endpoint.

## 5. The optional model features

The display-text service uses three preferences in Models (beside Jev's Decision API): `modelEnabled` (Model text),
`model` (default `deepseek-v4-1-flash-1017`) and `modelCallsPerHour` (default 60).
There is no backend selector, per-feature switch, pacing control, tier model,
effort preference or consent flow. Old keys are ignored, not migrated, and are
omitted on the next settings save; user caches and state are not deleted.

Without a saved master preference, `defaultSettings()` enables model text when
the HUD credential reader finds a Mistral or OpenAI key; otherwise it defaults
off. A saved boolean wins. `tree-page.ts` also checks `modelHttpRequest` before
configuring the service: without a key for the configured endpoint the effective
service is off even if the preference is on. Off sends no model requests.
The retained `brief-toggle` shortcut toggles this same master preference, not a
separate pause state.

### 5.1 One service: `collectors/small-model.ts`

Every request goes through `SmallModel.submit`, which provides:

- **Transport.** OpenAI-compatible `POST <base>/chat/completions`, with the
  base from `briefingApiBase` (empty uses `https://api.mistral.ai/v1`) and one
  `model` for all purposes. `CODEX_HUD_BRIEF_MODEL` remains an environment
  override. This path does not use Jev's decision provider.
  Credentials come only from the environment or `$HUD_HOME/credentials.env`:
  exact HTTPS origins `api.mistral.ai` and `api.openai.com` receive only their
  matching provider key, with environment precedence. Custom endpoints receive
  neither key. Missing keys disable requests; userinfo URLs and redirects refuse.
  Internal per-purpose efforts remain `none` for labels, `low` for progress and
  digests, `high` for causes. Bounded reasoning requests add 512 tokens; there is
  no fallback to another model/effort. A queued request retains its submitted
  configuration. Cache identity includes endpoint and actual model, never the key.
- **Queue.** One request in flight at a time. `cancelAll()` runs when the panel
  closes; cancellation holds the active slot until the fetch settles.
  HTTP redirects are refused, and reflected credentials are removed from errors.
- **Cache.** Only for callers that pass a `cacheKey`. Up to 200 entries in
  `display/model-cache/cache.json`.
- **Reply language.** A request that names its `language` (every feature
  but the connection probe) gets back only a reply in that language:
  `reply-language.ts` judges the words a person reads (a JSON reply's string
  values, echoed `agent`/`id`/`path` fields, code, paths and URLs left out)
  by share, so a quoted name passes. A reply plainly in another language
  (kana or Hangul a fifth of its CJK for Chinese, CJK three tenths of its
  letters for English, no Han at all in a sentence of Latin for Chinese) is
  an `invalid-response` failure and is not cached; a cached one that fails
  is dropped and asked again. Han alone cannot tell Chinese from Japanese,
  which is why the stored `lang` stamp is not enough.
- **Hourly cap.** `modelCallsPerHour`, default 60. The call log
  `display/model-cache/calls.json` is shared by every panel on the same `$HUD_HOME`.
- **Private files.** `writePrivateFile`: directories 0700, files 0600, written
  to a temp file and renamed into place. The panel's state files (scan cache,
  agent log and model cache) use it. `settings.ts` and `snapshot.ts` do
  the same temp-file, 0600 and rename write on their own.
  Snapshot ownership follows the atomically renamed file's device/inode, so
  an outgoing writer leaves a replacement snapshot alone; no separate owner
  sidecar is involved.

Nothing calls a model while rendering. Results are stored, and then
`onChange` triggers a repaint.

### 5.2 Native text only; no overview generator

Thin-job card sentences and decision titles (§5.6) join the retained native-agent labels, visible
progress sentences, result digests and failure causes. `tree-page.ts` derives the internal
`JobSwitches` from the effective master state: all three background jobs on,
or `NO_JOBS`; these are not independent user settings. Progress additionally
follows the existing card-visibility and native-eligibility gates (§5.5).

Periodic agent overviews, main recaps, session titles, approval descriptions,
change summaries and legacy facade-only job sentences have been removed. The panel
and bar neither load old recap/title files nor write new ones. Hidden and
secondary views receive factual state, not generated overview text.
`collectors/briefing.ts` and `collectors/recap.ts` retain renderer DTO types
only. `codex-hud brief --dry-run` reports the removal; it no longer previews
outbound material.

### 5.3 Background jobs (`collectors/model-jobs.ts`)

All retained jobs follow the single master switch and endpoint-key gate.
Facade-only and display-only roots are excluded before input construction.

| Job | Output |
|---|---|
| Result digest, stage digest | an agent log `digest` |
| Agent labels from public task text | `model-cache/labels.json` |
| Failure cause | an agent log `cause` (agents); in memory only (tool calls) |

**Where a label comes from.** `ModelJobs.apply` shows the labels job's name
for the parent's plaintext from before this agent was created (`node.charge`,
with its path and role), else for a plaintext task, else a compatible stored log label
in the panel's language (`AgentLog.label`). A Fernet payload (`gAAAAA`) is
not sent. Codex 0.162 encrypts the task a subagent is sent (§11), so the charge
is the text the labels job can still read. Without a label, use the native
name; no overview request is made to fill a gap.

**Language.** Digests and causes are stamped with the language they were
asked in. A language change clears the in-memory readings; a digest or cause
in the other language counts as absent and is eligible to be asked for again.
Language/root changes and stop/restart also advance a request generation:
late model replies and pending disk reads cannot land in, or clear, a newer
job using the same key. Retry cooldowns do not carry across languages.

**Retries.** A failed or refused job retries after 10 minutes.

**Concurrency.** At most 3 digest jobs and 3 cause jobs run at once.

**Prompts.** Every prompt wraps its input as quoted data.

### 5.4 Outbound native input

| Feature | What can leave the machine when the master is effectively on |
|---|---|
| Decision titles | that thin job's question and answer files only, ≤4096 bytes each (§5.6) |
| Native-agent sentences (`nativeMaterial`) | public name/role (80 characters each), task/pre-create charge (400), state/turn, report (600), action (200), final result (8,000 head/tail) and error output (2,000); settled non-Claude agents may read one safe 32 KiB transcript tail |
| Visible progress | bounded public current-turn evidence in §5.5 |
| Result/stage digest | public final answer, head and tail, ≤8000 characters |
| Agent labels | parent's pre-create public plaintext with path/role, else plaintext task; ≤400 characters per item, up to 8 items |
| Failure cause | recorded error output tail (≤2000 characters) and command where available |

Callers build these bounded prompts and submit directly to `SmallModel`; the
former `core/materials` authority/consent layer and job-report adapters are gone.
Legacy facade-only inputs stay excluded; thin-job input is bounded separately in §5.6. Model output
is display text, never lifecycle, acceptance or execution evidence.

Reasoning and private channels are excluded. Pre-create charge collection uses
the same public channel/phase boundary as agent reports and accepts only public
text blocks. Private or unknown assistant channels are excluded before anything
reaches a label or summary. Neither main prompts for session titles nor diff
hunks for change summaries are sent by the panel.

### 5.5 On-demand live progress (`collectors/progress-summary.ts`)

`ProgressSummarizer` follows the effective master switch and the existing
rich-layout/native eligibility policy. `cardSummaryTargets` uses the exact
card visibility settings, list filters and linger window; `progressTargets`
narrows those explicit IDs to live native agents. A hidden summary, child
list or child summary never implicitly requests that subject. Closing the
Agents pane or opening a modal clears the targets.
Rendering only reads lifecycle state and stored notes; it calls no model.
`ModelHandle.status` and subscriptions distinguish queued from running without
releasing a cancelled single-flight slot early. Public progress diagnostics
contain only phases, safe reasons and timestamps, never request text, endpoints
or reflected backend errors. The Inspector explains disabled/hidden/inactive,
missing public evidence, cooldown/retry, concurrency and hourly limits.
These diagnostics stay in the Inspector rather than adding compact-card prose.
Generated notes carry explicit `coverageAt` and actual `generatedAt` (cache reuse
keeps the original generation time); old notes have only recorded time unless
coverage is explicitly known. With the effective master off, `tree-page.ts`
filters model log kinds before rendering, falls back to native names and omits
generated tool causes. Files are retained. `logsIn(..., observed=false)` also
hides observed history when its separate Agent log switch is off.

Input is quoted public evidence from the current turn: up to four reports of
600 characters each, current stage intent (300), current tool/action (200),
plaintext task and pre-create charge (300 each), name and role (80 each), stage
metadata and descendant status counts. It reads no rollout file or reasoning
channel and never sends a sealed Fernet task. A running status or assignment
alone is insufficient evidence, so it sends nothing without a public report,
stage intent or open action. Output is exactly one sentence of at most 120
characters in the panel language, stamped with the request snapshot time in
the agent log. `summarySentence` also trims verbose replies to one sentence.

A stable input fingerprint caches and deduplicates notes. Changed public
progress is refreshed at most once per minute while its summary is visible;
failures retry after ten minutes. Hiding a summary, switching the master off,
changing roots/language/turns or exiting cancels obsolete work. Newer reports in the same turn do not starve
an in-flight snapshot; its note lands with its original coverage time, then a
later refresh can cover the new evidence. There are at most three pending
progress jobs, sharing `SmallModel`'s single-flight queue and hourly cap.

---

### 5.6 Thin-job card sentences (`collectors/job-sentences.ts`)

`JobSentences.update` runs on collection, after the deterministic workboard is built; `apply` overlays `OwnerWorker.modelSentence` and the short task name for painting. Thin jobs retain `briefTitle` from the existing bounded, signature-cached brief read: that first heading wins over a generated name, else the first task line remains the fallback. Names come in the same JSON response as the sentence, with no extra model call or referenced-file read; old plain-sentence responses/caches still work. Home and the Inspector share this title and their existing width cut. Project slice titles remain the ledger ID/description, never raw dispatch text. Master/key and language gates are shared with the existing service. Native cards and bars are unchanged; the settled card's final sentence is its one-line result (no second line).
Input is read-only under the exact job directory: brief title/goal (1500-byte prefix), STATUS state/phase, open question (2 KiB), newest review's verdict line, four report lines once settled, and four public assistant-text/tool-call blocks from the newest working-session JSONL's 32 KiB tail. Symlinks/nonregular files refuse; reasoning/private channels and paths referenced by messages are never read.
State/phase, question/answer revisions, report/review revisions and working-session activity fingerprint the request. One queued/running handle per job and a two-minute floor after settlement coalesce changes. A successful final sentence freezes only its `settledAt`; a continuation that settles again becomes eligible after the shared two-minute floor. Failed final requests retry no sooner than two minutes after failure. An unchanged running fingerprint advances the rate timestamp too, avoiding body re-reads on every following tick. Requests use `SmallModel.submit`, visible priority, the shared hourly cap and input cache.
The private `model-cache/job-sentences.json` retains up to 200 language-keyed job records: last sentence, successful fingerprint, rate timestamp, final-success bit and settlement timestamp. Updates re-insert rows so eviction drops the least recently written row. Reopen restores text without a call; unchanged input stays quiet. Disabling hides the overlay and cancels pending work without deleting records. Model text changes no deterministic state or activity timestamp.
`utils/keyword-marks.ts` parses up to four spans: `«keyword»` (legacy identifier ink), `«+stance»` (approve/accept/agree/pass, 批准/同意/通过/接受; `theme.board.success`), `«-stance»` (reject/object/oppose/fail/block, 拒绝/反对/驳回/失败/阻塞; `theme.board.danger`), and `«!opinion»` (judgement/recommendation; `theme.board.opinion`, the palette's info cyan). Opinion ink is distinct from identifier/success/danger/attention and is plain with text icons; theme none stays uncoloured. Delimiters/prefixes are stripped even for malformed, nested, empty/prefix-only or excess marks, which lose keyword emphasis. The shared prompt explicitly requires `«…»` in every language, including Chinese. Before span parsing, short `「…」` marks normalize to the same grammar and four-mark total: balanced, non-nested, 1–24 Unicode payload characters after an optional prefix, with no whitespace or sentence/clause punctuation (`。！？!?，,；;：:` or a final period); internal filename dots are allowed. Other corner quotations remain literal and unmarked. This applies equally to stored job/native sentences and `markedTitle` decision titles, without cache migration. Old plain-mark caches remain valid. `render/work-card.ts` shares painting with decision rows/Inspector: the deterministic `identifiers()` rule includes filenames with extensions as well as paths/code/flags, and file spans override mark ink even when unmarked. No model scheduling, cap, queue, spacing or input changes. Collapsed, one row cuts at a word with `…`, including width-safe CJK fallback; Enter wraps the complete sentence and shows the whole factual detail underneath. Missing text/key or master off leaves the existing factual rendering unchanged. A sentence is display text, never a workflow verdict.

`DecisionTitles` (`collectors/decision-titles.ts`) overlays `DecisionRecord.modelTitle` in both collapsed and expanded rows, leaving the question/alternative and Enter behavior intact. Collection reads only that thin job's question and answer (4096 bytes each), through the shared safe reader. Titles state what was decided in the panel language, with up to two keyword marks using the shared sentence grammar/painting. `markedTitle` counts visible words with `Intl.Segmenter` (including Chinese), cuts to eight words without counting prefixes/delimiters, and closes a mark that crosses the cap. The private adjacent `decision-titles.json` retains 200 records keyed by decision id, answer revision and language; reopen reuses them, and a changed answer revision requests anew. Up to three pending handles use the shared queue/cap, current viewport decisions first; failures wait two minutes before retrying. Master/key off hides titles and cancels requests without deleting records; missing/pending text leaves the original option/title.

## 6. Rendering

### 6.1 The bar

Three clients draw one bottom bar: Claude's statusline (`cli/statusline.ts` → `statusline-parity/render.ts`), pi's
footer (`harness/pi/p10k-footer.ts`) and the Codex tmux bar (`render/header.ts` `fitStatusBar` →
`layout/bar-modules.ts` `barFacts`). Each client only collects **facts**; `layout/bar-fields.ts` `renderBar(facts,
width, now)` words them, paints them in the chosen style and fits them to one line.

Codex call chain: `index.ts` `renderToStdout` → `composeStdoutFrame` → `render/header.ts` `renderHud` →
`fitStatusBar` → `barFacts` + `renderBar`.

**Facts.** `BarFacts` holds the optional `model`, `context`, `project`, `quota`, `needs` (what waits on the owner),
`events` (`BarEvent`: `started | done | failed | warn | skill`, text, short text, subject key, time; an agent's carries
its `name`) and `loaded` (counts and extra words). A client leaves out what it cannot supply; a missing fact is never
shown as zero. Words that carry meaning (an agent's `name [model · effort]`, an age via `span`) come from shared helpers
(`agentEvent`, `span`; the model name from `render/providers.ts` `shortModel`, next to `providerMark`) so the three
clients say the same thing. The clients name models by id: `shortModel(id)` drops route and vendor words, dates, builds
and the `[1m]` tag and turns version hyphens into dots.

**Context and quota bars** are claude-hud's (`colors.ts` `coloredBar`/`quotaBar`): `cells()` draws ten cells, `█` in the
reading's colour and `░` dim. The context's colours are `contextRole` (green, yellow from 70, red from 85), the quota's
`quotaRole` (bright blue, bright magenta from 75, red from 90; plain ANSI like claude-hud's, no colour with theme `none`).
`quotaSeg` shows one window, the one with the least left (the first wins a tie), for Claude and Codex alike; its
forms are bars with reset, bars, percent only. The capsule look leaves `bar` pieces of a `Form` out, so a p10k capsule
has the percentage only. Each client supplies only its own quota: Claude's `rate_limits`, Codex's windows, pi's cost.

**Fields, fixed order.** `model effort │ context %/window │ repo branch(dirty) │ quota │ notice zone ···· MCP n
skills n`. The fields shown are the `barFields` display setting (default all; no UI); `barStyle` picks
`line` (`│` separators, roles painted with theme inks) or `p10k` (powerline capsules on the old p10k-footer palette
indices: a space either side of each field and a powerline arrow (``) in its colour into the next, flat without
arrows when icons are `text`; it needs a theme, so `none` stays `line`; the
`text` icon set gives the provider's initials). Both are in
`render/hud-config.ts` and `settings.ts` (`HUD_BAR_STYLE`, `HUD_BAR_FIELDS`); the Codex bar gets them through
`applyDisplaySettings` (Settings → Display → Bar style cycles the exported `BAR_STYLES`), the Claude statusline and the pi footer, which draw only the bar, through
`settings-runtime.ts` `applyBarSettings()`.

**Context against compaction.** The window the percentage is measured against is where the client compacts, when the
client says so: Claude's `autoCompactWindow` (`statusline-parity/collect.ts` `compactWindow`, read-only from
`settings.json` in `$CLAUDE_CONFIG_DIR` or `~/.claude`) and Codex's `model_auto_compact_token_limit`. pi supplies none.

**The notice zone is events, not states.** (An agent's item is claude-hud's agents line: mark, name, dim `[model ·
effort]`, no words and no age; `noticeSeg` keeps the bracket whole or drops it. Claude's effort and fallback model come
from the type's definition, `statusline-parity/collect.ts` `agentDefinitions`: frontmatter of the first
`agents/<type>.md` in the project's `.claude`, else in `$CLAUDE_CONFIG_DIR`/`~/.claude`, first 8 KB, only for agents
with an event in the last three minutes.) A subagent or HUD job started, finished or failed, and a skill load, each
stay `NOTICE_MS` (3 minutes) after they happened, dated by the event, not by when a collector saw it. An agent or job
has one item, its latest (`BarEvent.key`: `finished` replaces `started`). The zone shows two items at once where there
is room for both at their short forms (`BarEvent.short`, then without the age): items 2k and 2k+1 with
`k = floor(now / 5 s) % ceil(n / 2)`; a pinned needs-you item takes the first slot and the events rotate through the
second. With room for one, `events[floor(now / 5 s) % n]` shows. The choice is a pure function of the clock, so a
client keeps no state. What needs the owner (an approval, a HUD job's question) is pinned while open. There is no
running line, no tool at work, no turn-done notice and no last-event fallback; with no event the zone is empty.
Sources: for Codex `collectors/bar-notices.ts` `BarNoticeTracker` (`HudData.notices`, newest first, one per change
between collections: an L1 agent started, finished or failed, the account went on to credits) plus `HudData.work`; for
Claude the transcript (agents, and `skillLoads`, the time of the latest `Skill` call of each name, from conversation
records only); for pi the HUD jobs only. HUD jobs come from `render/work-summary.ts` `workSignals(lanes, now)` (`needs`,
`events`) in all three; the Codex process reads the job folders at most every 5 seconds (`index.ts` `readJobSignals`).
pi's footer host and the Codex collectors expose no skill loads, so those clients tell none.

**Fitting.** The line is always one row. When it is too wide, one form or segment at a time gives up in the order of
`LADDER` (cheapest loss first): the loaded cluster to counts only (the whole cluster at once while a notice shows: the
notice is shown in full, not abbreviated to save it), the context bar, the quota's reset, the quota's bar, the
project's short form, the loaded cluster, then the `notice` step (the notice is cut at a word, if a word fits, and the
loop stops: the main session's effort is not spent on a notice), the model's effort, the project's name only, the quota,
the project, the context. The loop stops as soon as the notice fits whole or two events fit side by side. The model is
never dropped (`truncateAnsi` is the last resort). A pinned needs-you notice
is a segment of its own, in full. `FitResult.segments` lets the snapshot save placements, so a click maps to a field
(`utils/click-map.ts`: the notice zone focuses, the context and quota open the panel).

**Missing data.** A field without trustworthy data is left out. Never show a zero you do not have.

The bar is English-only.

### 6.2 The panel

*Superseded where it disagrees with [R5UX-P1 update: passive Home and Work](#r5ux-p1-update-passive-home-and-work);
kept as the historical/secondary description of the stacked monitor.*

`tree-page.ts` runs the panel:

- **`collectNow`** builds the tree, runs `jobs.apply` and `agentLog.observe`,
  reads agent tokens, then calls `updateProgress` and `updateJobs`. No briefer is constructed.
- **`render`** calls `renderMonitor(input)` and gets back a `MonitorFrame`:
  `lines`, `panes`, `controls` and `state`.
- **Painting.** Writes `ESC[H … ESC[J` only when the frame differs from `lastPaint`.
  Rich card cache keys include live clock seconds and the output rate's
  freshness state independently, so hiding the clock cannot freeze a rate.

**Always keep `frame.state`.** `renderMonitor` reconciles the state (selection,
scroll, visibility preferences) and returns the result in `frame.state`. The caller must
continue from that, never from the state it passed in.

The steps inside `renderMonitor` (`render/monitor.ts`):

```
reconcile state
panes (PANES = agents, changes, details):
  agents   → agents-view.ts  agentsView → richRows (cards.ts) | agentRows (compact)
  changes  → monitor-panes.ts changesRows (repository/worktree summary only)
  details  → monitor-inspector.ts inspectorRows  (the Inspector)
controlBar                   retained secondary chrome only (control-bar.ts)
```

The live pages do not use this pipeline: `renderWorkboardFrame` (`render/work-view.ts`) draws Home, the Inspector,
Help and Changes with the shared workboard frame — one top title band, exact-width rows, one footer, no status foot
and no picture. The no-sidecar secondary renderer described here is fixed to the rich layout; fixtures may still ask for
compact.

**Height budget.** Each open pane gets one row first. The remaining rows are
handed out round-robin. The live pages have no status foot; the retained
secondary renderer keeps its own. No generated brief or recap is supplied. What
is left goes to details or agents. Blank separator rows appear only when the
height is 30 or more.

**Types.** A `MonitorRow` is `{text, item, key, controls, counts}`. A
`MonitorControl` is a clickable rectangle. `panel-state.ts` keeps the
selection by item id, so it survives reordering.

### 6.3 Cards (`render/cards.ts`)

Home and the retained secondary renderer share the compact work card described in the opening panel update. It shows role/task, deterministic
state and minute age, an observed phase chain when known, and one detail line:
reason, reported test/file counts or an eligible native model sentence. It has
no rich-card telemetry, child rows, relations, model badge or footer. Full native
model/effort, evidence, logs and progress diagnostics stay in the Inspector.

The Panel group exposes `cardLabel`, `cardSummary` and `cardStallMinutes`;
`agentLog` is kept for the retained compact view and Inspector. Label
visibility affects card names only; summary visibility constrains automatic
native progress targets. Neither is a separate LLM permission or a switch for
result digests, labels or causes. Saved child-summary/scope preferences in
`card-visibility.ts` still constrain native eligibility, but do not restore the
retired rich-card body or controls.
`cardSummaryTargets` and `progressTargets` run in the collection/input layer,
never from rendering. Model requests still need the effective master state.

Raw native task/charge, reports and older notes remain in the Inspector. A
legacy facade-only card stays deterministic; thin jobs can overlay the §5.6 sentence.
Compact logs and the Inspector mark model-written text with a dim `~`.

### 6.4 Input

**Bar.** stdin is raw. Any bytes that reach the bar are replayed to Codex's
pane with `send-keys -H`.

**Panel keys.** Panel commands come only through the prefix:

1. The user presses the prefix key (`Ctrl+\` by default) and then one key.
2. `codex-hud-command` writes `ESC _ codex-hud:<cmd> ESC \` into the panel's input.
3. `WorkbenchInputDecoder` decodes it.
4. `monitorKey` or `overlayKey` in `utils/panel-command.ts` turn it into an action.

The command travels in the same input stream as typed keys, so ordering is
kept. On panel startup the prefix command table is refreshed from
`bin/codex-hud-keys`, so existing sessions lose the obsolete card `e` binding
and Space opens the Inspector after a restart; the root key table is preserved.

**Other keys.** With a main pane set and no overlay open, **every other key
and paste is forwarded to Codex** (`utils/key-forward.ts`). The settings page
and the help keep the keyboard while they are open.

**Mouse.** SGR mouse events are hit-tested against `frame.controls` by
`handleMonitorInput` (`render/monitor-input.ts`), which returns
`{state, close, action}`.

**Switching sessions.** `utils/session-navigation.ts` drives Codex's own
`/subagents` picker. It types the command, checks what was typed, parses the
picker from `capture-pane`, and arrows to the row. It has been verified only
against Codex 0.154 and 0.157.

---

## 7. Settings and state on disk

**Settings** (`src/settings.ts`):

- `HudSettings` holds the type, `defaultSettings()` the defaults, a per-key
  validator table the checks, and `loadSettings` / `saveSettings` the I/O.
- The page has four open groups, in this order: Display (Theme, Bar style, Icons, Language),
  Panel (Stall threshold, Notifications, Refresh, Mouse), Models (Model
  text, Model, Call cap, plus the read-only calls-this-hour gauge and Test API)
  and Codex (Width, Prefix key, Bar on launch). There is no accordion, no header
  buttons and no Reset all: `SETTING_ROWS` is one flat list and every group is
  open. The page is a draft; Theme and Icons paint in the draft value, so the
  page is its own preview. The selected row's help is a `┃` stem under it; a
  non-default value is in the accent and a changed row is marked `*`. The top
  band reads `‹ Settings` and `unsaved` at the right when dirty (a click saves).
  `s` saves, `r` resets only the selected group, `t` runs Test API, and Esc with
  a dirty draft opens `settings-confirmation`: save-and-leave, discard, or
  continue editing (the safe default). Save failure retains the draft and
  pending decision. Destinations are keys rather than old mouse coordinates,
  because saving can resize the panel. Clean drafts leave immediately. Values
  align at the actual terminal width's right edge; saving a new width reflows
  the rows. Width applies on Save, followed by a repaint as well as the stdout
  resize event; no draft-only resize.
- `card-presets.ts` retains legacy combinations for fixture/compatibility
  callers only. There is no preset row on the current page; it cannot restore
  retired rich-card contents. `agentLog`, `cardLabel` and `cardSummary` are retired by NATIVE-TREE.
- Reset group restores only its explicit owned fields. Resetting Models sets
  `modelEnabled: false` and preserves the connection, model and call cap; no
  other group touches the master preference. There is no Reset all. No
  credential or consent record is written; the helper only prepares a draft and
  Save is required.
- They are stored in `$HUD_HOME/hud-settings.json` (default `~/.hud`), or at
  `HUD_SETTINGS_PATH`. The file is capped at 64 KiB and written
  atomically with mode 0600.
- Once that file exists, the display environment variables
  (`CODEX_HUD_THEME`, `CODEX_HUD_ICONS`, `CODEX_HUD_BAR_STYLE`,
  `CODEX_HUD_BAR_FIELDS`, …) are ignored. Only `NO_COLOR` still wins
  (`settings-runtime.ts`). Removed preferences (`look`, `glyphs`, `motion`,
  `panelStyle`, `statusCard`, `art`, `artImage`, `density`, `context`,
  `cardCorners`, `cardClock`) are not in `HudSettings`; unknown old keys are
  ignored and omitted on the next save, and old `nerd`/`emoji` icons load as
  `unicode`.

**Files under `$HUD_HOME/display/`:**

| Path | Writer | Contents |
|---|---|---|
| `state/<session>.json` | bar or panel | snapshot for `--json` and bar clicks; deleted on exit only by the process that owns it |
| `scan/` | panel | tree scan cache (`SCAN_VERSION`) |
| `model-cache/{cache,calls,job-sentences,decision-titles}.json` | panel | shared replies/call log and display overlays; retired agent-log/label files are not read or removed |
| `profile.log` | both | only with `CODEX_HUD_PROFILE=1` |

**Display.** `icons` decides icons or words everywhere: the buttons, the
titles, "ago", the bar's activity and cache marks
(`iconSet()`, `iconic()`). It is `unicode` or `text`; there is no look selector.

**Read from `$CODEX_HOME`, never written:** `config.toml`, `sessions/`,
`shell_snapshots/`, `logs_2.sqlite`, `goals_1.sqlite`.

---

## 8. Rules every change keeps

Check this list before every change to `src/render/` or `src/collectors/`.

**Rendering**

- [ ] Every panel line is exactly `width` columns wide. Measure with
  `visualLength`, which counts CJK as 2, and cut with `truncateAnsi`. In the
  panel, never use `.length` or `truncate()`: `truncate()` counts UTF-16 units,
  not columns. The bar uses it because the bar is English-only.
- [ ] Text that comes from outside the HUD (agent output, file names, task
  text) passes through `monitorText` once. Never pass the panel's own ANSI
  through it.
- [ ] Every word in the panel goes through `t()` (`render/i18n.ts`). Keys are
  English, and there is a ZH table. The bar stays English.
- [ ] Colours come from `theme.*` roles (`palette.ts`), never raw escapes.
  `colors.bold` and `underline` still emit escapes under the `none` theme.
- [ ] Controls show words or icons, never shortcut letters. Every glyph has a word next to it.
- [ ] When space is short, drop a field before cutting one. Do not add
  placeholder lines, or hints that repeat what a count already says. Show
  nothing rather than a guess. Two exceptions state a fact once, dim, in rows
  nothing else uses: an agents view whose tree, read and built for the bound
  root, holds no thread at all (`emptyAgentsRows`: one sentence and where the
  help is; nothing while `loading`), and, in rich, a closing line after the
  cards when summaries are enabled but the model service is unavailable.
- [ ] Cards use deterministic observations and, for eligible native agents,
  an optional stored model sentence (§6.3), never raw report/task/helper prose.
- [ ] Rendering is pure. Pass `nowMs` in, never call `Date.now()`, and compute
  click rows with the same `nowMs` the frame used.

**Collection**

- [ ] Rollout offsets are byte offsets.
- [ ] Every parse goes through the single-flight queue.
- [ ] SQLite access is read-only and best-effort.
- [ ] A change to what the tree scan reads bumps `SCAN_VERSION`.
- [ ] A failed read gives `null`, never `0`.

**Privacy and the repository**

- [ ] With `modelEnabled: false`, no model request is sent. Without a matching
  endpoint key, the panel's model service is also off.
- [ ] Every new model input is listed in §5.4 and in the reference.
- [ ] New HUD state files are private: written with `writePrivateFile`, or
  with the same temp-file, 0600 and rename pattern.
- [ ] Tests, fixtures and README figures use **synthetic data only**. The repo
  is a public fork, so never paste text from a real session.

---

## 9. Tests and tooling

```bash
npm run build            # tsc: src → dist/
npm test                 # build + build:test (tsconfig.test.json → dist-test/)
                         #   then node --test dist-test/tests/unit/*.test.js
                         #   then node --test tests/unit/*.mjs   (these import dist/)
npm run test:integration # tests/run-integration.sh: tmux shell suites, exit 77 = skip
npm run test:visual      # fixed synthetic terminal-cell frames + semantic checks
npm run test:visual:update # explicit local-only baseline update; refused in CI
npm run test:windows     # PowerShell entry points, with fake binaries
```

**Continuous integration.** CI (`.github/workflows/ci.yml`) runs `npm test` on
Node 18, 20 and 22 with both empty `NO_COLOR` and `NO_COLOR=1`, and the
integration suite with tmux on Node 20.

**Node before 22.** Node 18 and 20 have no `node:sqlite`, so on them daemon
binding and the goal reader switch themselves off. Only the Node 22 CI job
runs them.

**Fixtures** (`tests/fixtures/`):

- `hud-data.ts`: `FIXED_NOW`, `makeHudData`, and the tree builders `node` and `treeOf`;
- `paths.ts`: `REPO_ROOT`, `rolloutFixture`;
- `rollouts/*.jsonl`: recorded synthetic sessions;
- `samples.ts`: the layouts recorded in `docs/BASELINE.md`.

**Test idioms:**

- Render with `renderMonitor` on a synthetic tree at a pinned `now`.
- Read the output with `stripAnsi`, and loop over several widths.
- Make temporary directories with `mkdtemp` and remove them in `finally`.
- `setDisplayConfig` and `setLanguage` return the previous value; restore it in `finally`.
- Colour-dependent suites call `useDisplayFixture` from `tests/fixtures/display.ts`:
  each test starts with an explicit display and restores the previous one. Do not
  remove `NO_COLOR` globally to make colour assertions pass. No-colour expectations
  choose `theme: 'none'` explicitly; `narrow-modes.test.ts` also checks the real
  environment override for saved settings and navigation at narrow widths.
- `test-narrow-panel-real-tmux.sh` drives a private tmux client with actual mouse
  input, reads the resulting screen, and checks modal return and input forwarding
  at 32/40/48/56 columns, in EN/ZH and both colour modes. Its session fixtures use
  the local date for the rollout directory, matching the session finder.

**Visual regressions.** `tests/fixtures/visual-baselines.ts` creates fixed-time
EN/ZH frames across five widths and the shared presets, plus
settings, confirmations and Inspector lifecycle scenes. The reviewed JSON
retains trailing cells; tests report the exact case and first changed row.
This is textual terminal-cell coverage, not pixel/font screenshots. Updating
requires the explicit local command above and is refused with any CI variable.
No real rollout, wall clock, credential or network input enters a baseline.

**README figures.** `tests/fixtures/readme-demo.ts` renders the synthetic
"parser-kit" scenes as `.ansi` files. The PNGs are rasterised from those files
outside the repo.

**Other tools:**

- `CODEX_HUD_PROFILE=1` times each stage into `display/profile.log`.
- `docs/reviews/ui-audit.mjs` and `render-ui-preview.py` support UI review.
- `codex-hud brief --dry-run` is a removal notice, not an outbound-input preview.
- `docs/issues/` holds 16 fixed bugs (in Chinese). Read the matching one
  before touching the rollout parser or the tmux scripts.

**Formatting.** A Prettier config exists but is not enforced, and much of the
code does not follow it. Match the surrounding code instead.

**Conventions:**

- Files are kebab-case.
- Function names follow the patterns `makeX`, `initialXState`, `renderX` and `handleXInput`.
- Time is passed in as `nowMs`.
- Comments are prose that explain why, not what.

### Checking a UI change live

Unit tests do not show what the user sees. After a rendering change:

1. Rebuild.
2. Restart the panel: press F12 twice, or start a new session. **A running
   panel keeps executing the `dist/` it started with.**
3. Look at the result at a real panel width (32–56 columns).

Do this on your own tmux server (`tmux -L <name>`) with a throwaway
`CODEX_HOME`. Never drive a user's live pane.

---

## 10. Recipes

### Add a setting

Card visibility fields are declared in `src/card-visibility.ts` and mapped
through `monitorSettings`. The obsolete `cardNotes` option is no longer used.

1. `src/settings.ts`: add the field to `HudSettings`, its default to
   `defaultSettings()`, and a validator, for example
   `cardSummary: isBoolean`.
2. `src/render/settings-page.ts`: add a row, for example
   `{key, group, label, values, help}`, in the group it belongs to: Display,
   Panel, Models (the master switch, model and call cap) or Codex. Settings that
   only make sense together are one row: give it `get` (their value as one) and
   `set` (the settings a value stands for), as Notifications does; `rowValue`
   and `withRowValue` read and write through them.
3. If rendering needs it: add a field to `MonitorState`
   (`render/monitor.ts`), map it in `monitorSettings`, and read it where it
   is drawn.
4. `src/render/i18n.ts`: add ZH strings for the label and the help.
5. Tests:
   - `settings.test` covers the default and validation;
   - the settings page has one more row, so heights in `settings-page.test`
     may need to grow;
   - a render test covers the effect.
6. `docs/reference.md` and `reference.zh.md`: add it to the settings list.

### Add or change a bar field

All three bars share `layout/bar-fields.ts`; a field is added once.

1. Add its name to `BAR_FIELDS` in `render/hud-config.ts` (and decide whether it is in `DEFAULT_BAR_FIELDS`).
2. Add its facts to `BarFacts` and a segment builder in `bar-fields.ts`: its forms from longest to shortest, each a
   list of `[text, role]` parts (roles map to theme inks in `line`, and to plain text in `p10k`). Return nothing when
   the fact is missing.
3. Give it a place in `LADDER` (who gives up a form or a segment, in which order).
4. Collect the fact in each client that can: `layout/bar-modules.ts` `barFacts` (Codex), `statusline-parity/render.ts`
   (Claude) and `harness/pi/p10k-footer.ts` `buildFacts` (pi). A client that cannot supply it leaves it out.
5. If it can raise an alert, change `render/attention.ts`.
6. Write tests at several widths (`tests/unit/bar-layout.test.ts`), and update the reference if it describes it.

### Add a line to a card or the Inspector

1. Decide the source first. Text an agent wrote, or a task, belongs in the
   Inspector (`monitor-inspector.ts`), wrapped with `flowLines` and never cut.
   Short text a model wrote can go on a card.
2. Pass external text through `monitorText`, and every label through `t()`.
3. Test the line at width 32 and at width 56, and in both languages if it has words.

### Add a panel command

1. Map the command in `utils/panel-command.ts` (`monitorKey` / `overlayKey`).
2. Bind it in `bin/codex-hud-keys`.
3. If the command only navigates, update **both** `needsOpenPanel` and the
   copy of that list in `bin/codex-hud-command`.
4. Name it in the help (Keys) and in the reference's keys section.

---

## 11. Gotchas

**Processes and launch**

- **Stale code.** A running bar or panel keeps the code it started with. After
  a build, restart the pane before you judge a change.
- **Panel replaces the bar.** While the right-side panel is open no bar process runs. The open
  panel writes `display/state/*.json` and sends notifications on its collect tick,
  so `--json` still has a file to read. The panel's `bar.segments` is empty.
- **Shared prefix table.** The prefix table belongs to the whole tmux server.
  Changing the prefix in one panel changes it in every session.
- **Display variables ignored.** The display environment variables stop
  working once `hud-settings.json` exists.
- **`CODEX_HUD_TMUX_BIN`** (a test hook) is honoured by the panel,
  session navigation and daemon binding, but not by `index.ts` `spawnTmux`.
- **Old sessions.** A session created before `@codex_hud_hud_cmd` existed gets
  a fallback bar command without `CODEX_HUD_TMUX_SESSION`. Its snapshot is
  named `pid-<n>`, and clicks on its bar only toggle.

**Collection**

- **Null peeks cached forever.** `rolloutMetaCache` caches a null first-line
  peek permanently.
- **One tree a tick.** The panel passes the tree it built into the status build.
- **Guardian threads.** Since Codex 0.155, each session gets a nickname-less
  guardian review thread. It used to be mistaken for the main session, so
  count guardians as reviews.

**Model features**

- **Credential origin.** The panel uses only the matching Mistral/OpenAI key
  from the environment or HUD credential file for the exact provider HTTPS
  origin. There is no settings-file key or general key fallback for custom
  endpoints (§5.1).
- **Shared cache.** Native background jobs (§5.3) and progress (§5.5) reuse
  cached replies; there is no periodic overview generator.
- **Late refusal.** The hourly cap is checked when a request runs, not when it
  is queued, so a queued job can be refused late.
- **Shared model state.** `model-runtime-store.ts` coordinates local panels with unique process tickets, atomic budget reservation, cache merge and same-input claims. A lost sender may conservatively consume its reservation; failures refuse rather than bypass accounting.
- **One master.** §5.3 jobs follow the effective master state, not retired
  per-feature or scope keys. Progress also follows native visibility gates.
- **Lost on restart.** Main-session tool-call causes live only in memory.
- **Encrypted tasks.** Codex 0.162 sends inter-agent messages encrypted:
  `spawn_agent`, `send_message` and `followup_task` carry a Fernet token, and
  an `agent_message` a plaintext header and `encrypted_content`. `node.task`
  is then empty or sealed. The labels job sends the parent's own plaintext
  from before the spawn (`node.charge`) when the rollout still has it, and
  otherwise has nothing to send; the native name remains when no compatible
  stored label is available. The details page shows the charge whole.
  The card does not.
- **Mixed languages.** What a model wrote stays in the log in the language it
  was written in. Anything that shows or resends log text goes through
  `logsIn`; an entry from before `lang` existed is read by its text (any Han
  character is Chinese).

**Rendering**

- **Two terminals, two fonts.** The same settings can look different in two
  windows because the terminal draws them. In Windows Terminal a shell started
  from Explorer or a shortcut runs in `profiles.defaults`, while the WSL
  distribution's profile (Ubuntu-24.04, generated from a fragment) has its own
  font face and size. Set the font on both, or start both from one profile.
- **Bar fallbacks.** When a button costs the tabs room (`⊕N` older), the bar
  gives up the unfocused tabs' icons before their words (`rowBar`'s `named`
  level), so the same panel width can read differently with and without it.
- **NUL sentinels.** Item ids starting with NUL (`'\0untracked'`,
  `'\0worktree:'`, `'\0earlier'`) are internal markers, not paths.

**Not settled yet**

- Does the bar's chokidar watcher, bound to today's `sessions/YYYY/MM/DD` at
  startup, re-root after midnight? The 1 s tick and the 5 s finder poll cover
  for it either way.
- Can anything still reach the native-Windows tmux branch in `bin/codex-hud`?
  `codex-hud.ps1` routes only to WSL or plain Codex.

### Incremental terminal painting

`render/frame-diff.ts` compares panel rows and writes only changed rows with
absolute cursor positioning. Initial paint and resize invalidate all rows.
Shortened or removed rows are erased, and updates do not emit scrolling
newlines. This reduces nested tmux/Herdr traffic for clock-only repaints. Each row is erased *before* it is written:
after a full-width row the cursor is still on the last cell, so an erase-to-end-of-line written afterwards would wipe
that cell in Herdr's terminal (every right-aligned row lost its last character, `⏎ open` read `⏎ ope`).

### Current failures and explicit probes

`collectors/bridge-health.ts` still supplies current health notices to the panel/bar.
`render/hud-diagnostics.ts` retains only `hudProblems` and agent `tokenRateDetails`,
used by those notices and the agent Inspector. There is no diagnostics page or
Sources/Calls/Export navigation. Settings → Models shows `SmallModel.usage()` calls this
hour against the shared cap, even with model text off; known zero is shown. The
separate feature telemetry store and its settlement writes are removed; ordinary
call reservations, cache coordination and `calls.json` remain.

`collectors/model-probe.ts` owns cancellable Settings API checks. It snapshots the
connection and checks labels, progress and cause with the same configured model
and their internal effort defaults. A separate SmallModel instance shares the
ordinary budget directory and sends only fixed synthetic text. A configuration
fingerprint and generation counter reject late results when leaving or changing
the draft. The master off or a missing endpoint key prevents network requests;
there is no separate pause bypass.

Performance evidence and the reproducible synthetic workload are documented in
[the performance report](./performance-20261024.md). Panel tree collection uses
`buildSubagentTreeYielding` to yield between files; the synchronous API remains
for existing consumers. Neither API changes the scan cache schema.

### Adaptive collection

Retired Timeline/history collection, activity journalling, inbox/pins/view receipts,
recent-session modal scans and diagnostic export have no running producers. Existing
user state is left alone. AgentLog stays: native models, the old Agents pane and
agent/job Inspector still read its observations, notes, digests, causes and labels.
The shared rollout parser and its checkpoint event schema are unchanged.

`adaptive-poll.ts` changes collection cadence, never repaint/input cadence.
`collectionObservation` fingerprints stable evidence, excluding refresh-time
noise, and only classifies positively bound idle sessions without unknown/live
descendants as quiet. Panel input uses an epoch so a force during an awaited
scan cannot be lost to that scan's completion. The bar's native watcher wakes
collection; the periodic tick remains its fallback. The yielding scanner has
within-file checkpoints; a single JSON.parse is still atomic.

### Codex adapter facade

`harness/codex/index.ts` implements the core `HarnessAdapter` without moving the
existing collectors. It resolves only an explicit, existing profile source root
and verifies an effective `CODEX_HOME` against that root. Sources use the core
`makeSourceId`; reads and native-tree listings stay within the selected source.
`SessionFinder.candidates` supplies the strict facade's cwd candidates, while
its existing pane/daemon check remains available for the matching ambient source.
Strict candidates retain quiet older roots rather than filtering by HUD startup.
An ambiguous candidate set returns null. A unique current registry observation
also supports selection without a host locator. A selected ordinary session has a full
`SessionRef`, nullable process/occupant observations and no invented managed run.
The bar and panel keep their existing finder/parser paths: their newest-cwd
selection is a different policy from strict facade binding.

`open` defers I/O to a serialized `read`. The opt-in rollout scanner stops at the
first byte, record or soft time budget (defaults 4 MiB, 2000 records and 20 ms).
It retains up to 1 MiB of undecoded tail bytes, or discards an oversized record
until its newline, recording an `oversize_unknown` gap. Gaps survive EOF. A
complete final JSON record without a newline still follows the legacy convention.
Legacy parser calls use their original read path. Read statistics include actual
bytes, records and elapsed read/assembly time; a parse or optional SQLite read is
not preemptible. Truncation, changed file identity and observed compaction advance
reader source generation independently of host/run generations.

The facade returns observation and checkpoint together in memory. A Codex
checkpoint contains the generic byte/tail/gap state plus the complete native
parser summary, open calls, token-rate baseline and wait union. Metric-specific
source-event clocks survive checkpoints; unrelated public replies do not refresh
model, context or cumulative-token timestamps. Reset lineage clears those clocks.
Baseline-adjusted context metrics are labelled estimated with their method source. Its native payload
uses Node's V8 serializer, checked against the recorded V8 runtime before restore;
a mismatched runtime/version is rejected, never silently advanced. This is not a
new checkpoint store or an implementation of B12's fenced atomic publication.

`children` passes a source-scoped listing to `buildSubagentTreeYielding` and returns
only its direct native children. Readers expose the latest explicitly collected
children references, without rescanning a tree during every budgeted read. An
empty native list before collection does not prove absence of children. Quota,
goals and plan/todos are typed `caps.codex` projections of the existing collectors;
public reports reuse their existing channel whitelist. Dollars stay unknown when
only tokens were reported. B16 still owns authoritative combined state/continuity;
the facade supplies transcript activity and leaves run terminality, liveness and
observation commit stamps unknown until those authorities provide them.

The tree scan now saves bounded hud-mcp link-result evidence and pending function
call IDs (100 each), so `SCAN_VERSION` is 4. Both the scanner and reader match exact
`response_item` function calls/outputs for spawn, resume and whoami, retaining only
link/run IDs, exact call/message anchors and event timestamps. The scanner knows
the standard `hud`/`hud-mcp` aliases; the reader uses the profile's server name.
Neither extracts claims from arguments or arbitrary shell output, creates links,
or authorizes a binding. The reconciler must still check the existing run, source,
independent identity, issuance window and uniqueness required by contracts 01/03.
Old scan versions are ignored and rebuilt; user state is not migrated or deleted.

`core/interfaces/session-evidence.ts` adds native evidence beside A5, reusing a
single `ObservationView`. `core/interfaces/snapshot-v3.ts` is only the additive
public v3 type draft: the `universal` slots reuse core identities, metrics,
workspace, status, lifecycle and observation stamps. Any future v3 outlet must be
selected explicitly and use a separate path. `snapshot.ts`, its version 2 writer
and the existing `--json` path retain their fields, units and output bytes.
