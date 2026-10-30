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
| Writes | `hud/state/<session>.json` snapshot, notifications | the same snapshot and notifications, on its collect tick; scan cache, agent logs, model cache, recaps, settings |

At any time **only one of the two is running**. The launcher starts with the compact bar. `CODEX_HUD_TREE=1` opens the
panel instead and kills the bar pane. `codex-hud-toggle` (F12) swaps one for the
other. The two processes never talk to each other directly. They share state
through tmux user options (`@codex_hud_*`), the snapshot file whichever of them is running wrote, and files
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
src/snapshot.ts      machine-readable snapshot (codex-hud --json); bar or panel
src/notify.ts        tmux / desktop notifications (bar or panel)
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
   - Keeps the compact bar by default. With `CODEX_HUD_TREE=1`, opens the
     panel (`open_default_tree_pane`) and kills the bar pane.
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

The bar renders `HudData`, and so does the panel's status card. The panel passes the tree it already built into `HudStatus.build`, so that build does not scan the rollouts again. A git refresh calls `onChange` only when the status itself changed.

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
  `$CODEX_HOME/hud/scan/`, so a restart does not rescan everything. When
  anything the scan reads changes, bump `SCAN_VERSION`. Otherwise stale cache
  entries survive the upgrade.

### 4.5 Per-agent data the panel adds

| Module | What it keeps |
|---|---|
| `agent-log.ts` (`AgentLog.observe`) | A per-agent history in `hud/agent-log/<rootId>.json`, capped at 30 entries per agent, 200 agents, 600 characters per entry, and 30 days. It has two families of kinds. **Observed:** `started`, `finished`, `failed` and `report` (the agent's own words, through `agent-report.ts`, final and commentary channels only). **Model-written:** `note`, `digest` and `cause` (`MODEL_LOG_KINDS`). |
| `agent-context.ts` (`readAgentTokens`) | Each running agent's context fill and output rate (`AgentTokens {usage, rate}`). It reads incrementally from the rollout tail, at most every 3 s, and re-reads after a shrink or inode change. `task_started` resets the rate's baseline; tool-call/output pairs exclude the union of tool waits. It shares the wallclock proxy with the main parser. |
| `workbench-events.ts` | The timeline's events, capped at 500. |
| `git-changes.ts`, `worktrees.ts` | The Changes pane. Read only while a pane that shows them is open. Probes run round-robin. On failure the counts are null, never 0. |

---

## 5. The optional model features

Everything here is **off by default**. The master switch is
`settings.briefing` (`off | agy | api`). Legacy `omp` settings migrate to
`api`; the OMP subprocess backend is no longer supported. While it is `off`, nothing
leaves the machine.

### 5.1 One service: `collectors/small-model.ts`

Every request goes through `SmallModel.submit`, which provides:

- **Backends.**
  - `agy` runs as a CLI subprocess: no shell, cwd set to the system
    temp directory, 90 s timeout, output capped at 64 KB.
  - `api` sends an OpenAI-compatible `POST <base>/chat/completions`.
    Labels, titles and approval descriptions use `gemini-3.5-flash-lite`;
    progress summaries, agents briefs, digests and changes use
    `gemini-3.8-flash-low`; recaps and failure causes use
    `gemini-3.8-flash-medium`. The three tiers are configurable.
  - `briefingApiModel`, when nonempty, overrides the API tiers.
    `CODEX_HUD_BRIEF_MODEL` overrides the model on either backend.
  - A queued request retains its submitted backend and model. Cache identity
    includes backend, endpoint and actual model, never the API key.
- **Queue.** One request in flight at a time. `cancelAll()` runs when the panel
  closes; cancellation holds the active slot until the fetch/subprocess settles.
  HTTP redirects are refused, and reflected credentials are removed from errors.
- **Cache.** Only for callers that pass a `cacheKey`. Up to 200 entries in
  `hud/model-cache/cache.json`.
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
  `hud/model-cache/calls.json` is shared by every panel on the same `CODEX_HOME`.
- **Private files.** `writePrivateFile`: directories 0700, files 0600, written
  to a temp file and renamed into place. The panel's state files (scan cache,
  agent log, model cache, recaps) use it. `settings.ts` and `snapshot.ts` do
  the same temp-file, 0600 and rename write on their own.
  Snapshot ownership follows the atomically renamed file's device/inode, so
  an outgoing writer leaves a replacement snapshot alone; no separate owner
  sidecar is involved.

Nothing calls a model while rendering. Results are stored, and then
`onChange` triggers a repaint.

### 5.2 The brief and the main-session recap

These live in `collectors/briefing.ts` and `collectors/recap.ts`.

**What it covers.** `Briefer.update` runs on every collection. Its scope comes
from `briefingScope()`, set by the two switches `briefAgents` and `briefMain`.

**When it runs.** There are two triggers:

- **The interval** (`briefingMs`, default 5 min): runs when a fast fingerprint
  has changed. That fingerprint covers stage edges, status changes, failures,
  important subtasks, and for the recap new user messages, turn ends, plan
  steps and approvals.
- **The floor** (`recapFloorMs`, default 15 min): runs when a floor
  fingerprint has changed. It adds routine progress.

Settings shows the two as one row, Brief pace, with four pairs to choose from.
Periodic agent brief (`briefAgents`) and main recap (`briefMain`) have separate
switches. Live progress (`agentProgress`) is independent and not paced by this row.

**Input.** `briefMaterial` builds:

- `<directions>`: one ranked entry per L1, made by `reportText`;
- `<news>`;
- `<previous_brief>`;
- for the recap, `<main>`.

**Size budget.** The target is 16 KB (`REPORT_BYTES`), trimmed in a fixed
order. Entries flagged for attention are never trimmed.

**Reply.** It must be JSON: `{overall, agents:[{agent, attention, note}], main?}`.
With `agentLabels` on (`BriefingContext.labels`), each agent entry also has
`label` and `kind`: a short name for what the agent is on now and its kind of
work. `parseBrief` reads them as `readLabel` reads the labels job's.
A reply in any other shape gets one repair request.

**Language.** Every prompt says to write in the panel's language, whatever the
material is in, and to translate what it keeps from `<previous_recap>` or
`<previous_brief>` (`tongueRule`). A language switch drops the brief on screen,
resets `coveredAt` and asks at once. The log is passed through `logsIn`, so a
note in the other language is neither the previous brief nor counted as
covering the news. A stored recap's `overall` and `coveredAt` are used only
when it is in the current language.

**Where results go:**

- each agent's note goes to the agent log as a `note`, stamped with its
  language (`lang`) and, when given, its `label` and `taskKind`;
- the main part goes to `hud/recaps/<sessionId>.json`, with its fingerprints.

Saving the fingerprints means reopening the panel does not start a new call.

Changing the model connection cancels the active brief without reporting a
failure. Its material remains eligible for the next interval.

### 5.3 Background jobs (`collectors/model-jobs.ts`)

Each job has its own switch. All of them follow the backend and pause switches.

| Job | Output |
|---|---|
| Result digest, stage digest | an agent log `digest` |
| Agent labels from task texts, session title | `model-cache/labels.json`, `recaps/<id>.title.json` |
| Failure cause | an agent log `cause` (agents); in memory only (tool calls) |
| Change summary, approval description | in memory only |

**Where a label comes from.** `ModelJobs.apply` shows the labels job's name
for the parent's plaintext from before this agent was created (`node.charge`,
with its path and role), else for a plaintext task, else the newest label a
brief note gave in the panel's language (`AgentLog.label`). A Fernet payload
(`gAAAAA`) is not sent. Codex 0.162 encrypts the task a subagent is sent
(§11), so the charge is the text the labels job can still read. The brief's
name fills in until that label arrives, and does not replace it once it has.

**Language.** Digests and causes are stamped with the language they were
asked in. A language change clears the in-memory readings; a digest, cause or
title in the other language counts as absent and is asked for again.
Language/root changes and stop/restart also advance a request generation:
late model replies and pending disk reads cannot land in, or clear, a newer
job using the same key. Retry cooldowns do not carry across languages.

**Retries.** A failed or refused job retries after 10 minutes.

**Concurrency.** At most 3 digest jobs and 3 cause jobs run at once.

**Prompts.** Every prompt wraps its input as quoted data.

**Approval descriptions.** `isVerdict` throws away a reply that judges the
command ("safe", "should approve") instead of describing it.

### 5.4 Privacy, by setting

| Setting | What can leave the machine |
|---|---|
| `briefAgents` | periodic brief: agent names and roles, tasks and intents (≤300 characters), updates (≤600), stage results, previous notes |
| `agentProgress` | visible live card summaries: the bounded public progress material in §5.5; independent of `briefAgents` |
| `briefMain` | user prompts and the assistant's public replies (≤4000 characters), plan, goal, approval summary |
| `resultDigest` | final answers, head and tail, ≤8000 characters |
| `agentLabels` | the parent's plaintext from before the subagent was created (≤400, with its path and role), else a plaintext task (≤400), and the first prompt (≤1500). A Fernet payload is not sent. The brief's labels send nothing more than the brief |
| `failureCause` | error output (≤2000) and the command |
| `changeSummary` | diff stat and hunks (≤6000) |
| `approvalDescription` | the command (≤2000) |

Reasoning and other private channels are never read for any of these.
Pre-create charge collection uses the same public channel/phase boundary as
agent reports and accepts only public text blocks. Private or unknown
assistant channels are excluded before anything reaches a label or summary;
scan version 3 invalidates previously collected charge caches.
`codex-hud brief --dry-run` prints exactly what a brief or recap would send,
with its sizes. It does not cover the jobs in §5.3.

### 5.5 On-demand live progress (`collectors/progress-summary.ts`)

`ProgressSummarizer` is independent of the rolling brief's interval and scope.
`cardSummaryTargets` uses the exact card visibility settings, list filters and
linger window; `progressTargets` narrows those explicit IDs to live agents.
A hidden main summary, child list or child summary never implicitly requests
that subject. This follows `agentProgress`, backend and pause switches, not
`briefAgents`. Closing the Agents pane or opening a modal clears the targets.
Rendering only reads lifecycle state and stored notes; it calls no model.
`ModelHandle.status` and subscriptions distinguish queued from running without
releasing a cancelled single-flight slot early. Public progress diagnostics
contain only phases, safe reasons and timestamps, never request text, endpoints
or reflected backend errors. The Inspector explains disabled/hidden/inactive,
missing public evidence, cooldown/retry, concurrency and hourly limits. Cards
show only concise queued/running/failure/cap hints beside enabled summaries.
Generated notes carry explicit `coverageAt` and actual `generatedAt` (cache reuse
keeps the original generation time); old/periodic notes have only recorded time
unless coverage is explicitly known. Stored model entries remain visible with
the backend off; `logsIn(..., observed=false)` still hides observed history when
its separate log switch is off.

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
failures retry after ten minutes. Hiding a summary, pausing, changing
roots/language/turns or exiting cancels obsolete work. Newer reports in the same turn do not starve
an in-flight snapshot; its note lands with its original coverage time, then a
later refresh can cover the new evidence. There are at most three pending
progress jobs, sharing `SmallModel`'s single-flight queue and hourly cap.

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
  Rich card cache keys include live clock seconds and the output rate's
  freshness state independently, so hiding the clock cannot freeze a rate.

**Always keep `frame.state`.** `renderMonitor` reconciles the state (selection,
scroll, visibility preferences) and returns the result in `frame.state`. The caller must
continue from that, never from the state it passed in.

The steps inside `renderMonitor` (`render/monitor.ts`):

```
reconcile state
planFoot                     status card (status-foot.ts / status-block.ts), levels min | status | full
controlBar                   pane tabs + Settings; 5 looks: tab, band, tile, frame, pill  (control-bar.ts)
panes (PANES = agents, timeline, changes, details):
  agents   → agents-view.ts  agentsView → richRows (cards.ts) | agentRows (compact)
  timeline → monitor-timeline.ts timelineRows
  changes  → monitor-panes.ts changesRows (+ worktrees)
  details  → monitor-inspector.ts inspectorRows  (the Inspector)
placeArt                     optional picture (art.ts)
footPlan.draw
```

**Height budget.** Each open pane gets one row first. The remaining rows are
handed out round-robin. Rich mode reserves the status brief's height independently
of card content settings, so adding fields scrolls agents rather than shrinking
the recap. Compact mode can give unused rows to the foot. What is left goes to
details or agents. Blank separator rows appear only when the height is 30 or more.

**Types.** A `MonitorRow` is `{text, item, key, controls, counts}`. A
`MonitorControl` is a clickable rectangle. `panel-state.ts` keeps the
selection by item id, so it survives reordering.

### 6.3 Cards (`render/cards.ts`)

The agents pane shows one card per L1 agent, with its subtasks inside. The
rules below were set by the user; keep them.

- **No expand/collapse state.** Every visible L1 is the same configurable
  card, working or idle. There is no card arrow, `cards` set or expansion
  control. Clicking selects; Enter/Space or the Inspector button opens details.
- **Independent contents.** `src/card-visibility.ts` defines booleans for AI
  label, Codex original name, newest summary, relations, current action, child
  list, child summary, role counts, model badge, review chip, clock, output rate
  and context meter. Child role counts (`cardRoleCounts`, shown as 子 agent
  数量统计) controls only the footer's `2 scout · 1 implementer` counts;
  disabling it leaves child lines, summaries and progress targets unchanged.
  Name and status always remain. `cardSubagentScope` is
  `live | important | all`, default `important` (live plus failed, flagged and
  key-role descendants). Disabling a field removes its space, not its data.
- **Model text only.** A main summary shows only the latest model note wrapped
  whole. Raw task, pre-create `charge`, stage intent, agent reports and older
  notes remain in the Inspector. `cardLabel` affects names on this card only;
  other views keep their own naming policy. Original name is optional.
- **Child summaries are one sentence.** An active child uses its newest note,
  never a stale digest. A failed child prefers cause; a settled child prefers
  digest, else a note. `summarySentence` takes the first sentence/first digest
  line, capped at 160 code points, so evidence and caveats stay in the
  Inspector. The sentence wraps beside/under the name, rather than losing the
  end to a one-row cut. Child clocks follow the card clock switch.
- **Visibility controls generation.** `cardSummaryTargets` returns only the
  subject IDs whose summary is enabled in the current rendered list. Progress
  requests (§5.5) run in the collection/input layer, never in rendering.
  Pending/error text accompanies the respective enabled summary and retains
  old words. Turning off child summaries leaves the child names and status.
- **The model badge** spells the version with the family (`6.1sol·max` in
  text mode, glyph then those words in both). Glyph mode stays the symbols.
  `modelLegend()` keeps the family names (`★ Sol`): it is a key, not a badge.
  The Inspector shows the full slug.
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
- The page separates Display, Panel, Agents, Cards, LLM, Status bar and Input,
  drawn as an accordion (`displayLines(draft, selected)`): the selected row's
  group open, the others folded to one line with `SECTION_SUMMARY` values.
  `SettingsFrame.groups` maps a folded line to its group's first row, so a
  click there only selects; `rows` stays the map of real rows, whose click
  steps a value. PgUp/PgDn step by group.
  Settings is a labelled main navigation tab (`BarInput.settingsActive`), not a
  gear-only action. The page keeps that bar above its Back/Save/Reset header;
  `navigationControls` and `headerY` retain correct hit maps. Clicking the
  active Settings tab keeps the draft. A dirty draft leaving through Back,
  Escape, navigation or a prefix command goes through `settings-confirmation`:
  save-and-leave, discard, or continue editing (the safe default). Save failure
  retains the draft and pending decision. Destinations are keys rather than
  old mouse coordinates, because saving can resize the panel. Clean drafts
  leave immediately. `navigationOverlay` opens/selects the target instead of
  toggling an already-open stacked pane closed. Normal stacked clicks still toggle.
  Values use the actual terminal width's right edge; from 70 columns a stable
  help column reserves the rightmost portion. Width applies on Save, followed
  by a repaint as well as the stdout resize event; no draft-only resize.
  Cards controls presentation; LLM controls model generation and privacy.
  A selected unavailable row explains its dependency rather than just dimming.
  Rows stay editable to prepare preferences in advance. Pausing models does
  not hide stored summaries, and hiding card content does not disable unrelated
  periodic briefs or result digests. The automatic progress target list follows
  only the enabled card summaries.
- `card-presets.ts` owns three combinations of the thirteen content booleans:
  minimal, progress and monitor. The virtual `cardPreset` row derives custom
  from actual switches, never persists metadata, and leaves child scope,
  corners, model permissions, credentials and other settings unchanged.
- Reset group restores only its explicit owned fields (including hidden
  counterparts of composite rows). Reset all means known page preferences,
  not connection data: backend, API endpoint/key/models/reasoning, call cap
  and picture/worktree assets survive. LLM/all reset disables generation and
  pauses models rather than silently granting default permissions. Both
  helpers only prepare drafts; Save is required.
- They are stored in `$CODEX_HOME/hud-settings.json`, or at
  `CODEX_HUD_SETTINGS_PATH`. The file is capped at 64 KiB and written
  atomically with mode 0600.
- Once that file exists, the display environment variables
  (`CODEX_HUD_THEME`, `DENSITY`, `LOOK`, …) are ignored. Only `NO_COLOR` still
  wins (`settings-runtime.ts`).

**Files under `$CODEX_HOME/hud/`:**

| Path | Writer | Contents |
|---|---|---|
| `state/<session>.json` | bar or panel | snapshot for `--json` and bar clicks; deleted on exit only by the process that owns it |
| `scan/` | panel | tree scan cache (`SCAN_VERSION`) |
| `agent-log/<rootId>.json` | panel | per-agent history |
| `model-cache/{cache,calls,labels}.json` | panel | model replies, hourly call log, labels |
| `recaps/<sessionId>{,.title}.json` | panel | main recap and session title |
| `activity/<root-hash>.json` | bar or panel | bounded per-root events, observed snapshots, pins and explicit viewed/read/snooze receipts |
| `model-cache/telemetry/telemetry.json` | model service | allowlisted settled feature outcomes, 24h/1000 records, coordination independent of budget/cache claims |
| `diagnostics/diagnostic-<uuid>.json` | explicit export action | exact preview bytes, fresh exclusive 0600 file, no source content or identifiers |
| `profile.log` | both | only with `CODEX_HUD_PROFILE=1` |

**Display.** `icons` decides icons or words everywhere: the buttons, the
titles, the brief's field labels, "ago", the bar's activity and cache marks
(`iconSet()`, `iconic()`). `glyphs` is the model badge's alone; nothing else
reads it.

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
  cards when the card summary is shown but no backend is set.
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
EN/ZH frames across five widths, five looks and three shared presets, plus
settings, confirmations and Inspector lifecycle scenes. The reviewed JSON
retains trailing cells; tests report the exact case and first changed row.
This is textual terminal-cell coverage, not pixel/font screenshots. Updating
requires the explicit local command above and is refused with any CI variable.
No real rollout, wall clock, credential or network input enters a baseline.

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

Card visibility fields are declared in `src/card-visibility.ts` and mapped
through `monitorSettings`. The obsolete `cardNotes` option is no longer used.

1. `src/settings.ts`: add the field to `HudSettings`, its default to
   `defaultSettings()`, and a validator, for example
   `cardSummary: isBoolean`.
2. `src/render/settings-page.ts`: add a row, for example
   `{key, group, label, short, values, help}`, in the group it belongs to:
   Display, Panel, Agents, Cards, LLM (anything that sends material to a model, its
   help starting "Sends"), Status bar or Input. Settings that only make sense
   together are one row: give it `get` (their value as one) and `set` (the
   settings a value stands for), as Brief pace, Agent names and
   Notifications do; `rowValue` and `withRowValue` read and write through them.
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
- **Panel replaces the bar.** While the right-side panel is open no bar process runs. The open
  panel writes `hud/state/*.json` and sends notifications on its collect tick,
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

- **Prompts on the command line.** `agy` receives the whole prompt as
  command-line arguments, so other local users can read it with `ps`.
- **API key fallback.** The `api` backend uses its explicit key or
  `CODEX_HUD_BRIEF_API_KEY`. `OPENAI_API_KEY` is a fallback only for the
  official OpenAI origin, never for a custom endpoint.
- **No cache for briefs.** Briefs and recaps are never cached. Background jobs
  (§5.3) and live progress (§5.5) are cached.
- **Late refusal.** The hourly cap is checked when a request runs, not when it
  is queued, so a queued job can be refused late.
- **Shared model state.** `model-runtime-store.ts` coordinates local panels with unique process tickets, atomic budget reservation, cache merge and same-input claims. A lost sender may conservatively consume its reservation; failures refuse rather than bypass accounting.
- **Jobs ignore the scope.** §5.3 jobs follow only the backend and pause
  switches, not `briefAgents` or `briefMain`.
- **Lost on restart.** Tool-call causes, change summaries and approval
  descriptions live only in memory.
- **Encrypted tasks.** Codex 0.162 sends inter-agent messages encrypted:
  `spawn_agent`, `send_message` and `followup_task` carry a Fernet token, and
  an `agent_message` a plaintext header and `encrypted_content`. `node.task`
  is then empty or sealed. The labels job sends the parent's own plaintext
  from before the spawn (`node.charge`) when the rollout still has it, and
  otherwise has nothing to send; the brief's labels (§5.2) cover that case
  until a charge label arrives. The details page shows the charge whole.
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
newlines. This reduces nested tmux/Herdr traffic for clock-only repaints.

### Operational diagnostics and explicit probes

`collectors/bridge-health.ts` reads bounded per-attach health reports on collection
ticks. The pure `render/hud-diagnostics.ts` formats current failures and TPS evidence.
`Ctrl+\ d` selects Inspector preview `diagnostics`; agent TPS evidence is expanded
with the existing Inspector Enter action. Unbound sessions are distinct from read
failures via `HudHealth.bind`, while model lifecycle callbacks repaint classified
failures and queue status without performing I/O in the renderer.

`collectors/model-probe.ts` owns cancellable Settings API checks. It snapshots the
connection, resolves three feature routes, uses a separate SmallModel instance
sharing the ordinary budget directory, and sends only fixed synthetic text. A
configuration fingerprint and generation counter reject late results when leaving
or changing the draft. Off remains no-network; explicit probes may run while
ordinary model generation is paused.

Performance evidence and the reproducible synthetic workload are documented in
[the performance report](./performance-20261024.md). Panel tree collection uses
`buildSubagentTreeYielding` to yield between files; the synchronous API remains
for existing consumers. Neither API changes the scan cache schema.

### Local activity, evidence and adaptive collection

`ActivityJournal` distils root-scoped facts from fresh coherent HudData/tree/logs;
both entry points observe it so closing the panel does not stop recording. The
panel uses `scopedActivityObservation` to reject retained material from a previous
root, and cancels old model jobs/attaches AgentLog before awaiting a new tree.
Per-source successful collection watermarks resolve that source's historic
errors; a successful session read does not certify Git/tree/status recovery.
Unchanged observations are coalesced; mutations reload and merge under a private
lock, and a pending write is retained. The journal's in-memory `view()` is safe
on redraw. Its limits and incomplete-history semantics are in the reference.

`render/activity-hub.ts` is a pure modal renderer/input reducer for Inbox,
Since viewed, Find and History. A seen receipt names only the events actually
visible in that frame. Search receives literal Unicode/paste; keys cannot fall
through into Codex while either new modal owns input. Historical target IDs
are checked against the current tree before opening an Inspector.

`diagnostics/provenance.ts` builds an allowlisted evidence object. The Sources
view and diagnostic export share it; `model.telemetry()` samples local records
outside rendering. Export freezes an allowlisted preview; only an explicit
save writes the same bytes. Startup identity is captured once from the panel
entry file and manifest, labelled `entry-file-at-start`, not whole-build/Git
identity. Telemetry never changes provider payloads, cache keys, budget claims,
or retry behavior; probe telemetry overrides grouping only. Shutdown settles
bounded local telemetry writes before process exit.

`adaptive-poll.ts` changes collection cadence, never repaint/input cadence.
`collectionObservation` fingerprints stable evidence, excluding refresh-time
noise, and only classifies positively bound idle sessions without unknown/live
descendants as quiet. Panel input uses an epoch so a force during an awaited
scan cannot be lost to that scan's completion. The bar's native watcher wakes
collection; the periodic tick remains its fallback. The yielding scanner has
within-file checkpoints; a single JSON.parse is still atomic.

### Native usage and Quiet overview

`collectors/usage-analytics.ts` and `usage-records.ts` own historical token
accounting, independently of the live `RolloutParser`. `usage-types.ts` is the
boundary: query snapshots contain totals, daily buckets, task trees,
model/effort/role/project groups, per-request costs and evidence coverage. `render/usage-page.ts` is pure;
it consumes a memory snapshot and returns rows, controls and navigation state.

`tree-page.ts` opens Usage as an independent overlay. On entry and at a
throttled cadence while open, it requests asynchronous refresh without awaiting
it in `collectNow` or rendering. The service single-flights work and yields while
reading history; shutdown suppresses late callbacks. No toktrack subprocess,
price fetch, provider polling or model request is involved.

The index lives privately under `$CODEX_HOME/hud/usage-index/` and caches derived
metadata and counters, not conversation text. Native `sessions` and
`archived_sessions` remain read-only. The index accelerates existing sources;
it is not an archival backup after source deletion. Source-read and accounting
gaps remain visible rather than being converted to zero. A home is a source,
not proof of a single subscription account. See the
[architecture and acceptance plan](./native-usage-ui-plan.md) for fork ownership,
deduplication and cumulative-baseline limits.

Quiet overview is a selectable presentation, not a migration of saved user
preferences. It adds labeled multirow navigation and a compact agent overview
while retaining Inspector, changes and timeline access. The legacy monitor pane
set remains unchanged. Both presentation and Usage must satisfy the existing
column-width, input ownership, no-color and localization rules. See
[usage and activation instructions](./native-usage.md).

The Usage dashboard ports toktrack `a6353d3` pricing and TUI primitives.
`usage-pricing.ts` reads the reference's local pricing cache/custom TOML or the
MIT-attributed offline table, then prices each deduplicated request before
aggregation. Tiers never operate on a period's token sum. Pricing generation
and usage generation publish together. Fast tiers and projects are retained
in the allowlisted numeric index (version 3); model/project/effort/role
drill-down is included in snapshot memo keys. `usage-theme.ts` retains the
reference's palette, five-part colour order and largest-remainder allocation.
The overview uses cost/tokens/hit, composition, ranking and an eighth-block
column chart, with `m`/`v`/Enter/Esc navigation. A conformance test invokes an
installed toktrack only against private synthetic logs and prices; the HUD
runtime neither invokes toktrack nor polls a price provider.
