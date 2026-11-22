# How the HUD works

The HUD serves Claude Code, Codex and pi on Linux/WSL inside herdr.
[The spec](./spec.md) defines the product; [the reference](./reference.md) describes
its controls. This page describes the current code, not an execution platform.
Earlier designs remain in git history and
[dated reviews](https://github.com/CartmanFatass/codex-hud/tree/universal-hud/docs/reviews).

## 1. The mental model in one screen

There are separate display and execution paths:

```text
Claude statusline input/transcript ─► statusline-parity ─┐
pi session events ─► p10k-footer ────────────────────────┼─► BarFacts ─► renderBar
Codex rollout/sqlite/git ─► HudStatus ─► index.ts ───────┘

client transcripts + HUD job files + project files
  ─► panel collectors ─► WorkboardSnapshot / ProjectSnapshot
  ─► optional stored model overlays ─► renderMonitor ─► terminal frame

main session ─► HUD MCP ─► job files + herdr tab
  ├─► external pi-roles + pi
  ├─► interactive CLI (grok / agy / claude / codex) + per-job supervisor
  └─► external jev-* browser CLIs
job-file / herdr events ─► on-demand watcher ─► pi-role-reap
```

The panel observes; it does not brief workers, accept work or chain roles. The main
session makes those decisions through the MCP. Its writes are the Control plane's role
places (§4.6) and the owner's three micro-actions on a HUD job (§6): focus its tab,
answer an open question, stop it. Models write only display text. There is no ledger database, resident execution host or owned
browser runtime.

CLI dispatch is `dispatchCli` in `src/mcp/thin-main.ts`. Kind flags,
trust-dialog text and decline keys, and startup quirks are the table in
`src/roles/cli-kinds.ts`. Before opening a tab, dispatch requires an explicit
local trust grant for Grok, Antigravity and Claude; missing, unreadable, malformed
or symlinked trust files do not grant trust. Codex skips this check, and the
other CLIs' screen-dialog checks remain in place. `packages/hud-mcp/bin/hud-cli.mjs` is the per-job
supervisor. Claude and Codex workers use the HUD MCP's worker-only surface; pi
loads the HUD extension explicitly and retains pi-roles' native async ask. The
shared worker protocol writes reports, check-ins and CLI questions and dispatches
only sonic children. Antigravity and Grok Build use the fallback scripts in
place of MCP tools. The HUD passes only model, effort,
the bypass flag and role `args`. Harness behaviour and session places are untouched.
`hud_create` validates explicit context file and report references before dispatch.
Local briefs list resolved paths and reference a registered project's optional `.hud/brief.md`.
Browser briefs include the paths and bounded file bodies, including that standing brief
if present, in the prompt sent to the selected browser service.

Claude's statusline, pi's footer and Codex's tmux bar (`src/index.ts`) are the client
integrations. One standalone panel (`src/tree-page.ts`) serves all three clients
via `/hud` (`hud panel`), writing its own snapshot and notifications when needed.
No panel opens at launch.

## 2. Repository map

| Path | Responsibility |
|---|---|
| `bin/` | Public launchers and Codex tmux helpers |
| `install`, `install.d/` | Core installer and selected client/prerequisite extensions |
| `src/mcp/thin-main.ts` | Main and worker stdio MCP surfaces; job dispatch |
| `packages/hud-mcp/bin/worker-tools.mjs` | Worker tools shared by MCP, pi and fallback commands; CLI report receipts bind the prompt's token to the fresh disk report |
| `packages/hud-mcp/bin/hud-watch.mjs`, `hud-cli.mjs`, `hud-jev.mjs` | On-demand reaper, CLI supervisor, browser-CLI wrapper |
| `src/roles/roster.ts` | Role definitions, assignments and convention, shared by MCP/Project |
| `src/cli/` | Panel, statusline, import and Codex compatibility commands |
| `src/index.ts`, `src/tree-page.ts` | Codex bar and shared panel loops |
| `src/collectors/` | Disk/sqlite/git observations and display generators |
| `src/render/` | Pure bar/panel rendering, input state, themes and EN/ZH labels |
| `src/settings.ts`, `src/settings-runtime.ts` | Validated saved settings and display configuration |
| `src/snapshot.ts`, `src/notify.ts` | Snapshot and optional notifications |
| `integrations/` | Client/skill assets consumed by the installer |
| `tests/unit/`, `tests/fixtures/` | Behaviour tests and synthetic data/frames |

## 3. Launch and installation

`./install --with claude,pi,codex,browser,herdr` validates selected extension names,
checks Node, then runs prerequisite hooks before any build or filesystem change.
Core is always included. The default builds the HUD and MCP together into `dist/`; `--skip-build` uses
existing outputs. Commands link into this checkout/extraction, and client bindings
also retain its path: keep that directory. Runtime launchers and the panel reload
probe hold a per-checkout lock while loading their initial `dist/` module graph.
The builder takes that lock only to publish or clean `dist/`, not to compile.
A timed-out launcher fails rather than importing a partial build.

The installer backs up edited client files, uses official registration commands
where available, and never edits shell rc files. `hud uninstall` invokes `./install --uninstall`, removes owned bindings
and command links, and retains HUD data. See [installer extensions](../install.d/README.md).

**Node floor: ≥24.0.0. Node 24 is the tested supported line.** Root/MCP package
engines, installer and command launchers share this floor. Earlier Node versions
are not supported, even if individual APIs or dependencies work there.

- The full suite on Node 22.13.0 failed five watcher tests: four link-loop cases
  depend on Node 24's `watch error: ELOOP` behavior, and the unreadable-sessions
  working-tab case did not settle. Node 22's watcher behavior is not qualified;
  a SQLite-only API floor is insufficient for the shipped product.
- [Node 24's filesystem documentation](https://nodejs.org/docs/latest-v24.x/api/fs.html#fswatchfilename-options-listener)
  describes the watcher API. The release is rehearsed on Node 24 with an isolated
  offline build and client stand-ins, not a claim of real-client validation.
- `collectors/daemon-binding.ts` uses `node:sqlite` for best-effort read-only Codex
  binding. `utils/panel-reload.ts` still feature-detects `process.execve` and keeps
  its signal-forwarding fallback; neither lowers the supported product floor.
- Locked runtime dependencies `chokidar` 5 and `readdirp` 5 require **≥20.19.0**;
  the locked build tools need no higher floor than the product (see `package-lock.json`).

`hud codex` runs the existing `bin/codex-hud` tmux launcher. It creates a session
for the cwd and selected `CODEX_HOME`, starts Codex unchanged, and opens the 1-line bar.
The launcher forwards Codex arguments and `CODEX_HOME`; explicit `--attach` reuses a session.
The read-only herdr observer checks the designated main pane, not whichever pane
is focused. No global tmux configuration is required. `/hud` opens the standalone
herdr sidebar panel (`hud panel`).

## 4. Collecting data

### 4.1 Finding the Codex session

`SessionFinder` tries the pane's process/daemon connection in `logs_2.sqlite`,
shell snapshots after launch, then bounded cwd rollout candidates. Daemon binding
anchors to explicit startup records and periodically rechecks PID/start time;
replacement clears the connection and cursor. A shell snapshot's `TMUX_PANE`
may name the daemon, not the client: never use that value as a client binding.
SQLite is read-only and best-effort; unavailable evidence remains unknown.

`hud panel` can explicitly select a root or a harness/session/source. Otherwise,
with `HERDR_PANE_ID` set, `claudeCallerSession` asks `herdr pane current` with a
one-second budget. A Claude UUID locates an existing transcript in the configured
projects directory: cwd slug first, then at most 256 immediate entries. Explicit
selection wins. Missing evidence leaves an unbound jobs view; the statusline
writes no pane-keyed binding. Selection is for display, not execution authority.

### 4.2 Parsing rollouts

`RolloutParser` retains byte offsets and open calls across JSONL batches. Reads
handle CRLF, final records without a newline, split UTF-8, shrink and inode
replacement. `utils/parse-queue.ts` serializes parses per file; file signatures
avoid unchanged reads. `buildSubagentTreeYielding` yields between files and shares
the scan cache under `$HUD_HOME/display/scan/`. Changing what the scan reads requires
a `SCAN_VERSION` bump. A parse and a SQLite statement are not preemptible.

### 4.3 Main-session facts

`HudStatus.build` combines rollout, Codex config, context, token-rate, quota and
cached project/git facts into `HudData`. The panel passes its existing tree and
skips the bar's Git refresh; Project and Changes own their on-demand probes.
The output-rate estimate uses current-turn output-token deltas divided by elapsed
time minus the union of known tool waits; it includes initial latency and stalls.
It is not exact request telemetry, and unchanged counters do not refresh it.
Missing facts are absent, not fabricated zeroes.

### 4.4 Native agents

Codex descendants come from the incremental rollout tree. `ClaudeNativeTree`
reads selected-session `subagents/agent-*.meta.json` and JSONL: at most 401 directory
entries, 200 agents, four forward reads per refresh, 8 KiB metadata and up to
1 MiB transcript each. Separately, up to 16 first-seen transcripts over 64 KiB
get their last 64 KiB and metadata read for the first card view, then join forward
replay on later refreshes. Preview text is local display only; forward replay
retains public Agent/Task call ids to establish nesting. Partial records carry
across forward passes, up to 4 MiB;
oversized records and deferred/unreadable evidence mark coverage incomplete.
Shrink/replacement clears prior evidence and replays. Unmatched nested cards wait
while candidate parents replay, then appear at top level if still unmatched.

Completion is provisional: observed transcript growth reopens a completed Claude
agent; fresh finished metadata or a caught-up public `end_turn` with no open tool
calls settles it again. Replay preserves prior metadata lifecycle and settlement
age but blocks sentence requests until caught up. pi helpers are HUD jobs, not a
separate native tree.

### 4.5 Jobs and workboard

Home's workboard has exactly two live sources: thin jobs in `$HUD_HOME/jobs/`
for the caller pane and the selected main session's native Claude/Codex `SubagentTree`
(§4.4). `PanelJobPipeline` reads the jobs through `readThinJobs` and passes both
sources to `buildWorkboard`. `DiffStatCollector` adds a bounded Git diff on demand
for an inspected thin job, and `ActivityRings` records observed writes in memory;
neither supplies workers. Failed or incomplete reads are not evidence of absence.

The panel does not poll `herdr agent list`, scan workspace `tmp/tasks/`, or read
retired `$HUD_HOME` observation records such as `assoc/`, `native-relations/` and
`jev-runtime/`. Existing records are left in place. `CODEX_HUD_PANEL_ALL_DELEGATIONS`
is ignored; it does not widen the pane scope.

`readThinJobs` selects the newest 200 job directories and filters to the caller's
recorded pane. It excludes jobs settled before the panel's original `openedAt`
before reading their artifacts or planning model requests. Active/unknown jobs
remain eligible. It reads job/STATUS, brief heading, report, newest review and QA.
Only settled jobs expose worker metadata whose report signature still matches. The summary is their result line
and matches the Home filter; the Inspector shows up to 12 reported paths as text only when no Git changes are shown.
Single-job reads reuse the summary and file list. Task notices use the summary and wait for HUD-run checks, reporting only the outcome; watch and
`changes` lines and list reads carry only a clipped summary. Metadata writes do not wake `hud watch` on their own.
Working-session target mtime contributes activity without an extra body read.
The thin-job signature cache is shared disposable display state, never job authority.
Job directory enumeration/stat/ranking still grows with retained history; the body
limits are not a claim of constant total scan cost.

Home has package lanes plus one lane per native main session. Direct native children
are cards, their children indent one level, deeper descendants say `↳ parent`.
`work-visibility.ts` owns shared lifetimes: settled cards fold after 5 minutes and
hide after 15 by default (failed/stopped at least 30); `a` reveals older items in
place. Decisions hide after 30 minutes, departures after two hours. Enter toggles
cards/questions/decisions; only the newest current settled card opens automatically,
and explicit choices win. All states and lifetimes are presentation, not acceptance.

### 4.6 Project, Control and Changes

`ProjectCollector` reads STATE, spec milestone, reviews, roles/convention/instructions,
key-presence booleans, local tickets, current jobs and Git/worktree facts. Full reads
run only while Project is shown without a modal. Home reads the same progress facts, not the control plane or working-tree diff. STATE, spec, try records, tickets and the newest 64 job directories are signature-cached; the last 64 commit subjects are cached by checkout HEAD SHA. Tickets come from `.scratch/<feature>/issues/<NN>-<slug>.md` (64 feature directories, 512 files total, 64 KiB each). Derive ticket states and resolve local and cross-feature dependencies before limiting detail to open features plus the newest finished ones up to 16. No collector writes project files.

The panel owns one `ProjectCollector` per project the Project tab has shown
(`ProjectVisits`: at most four, its own never dropped, the oldest other one first) and
collects only the shown one; the chosen root is `MonitorState.projectRoot`, so it
survives the self-reload, and Home reads the panel's own collector only. While the
Projects list is open (`MonitorState.projectList`) the shown project's full collection
pauses and `ProjectOverviews` reads every listed root lightly: one Home-mode collector
per root (file signatures, no Git, no roles) and one `liveCwds()` pass over the newest-64
job lookup, counted per root, at most once per five seconds while the list stays open;
the panel attaches each result to its `ProjectChoice`. A root just switched to has no
snapshot until its first collection: `ProjectVisits.shown` then gives the previous one,
with its root, so the first frame is the old page and never a blank one.

Project and `WorktreeCollector` use gated asynchronous Git reads; Changes runs only
when focused and probes worktrees round-robin. Repository commands/filters and lazy
fetching must not execute just to draw status. Git failure is unknown, never clean.
Project opens files through the existing `$EDITOR` herdr-tab action.

`hud board` and the panel's `w` write one static HTML review board (`render/html-board.ts`, pure: collected facts in,
one escaped, script-free page out; `cli/board.ts` collects once with a fresh `ProjectCollector` and the stored `TryBriefs`,
and writes with `writePrivateFile`). No model call, no server; its text and sections are in the reference.

Control is a top-level tab. It follows Project's selected root, but has its own cursor, folds and scroll. Its narrow `ProjectCollector` mode reads only that root's Control facts (no STATE, tickets or Git worktree/status collection) and caches them separately from Project's snapshot. Unlike Project's hub, Control never paints the previous root's snapshot while a new root loads. Local model list discovery starts only on entering Control or refreshing (`r` in Control, Ctrl+R in the picker), not on Home or on a collection tick.
`roles/role-control.ts` has both halves: `controlFacts` (read-only, called by the collector:
each role's active/standby/off/exhausted/missing places and the machine's Harnesses inventory) and
`editPlaces` (role and quota edits). `roleRegistry.assignment` resolves the chain for Control, roster and create;
Control's Harnesses preview also uses that evaluation to show what a switch would change. Local pi
settings (bounded, signature-cached) and the unfiltered discovery cache supply provider attribution.
Dispatch checks the selected place's thinking support before opening its tab. For pi, the picker cache can
establish that only `off` is supported; an offline, sessionless Pi metadata probe supplies exact levels when available.
This does not refresh the picker or make a model request. The `harness-switch` action updates only
`$HUD_HOME/harnesses.json` (`disabled`) via `roles/harness-switches.ts`, by private atomic replacement. Machine switches never rewrite role files. The in-place chain editor
(`render/chain-input.ts`) works on an in-memory draft of raw places and uses snapshot facts for
its preview. The field sheet embeds the pi picker (`render/model-input.ts`), which returns
a model ID to the sheet, not to disk. Save sends one
`preset-edit` with the whole chain and the captured role revision; `tree-page.ts` applies it through
`editPreset` and the existing atomic role writer. Project-pinned roles are read-only; target changes
that would lose launch options are refused. `editPlaces` handles preset cycling and immediate quota
clears separately. Pi's picker groups
one list of exact IDs from the unfiltered discovery cache, skipping off providers for display only.
Discovery keeps the last successful list and timestamp per source. The same cache holds optional
pi capability facts from the same `pi --list-models` call and supplies unfiltered provider attribution.
The bottom strip uses those facts, the existing switch and exhaustion evidence, and the frame clock. A successful empty pi list supersedes the previous list; only the
absence of any successful pi result uses the limited offline catalog. What is on screen needs no new
data: the hub's Latest and Progress's History order by the commit dates the ledger read
already carries, and the Projects list's second row is `ProjectOverview.latest`.
The next `hud_create` reads the same files. Keys are reduced
to name/presence booleans, never retained as values. Browser availability is only a
PATH check for Chrome and `jev-ask`, not a login/health claim.

## 5. Optional model features

Collection builds bounded public input; rendering reads stored overlays only.
There is one Model text master switch. Without a saved preference it defaults on
when a Mistral, OpenAI or Gemini key exists; text still requires a matching endpoint
key, and decisions separately require a keyed decision provider. Master off sends
nothing and hides overlays without deleting caches. Reasoning/private channels and
sealed tasks never become model input. Referenced transcript paths are not followed.

`SmallModel.submit` owns a single-flight chat queue, cancellation, cache and shared
LLM reservations under `display/model-cache/`. Endpoint identity includes the actual
model but never a key. Exact Mistral/OpenAI HTTPS origins receive only the matching
key from the environment or private HUD credential file; custom origins get neither.
Userinfo and redirects refuse. Wrong-language text is rejected rather than cached.

| Feature / collector | Public input that can leave the machine |
|---|---|
| `JobSentences`, thin jobs | A current worker summary (≤160 Unicode code points) needs no request in the panel's language; translation sends only that summary. Otherwise: brief title/goal (1500-byte head), state/phase, question (2 KiB), review verdict, settled report excerpt (4096 UTF-8 bytes), four public text/tool blocks from a safe 32 KiB working-session tail |
| `JobSentences`, native agents | Name/role (80 chars each), task/charge (400), report (600), action (200), final result (8000 head/tail), error (2000); a settled Codex agent may use one safe 32 KiB tail |
| `TryBriefs` | One call per to-try slice, while Home or Project is shown (newest 12 slices): its ledger line, up to 5 commits' messages (1200 chars each), up to 4 ticket files (3000 bytes each) under a `.scratch/<slug>/` the line names |
| `WaitingBriefs` | Wrong-language prose only: first 8 STATE waiting items (≤2 KiB each), open QA question, context, options and default (≤4 KiB), open ticket titles (≤512 bytes each). Batch ≤25 strings / 4 KiB; `waiting-briefs.json` caches by language and text hash. Display copies carry translations; the answer action always uses original options. |
| `DecisionTitles` | Only for an inspected job's answered question in Files: question and answer, 4096 bytes each; one response includes ≤8-word title and localized question/answer/instead/why |
| `DecisionLabels`, outcome/kind | Final state + the same settled report excerpt (4096 UTF-8 bytes), or brief title/goal (1500-byte head); once per settlement/job respectively |
| `DecisionLabels`, looping | Latest 12 public tool/result pairs, 600 chars each part, from the same safe session tail |
| `DecisionLabels`, question/review | Current open question head (4096 bytes), or ≤24 list items of 400 chars from a 32 KiB review head |
| `HomeRecommendation` | ≤200 cards' ids, lanes, state, role (80), title (160), age, sentence/reason (240, can include the worker summary), question flag and outcome; no file bodies |
| Sonic auto-thinking | First 4000 characters of the dispatched task, plus sonic role scope and thinking purposes; no standing brief or referenced files |
| Settings Test API | Fixed synthetic messages only |

`JobSentences` replaces separate native labels/digests/causes/progress schedulers;
there is no agent-log writer. Names and keyword-marked sentences share a request.
Both settled-report consumers take a short report head plus sections on incomplete
work, blockers, failures, tests/checks or open questions, or the tail if there are no
such sections. The excerpt uses a safe scan of at most the first 32 KiB and, if needed,
the last 16 KiB. Outcome is the Decision API's independent display judgement.
Running changed inputs follow Summary interval (default five minutes). A thin job
clears its running sentence on settlement and is immediately eligible for a final
request; failed final attempts retry no sooner than two minutes. Native finals keep
the two-minute floor. Finals freeze after one success per settlement. At most three
pending sentence handles share the service. `DecisionTitles` uses the same queue;
its revision/language-keyed cache survives reopen.
`TryBriefs` (`collectors/try-brief.ts`) is the same shape for the slices still to try: one call writes a brief and acceptance
steps from the ledger line, its commits and tickets; stored per slice and language under a hash of that input, laid on the
ledger rows only while the ledger line is unchanged (`LedgerSlice.brief`), so an unchanged slice costs no call and a pending,
failed or master-off state leaves the original text. The panel shows a briefed slice as its id and the brief's first sentence on one row, and
in its preview (Split) or expanded row (Classic) the whole brief, the steps and the original ledger text folded below them
(`project-view.ts` `tryDetailRows`, `landedInline`); `tryCount` reports pending milestone tasks or individual `try` slices, according to Detail.
Waiting, the Progress row and the Projects list use the same unit. Keyword painting is shared by
cards, decisions and Inspector (`utils/keyword-marks.ts`), never lifecycle evidence.

Decision labels and Home ranking use `selectDecisionProvider`, not the chat endpoint.
Settings → Decision API persists `config.json.decisions.primary` (default OpenAI).
Automatic fallback chooses another keyed provider in Gemini → OpenAI → TypeSafe
order; one fallback covers missing credentials, quota/auth/5xx/timeout, not malformed
answers or refusals. Gemini quota replies impose an in-memory cooldown. Labels store
revision-keyed enums and translate locally; provider failures show no raw HTTP text.
Recommended Home ranks cards without hiding questions/failures/human-needed cards or
breaking native subtree order. A separate chat request writes its short progress brief.

LLM cap defaults to 60/hour; Decision cap defaults to unlimited (`0`). Both reserve
atomically across panels on one local HUD home and still count unlimited calls.
Decision fallback HTTP attempts count separately. Settings derives per-feature counts
from those logs. Coordination failure refuses, not bypasses accounting. Connection
probes use the ordinary cap. No old recap, session-title, approval-description or
change-summary generator runs.

## 6. Rendering and input

All three bars collect `BarFacts`; `render/layout/bar-fields.ts` fits and paints
model/effort, context, repo/branch, client quota (pi cost in its ribbon), output rate
(Claude and Codex; pi keeps its ribbon reading), event notices and loaded counts.
Missing facts disappear. Notices retain starts/completions/failures and Claude skill loads
for three minutes, with open questions/approvals pinned. No tool-at-work line or clock
appears in the bar. Styles are line,
p10k, gauge, tide, micro, stacked, headline and triptych; Stacked is two rows in
Claude/pi, with the one-row Codex pane falling back to line.

`renderMonitor` always uses `renderWorkboardFrame`: Home, Project, Inspector, Changes,
Settings and Help share exact-width rows, one title band and whole footer hints.
Callers without a workboard project native cards into the same Home renderer. There
is no secondary stacked/compact Agents renderer, Timeline or diagnostics page.
The `split` layout (`panelLayout`, `render/split-*.ts`) draws Home, the hub and the list pages as a list over a preview:
one scene per view (`split-home.ts`, `split-project.ts`), one painter (`split-frame.ts`) and its own keys (`split-input.ts`);
`renderWorkboardFrame` and `workboardInput` only branch to them, and what Split does not draw stays Classic's.
The list is as tall as it needs, at most `MonitorState.splitRatio` of the list-and-preview rows (`=` `+` `-`,
`resize` in `split-input.ts`; keys only, no divider drag, so `tree-page.ts` asks the terminal for clicks and the wheel (mode 1000) and no motion reports; the state travels in the
reload's JSON), and three rows around the cursor while `splitFocus` is `preview`. A preview with more rows than its room
(`splitScrolls`) is built again one cell narrower and paints its scrollbar in the freed last cell; a Home lane at work that
the cursor is not on may add a cue (`laneCue`) to its row.
A key has one meaning per page (`n` is only `try-flag`; `>` `<` move between Home's cards that need you; `i` and Delete
add and remove a place, `+` `=` `-` are only `list-grow` / `list-shrink`; the decoder names each once and
`tests/unit/panel-keys-rows.test.mjs` checks Help lists each key once per section). A footer's keys come from the selected row
(`homeKeys` in `job-actions.ts`, the `hints` a split scene returns): per-hint words are in `split-i18n.ts`, and
`footerLayout` translates a footer hint by hint, so a new hint is one entry, not one whole line per combination.
Rows that have to fit 40 columns keep what identifies them: `cutWords` cuts at a word, `briefStack` gives a briefed
row's sentence its own line when the id is long, and `placeRows` (`control-view.ts`) shows a place's model by short name
on the row, or on a second line before it cuts the name.
The owner's micro-actions on a HUD job (`render/job-actions.ts`, spec §2.2) are pure input: `g` (on a job's row) becomes
`focus-job-tab`; `1`–`4` and `d` on an expanded question slab (or in the Inspector) pick an option or the worker's
default and become `answer-job` (the digits switch no tab, so they mean nothing elsewhere: tabs are ←→, Tab and a click); `X` opens the stop-confirmation overlay, whose `y`/Enter becomes
`stop-job`. Any other input cancels the stop prompt. `tree-page.ts` does the I/O: `focusJobTab` and `stopJob`
(`cli/panel-pane.ts`: `herdr tab focus`, `pi-role-reap`) and `answerJobQuestion` (`collectors/panel-actions.ts`), which
writes `qa/qN.answer.md` once (`wx`, like `hud_respond`) and appends the answer to `$HUD_HOME/panel-actions.jsonl`.
`PanelActionLog` turns those records into `[role@job] ANSWERED qN from panel: …` lines for `hud watch` and the MCP
`changes`, as the try log does: only answers made while the reader runs.
The `/` filter (`render/filter.ts`, `MonitorState.filterQuery`/`filterOpen`; the kept query survives reload) is pure input plus a pure match: `filterInput`
runs first in `handleMonitorInput` and owns the keyboard while the bar is open, and a change of `filterScope` (Home, or Progress/Tickets of one
project) clears it. The views are filtered, not their rows: `renderWorkboardFrame` hands Home a `visibleWorkboard` of the matching cards and
Progress/Tickets a `filterProject` snapshot, so Classic, Split, the cursor and `workboardInput` all see only what matches. The bar is a
pinned row under the header (a Split note), never a scrolling one.
Always retain `frame.state`: reconciliation preserves selection by identity and
separate scroll/fold state. Cards show a title plus two sentence rows, expanding
in place; raw workflow files open from the Inspector or `o`.

Settings → Panel → Layout (`panelLayout`) defaults to Classic (`home-view.ts` and `project-view.ts`);
Split is the other choice. Both layouts share the Space marks and `y`/`n` batch action for to-try rows.
Marks belong to the open view. A batch appends one record under `$HUD_HOME`, never to project files.

All standalone panels decode their own keys and SGR mouse events through
`WorkbenchInputDecoder('workboard')`. Mouse hit testing uses the same frame controls.
`frame-diff.ts` writes changed rows with absolute positioning and erases each row
before writing (erasing after a full-width row would wipe its last cell).

The panel polls its own installed entry signature per collection. A change must be
quiet for two seconds and pass a bounded child import before reload. Dirty Settings, an open filter,
stop confirmation and Control/EXP editors delay replacement. The transient `MonitorState.overlay`
is never sent to the next process; a clean chain view returns to its role row. `render/monitor-state.ts`
holds these reload rules and the input rule for unnamed keys (including `/` and `g`). A bad generation
leaves the old panel running. Restart preserves
argv/env, view/selection/scroll/expansion, Settings cursor, opening time and width
override. `process.execve` replaces the process when available; otherwise one
signal-forwarding supervisor handles restart-exit handoffs without nested parents.
Shutdown cancels generators, timers, input/lifetime listeners and snapshot ownership.

## 7. Settings and state on disk

`settings.ts` validates a ≤64 KiB private settings file at `$HUD_HOME/hud-settings.json`
(or `HUD_SETTINGS_PATH`). Saves use temp-file + 0600 + rename. Display settings override
environment defaults once saved; `NO_COLOR` always wins. Unknown retired keys are
ignored and dropped on save, not migrated into new permissions.

Settings has four open groups: Display, Panel, Models, Codex. It edits a draft;
`s` saves, `r` resets that group, `t` probes the API. Dirty navigation asks save,
discard or continue; failed saves retain the draft. Width applies to tmux/herdr
panels on Save and containing-window resize, not unrelated saves or border drags.

| Path under HUD home | Contents / writer |
|---|---|
| `jobs/<job>/` | Plain job/brief/STATUS/report/QA and session links; MCP, pi-roles, CLI supervisor or browser wrapper |
| `jobs/<job>/report-meta.json` | Optional private 0600 worker summary and file list, bound to `report.md` by signature; no lifecycle, checks or outcome authority |
| `roles/`, `hud-convention.md` | Owner overrides; read by roster; `roles/<role>.json` places are also written by the Control tab |
| `exhausted.json` | Quota marks on places until the parsed reset (1 minute to 24 hours; 1 hour by default); cleared by the Control tab |
| `credentials.env`, `config.json` | Owner keys and Decision API/configuration |
| `display/state/<session>.json` | Active Codex bar/panel snapshot; atomic inode ownership prevents outgoing writers deleting replacements |
| `display/state/claude-quota.json` | Last reported quota windows only; optional private cache from Claude statusline stdin |
| `exp/config.json`, `exp/proxy.json` | Private EXP settings and the bound Codex profile's quota snapshot (windows, binding revision, observation time and retry state) |
| `exp/codex-native-<profile hash>.json` | Last native MyHUD bar observed for that canonical local Codex profile (opt-in) |
| `exp/ledger-<account>.jsonl` | Append-only private API grant events; a per-ledger writer lock excludes duplicate IDs, and reads deduplicate legacy entries |
| `display/scan/`, `display/thin-jobs.json` | Rebuildable observation caches |
| `display/model-cache/` | Shared text replies/reservations and revision-keyed overlays; Decision reservations have their own subdirectory |
| `display/profile.log` | Optional stage timings |
| `panel-actions.jsonl` | Append-only 0600 log of answers the owner gave from the panel; read by `hud watch` and the MCP `changes` |
| `watch.pid`, `watch.log` | On-demand watcher PID and diagnostics |
| `archive/YYYY-MM.jsonl` | Private, append-only job facts written by the watcher before retention deletes a job; no reader or expiry |

An EXP-enabled pi footer draw initiates asynchronous snapshot collection. A per-HUD-home Linux abstract socket excludes concurrent refreshes; the bounded Codex app-server stdio request is only for account rate limits, not inference. The panel reads the snapshot but never starts refreshes. Pi keeps direct subscription windows in memory for the current request only.

Pi history lives in pi's own session store; job directories contain links. The watcher
reaps finished tabs, keeps failed tabs for two hours, and deletes settled job directories
one day after closure on a later scan, not a dedicated expiry timer. Before deletion
it moves legacy real JSONL sessions to pi's store; failures retain the job. No session-link
target is deleted. CLI sessions stay in that CLI's store. An open CLI job is also checked
on `HUD_WATCH_CLI_CHECK_MS` (default 30 s); a dead supervisor with a live worker hands the job to the main
session (`waiting_orchestrator`), and `hud_send` restarts it. It exits
with no open job or failed deadline; a later create restarts it.
No HUD collection writes into Codex's transcripts/configuration; explicit installer
registration and `hud import` are separate user actions.

## 8. Rules every change keeps

**Rendering**

- Every panel line is exactly `width` columns: measure with `visualLength`, cut
  with `truncateAnsi`, not UTF-16 length. The bar remains English-only.
- External text passes through `monitorText` once; never sanitize the panel's own ANSI.
- Panel words go through `t()` with EN/ZH entries. Colours use theme roles,
  including `theme.board`, not raw escapes; `none` emits no colour.
- Controls use words or icons, not shortcut letters as their labels; glyphs have
  meaningful accompanying text. Footer shortcut hints remain whole when fitted.
- Drop optional fields before cutting; missing evidence stays absent/unknown.
  Cards use observations plus optional stored model text, never an inferred verdict.
- Rendering is pure: pass `nowMs`; do not perform I/O, request a model or advance
  lifecycle during paint. Click geometry uses the same frame clock.

**Collection**

- Rollout offsets are bytes; parses go through the single-flight queue.
- SQLite is read-only and best-effort. Scan changes bump `SCAN_VERSION`.
- Failed reads yield null/unknown, never a fabricated zero or clean state.
- Status collection must not run repository-provided Git commands/filters or fetch.
- Keep collection bounds and incomplete-coverage facts; do not claim bounded body
  reads make directory enumeration or native-session totals constant-cost.

**Privacy and repository**

- The Model text master switch controls display requests; chat also requires a matching endpoint key. Sonic auto-thinking has its own explicit Decision API switch, independent of Model text, like the quiet-job dispatch path.
- List every new outbound model input here and in both reference languages.
- State is private: `writePrivateFile` or equivalent temp-file/0600/rename.
- Preserve owner configuration, keys, history and unrelated state.
- Tests, fixtures, logs and README examples use synthetic data only.

## 9. Tests and tooling

```sh
npm run build
npm run build:test
npm test
npm run check:fixtures
npm run snapshots:update
```

Both test suites import the app from `dist/`. `build:test` needs the declarations from `npm run build`
and emits only TypeScript tests and fixtures under `dist-test/`. `npm test` runs both builds in that order,
then the default unit runner and the `.mjs` suites. Snapshot updates are explicit: inspect their diff; normal tests do not
rewrite frames. Tests use temporary homes, fixed clocks and synthetic data;
render checks compare terminal cells, not font pixels. Restore display/language
state in `finally`. A real client/browser check remains separate from fixtures.
CI runs `npm test` and fixture checks on Node 24 with and without colour.
For a clean regression run, use `npm run clean` before testing in an isolated
checkout, not one serving a live panel.

`CODEX_HUD_PROFILE=1` appends stage timings to `display/profile.log`.
Performance evidence names host and workload; it is not automatically WSL qualification.

## 10. Recipes

- **Setting:** add type/default/validation in `settings.ts`, a row in
  `render/settings-page.ts`, mapping through `monitorSettings` if needed, EN/ZH
  labels, behaviour tests and both references. No retired card-visibility layer.
- **Theme:** add its name/order in `hud-config.ts`, palette/board inks in
  `palette.ts`, translations and contrast/frame tests. Keep 4.5:1 card text,
  4:1 failed/question text and 3:1 selected-row floors.
- **Bar field:** add facts and a builder in `layout/bar-fields.ts`, its field
  list and fitting-ladder position, then each client's available facts. Test widths.
- **Card/Inspector:** external prose is sanitized and wrapped; stored model text
  may decorate a card, never decide its state. Test narrow widths and both languages.

## 11. Gotchas

- Panels reload after a valid build; bars still need restarting for new code.
- Saved display settings override environment defaults; `NO_COLOR` still wins.
- A report's existence is not proof of success; model text is not a workflow verdict.
- Codex encrypted tasks have no public text to summarize. Do not send ciphertext
  or invent a task from a nickname; public pre-create charge is usable when present.
- LLM/Decision caps are shared local-filesystem coordination, not provider billing.
- Moving/removing the installed checkout breaks path-bound command/client links.
