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

## 1. The mental model in one screen

codex-hud wraps the OpenAI Codex CLI in a tmux session. Codex runs unchanged in
one pane. The HUD runs next to it, in one of two forms, and only reads what
Codex writes to disk.

```
 Default (panel)                               F12 toggles to (bar)
 +-------------------------+----------+        +-----------------------------------+
 | %main: shell -> codex   | %tree    |        | %main: shell -> codex             |
 |                         | node     |        |                                   |
 |                         | dist/    |        +-----------------------------------+
 |                         | tree-    |        | %hud: node dist/index.js (1 line) |
 |                         | page.js  |        +-----------------------------------+
 +-------------------------+----------+
   panel is 32 cols by default; Codex keeps >= 41 columns
```

| | The bar | The panel |
|---|---|---|
| Entry | `src/index.ts` | `src/tree-page.ts` |
| Size | 1 line (`HUD_PANE_HEIGHT`) | a column, usually 32–56 wide |
| Loop | 1 s tick + chokidar watchers | `settings.refreshMs` collect (default 1 s), no watcher |
| Renders with | `render/header.ts` → `layout/` engine | `render/monitor.ts` `renderMonitor` |
| Writes | `hud/state/<session>.json` snapshot, notifications | scan cache, agent logs, model cache, recaps, settings |

At any time **only one of the two is running**. The launcher opens the panel by
default and kills the bar pane. `codex-hud-toggle` (F12) swaps one for the
other. The two processes never talk to each other directly. They share state
through tmux user options (`@codex_hud_*`), the bar's snapshot file, and files
under `$CODEX_HOME/hud/`.

Data flows one way:

```
 $CODEX_HOME (written by Codex)                codex-hud
 ─────────────────────────────                 ─────────
 logs_2.sqlite ─┐
 shell_snapshots├─► SessionFinder ─► RolloutParser ─► HudStatus ─► HudData ─► bar / status card
 sessions/*.jsonl┘                                           
 sessions/*.jsonl ─► buildSubagentTree ─► SubagentTree ─┬─► AgentLog.observe ─► agent log
                                                         ├─► readAgentTokens (context %, tok/s)
                                                         ├─► Briefer / ModelJobs (optional LLM)
                                                         └─► renderMonitor ─► panel frame
 git / worktrees ─► collectGitChanges, WorktreeCollector ─┘
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
src/snapshot.ts      the bar's machine-readable snapshot (codex-hud --json)
src/notify.ts        tmux / desktop notifications (bar only)
src/brief-dry-run.ts `codex-hud brief --dry-run`
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
| `utils/tree-keys.ts` | Imported only for its types, by `render/panel-state.ts`. `parseTreeKey` is not on the input path. |
| `bin/codex-hud-tree` | Runs `dist/tree-page.js`. Its comment says tmux display-popup uses it, but nothing in the repo calls it. |
| `dist/utils/tmux-copy.js` | A stale build output with no source file. `tsc` never cleans `dist/`. |

---

## 3. Launch and the tmux session

### `bin/codex-hud`, step by step

1. **Early flags.**
   - `--help`, `--self-check`, `--list`.
   - `--kill` kills every session for this directory.
   - `--json` prints `$CODEX_HOME/hud/state/<session>.json`.
   - `brief --dry-run` runs `dist/brief-dry-run.js`.
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
   - Opens the panel (`open_default_tree_pane`, `split-window -h -l 32`) and
     kills the bar pane, unless `CODEX_HUD_TREE=0`.
6. **Cleanup.** An `EXIT` trap kills the session only if this run created it. Then the script attaches.

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
| `codex-hud-art`, `codex-hud-fonts` | Set the panel picture; install MesloLGS NF. |
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
- `token-rate.ts`;
- `quota-forecast.ts` (a least-squares fit of the usage window).

The bar renders `HudData`, and so does the panel's status card.

### 4.4 The agent tree (`collectors/subagent-tree.ts`)

`buildSubagentTree` scans the last three days of rollouts. For each one it
reads only the first line, up to 1 MB. From those lines it builds a parent
map and the tree under the current root thread.

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
  `$CODEX_HOME/hud/scan/`, so a restart does not rescan everything. When
  anything the scan reads changes, bump `SCAN_VERSION`. Otherwise stale cache
  entries survive the upgrade.

### 4.5 Per-agent data the panel adds

| Module | What it keeps |
|---|---|
| `agent-log.ts` (`AgentLog.observe`) | A per-agent history in `hud/agent-log/<rootId>.json`, capped at 30 entries per agent, 200 agents, 600 characters per entry, and 30 days. It has two families of kinds. **Observed:** `started`, `finished`, `failed` and `report` (the agent's own words, through `agent-report.ts`, final and commentary channels only). **Model-written:** `note`, `digest` and `cause` (`MODEL_LOG_KINDS`). |
| `agent-context.ts` (`readAgentTokens`) | Each running agent's context fill and output rate (`AgentTokens {usage, rate}`). It reads incrementally from the rollout tail, at most every 3 s, and re-reads after a shrink or inode change. `task_started` resets the rate's baseline. |
| `workbench-events.ts` | The timeline's events, capped at 500. |
| `git-changes.ts`, `worktrees.ts` | The Changes pane. Read only while a pane that shows them is open. Probes run round-robin. On failure the counts are null, never 0. |

---

## 5. The optional model features

Everything here is **off by default**. The master switch is
`settings.briefing` (`off | omp | agy | api`). While it is `off`, nothing
leaves the machine.

### 5.1 One service: `collectors/small-model.ts`

Every request goes through `SmallModel.submit`, which provides:

- **Backends.**
  - `omp` and `agy` run as CLI subprocesses: no shell, cwd set to the system
    temp directory, 90 s timeout, output capped at 64 KB.
  - `api` sends an OpenAI-compatible `POST <base>/chat/completions`.
  - `CODEX_HUD_BRIEF_MODEL` overrides the model on all three.
- **Queue.** One request in flight at a time. `cancelAll()` runs when the panel closes.
- **Cache.** Only for callers that pass a `cacheKey`. Up to 200 entries in
  `hud/model-cache/cache.json`.
- **Hourly cap.** `modelCallsPerHour`, default 60. The call log
  `hud/model-cache/calls.json` is shared by every panel on the same `CODEX_HOME`.
- **Private files.** `writePrivateFile`: directories 0700, files 0600, written
  to a temp file and renamed into place. The panel's state files (scan cache,
  agent log, model cache, recaps) use it. `settings.ts` and `snapshot.ts` do
  the same temp-file, 0600 and rename write on their own.

Nothing calls a model while rendering. Results are stored, and then
`onChange` triggers a repaint.

### 5.2 The brief and the main-session recap

These live in `collectors/briefing.ts` and `collectors/recap.ts`.

**What it covers.** `Briefer.update` runs on every collection. Its scope comes
from `briefingScope()`, set by the two switches `briefAgents` and `briefMain`.

**When it runs.** There are two triggers:

- **Brief every** (`briefingMs`, default 5 min): runs when a fast fingerprint
  has changed. That fingerprint covers stage edges, status changes, failures,
  important subtasks, and for the recap new user messages, turn ends, plan
  steps and approvals.
- **Routine every** (`recapFloorMs`, default 15 min): runs when a floor
  fingerprint has changed. It adds routine progress.

**Input.** `briefMaterial` builds:

- `<directions>`: one ranked entry per L1, made by `reportText`;
- `<news>`;
- `<previous_brief>`;
- for the recap, `<main>`.

**Size budget.** The target is 16 KB (`REPORT_BYTES`), trimmed in a fixed
order. Entries flagged for attention are never trimmed.

**Reply.** It must be JSON: `{overall, agents:[{agent, attention, note}], main?}`.
A reply in any other shape gets one repair request.

**Where results go:**

- each agent's note goes to the agent log as a `note`;
- the main part goes to `hud/recaps/<sessionId>.json`, with its fingerprints.

Saving the fingerprints means reopening the panel does not start a new call.

### 5.3 Background jobs (`collectors/model-jobs.ts`)

Each job has its own switch. All of them follow the backend and pause switches.

| Job | Output |
|---|---|
| Result digest, stage digest | an agent log `digest` |
| Agent labels, session title | `model-cache/labels.json`, `recaps/<id>.title.json` |
| Failure cause | an agent log `cause` (agents); in memory only (tool calls) |
| Change summary, approval description | in memory only |

**Retries.** A failed or refused job retries after 10 minutes.

**Concurrency.** At most 3 digest jobs and 3 cause jobs run at once.

**Prompts.** Every prompt wraps its input as quoted data.

**Approval descriptions.** `isVerdict` throws away a reply that judges the
command ("safe", "should approve") instead of describing it.

### 5.4 Privacy, by setting

| Setting | What can leave the machine |
|---|---|
| `briefAgents` | agent names and roles, tasks and intents (≤300 characters), updates (≤600), stage results, previous notes |
| `briefMain` | user prompts and the assistant's public replies (≤4000 characters), plan, goal, approval summary |
| `resultDigest` | final answers, head and tail, ≤8000 characters |
| `agentLabels` | task texts (≤400), the first prompt (≤1500) |
| `failureCause` | error output (≤2000) and the command |
| `changeSummary` | diff stat and hunks (≤6000) |
| `approvalDescription` | the command (≤2000) |

Reasoning and other private channels are never read for any of these.
`codex-hud brief --dry-run` prints exactly what a brief or recap would send,
with its sizes. It does not cover the jobs in §5.3.

---

## 6. Rendering

### 6.1 The bar

Call chain:

1. `index.ts` `renderToStdout`
2. `composeStdoutFrame`
3. `render/header.ts` `renderHud`
4. `fitStatusBar`
5. `layout/bar-modules.ts` `buildBarModules`
6. `layout/engine.ts` `fitModules`

**Modules.** A `BarModule` has:

- an `id`;
- a `priority`, from `MODULE_PRIORITY`;
- an optional `group` (`who`, `load`, `usage` or `meta`);
- an optional `pinned` flag;
- `variants`: `full`, `short` and `min`.

**Fitting.** `fitModules` works on the module with the lowest priority first.
It shortens it to the next variant, then drops it, and only as a last resort
truncates. It returns the `segments` it placed, and the snapshot saves them so
a click on the bar can be mapped to a field (`utils/click-map.ts`).

**Density.** `DENSITY_MODULES` sets which modules each density preset may show at all.

**Missing data.** A field without trustworthy data renders as `''` and is
skipped. Never show a zero you do not have.

The bar is English-only.

### 6.2 The panel

`tree-page.ts` runs the panel:

- **`collectNow`** builds the tree, runs `jobs.apply` and `agentLog.observe`,
  reads agent tokens, then calls `updateBriefer` and `updateJobs`.
- **`render`** calls `renderMonitor(input)` and gets back a `MonitorFrame`:
  `lines`, `panes`, `controls` and `state`.
- **Painting.** Writes `ESC[H … ESC[J` only when the frame differs from `lastPaint`.

**Always keep `frame.state`.** `renderMonitor` reconciles the state (selection,
scroll, open cards) and returns the result in `frame.state`. The caller must
continue from that, never from the state it passed in.

The steps inside `renderMonitor` (`render/monitor.ts`):

```
reconcile state
planFoot                     status card (status-foot.ts / status-block.ts), levels min | status | full
controlBar                   tabs; 5 looks: tab, band, tile, frame, pill  (control-bar.ts)
panes (PANES = agents, timeline, changes, details):
  agents   → agents-view.ts  agentsView → richRows (cards.ts) | agentRows (compact)
  timeline → monitor-timeline.ts timelineRows
  changes  → monitor-panes.ts changesRows (+ worktrees)
  details  → monitor-inspector.ts inspectorRows  (the Inspector)
placeArt                     optional picture (art.ts)
footPlan.draw
```

**Height budget.** Each open pane gets one row first. The remaining rows are
handed out round-robin. What is left goes to the status brief, then to details
or agents. Blank separator rows appear only when the height is 30 or more.

**Types.** A `MonitorRow` is `{text, item, key, controls, counts}`. A
`MonitorControl` is a clickable rectangle. `panel-state.ts` keeps the
selection by item id, so it survives reordering.

### 6.3 Cards (`render/cards.ts`)

The agents pane shows one card per L1 agent, with its subtasks inside. The
rules below were set by the user; keep them.

- **A card shows only text a model wrote:**
  - the model-written label, shown only when the agent was renamed;
  - notes, digests and causes (`modelNotes`);
  - the status line.
- **Never on a card:** the task text, a stage intent or the agent's own
  reports. That text is long, and cut to one line it is unreadable. The
  Inspector shows it whole.
- **A working card** (the agent or one of its subtasks is live) shows its
  newest `cardNotes` notes (Settings, 1–5, default 3), each wrapped in full and
  never cut. The newest is in the text colour (the warning colour when
  flagged). Older notes are dim. There is no `~` mark on cards.
- **A subtask line** (`kidLines`) has the model's digest or cause beside the
  name, wrapped under it in full. When the name leaves less than
  `KID_SAID_BESIDE` columns, the words start on the next line.
- **A resting agent** (not working, no subtask working, not opened, nothing
  flagged; `isOneLine`) is its row, with the newest note (`briefLine`) on a
  dim line under it. Cutting that note to one line is acceptable there.
- **The footer** shows the clock, then the output rate (`~42 tok/s`) when it
  fits, then the context meter.
- **The summary row** at the top of the pane adds up every live thread's rate.
  `agentRate` in `monitor-labels.ts` decides whether a rate is current enough
  to show.

The compact log and the Inspector still use a dim `~` to mark model-written
text.

### 6.4 Input

**Bar.** stdin is raw. Any bytes that reach the bar are replayed to Codex's
pane with `send-keys -H`.

**Panel keys.** Panel commands come only through the prefix:

1. The user presses the prefix key (`Ctrl+]` by default) and then one key.
2. `codex-hud-command` writes `ESC _ codex-hud:<cmd> ESC \` into the panel's input.
3. `WorkbenchInputDecoder` decodes it.
4. `monitorKey` or `overlayKey` in `utils/panel-command.ts` turn it into an action.

The command travels in the same input stream as typed keys, so ordering is
kept.

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
- They are stored in `$CODEX_HOME/hud-settings.json`, or at
  `CODEX_HUD_SETTINGS_PATH`. The file is capped at 64 KiB and written
  atomically with mode 0600.
- Once that file exists, the display environment variables
  (`CODEX_HUD_THEME`, `DENSITY`, `LOOK`, …) are ignored. Only `NO_COLOR` still
  wins (`settings-runtime.ts`).

**Files under `$CODEX_HOME/hud/`:**

| Path | Writer | Contents |
|---|---|---|
| `state/<session>.json` | bar | snapshot for `--json` and bar clicks; deleted on exit |
| `scan/` | panel | tree scan cache (`SCAN_VERSION`) |
| `agent-log/<rootId>.json` | panel | per-agent history |
| `model-cache/{cache,calls,labels}.json` | panel | model replies, hourly call log, labels |
| `recaps/<sessionId>{,.title}.json` | panel | main recap and session title |
| `profile.log` | both | only with `CODEX_HUD_PROFILE=1` |

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
  placeholder or empty-state lines, or hints that repeat what a count already
  says. Show nothing rather than a guess.
- [ ] Cards hold model-written text only (§6.3).
- [ ] Rendering is pure. Pass `nowMs` in, never call `Date.now()`, and compute
  click rows with the same `nowMs` the frame used.

**Collection**

- [ ] Rollout offsets are byte offsets.
- [ ] Every parse goes through the single-flight queue.
- [ ] SQLite access is read-only and best-effort.
- [ ] A change to what the tree scan reads bumps `SCAN_VERSION`.
- [ ] A failed read gives `null`, never `0`.

**Privacy and the repository**

- [ ] With `briefing` set to `off`, nothing leaves the machine.
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
npm run test:windows     # PowerShell entry points, with fake binaries
```

**Continuous integration.** CI (`.github/workflows/ci.yml`) runs `npm test` on
Node 18, 20 and 22, and the integration suite with tmux on Node 20.

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

**README figures.** `tests/fixtures/readme-demo.ts` renders the synthetic
"parser-kit" scenes as `.ansi` files. The PNGs are rasterised from those files
outside the repo.

**Other tools:**

- `CODEX_HUD_PROFILE=1` times each stage into `hud/profile.log`.
- `docs/reviews/ui-audit.mjs` and `render-ui-preview.py` support UI review.
- `codex-hud brief --dry-run` shows what a brief would send.
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

The `cardNotes` setting (commit `c71a1c9`) is a complete example.

1. `src/settings.ts`: add the field to `HudSettings`, its default to
   `defaultSettings()`, and a validator, for example
   `cardNotes: (v) => isIntegerBetween(v, 1, 5)`.
2. `src/render/settings-page.ts`: add a row, for example
   `{key, group, label, short, values, help}`.
3. If rendering needs it: add a field to `MonitorState`
   (`render/monitor.ts`), map it in `monitorSettings`, and read it where it
   is drawn.
4. `src/render/i18n.ts`: add ZH strings for the label, the short label and the help.
5. Tests:
   - `settings.test` covers the default and validation;
   - the settings page has one more row, so heights in `settings-page.test`
     may need to grow;
   - a render test covers the effect.
6. `docs/reference.md` and `reference.zh.md`: add it to the settings list.

### Add or change a bar field

The credits field (commit `44ce0a7`) is a complete example.

1. Get the data into `HudData`, through the parser or `HudStatus`.
2. Add a module to `layout/bar-modules.ts`:
   - give it an entry in `MODULE_PRIORITY`;
   - give it `full`, `short` and `min` variants;
   - return `''` when the data is missing;
   - add it to `DENSITY_MODULES` if it belongs in focus or balanced.
3. If the panel's status card should show it too, change `status-block.ts`
   and `status-foot.ts`.
4. If it can raise an alert, change `render/attention.ts`.
5. Write tests at several widths, and update the reference and both READMEs if
   they describe it.

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
4. Name it in the help (Shortcuts) and in the reference's keys section.

---

## 11. Gotchas

**Processes and launch**

- **Stale code.** A running bar or panel keeps the code it started with. After
  a build, restart the pane before you judge a change.
- **No bar by default.** In the default layout no bar process runs. That
  means no `hud/state/*.json`, no `--json` output, and no notifications.
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
- **Tree built twice.** Each panel collect builds the tree twice.
- **Guardian threads.** Since Codex 0.155, each session gets a nickname-less
  guardian review thread. It used to be mistaken for the main session, so
  count guardians as reviews.

**Model features**

- **Prompts on the command line.** `omp` and `agy` receive the whole prompt as
  command-line arguments, so other local users can read it with `ps`.
- **API key fallback.** The `api` backend falls back to `OPENAI_API_KEY`
  whatever the base URL is, so a custom endpoint can receive that key.
- **No cache for briefs.** Briefs and recaps are never cached. Only §5.3 jobs are.
- **Late refusal.** The hourly cap is checked when a request runs, not when it
  is queued, so a queued job can be refused late.
- **Unlocked call log.** Two panels writing `calls.json` at once can lose a count.
- **Jobs ignore the scope.** §5.3 jobs follow only the backend and pause
  switches, not `briefAgents` or `briefMain`.
- **Lost on restart.** Tool-call causes, change summaries and approval
  descriptions live only in memory.

**Rendering**

- **NUL sentinels.** Item ids starting with NUL (`'\0untracked'`,
  `'\0worktree:'`, `'\0earlier'`) are internal markers, not paths.

**Not settled yet**

- Does the bar's chokidar watcher, bound to today's `sessions/YYYY/MM/DD` at
  startup, re-root after midnight? The 1 s tick and the 5 s finder poll cover
  for it either way.
- Can anything still reach the native-Windows tmux branch in `bin/codex-hud`?
  `codex-hud.ps1` routes only to WSL or plain Codex.
