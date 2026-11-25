# How the HUD works

The HUD serves Claude Code, Codex and pi on Linux/WSL inside herdr.
[The spec](./spec.md) defines the product; [the reference](./reference.md) describes its controls.
This page describes the current code, not an execution platform.
Earlier designs remain in git history and [dated reviews](https://github.com/CartmanFatass/codex-hud/tree/universal-hud/docs/reviews).

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

The panel observes; it does not brief workers, accept work or chain roles.
The main session makes those decisions through the MCP.
Its writes are the Control plane's role places (§4.6) and the owner's three micro-actions on a HUD job (§6): focus its tab, answer an open question, stop it.
Models write only display text.
There is no ledger database, resident execution host or owned browser runtime.

CLI dispatch is `dispatchCli` in `src/mcp/thin-main.ts`.
Kind flags, trust-dialog text and decline keys, and startup quirks are the table in `src/roles/cli-kinds.ts`.
Before opening a tab, dispatch requires an explicit local trust grant for Grok, Antigravity and Claude; missing, unreadable, malformed or symlinked trust files do not grant trust.
Codex skips this check, and the other CLIs' screen-dialog checks remain in place.
`packages/hud-mcp/bin/hud-cli.mjs` is the per-job supervisor.
Claude and Codex workers use the HUD MCP's worker-only surface; pi loads the HUD extension explicitly and retains pi-roles' native async ask.
The shared worker protocol writes reports, check-ins and CLI questions and dispatches only sonic children.
Antigravity and Grok Build use the fallback scripts in place of MCP tools.
The HUD passes only model, effort, the bypass flag and role `args`.
Harness behaviour and session places are untouched.
`hud_create` validates explicit context file and report references before dispatch.
Local briefs list resolved paths and reference a registered project's optional `.hud/brief.md`.
Browser briefs include the paths and bounded file bodies, including that standing brief if present, in the prompt sent to the selected browser service.

Claude's statusline, pi's footer and Codex's tmux bar (`src/index.ts`) are the client integrations.
One standalone panel (`src/tree-page.ts`) serves all three clients via `/hud` (`hud panel`), writing its own snapshot and notifications when needed.
No panel opens at launch.

## 2. Repository map

| Path | Responsibility |
|---|---|
| `bin/` | Public launchers and Codex tmux helpers |
| `install`, `install.d/` | Core installer and selected client/prerequisite extensions |
| `packages/hud-mcp/bin/hud-mcp.mjs`, `packages/hud-mcp/bin/surface.mjs` | Stdio transport and entry selection for the reloadable MCP runtime |
| `src/mcp/mcp/server.ts`, `src/mcp/mcp/operations.ts`, `src/roles/tool-definitions.ts` | Main/worker MCP request handling, main-session operations and role tool schemas |
| `src/mcp/codex-statusline.ts` | Codex native status line tool and MCP resource |
| `src/mcp/dispatch/orchestrator.ts`, `src/mcp/dispatch/places.ts`, `src/mcp/dispatch/context.ts` | Job dispatch, place selection and context assembly |
| `src/mcp/dispatch/harness-pi.ts`, `src/mcp/dispatch/harness-cli.ts`, `src/mcp/dispatch/harness-bro.ts` | pi, CLI and browser dispatch adapters |
| `src/worker/tools.ts`, `packages/hud-mcp/bin/worker-tools.mjs` | Shared worker tools and their JS bridge; CLI report receipts bind the current turn token to the fresh disk report |
| `packages/hud-mcp/bin/hud-watch.mjs`, `src/runtime/watch.ts`, `src/runtime/watch-runtime.ts` | Watcher launcher, reloadable watcher host and on-demand reaper |
| `packages/hud-mcp/bin/hud-cli.mjs`, `src/runtime/cli-supervisor.ts` | Launcher and implementation of the per-job CLI supervisor |
| `packages/hud-mcp/bin/hud-jev.mjs`, `src/runtime/browser-runner.ts` | Launcher and implementation of the browser-CLI wrapper |
| `src/roles/roster.ts` | Role definitions, assignments and convention, shared by MCP/Project |
| `src/cli/` | HUD commands including panel, statusline, settings import and Codex launcher compatibility |
| `src/index.ts` | Codex tmux bar loop |
| `src/cli/statusline.ts`, `src/statusline-parity/` | Statusline command and Claude/Antigravity statusline collection and rendering adapters |
| `src/harness/pi/p10k-footer.ts` | pi footer and editor ribbon |
| `src/tree-page.ts`, `src/panel/controller.ts` | Standalone panel entry and interaction/repaint loop |
| `src/collectors/` | Display observations from disk, SQLite and Git; workboard and project snapshots |
| `src/render/` | Bar/panel renderers, input state, themes and EN/ZH labels |
| `src/settings.ts`, `src/settings-runtime.ts` | Saved settings validation and I/O; runtime display configuration |
| `src/snapshot.ts`, `src/notify.ts`, `src/roles/notify.ts` | Display snapshot, opt-in Codex display notifications and worker-event delivery, respectively |
| `integrations/` | Client assets and bundled skills consumed by the installer |
| `tests/unit/`, `tests/fixtures/` | Behaviour tests and synthetic data/frames |

## 3. Launch and installation

`./install --with claude,pi,codex,browser,herdr` validates selected extension names, checks Node, then runs prerequisite hooks before any build or filesystem change.
Core is always included.
The default builds the HUD and MCP together into `dist/`; `--skip-build` uses existing outputs.
Commands link into this checkout/extraction, and client bindings also retain its path: keep that directory.
Runtime launchers and the panel reload probe hold a per-checkout lock while loading their initial `dist/` module graph.
The builder takes that lock only to publish or clean `dist/`, not to compile.
A timed-out launcher fails rather than importing a partial build.

The MCP stdio owner checks `dist/index.js` once per incoming line; the watcher checks it once per 30 s without scanning jobs.
A successful main build publishes or touches this stamp, including script-only builds.
At a change the MCP drains admitted calls; the watcher drains checks, reaps and worktree operations.
Each loads the replacement in a fresh worker thread under the dist lock; a bad import leaves the previous runtime in use.
When a swapped MCP runtime changes the connection's `tools/list` payload, the owner emits `notifications/tools/list_changed`.
The transport PID stays put (including the watcher's tab-close subscription).
MCP task IDs, turn fences, baselines, terminal replies and expiry times travel only over this live connection's in-memory handoff.
Polls still read current job facts, and the existing PID/start-time delivery marker remains valid.
A fresh connection cannot adopt or cancel another connection's tasks.
Launcher/transport changes themselves need a new launch.

The installer backs up edited client files, uses official registration commands where available, and never edits shell rc files.
`hud uninstall` invokes `./install --uninstall`, removes owned bindings and command links, and retains HUD data.
See [installer extensions](../install.d/README.md).

**Node floor: ≥24.0.0.
Node 24 is the tested supported line.**
Root/MCP package engines, installer and command launchers share this floor.
Earlier Node versions are not supported, even if individual APIs or dependencies work there.

- The full suite on Node 22.13.0 failed five watcher tests: four link-loop cases depend on Node 24's `watch error: ELOOP` behavior, and the unreadable-sessions working-tab case did not settle.
  Node 22's watcher behavior is not qualified; a SQLite-only API floor is insufficient for the shipped product.
- [Node 24's filesystem documentation](https://nodejs.org/docs/latest-v24.x/api/fs.html#fswatchfilename-options-listener) describes the watcher API.
  The release is rehearsed on Node 24 with an isolated offline build and client stand-ins, not a claim of real-client validation.
- `collectors/daemon-binding.ts` uses `node:sqlite` for best-effort read-only Codex binding.
  `utils/panel-reload.ts` still feature-detects `process.execve` and keeps its signal-forwarding fallback; neither lowers the supported product floor.
- Locked runtime dependencies `chokidar` 5 and `readdirp` 5 require **≥20.19.0**; the locked build tools need no higher floor than the product (see `package-lock.json`).

`hud codex` runs the existing `bin/codex-hud` tmux launcher.
It creates a session for the cwd and selected `CODEX_HOME`, starts Codex unchanged, and opens the 1-line bar.
The launcher forwards Codex arguments and `CODEX_HOME`; explicit `--attach` reuses a session.
The read-only herdr observer checks the designated main pane, not whichever pane is focused.
No global tmux configuration is required.
`/hud` opens the standalone herdr sidebar panel (`hud panel`).

## 4. Collecting data

### 4.1 Finding the Codex session

`SessionFinder` tries the pane's process/daemon connection in `logs_2.sqlite`, shell snapshots after launch, then bounded cwd rollout candidates.
Daemon binding anchors to explicit startup records and periodically rechecks PID/start time; replacement clears the connection and cursor.
A shell snapshot's `TMUX_PANE` may name the daemon, not the client: never use that value as a client binding.
SQLite is read-only and best-effort; unavailable evidence remains unknown.

`hud panel` can explicitly select a root or a harness/session/source.
Otherwise, with `HERDR_PANE_ID` set, `claudeCallerSession` asks `herdr pane current` with a one-second budget.
A Claude UUID locates an existing transcript in the configured projects directory: cwd slug first, then at most 256 immediate entries.
Explicit selection wins.
Missing evidence leaves an unbound jobs view; the statusline writes no pane-keyed binding.
Selection is for display, not execution authority.

### 4.2 Parsing rollouts

`RolloutParser` retains byte offsets and open calls across JSONL batches.
Reads handle CRLF, final records without a newline, split UTF-8, shrink and inode replacement.
`utils/parse-queue.ts` serializes parses per file; file signatures avoid unchanged reads.
`buildSubagentTreeYielding` yields between files and shares the scan cache under `$HUD_HOME/display/scan/`.
Changing what the scan reads requires a `SCAN_VERSION` bump.
A parse and a SQLite statement are not preemptible.

### 4.3 Main-session facts

`HudStatus.build` combines rollout, Codex config, context, token-rate, quota and cached project/git facts into `HudData`.
The panel passes its existing tree and skips the bar's Git refresh; Project owns its on-demand Git probes.
The output-rate estimate uses current-turn output-token deltas divided by elapsed time minus the union of known tool waits; it includes initial latency and stalls.
It is not exact request telemetry, and unchanged counters do not refresh it.
Missing facts are absent, not fabricated zeroes.

### 4.4 Native agents

Codex descendants come from the incremental rollout tree.
`ClaudeNativeTree` reads selected-session `subagents/agent-*.meta.json` and JSONL: at most 401 directory entries, 200 agents, four forward reads per refresh, 8 KiB metadata and up to 1 MiB transcript each.
Separately, up to 16 first-seen transcripts over 64 KiB get their last 64 KiB and metadata read for the Native Inspector, then join forward replay on later refreshes.
Preview text is local display only; forward replay retains public Agent/Task call ids to establish nesting.
Partial records carry across forward passes, up to 4 MiB; oversized records and deferred/unreadable evidence mark coverage incomplete.
Shrink/replacement clears prior evidence and replays.
Unmatched nested agents wait while candidate parents replay, then appear at top level if still unmatched.

Completion is provisional: observed transcript growth reopens a completed Claude agent; fresh finished metadata or a caught-up public `end_turn` with no open tool calls settles it again.
Replay preserves prior metadata lifecycle and settlement age.
pi helpers are HUD jobs, not a separate native tree.

### 4.5 Jobs and workboard

Home reads the current project's STATE handoff and the caller pane's scoped job totals.
`PanelJobPipeline` reads thin jobs in `$HUD_HOME/jobs/` via `readThinJobs` for Jobs and Inspector. `DiffStatCollector` adds a bounded Git diff on demand for an inspected job.
The selected main session's native Claude/Codex `SubagentTree` (§4.4) is collected on demand for the Native Inspector only.
Failed or incomplete reads are not evidence of absence.

The panel does not poll `herdr agent list`, scan workspace `tmp/tasks/`, or read retired `$HUD_HOME` observation records such as `assoc/`, `native-relations/` and `jev-runtime/`.
Existing records are left in place.
`CODEX_HUD_PANEL_ALL_DELEGATIONS` is ignored; it does not widen the pane scope.

A job whose receipt names a `ticket` (`feature/NN`, or a `package` and a number) also gets `ticketTitle`, the heading of `<project_root>/.scratch/<feature>/issues/NN-*.md`: the first 512 bytes of one regular file in an unlinked directory, cached for 30 seconds per ticket (`ticket-title.ts`); a missing or unreadable file is no title.
Jobs can display it without sending it to a model.

`readThinJobs` selects up to 200 top-level jobs plus up to 200 of their children and filters to the caller's recorded pane.
A caller can exclude earlier settlements before reading their artifacts; the panel's Jobs list keeps retained jobs.
Active/unknown jobs remain eligible.
It reads job/STATUS, brief heading, report, reviews and QA.
Only settled jobs expose worker metadata whose report signature still matches.
The Inspector shows the summary in the worker's own words and up to 12 reported paths as text only when no Git changes are shown.
Single-job reads reuse the summary and file list.
Task notices use the summary and wait for HUD-run checks, reporting only the outcome; watch and `changes` lines and list reads carry only a clipped summary.
Metadata writes do not wake `hud watch` on their own.
Working-session target and headless `stdout.jsonl` mtimes contribute observed activity without reading log bodies for stage classification.
The thin-job signature cache is shared disposable display state, never job authority.
Ranked display windows check at most 1,024 cached receipts for parent links and follow selected parents’ `.sonic` markers.
Omitted directories keep job coverage incomplete.
Job directory enumeration/stat/ranking still grows with retained history; the body limits are not a claim of constant total scan cost.

`hud_land` runs in a detached helper.
The watcher uses the job's latest land attempt to protect its worktree and receipt while queued or running.
A retry before fast-forward keeps the old attempt readable under its own flow ID and removes its scratch worktree under the `main-checkout` lease.
Integration tests the source commit directly when possible, otherwise picking only commits not on the current base.
The landing records `done` when `Owner try` is omitted or `no`; only `yes` lands `ready-for-human`.
A red gate gets one immediate rerun of the reported Node.js test files (or of the whole command when no files are reported); recovery is stored in the flow and reported with the flaky test names when available.

### 4.6 Project and Control

`ProjectCollector` reads STATE, spec milestone, reviews, roles/convention/instructions, key-presence booleans, local tickets, current jobs and Git/worktree facts.
Full reads run only while Project is shown without a modal.
Home reads the handoff and owner requests, not the control plane or working-tree diff.
STATE, spec, try records, tickets and the newest 64 top-level jobs (plus up to 64 children) are signature-cached; the last 64 commit subjects are cached by checkout HEAD SHA.
Tickets come from `.scratch/<feature>/issues/<NN>-<slug>.md` (64 feature directories, 512 files total, 64 KiB each).
Derive ticket states and resolve local and cross-feature dependencies before limiting detail to open features plus the newest finished ones up to 16.
Tickets and landing evidence supply progress rows; STATE supplies the milestone, Now, Waiting and Next, not progress rows.
No collector writes project files.

The panel owns one `ProjectCollector` per project the Project tab has shown (`ProjectVisits`: at most four, its own never dropped, the oldest other one first) and collects only the shown one; the chosen root is `MonitorState.projectRoot`, so it survives the self-reload, and Home reads the panel's own collector only.
While the Projects list is open (`MonitorState.projectList`) the shown project's full collection pauses and `ProjectOverviews` reads every listed root lightly: one Home-mode collector per root (file signatures, no Git, no roles) and one `liveCwds()` pass over the newest-64 job lookup, counted per root, at most once per five seconds while the list stays open; the panel attaches each result to its `ProjectChoice`.
A root just switched to has no snapshot until its first collection: `ProjectVisits.shown` then gives the previous one, with its root, so the first frame is the old page and never a blank one.

Project and `WorktreeCollector` use gated asynchronous Git reads; Project's Working tree page probes worktrees round-robin only when focused.
Repository commands/filters and lazy fetching must not execute just to draw status.
Git failure is unknown, never clean.
Project opens files through the existing `$EDITOR` herdr-tab action.

`hud board` and the panel's `w` write one static HTML review board (`render/html-board.ts`, pure: collected facts in, one escaped, script-free page out; `cli/board.ts` collects once with a fresh `ProjectCollector`, and writes with `writePrivateFile`).
No model call, no server; its text and sections are in the reference.

Control is a top-level tab.
It follows Project's selected root, but has its own cursor, folds and scroll.
Its narrow `ProjectCollector` mode reads only that root's Control facts (no STATE, tickets or Git worktree/status collection) and caches them separately from Project's snapshot.
Unlike Project's hub, Control never paints the previous root's snapshot while a new root loads.
Local model list discovery starts only on entering Control or refreshing (`r` in Control, Ctrl+R in the picker), not on Home or on a collection tick.
`roles/role-control.ts` has both halves: `controlFacts` (read-only, called by the collector: each role's active/standby/off/exhausted/missing places and the machine's Harnesses inventory) and `editPlaces` (role and quota edits).
`roleRegistry.assignment` resolves the chain for Control, roster and create; Control's Harnesses preview also uses that evaluation to show what a switch would change.
Local pi settings (bounded, signature-cached) and the unfiltered discovery cache supply provider attribution.
Dispatch checks the selected place's thinking support before opening its tab.
For pi, the picker cache can establish that only `off` is supported; an offline, sessionless Pi metadata probe supplies exact levels when available.
This does not refresh the picker or make a model request.
The `harness-switch` action updates only `$HUD_HOME/harnesses.json` (`disabled`) via `roles/harness-switches.ts`, by private atomic replacement.
Machine switches never rewrite role files.
The in-place chain editor (`render/chain-input.ts`) works on an in-memory draft of raw places and uses snapshot facts for its preview.
The field sheet embeds the pi picker (`render/model-input.ts`), which returns a model ID to the sheet, not to disk.
Save sends one `preset-edit` with the whole chain and the captured role revision; `tree-page.ts` applies it through `editPreset` and the existing atomic role writer.
Project-pinned roles are read-only; target changes that would lose launch options are refused.
`editPlaces` handles preset cycling and immediate quota clears separately.
Pi's picker groups one list of exact IDs from the unfiltered discovery cache, skipping off providers for display only.
Discovery keeps the last successful list and timestamp per source.
The same cache holds optional pi capability facts from the same `pi --list-models` call and supplies unfiltered provider attribution.
The bottom strip uses those facts, the existing switch and exhaustion evidence, and the frame clock.
A successful empty pi list supersedes the previous list; only the absence of any successful pi result uses the limited offline catalog.
What is on screen needs no new data: the hub's Latest and Progress's History order by the commit dates the ledger read already carries, and the Projects list's second row is `ProjectOverview.latest`.
The next `hud_create` reads the same files.
Keys are reduced to name/presence booleans, never retained as values.
Browser availability is only a PATH check for Chrome and `jev-ask`, not a login/health claim.

## 5. Model inputs in execution

Display surfaces do not call text models or the Decision API. The Inspector draws observed facts, original questions and bounded report text, and the worker's signature-checked summary. It does not use retired display-model caches. Control model discovery reads model identifiers and capabilities, not completions.

| Feature / collector | Public input that can leave the machine |
|---|---|
| Quiet-job choice | Last 60 pane lines (≤12,000 chars) of a CLI worker, state, role, agent, minutes quiet, background-child flag and whether the report prompt was sent; at most once per idle grace without a report, ≤3 per supervisor run |
| Sonic auto-thinking | First 4000 characters of the dispatched task (the kind prompt, caller ask and bounded target brief for prewalk scouts), plus Sonic role scope and thinking purposes; no standing brief or referenced files |
| Claude mod event wake | Existing pane-scoped `hud watch` lines (job status and report summary/read hint, questions, Sonic checkpoints, land and owner panel decisions), submitted or appended as status text to the main Claude conversation; no separate model call or report-body read |
| Stopped Sonic retry | The new pi job receives its saved native session context and a short continuation naming the stop reason. Fresh fallback uses the brief plus the last 8 KiB of partial report or stdout. |
| Imp auto routing | First 4000 characters of the dispatch brief and up to 4 KiB/4000 characters of the named local ticket; up to 32 context-file relative names (512 characters each) and byte sizes; configured tier and mode purposes. No context bodies, standing brief, prior reports or preset/model IDs. |
| Role pool pick | First 4000 characters of the dispatch brief as untrusted data; role and project name (checkout basename); the owner pool index (up to 64 filenames, titles, `Kind`, `Status` and `Fits`, ≤400 bytes read per entry); and the first 8 KiB of the README as selection criteria (all facts ≤48 KiB together). No pool directory path, entry bodies, standing brief, project design file or other references. |
| Advisor shadow: skills | Opt-in (`advisorShadow`, off by default): secret-scrubbed latest owner message and previous assistant reply (≤2000 characters each) from a tracked main session, plus up to 200 skill `name` and `description` entries (≤300 bytes each, ≤64 KiB total) from `advisorSkillDirs`. No skill file paths, bodies or full transcripts; never injected into any session. |
| Advisor shadow: rules | Same opt-in: on a completed main-session reply, run any built-in `(check: …)` rules locally, then quote the secret-scrubbed latest owner message (first 2000 characters), reply (last 4000 characters) and remaining model-judged rule IDs and sentences (≤30 rule lines from `advisorRulesFile`, ≤8 KiB; no call when every rule is check-based). No rules file path, other lines or full transcript; no result injected into any session. |
| Prewalk scouts | For each caller-named scout (`scouts: [{kind, ask}]`, 0–3 items), the fixed kind prompt plus caller `ask`, bounded target brief (≤16,000 chars) and target `context_files` (`code`/`docs` only; not `web`) go to headless Sonic under normal brief rules. Code and docs scouts search only inside the checkout; web scouts query only public technologies, never private brief content. HUD waits until every scout settles under Sonic's own limits (`max_s`, stall, looping); settled reports attach via `from_jobs`, inline within the usual byte limits for browser targets. |
| Council | Explicit owner request: each member independently gets the task and borrowed instructions. Local members get original context references; browser participants get an index of the original attachments (GitHub repository, locally known pushed commit and paths, or local-only labels), not their bodies. Each job receives the normal project standing brief. The synthesizer gets the original task, fixed plan instructions, member identities, failures and successful reports, plus original `context_files` references for a local synthesizer. Browser reports are inlined within ordinary context limits. `main` synthesis makes no additional model call. |
| Land repair | Failing cherry-pick or gate step and error, plus up to 40 output lines (8 KiB) to the source worker or same-role replacement. Blank and HUD frame lines are removed; recognized test names and assertions from the failing command take priority over a plain log tail. |
| Pre-report worker checks | Failing project command (label up to 200 characters) and up to 2 KiB of its trailing stdout/stderr to the same worker in the `hud_report` error. An explicit skip reason is returned to the calling session in the report digest. |

Headless Claude Code and Antigravity dispatch use the same model inputs as worker tabs: the assembled brief, role instructions, and subsequent answers, sends or repair messages.
The native stream's session ID is read locally to bind the next turn; the stream is not sent to a separate model.
For pi and headless CLIs, sends queued during a turn go to the same worker's native session in send order on its next turn, alongside the answer if it asked.
A `general` job with `instructions: "<role>"` supplies the borrowed role's instructions to its selected pi or CLI worker instead of general's instructions.

Settings → Decision API persists `config.json.decisions.primary` (default OpenAI).
Automatic fallback chooses another keyed provider in Gemini → OpenAI → Anthropic → TypeSafe order; one fallback covers missing credentials, quota/auth/5xx/timeout, not malformed answers or refusals. Gemini quota replies impose an in-memory cooldown.
Anthropic receives the same Decision API inputs through the Messages API, called with Node's built-in fetch.
The execution Decision cap defaults to unlimited (`0`), with atomic reservations across processes on one local HUD home. Fallback HTTP attempts count separately; coordination failure refuses instead of bypassing accounting. Settings reads the hourly ledger outside paint.

## 6. Rendering and input

All three bars collect `BarFacts`; `render/layout/bar-fields.ts` fits and paints model/effort, context, repo/branch, client quota (pi cost in its ribbon), output rate (Claude and Codex; pi keeps its ribbon reading), the notice zone and loaded counts.
Missing facts disappear.
The notice zone pins native approvals, shows running counts by role and an optional queued count from the fresh global `work-summary-snapshot.ts` census, and retains native subagent events and Claude skill loads for three minutes.
Workers waiting on main count as running but do not appear as owner requests. Readers never fall back to a pane-local job scan.
The machine counts fit as one segment or are omitted whole; the `title` rungs of `LADDER` cut subagent titles only.
No tool-at-work line or clock appears in the bar.
The only styles are `line` and `p10k`, both one row.
Retired style values load as `line`.

`renderMonitor` uses `renderWorkboardFrame` for Home, Project, Control, Jobs, Inspector and Help. Frames use exact-width rows and whole footer hints; `footerLayout` translates hint by hint.
Home Waiting links open the corresponding Project detail. `v` opens Jobs; Enter opens Inspector there, and `n` opens Native Inspector from Jobs or Inspector.
The owner's Inspector actions (`render/job-actions.ts`, spec §2.2) are pure input: `g` becomes `focus-job-tab`; `1`–`4` and `d` pick an option or the worker's default and become `answer-job`; `X` opens the stop-confirmation overlay, whose `y`/Enter becomes `stop-job`.
Any other input cancels the stop prompt.
`tree-page.ts` does the I/O: `focusJobTab` and `stopJob` (`cli/panel-pane.ts`: `herdr tab focus`, `pi-role-reap`) and `answerJobQuestion` (`collectors/panel-actions.ts`), which writes `qa/qN.answer.md` once (`wx`, like `hud_respond`) and appends the answer to `$HUD_HOME/panel-actions.jsonl`.
`PanelActionLog` turns those records into `[role@job] ANSWERED qN from panel: …` lines for `hud watch` and the MCP `changes`, as the try log does: only answers made while the reader runs.
The `/` filter (`render/filter.ts`) owns the keyboard while editing and provides a filtered snapshot for Project Progress and Tickets. Leaving the view clears it; a kept query survives reload. The filter bar is pinned under the header.
Always retain `frame.state`: reconciliation preserves selection and separate scroll/fold state.

Project → Tickets offers one explicit Accept all action, not on the hub.
Off the paint path, `panel/actions.ts` uses the displayed project's unfiltered ledger and appends one `accept` record under `$HUD_HOME`, never to project files.
The `TryLog` reader still understands old `flag` and `accept` records; the list of flagged items shown to the owner comes from STATE Waiting.

All standalone panels decode their own keys and SGR mouse events through `WorkbenchInputDecoder('workboard')`.
Mouse hit testing uses the same frame controls.
`frame-diff.ts` writes changed rows with absolute positioning and erases each row before writing (erasing after a full-width row would wipe its last cell).

The panel polls its own installed entry signature per collection.
A change must be quiet for two seconds and pass a bounded child import before reload.
Dirty Settings, an open filter, stop confirmation and Control/EXP editors delay replacement.
The transient `MonitorState.overlay` is never sent to the next process; a clean chain view returns to its role row.
`render/monitor-state.ts` holds these reload rules and the input rule for unnamed keys (including `/` and `g`).
A bad generation leaves the old panel running.
Restart preserves argv/env, view/selection/scroll/expansion, Settings cursor, opening time and width override.
`process.execve` replaces the process when available; otherwise one signal-forwarding supervisor handles restart-exit handoffs without nested parents.
Shutdown cancels generators, timers, input/lifetime listeners and snapshot ownership.

## 7. Settings and state on disk

`settings.ts` validates a ≤64 KiB private settings file at `$HUD_HOME/hud-settings.json` (or `HUD_SETTINGS_PATH`).
Saves use temp-file + 0600 + rename.
Display settings override environment defaults once saved; `NO_COLOR` always wins.
Unknown retired keys are ignored and dropped on save, not migrated into new permissions.

Settings has five open groups: Display, Panel, Models, Workers, Codex.
It edits a draft; `s` saves and `r` resets that group.
Dirty navigation asks save, discard or continue; failed saves retain the draft.
Width applies to tmux/herdr panels on Save and containing-window resize, not unrelated saves or border drags.

| Path under HUD home | Contents / writer |
|---|---|
| `jobs/<job>/` | Plain job/brief/STATUS/report/QA and session links; MCP, pi-roles, CLI supervisor or browser wrapper |
| `jobs/<job>/report-meta.json` | Optional private 0600 worker summary, file list and check skip reason, bound to `report.md` by signature; no lifecycle, checks or outcome authority |
| `roles/`, `hud-convention.md` | Owner overrides; read by roster; `roles/<role>.json` places are also written by the Control tab |
| `exhausted.json` | Quota marks on places until the parsed reset (1 minute to 24 hours; 1 hour by default); cleared by the Control tab |
| `credentials.env`, `config.json` | Owner keys and Decision API/configuration |
| `backups/trust/` | `hud trust` keeps ten backups per canonical source path and skips byte-identical repeats of its newest backup. Legacy names assume one owner file per agent/basename; the watcher keeps the newest twenty per group. |
| `display/state/<session>.json` | Active Codex bar/panel snapshot; atomic inode ownership prevents outgoing writers deleting replacements. The watcher removes `pid-<pid>.json` only when the PID no longer exists. |
| `display/state/claude-quota.json` | Last reported quota windows only; optional private cache from Claude statusline stdin |
| `exp/config.json`, `exp/proxy.json` | Private EXP settings and the bound Codex profile's quota snapshot (windows, binding revision, observation time and retry state) |
| `exp/codex-native-<profile hash>.json` | Last native MyHUD bar observed for that canonical local Codex profile (opt-in) |
| `exp/ledger-<account>.jsonl` | Append-only private API grant events; a per-ledger writer lock excludes duplicate IDs, and reads deduplicate legacy entries |
| `display/scan/`, `display/thin-jobs.json` | Rebuildable observation caches |
| `display/model-cache/decision-api/` | Shared execution Decision API reservations |
| `display/model-cache/decision-labels/`, `display/statusline/` | Legacy display labels and rebuildable statusline caches; existing watcher retention applies (30 days, 512 files or 8 MiB per directory) |
| `display/profile.log` | Optional stage timings |
| `panel-actions.jsonl` | Append-only 0600 log of answers the owner gave from the panel; read by `hud watch` and the MCP `changes` |
| `watch.pid`, `watch.log` | On-demand watcher PID and diagnostics |
| `archive/YYYY-MM.jsonl` | Private, append-only job facts written by the watcher before retention deletes a job; no reader or expiry |

An EXP-enabled pi footer draw initiates asynchronous snapshot collection.
A per-HUD-home Linux abstract socket excludes concurrent refreshes; the bounded Codex app-server stdio request is only for account rate limits, not inference.
The panel reads the snapshot but never starts refreshes.
Pi keeps direct subscription windows in memory for the current request only.

Pi history lives in pi's own session store; job directories contain links.
If a Pi worker exits before publishing shutdown status, `hud_close` and the watcher can record `stopped` from `STATUS.json.stop-requested` and the confirmed exit of the recorded process instance.
The watcher scans on the marker.
Native pi-roles workers have no HUD-owned runner socket, so pending stop settlement and read-close preflight may still need a timed recheck (`HUD_WATCH_CLI_CHECK_MS`, default 30 s).
It reaps finished tabs, keeps failed tabs for two hours, and deletes settled job directories one day after closure on a later scan, not a dedicated expiry timer.
Before deletion it moves legacy real JSONL sessions to pi's store; failures retain the job.
No session-link target is deleted.
CLI sessions stay in that CLI's store.
Headless Sonic, CLI supervisors, land and adopted check helpers expose per-job, per-PID abstract sockets.
`runner.ready` wakes a watcher that scanned during startup.
Socket close prompts a fresh PID/receipt check, not a terminal verdict.
A dead CLI supervisor with a live worker hands the job to the main session (`waiting_orchestrator`); the socketless orphan is rechecked with exponential backoff until it exits or `hud_send` restarts the supervisor.
The watcher exits with no open job or failed deadline and restarts on demand.

HUD-home housekeeping piggybacks on the startup scan.
Later scans run it at most once an hour while the watcher is active.
Housekeeping does not keep the watcher running.

No HUD collection writes into Codex's transcripts/configuration; explicit installer registration and `hud import` are separate user actions.

## 8. Rules every change keeps

**Rendering**

- Every panel line is exactly `width` columns: measure with `visualLength`, cut with `truncateAnsi`, not UTF-16 length.
  The bar remains English-only.
- External text passes through `monitorText` once; never sanitize the panel's own ANSI.
- Panel words go through `t()` with EN/ZH entries.
  Colours use theme roles, including `theme.board`, not raw escapes; `none` emits no colour.
- Controls use words or icons, not shortcut letters as their labels; glyphs have meaningful accompanying text.
  Footer shortcut hints remain whole when fitted.
- Drop optional fields before cutting; missing evidence stays absent/unknown.
  Rows use observations and worker declarations, never an inferred verdict.
- Rendering is pure: pass `nowMs`; do not perform I/O, request a model or advance lifecycle during paint.
  Click geometry uses the same frame clock.

**Collection**

- Rollout offsets are bytes; parses go through the single-flight queue.
- SQLite is read-only and best-effort.
  Scan changes bump `SCAN_VERSION`.
- Failed reads yield null/unknown, never a fabricated zero or clean state.
- Status collection must not run repository-provided Git commands/filters or fetch.
- Keep collection bounds and incomplete-coverage facts; do not claim bounded body reads make directory enumeration or native-session totals constant-cost.

**Privacy and repository**

- Display surfaces do not call text models or the Decision API.
  Quiet-job decisions in the CLI supervisor, Sonic auto-thinking, Imp auto routing and role pool picks (governed by `autoPrewalk` and `poolPick`) have independent execution-side switches.
- List every new outbound model input here and in both reference languages.
  A land repair sends only the failing cherry-pick or gate step and its bounded output evidence (§5) to the project's source worker or its same-role replacement.
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

Both test suites import the app from `dist/`.
`build:test` needs the declarations from `npm run build` and emits only TypeScript tests and fixtures under `dist-test/`.
`npm test` runs both builds in that order, then the default unit runner and the `.mjs` suites.
Snapshot updates are explicit: inspect their diff; normal tests do not rewrite frames.
Tests use temporary homes, fixed clocks and synthetic data; render checks compare terminal cells, not font pixels.
Restore display/language state in `finally`.
A real client/browser check remains separate from fixtures.
CI runs `npm test`, `npm run test:release` and fixture checks on Node 24 with and without colour; a separate stable Rust job builds and tests `native/`.
For a clean regression run, use `npm run clean` before testing in an isolated checkout, not one serving a live panel.

`CODEX_HUD_PROFILE=1` appends stage timings to `display/profile.log`.
Performance evidence names host and workload; it is not automatically WSL qualification.

## 10. Recipes

- **Setting:** add type/default/validation in `settings.ts`, a row in `render/settings-page.ts`, mapping through `monitorSettings` if needed, EN/ZH labels, behaviour tests and both references.
- **Theme:** add its name/order in `hud-config.ts`, palette/board inks in `palette.ts`, translations and contrast/frame tests.
  Keep 4.5:1 body text, 4:1 failed/question text and 3:1 selected-row floors.
- **Bar field:** add facts and a builder in `layout/bar-fields.ts`, its field list and fitting-ladder position, then each client's available facts.
  Test widths.
- **Job/Inspector:** external prose is sanitized and wrapped; show declared or observed evidence, never generate display summaries or verdicts.
  Test narrow widths and both languages.

## 11. Gotchas

- Panels reload after a valid build; bars still need restarting for new code.
- Saved display settings override environment defaults; `NO_COLOR` still wins.
- A report's existence or summary is not proof of success.
- Codex encrypted tasks have no public text to summarize.
  Do not send ciphertext or invent a task from a nickname; public pre-create charge is usable when present.
- LLM/Decision caps are shared local-filesystem coordination, not provider billing.
- Moving/removing the installed checkout breaks path-bound command/client links.
