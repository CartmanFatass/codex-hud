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

main session ─► six-tool MCP ─► job files + herdr tab
  ├─► external pi-roles + pi
  └─► external jev-* browser CLIs
job-file / herdr events ─► on-demand watcher ─► pi-role-reap
```

The panel observes; it does not brief workers, answer questions, accept work or
chain roles. The main session makes those decisions through the MCP. Models write
only display text. There is no ledger database, resident execution host or owned
browser runtime.

Claude's statusline and pi's footer are client integrations. Codex's tmux display
has two entries: `src/index.ts` (bar) and `src/tree-page.ts` (panel). In that tmux
session the panel replaces the bar; the active process writes the snapshot and
notifications. A herdr panel opened for Claude/pi is separate from their statusline.
No panel opens at launch: `/hud` opens it in Claude/pi, F12 in Codex.

## 2. Repository map

| Path | Responsibility |
|---|---|
| `bin/` | Public launchers and Codex tmux helpers |
| `install`, `install.d/` | Core installer and selected client/prerequisite extensions |
| `packages/hud-mcp/src/thin-main.ts` | Six stdio MCP tools and job dispatch |
| `packages/hud-mcp/bin/hud-watch.mjs`, `packages/hud-mcp/bin/hud-jev.mjs` | On-demand reaper and external browser-CLI wrapper |
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
Core is always included. The default builds the HUD and MCP; `--skip-build` uses
existing outputs. Commands link into this checkout/extraction, and client bindings
also retain its path: keep that directory. The installer backs up edited client
files, uses official registration commands where available, and never edits shell
rc files. `hud uninstall` invokes `./install --uninstall`, removes owned bindings
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
for the cwd and selected `CODEX_HOME`, starts Codex unchanged, and opens the bar.
F12 uses `codex-hud-toggle` to replace bar/panel; the replacement is checked alive
before the old pane is killed, under a tmux lock. `codex-hud-keys` owns the HUD's
prefix table; `codex-hud-command` delivers panel commands through the input stream.
The launcher forwards Codex arguments; explicit `--attach` reuses a session.
The read-only herdr observer checks the designated main pane, not whichever pane
is focused. No global tmux configuration is required.

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
entries, 200 agents, four changed/replaying agents per refresh, 8 KiB metadata
and up to 1 MiB transcript each. It retains public Agent/Task call ids to establish
nesting across long transcripts. Partial records carry across passes, up to 4 MiB;
oversized records and deferred/unreadable evidence mark coverage incomplete.
Shrink/replacement clears prior evidence and replays. Unmatched nested cards wait
while candidate parents replay, then appear at top level if still unmatched.

Completion is provisional: observed transcript growth reopens a completed Claude
agent; fresh finished metadata or a caught-up public `end_turn` with no open tool
calls settles it again. Replay preserves prior metadata lifecycle and settlement
age but blocks sentence requests until caught up. pi helpers are HUD jobs, not a
separate native tree.

### 4.5 Jobs and workboard

`PanelJobPipeline` reads passive task/job observations and calls `buildWorkboard`.
Task artifacts are bound to an explicit workspace; no cwd/name join grants a task
authority over a facade job. Source capacity is 200; bounded artifact/QA readers
and persistent cursors retain incomplete coverage rather than inventing absence.
Shared readers use stat signatures; unchanged warm artifacts need no body read.

`readThinJobs` selects the newest 200 job directories and filters to the caller's
recorded pane. It excludes jobs settled before the panel's original `openedAt`
before reading their artifacts or planning model requests. Active/unknown jobs
remain eligible. It reads job/STATUS, brief heading, report, newest review and QA.
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

### 4.6 Project and Changes

`ProjectCollector` reads STATE, spec milestone, reviews, roles/convention/instructions,
key-presence booleans, local tickets, current jobs and Git/worktree facts. Full reads
run only while Project is shown without a modal. Home reuses only cached STATE and
ticket facts for its spare-row progress block; cards always get space first.
Tickets come from `.scratch/<feature>/issues/<NN>-<slug>.md`, at most 16 features ×
64 files, 64 KiB each; dependencies and checked criteria determine display state.
Jobs enrich ticket rows but cannot complete tickets. Project's job join reads
job/STATUS bodies in the newest 64 directories; only matching tickets need brief bodies.

Project and `WorktreeCollector` use gated asynchronous Git reads; Changes runs only
when focused and probes worktrees round-robin. Repository commands/filters and lazy
fetching must not execute just to draw status. Git failure is unknown, never clean.
Project opens files through the existing `$EDITOR` herdr-tab action. Keys are reduced
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
| `JobSentences`, thin jobs | Brief title/goal (1500-byte head), state/phase, question (2 KiB), review verdict, four settled report lines, four public text/tool blocks from a safe 32 KiB working-session tail |
| `JobSentences`, native agents | Name/role (80 chars each), task/charge (400), report (600), action (200), final result (8000 head/tail), error (2000); a settled Codex agent may use one safe 32 KiB tail |
| `DecisionTitles` | That job's question and answer, 4096 bytes each; one response includes ≤8-word title and localized question/answer/instead/why |
| `DecisionLabels`, outcome/kind | Final state + first 12 report lines (4096-byte head), or brief title/goal (1500-byte head); once per settlement/job respectively |
| `DecisionLabels`, looping | Latest 12 public tool/result pairs, 600 chars each part, from the same safe session tail |
| `DecisionLabels`, question/review | Question head (4096 bytes, ≤100 per job), or ≤24 list items of 400 chars from a 32 KiB review head |
| `HomeRecommendation` | ≤200 cards' ids, lanes, state, role (80), title (160), age, sentence/reason (240), question flag and outcome; no file bodies |
| Settings Test API | Fixed synthetic messages only |

`JobSentences` replaces separate native labels/digests/causes/progress schedulers;
there is no agent-log writer. Names and keyword-marked sentences share a request.
Running changed inputs follow Summary interval (default five minutes); finals keep
a two-minute floor and freeze after one success per settlement. At most three
pending sentence handles share the service. `DecisionTitles` uses the same queue;
its revision/language-keyed cache survives reopen. Keyword painting is shared by
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
model/effort, context, repo/branch, client quota (pi cost in its ribbon), event notices
and loaded counts. Missing facts disappear. Notices retain starts/completions/failures
and Claude skill loads for three minutes, with open questions/approvals pinned.
No tool-at-work line, clock or output rate appears in the bar. Styles are line,
p10k, gauge, tide, micro, stacked, headline and triptych; Stacked is two rows in
Claude/pi, with the one-row Codex pane falling back to line.

`renderMonitor` always uses `renderWorkboardFrame`: Home, Project, Inspector, Changes,
Settings and Help share exact-width rows, one title band and whole footer hints.
Callers without a workboard project native cards into the same Home renderer. There
is no secondary stacked/compact Agents renderer, Timeline or diagnostics page.
Always retain `frame.state`: reconciliation preserves selection by identity and
separate scroll/fold state. Cards show a title plus two sentence rows, expanding
in place; raw workflow files open from the Inspector or `o`.

Codex prefix commands arrive through `codex-hud-command` and the input decoder in
stream order. Outside modal pages, ordinary input/paste forwards to Codex; standalone
panels consume their own keys. Mouse hit testing uses the same frame controls.
`frame-diff.ts` writes changed rows with absolute positioning and erases each row
before writing (erasing after a full-width row would wipe its last cell).

The panel polls its own installed entry signature per collection. A change must be
quiet for two seconds and pass a bounded child import before reload. Dirty Settings
delay replacement; a bad generation leaves the old panel running. Restart preserves
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
| `jobs/<job>/` | Plain job/brief/STATUS/report/QA and session links; MCP, pi-roles/browser wrapper |
| `roles/`, `hud-convention.md` | Owner overrides; read by roster |
| `credentials.env`, `config.json` | Owner keys and Decision API/configuration |
| `display/state/<session>.json` | Active Codex bar/panel snapshot; atomic inode ownership prevents outgoing writers deleting replacements |
| `display/scan/`, `display/thin-jobs.json` | Rebuildable observation caches |
| `display/model-cache/` | Shared text replies/reservations and revision-keyed overlays; Decision reservations have their own subdirectory |
| `display/profile.log` | Optional stage timings |
| `watch.pid`, `watch.log` | On-demand watcher PID and diagnostics |

Pi history lives in pi's own session store; job directories contain links. The watcher
reaps finished tabs, keeps failed tabs for two hours, and deletes settled job directories
one day after closure on a later scan, not a dedicated expiry timer. Before deletion
it moves legacy real JSONL sessions to pi's store; failures retain the job. No session-link
target is deleted. It exits with no open job or failed deadline; a later create restarts it.
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

- Master off sends no model requests; chat also requires a matching endpoint key.
- List every new outbound model input here and in both reference languages.
- State is private: `writePrivateFile` or equivalent temp-file/0600/rename.
- Preserve owner configuration, keys, history and unrelated state.
- Tests, fixtures, logs and README examples use synthetic data only.

## 9. Tests and tooling

```sh
npm run build
npm run build:test
npm run build:hud-mcp
npm test
npm run check:fixtures
npm run snapshots:update
```

`npm test` builds all three trees, runs the default unit runner and the `.mjs`
suites. Snapshot updates are explicit: inspect their diff; normal tests do not
rewrite frames. Tests use temporary homes, fixed clocks and synthetic data;
render checks compare terminal cells, not font pixels. Restore display/language
state in `finally`. A real client/browser check remains separate from fixtures.
CI runs `npm test` and fixture checks on Node 24 with and without colour.

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
- **Panel command:** update `utils/panel-command.ts`, the tmux key binding,
  both needs-open-panel lists, help and references. No native-session-switch recipe.

## 11. Gotchas

- Panels reload after a valid build; bars still need restarting for new code.
- Saved display settings override environment defaults; `NO_COLOR` still wins.
- Codex's prefix table is shared within its tmux server, not the global root table.
- A report's existence is not proof of success; model text is not a workflow verdict.
- Codex encrypted tasks have no public text to summarize. Do not send ciphertext
  or invent a task from a nickname; public pre-create charge is usable when present.
- LLM/Decision caps are shared local-filesystem coordination, not provider billing.
- Moving/removing the installed checkout breaks path-bound command/client links.
