# HUD product spec

Only the owner decides what this page says. An agent may edit it only after telling the owner the change
and why. This page is the boundary for every brief, answer and review. It overrides the concept document
and older decisions. (17.01, 10.02)

Decision refs use `DD.NN` for `D-2026-11-DD-NN` in `docs/decisions-log.md`.

## 1. What it is

One HUD for Claude Code, Codex, pi and Antigravity (`agy`), used by one person (the owner) on one Linux/WSL
machine, inside herdr. (10.02, 22.12)

## 2. What it must do

### 2.1 Delegation through one MCP

#### 2.1.1 Tool surface and thin layer

- Start and use roles through one MCP from any supported main session. Add tools when clearer; no cap.
  (17.02)
- Main-session tools: `hud_roster`, `hud_create`, `hud_read`, `hud_send`, `hud_respond`, `hud_close`,
  `hud_wait` (hidden from MCP-task clients), `hud_peek`, `hud_tickets`, `hud_lease`, `hud_statusline`.
  (17.02, 21.07, 22.04)
- `hud_land({ job })` lands a settled managed worktree through the project's configured gate, fast-forward, after commands, optional push and cleanup as one flow. (22.19)
- `hud_read` returns a digest by default (state, result line, changed files, verdict and blockers when the report gives them); `mode: "full"` returns the whole report; `jobs` reads several at once. (22.15)
- Thin tools over local herdr and unbundled pi-roles (its pi package, `STATUS.json`, `qN.answer.md`,
  `pi-role-reap`). The MCP opens the job's herdr tab. Jobs are plain JSON under `$HUD_HOME/jobs`. (10.01)

#### 2.1.2 Roles, routing and presets

- Role files set instructions and continuability; HUD ships defaults. MCP names logical roles (`imp`,
  `reviewer`, `sonic`, `oracle`, etc.), not roles per harness or site. (14.01)
- Use the first available place (harness, model, thinking) in the role's ordered chain. Skip exhausted
  places until parsed quota reset (one hour if unspecified). Skip pre-input launch failures for this
  dispatch. Name places tried in the result. (14.01, 18.01, 21.01)
- CLI roles use herdr with pi-roles or an interactive CLI (§2.1.3). Browser tasks (ChatGPT, Gemini, AI Studio,
  Flow) use the shared browser via `bro`. Jev and Decision API name the structured choice/predicate model
  with probabilities, not the browser. (11.01, 14.01)
- `oracle`: strongest-model local, read-only advisor on a model harness for any judgement in the brief.
  `architect` and `oracle` share `oracle`, with former setups as presets. On create, `architect` aliases
  `oracle` unless a role file defines `architect`. Strong web role `pro`: ChatGPT 6 Pro, then Gemini, then
  AI Studio. (14.01, 17.03)
- `general`: global ad-hoc work set by the brief, with any model (e.g. a pi provider's) via `hud_create`
  `model`/`thinking` for one job (§2.1.4). (16.01)
- Named presets in role files are full chains. Owner switches places and presets in Control (§2.2.5).
  `hud_create` can pick a harness (`on`) or `preset` for one job without editing role files (§2.1.4).
  (14.01, 17.04, 18.01)
- Ship presets for the owner's current combinations, including Antigravity Hydrogen (`high`) for `imp`.
  No shipped Grok presets for `imp`; `grok` and `xai` are currently switched off. (21.02)

#### 2.1.3 Interactive CLI harnesses and trust

- Support Grok Build, Antigravity, Claude Code and Codex. Check local CLI trust files before opening a tab;
  refuse untrusted directories. Launch in the job's herdr tab with only model, effort and permission-bypass
  flags, without editing CLI config or session stores at launch. Use herdr status for report, idle grace,
  continuation, questions, stop and reap as with pi. Launch per job without blocking other jobs or answers.
  (13.01, 18.02)
- Antigravity workers get the worker MCP like Claude and Codex, with the shell done-command fallback. (22.12)
- `hud trust <dir>` backs up files under `$HUD_HOME`, then directly adds the owner's chosen project directory
  `<dir>` to Grok Build, Antigravity and Claude Code trust lists. Installer config is separate (§2.4). (13.01, 22.12)

#### 2.1.4 Dispatch inputs, isolation and launch guards

- `hud_create` can override model and thinking for one job. Per `docs/delegation.md`, the main session
  passes `preset`, `on`, `model` or `thinking` only if the owner asks for it in that request; no carryover.
  Exception: `preset: astra` for `imp` on hard slices (several modules, review fixes, design-heavy). (22.20)
  For pi roles, named switches cover pi-lens, MCP adapter, tokens/s, UI extensions, helper pane and personal
  skills; pass extra pi args as given. (11.02)
  Pi workers skip the MCP adapter when no MCP servers are configured unless `mcp: true` is set. (22.17)
  Claude and Codex CLI workers load only the HUD worker MCP and servers named by their role, except that unreadable Codex configuration leaves its MCPs unchanged with a launch diagnostic. (22.18)
- `context_files` and `from_jobs` write a reference index into local worker briefs and splice bounded file
  contents into browser briefs, without round-tripping through main-session context. (18.03)
- `hud_create(scout: "<question>")` runs sonic on its role defaults in the target cwd with the target's `context_files`, then starts the target with the dossier in `from_jobs` or a failure note in its brief, with one notice or MCP task for both stages; sonic cannot request a scout. (22.19)
- `isolation: "worktree"` creates a clean Git worktree with linked `node_modules`; `hud_read` gives
  `git_summary`, including files also changed in other managed worktrees of the same checkout. After closure
  the watcher reaps only clean worktrees that are merged or unmodified, or whose commits are already on
  the base branch (cherry-picked); preserve dirty worktrees or those with unintegrated work. (18.03)
- Panel try marks, question answers and retry or land requests reach the main session even when it uses MCP tasks without `hud watch`.
- A project's `worktree.disposable` globs exempt matching ignored files from worktree cleanup's dirty check; the default is empty. (22.19)
- HUD, not the model, manages launch parameters. Check each dispatch's model, thinking and place against
  model facts before opening a tab. Show only supported levels; map to nearest supported and report the
  level used. On pre-start failure close the tab and report the cause, not a timeout. (21.04)
- Sonic thinking uses the role default (`high`), not caller choice or a tool prompt. Off by default:
  Decision API chooses `low`/`high`/`max` using each brief and the role file's level purposes. Any failure
  falls back to the default. (21.05)

#### 2.1.5 Lifecycle, settlement and cleanup

- Main decides each step except the quiet-job choice below, never manages workers. `hud_create` starts
  them, the watcher closes them, `hud_close` only closes early. No HUD role chaining. (11.03, 14.02)
- Only facts end a CLI job. It fails only if its process is gone, its tab closes or dispatch is rejected
  before input. Exit after reporting means closed, not failed. Herdr screen status, absent report or dead
  supervisor hand live workers to main; never fail or quit them. (14.02, 22.10)
- Quiet CLI job past idle grace with no report: one Decision API choice to wait, send one fixed prompt to
  write the report, fail and mark the place exhausted, or hand to main. A fail choice stands only if it
  quotes a quota or rate-limit line from the worker's screen; otherwise hand to main. Also hand to main
  below confidence threshold, without a key or on any error. (14.02)
- A live child the worker starts this turn proves work. No settlement, quiet-job decision or closure before
  declared completion. Session-long helpers (e.g. MCP servers) don't count. Exempt MCP servers launched by
  `npm exec`, `npx` or `uvx` even if startup ends after first turn dispatch. (17.05, 18.04)
- Require an explicit current-turn CLI done receipt with the signature of a fresh report that still matches
  the report on disk. A new turn or rewritten report invalidates it; terminal output and herdr idle neither
  declare nor invalidate. Pi native settlement plus changed report is equivalent. Without valid declaration
  the live-child rule applies. (19.01)
- After declaration, leftover shells, test runners and daemons don't block settlement. An unread report
  puts a continuable worker in idle grace. Close a settled worker as soon as main reads its report; else
  keep it until its idle deadline. Terminate only the worker and proven descendants, including leftovers;
  leave processes without captured ancestry alone. (17.08, 19.01)
- Intentional stop records stopped regardless of first writer, even with simultaneous tab close. Retry failed
  process/tab cleanup after closure until gone. Pre-input continuation refusal opens no turn. (18.05)
- `hud_send` to a closed job creates a new repair job referencing the old brief and report. `hud_create`
  and `hud_send` derive omitted idempotency keys. (21.06)
- Before deleting a closed job directory, the watcher appends one line of the job's facts (no report text) to `$HUD_HOME/archive/YYYY-MM.jsonl`; nothing reads it yet. (22.16)

#### 2.1.6 Events, project scope and the worker surface

- `hud_peek`: bounded recent pane output and optional `hud-progress` `progress.jsonl` entries; no state
  changes. (18.03)
- Whatever the panel shows about a job also reaches the session that dispatched it. `hud_create` returns
  dispatch failures as failures. For clients without MCP tasks, each MCP response carries session job
  `changes` since its last call and `watcher_alive` if a pane watcher is registered. `hud_wait` gives one
  event watch for `any`/`all` settlements or open questions across named jobs or all open session jobs;
  `hud watch` prints one line per job event for command watchers (Claude Code Monitor). Clients that
  declare MCP tasks get task completions instead. (14.03, 18.03, 20.09, 22.09)
- Codex queues silently; pi uses its HUD extension's native session message queue. No main-pane typing with
  native or watched delivery. The panel and MCP share a state reader. (14.03, 18.06)
- A working Antigravity session gets job events through its `PreInvocation` hook. An idle session has them
  typed into its prompt. (22.12)
- Neutral workers do only their job, with one role text across harnesses. On any harness a worker may
  choose to start sonic for a useful, simple, fully specified sub-task. If it does, it collects the report.
  HUD refuses worker requests to start other roles. (17.06)
- HUD identifies jobs from the worker environment; no protocol paths or commands in briefs or role texts.
  Worker MCP lists only `hud_report` (report, optional one-line summary and file list, done receipt in one
  step), `hud_ask`, `hud_sonic` (start without blocking, then collect; pi workers get a ready notice when a child settles), `hud_progress`
  and `hud_lease` once leases exist. Pi gets the same worker tools natively. Scripts only for harnesses
  without MCP or the Antigravity fallback (§2.1.3). (21.03, 21.07, 22.01, 22.08, 22.12)
- Worker or main takes a named `hud_lease` before using a shared resource named in the brief (real install,
  paid or live runs, shared browser). One holder; free on holder end. No resident process. (21.07)
- `hud_create` may name check commands. HUD runs them once the worker declares completion, records them
  against that report's signature and attaches results. Checks never settle, accept or fail a job. (21.08)
- Job lists are per project root, not pane. Same-project sessions adopt jobs whose recorded pane is gone.
  Manual restart recovery: herdr resume loses job bindings; no relaunch of resumed sessions. (21.09)

#### 2.1.7 Ticket method and dispatch convention

- No role- or workflow-specific MCP logic except `hud_tickets`. With no operation it returns one shipped
  method/template text for every MCP client, without per-client skills or additions to the convention.
  Main drafts the slices. (20.03)
- `add`: feature slug and drafted tickets (title, blocked-by numbers, deliverables, acceptance items) in
  numbered Project-format files in `.scratch/<feature>/issues/`; reject unknown blocker numbers.
  `update`: set status (including `claimed` and `done`), tick acceptance items or set blockers; blockers may
  name `<feature>/<NN>`. `sync`: run `hud tickets sync`. `add` and `update` write
  local trackers only; refuse GitHub mirrors and give the `gh` plus sync route. (20.03)
- `hud_roster` returns roles and effective convention. Ship a short default, replaced whole by a project or
  owner file. Only dispatch mechanics; methods (grilling, specs, tickets, design vocabulary, build recipes)
  go in on-demand skills that may stay uninstalled, not every session's convention. (17.07)
- Mutating MCP tools accept batch arrays with independent per-item results in input order: `hud_create` `jobs` (with `brief_file` for task text inside `cwd`, each created job keeping its own notice), `hud_tickets` `updates`, `hud_respond` `answers`, and `hud_send` `messages` (alongside fan-out `jobs`).

### 2.2 Observation, status bars and side panel

#### 2.2.1 Status lines and themes

- Every status line shows output tokens/s. Each client keeps one always-on bottom line: Claude replaces
  claude-hud (same owner fields), pi absorbs p10k-footer, `codexH` keeps its tmux bar. Pi ribbon stays at the
  right end of the editor's top border; other extensions' statuses stay visible. (11.04, 12.01, 17.09)
- Antigravity shows the HUD statusline through its `statusLine` command. (22.12)
- BAR-THEMES for the Claude, Codex and pi bars and pi ribbon: Gauge Plates, Tide, Micro Glyphs, Stacked, Headline, Triptych.
  Keep default look. Stacked is the sole opt-in two-row theme. (12.01)

#### 2.2.2 Side panel, tabs and layouts

Reference: `docs/design/panel-v8/` (option 2) and `docs/design/panel-v8/notes.md`.

- All clients: `/hud` alone opens the same standalone herdr sidebar with main-session jobs and state.
  Delegation tools stay registered either way. No Codex tmux panel (F12/Shift-F12, prefix keys/setting,
  gutter focus lock). (11.04, 17.09)
- All clients: click selects tabs/rows/buttons, second click is Enter, wheel scrolls. Click a picker row to
  set the model. Left/Right, Tab and clicks switch tabs, not numbers. (20.10, 19.03)
- Settings → Panel → Layout: Classic (default), Split (list over selected-row preview). Only the notes
  override Home/Project layout rules in Split. Never hide owner needs. Split ratio: `=` / `-`, no drag.
  Compact the list on preview focus; zero-width right-edge scrollbar on scrollable previews. `/` filters
  Home, Progress slices and Tickets live. (17.13, 18.08, 18.09, 19.03)
- Main tabs: Home, Project, Control and experimental EXP. Project layouts apply only to Project pages.
  (11.04, 20.01, 22.02)
- The old panel-level Inbox is removed, not Project's Inbox layout (§2.2.4). (18.08, 20.06, 22.05)

#### 2.2.3 Home and native subagents

- One Home page: owner needs, then job cards in lanes. Group by optional `hud_create` package label, else
  brief title; display only, not interpreted by MCP. Default: see, try and accept tasks (ledger milestones
  or ticket features). A setting shows slices and tickets. (11.04, 11.08, 20.04)
- Finished jobs hide after a short time; `a` reveals them in place. (11.04)
- Collect worker decisions for the owner but do not show them. (20.04, 22.11)
- Default or Recommended. Recommended ranks and folds cards via Decision API and shows a short progress
  brief. Never hide cards needing the owner. (12.02)
- Read native subagents from transcripts (Claude Agent incl. custom, Codex, pi). One lane per main session
  beside package lanes; one card per subagent with same hide rules. Indent nested agents one level; deeper
  use flat `↳ parent`. External current-work summaries follow the master switch. No agent log, card label
  or card summary settings. (12.03)
- Spare rows: compact board and the milestone and ticket rollup (started features, unstarted folded into one row); cards win. (22.14) Top line counts STATE waiting items with questions.
  Idle Home lists waiting items and newest landed slices above progress. (12.04, 17.10)

#### 2.2.4 Project hub, progress, layouts and export

Reference: `docs/design/project-ux/` (A: Timeline; B and C: Board and Inbox),
`.scratch/project-layouts/spec.md`.

- Project can switch among the panel's project and `hud setup` projects. Home stays local. Progress,
  Tickets, Working tree and Docs each have a hub summary row and their own page. (12.04, 14.04, 22.02)
- Working tree: branch, changes, editing job, last commit. Docs: spec milestone, STATE waiting items, newest
  review. STATE carries `## Waiting for the owner` and `Milestone:`. Tickets (`to-tickets`): derive status at
  read time from linked jobs, STATE slices, commits naming the ticket and accepted tries, else the file's own
  status; a ticket waiting only on unfinished predecessors shows as queued, not blocked, alongside its blockers,
  package lane links, checklist and latest comment. (12.04, 14.04)
- Progress reads project files: STATE `## Now` summary, one stacked bar and legend from `## Slices` (working,
  blocked, landed to try, accepted, todo, dropped), §5 chips with current from `Milestone:`, in-flight slice
  blocks with current job work, and `## Next`. Include running project jobs; group to-try and accepted slices
  by milestone, older folded. (12.04, 14.04)
- Timeline hub: Now (who, slice, duration) and Latest (landed slices, age, awaiting try) above page rows;
  fold Latest first when short. Hub bar is current milestone. Progress: dated feed of the last 7 days, one
  row per older milestone. Tickets: state lanes and For-you. (14.04)
- In Progress's to-try view, `y` accepts and `n` flags one slice or all still-to-try slices on a milestone
  row. Multi-select
  emits one record and one line. Write only under `$HUD_HOME`, never to project files. Mark at once.
  Main hears via `hud watch` and MCP `changes`, updates STATE (`accepted` or Waiting for the owner) and
  asks what's wrong for flags.
  (17.11, 18.07)
- A waiting item can end in `(waits on <slice ID>, <feature>/<NN>)`. When all named slices are accepted or
  dropped and tickets done or dropped, hide it and stop counting it without editing STATE. No to-try slice
  is also a waiting item. Wrap the whole item where rows permit. Never cut what the owner tries to a name.
  (18.07, 20.05)
- The board model can translate waiting items, open worker questions and open ticket titles into the display
  language when needed, with the original folded below (22.14). For to-try slices it writes a short brief
  explaining what changed in plain words, and steps for trying it, from the ledger line, ticket and commits. List: ID and first sentence. Preview or expanded row:
  full brief and steps, ledger text folded below. No model or no brief: wrap full original text. (18.07, 19.02)
- Settings → Panel → Project layout offers Timeline (default), Board and Inbox in Classic and Split. It
  only arranges Project pages; counts, keys, to-try rows, cuts, words, Home and Tickets stay unchanged.
  (20.06, 22.05)
- `hud board [--html] [--open]` or panel `w` exports self-contained static HTML for the project and to-try
  review, with no network fetches or resident server. (18.09)

#### 2.2.5 Control and model picker

Reference: `docs/design/control-tab/design.md`, `docs/design/control-tab/index.html`, `.scratch/control-tab/`,
`docs/design/model-picker/index.html`, `.scratch/model-picker/`, `docs/design/ux-pass/`, `.scratch/ux-pass/`.

- Roles, Attention, Usage and Files for the selected project. Open on owner attention and next job place;
  fold healthy roles. Show role/harness/model/thinking/source, convention/source, available keys, browser
  availability, client quota watermarks, today's pi spend and today's per-role dispatch health beside
  presets. (12.04, 14.04, 18.09, 20.01, 22.02)
- List HUD roles, pi-roles definitions (model/thinking), native custom agents (`~/.claude/agents`,
  `.claude/agents`, `~/.codex/agents`), active convention, `CLAUDE.md`, `AGENTS.md`. Enter opens file beside
  panel in herdr with `$EDITOR` (default `vim`). (12.04)
- Toggle supported CLI agents, browser tools, pi runner and pi providers for future jobs via `disabled` in
  `$HUD_HOME/harnesses.json`. Absent or new means on. Keep off places in chains; skip like exhausted places.
  Don't rewrite role files. Panel, `hud_roster` and `hud_create` share evaluation. Unattributable provider:
  report unknown, don't guess or block. (20.01)
- One role-row key applies a preset. Show active preset and next place. Save current chain or empty draft as
  a new preset; rename/remove presets. Add places with model/thinking; move/remove/save in place.
  (17.04, 20.01)
- Discover pi models on demand, not per key or tick. List all enabled providers' discovered models grouped by
  provider. Click a place's model field or press `m` on role/place for same-pane picker (two columns from
  about 100 columns; no zoom or web console). Save a place's model instantly; other edits stay drafts.
  (20.02)
- Likely first: current, role presets, providers roles use. Typing filters one ranked flat list. Pin current
  and role preset models; show context, output, thinking, image facts and HUD state. No price without local
  source. (20.02)

#### 2.2.6 Micro-actions and visual cues

- No panel briefing or chaining. Owner actions equivalent to local commands: `g` focuses selected job's
  herdr tab; `1`–`4` or `d` on expanded question writes `qa/qN.answer.md` once, notifies main via `changes` /
  `hud watch`; confirmed `X` reaps a runaway via `pi-role-reap`. (18.09)
- `r` on a failed job requests a retry and `m` on a to-try slice requests landing; the panel records the intent and the main session decides whether to act.
- Split's unselected working rows show compact keyword and progress cues. Cards and Inspector show a 10-bucket
  activity sparkline (`▁`–`█`), `hud-progress` milestones and nested `sonic` trees under their parent jobs.
  Inspector, Working tree and To-try previews show a bounded safe Git `--numstat` diff bar (top 12 files)
  for the job's worktree or slice commits. (18.09)

#### 2.2.7 Experimental EXP tab

Reference: `docs/design/exp-usage-plan.md`, `.scratch/exp/`.

- EXP: machine-wide HUD usage settings. Settings → Panel → Experiments defaults off: no tab, collection
  or refresh. (20.07)
- Codex native line beside `codexH` tmux bar. Pi footer subscription proxy: bound Codex profile's rate-limit
  windows, source and estimate `≈`; Claude-style bar, percent used, threshold colour and reset. (20.07)
- Refresh only while used: pi footer draw starts one locked async refresh when the reading is older than
  the interval. No timer or resident service. (20.07)
- `anthropic-api`/`openai-api` grant ledgers: monthly grant, renewal day, manual calibration and estimated USD
  remaining. Append-only JSONL in `$HUD_HOME/exp/` with a dedup key per request; balance on read. No vendor
  billing sync, balance scraping, request blocking or admin keys. Zero estimate never stops a CLI. (20.07)

#### 2.2.8 External models for display

- Optional external Decision API text in panel and bars: summaries, recaps and sentences with owner keys
  (`$HUD_HOME/credentials.env`). Read only job files and the project's STATE and ticket files; write only display text. Never prompt, brief or steer
  workers. No consent or authority layer. (11.05, 12.02)
- Settings API (default OpenAI) labels settled outcome, job kind, quiet repeated failures on running cards,
  question category and review finding severity. Outcome is independent report judgement, never self-graded.
  (12.02, 22.01)
- Signature-bound worker `hud_report` summary supplies the finished result line, notices and `hud_read`.
  Model fallback only if absent, stale or wrong panel language. No two-minute hold on settled results.
  (22.01)
- Small external model: thin-card short name and third line (one sentence on current work), one-line finished result subject
  to the rule above, 1–3 marked keywords for panel colour. On state change, in panel language, ≥2 minutes
  apart per job except above. Factual line with no key or switch off. Settings: master switch (on with a key),
  model and call cap; no per-feature switches. (11.05, 22.01)
- Same approach on native cards: names, progress, result digest and failure cause. No consent setting or
  "Job consent denied", no card progress used only by retired facade jobs, no model text only for hidden views
  (main recap, approval words, change summary, session title, `S` overview). (11.05, 12.03)

#### 2.2.9 Help and backup skills

- Help (`?`) has a section listing backup skills. (17.12, 17.14, 22.03)
- Shipped catalog: uninstalled Matt Pocock skills (adapted and upstream, §2.3.2). Show name and full one-line
  panel-language description, wrapped under name at 40 columns. Display only: no row action, install state
  or adopted/dropped skills. Main reads a skill on owner request. (17.12)
- Keep Inspector (`v`), Settings and Help in Home's look. No old Timeline page (not Project's Timeline
  layout), Activity hub, Summary, diagnostics pages or old Agents pane. Keep only the model-call count
  from diagnostics in Settings → LLM. No Settings panel picture, Look presets, Nerd Font or emoji icon
  sets, motion switch, stack/tabs layouts, foot status card or rows only they used. (11.06)
- Changes: Git/worktree summary only (branch, ahead/behind, change counts, row per worktree); no file lists,
  diffs or previews. (12.06)

### 2.3 Project setup, skills and ticket sync

#### 2.3.1 Setup and trust gate

- One owner conversation via `hud-setup`, like claude-hud. `hud setup --detect | --apply PLAN | --remove`
  writes `.hud/`. Load only for owner-set-up projects (`$HUD_HOME/projects.json`), never on clone alone.
  (13.02)
- Commit project roles in `.hud/roles`; set-up projects may hide others. Pi-only worker customization:
  role-named skills linked under `.hud/skills`, prompt in `.hud/agents`, settings. Main sessions and official
  CLIs (§2.1.3) keep their behaviour. Like owner files, project chains can name CLI places (agent, model,
  thinking only, no extra args). (13.02, 20.08)
- Optional `.hud/brief.md` for set-up projects; every brief there references it after the task. (21.10)

#### 2.3.2 Skills policy

- Use the HUD flow in `docs/delegation.md`: the `to-tickets` method (§2.1.7) and one review per milestone.
  The Matt Pocock collection is inactive and on demand. The upstream plugin is off in Claude, Codex, pi and
  all other harnesses. Install none of it; remove earlier `to-tickets` links in Claude, Codex and pi. Install
  `hud-delegate`, `hud-setup` and `hud-handoff` for all three. (17.14, 20.03)
- Keep adapted `grill-with-docs` (with `grilling` and `domain-modeling`), `to-spec`, `hud-build`, `tdd` and
  `diagnosing-bugs` in `integrations/skills-optional/`. Keep verbatim `wayfinder`, `triage`,
  `improve-codebase-architecture`, `wizard`, `teach`, `wait-what`, `writing-for-agents`, `to-questionnaire`,
  `prototype`, `retro`, `pr`, `codebase-design` there too. Each names its upstream commit; we own adapted text
  and do not track upstream. (17.14)
- Do not install, link to workers or offer these in `hud setup`. No role, including oracle, loads them by
  default.
  The main session reads one at the owner's request or names it by path in a worker brief. (17.14)

#### 2.3.3 One-way GitHub Issues mirror

- `hud tickets sync` alone writes the one-way GitHub Issues mirror in `.scratch/` for Project and workers.
  Read via `gh`: parent with sub-issues becomes title-slug feature, sub-issues its tickets. Use Project
  format. Main syncs after each tracker write. No polling or panel network access. (17.15)

### 2.4 Installation and uninstallation

One command each: `./install` with core and chosen extensions (Claude, pi, Codex, `agy`, browser, herdr);
`hud uninstall` removes them. Register via official client commands where available. The `agy` extension
reversibly configures Antigravity's MCP, permission, statusline and `PreInvocation` hook. (13.04, 22.12)

## 3. What it does not do

- No own execution platform: no ledger database, no general process-supervision platform, no native host
  or bridge, no SDK-driven sessions. herdr, pi-roles and the browser runtime already do execution. The
  per-job CLI supervisor and on-demand watcher are allowed (§2.1.5 and §4). (10.01, 10.03, 14.02, 22.10)
- No workflow engine or automatic role chaining. No multi-user or adversarial security model and no identity
  proofs between local processes. (10.03)
- No transactional installer: no plan IDs, receipts or byte-exact restore. A plain backup of each edited
  client
  file is enough. No vendor version pins. (10.03)
- Do not track upstream for the ported claude-hud statusline or p10k-style footer. They are ours and change
  only for our needs. Update pi and its extensions with `pi update` when useful. (10.01, 10.03)
- No native Windows, npm publishing or cross-machine use. (10.03)

## 4. Threat model and quality bar

- Trust the owner, their configs and tools. Guard against only irreversible loss of the owner's data or
  config,
  and commands from an untrusted repository (e.g. Git config in a clone). (10.04)
- Otherwise use the simplest implementation that works. New guards, options or abstractions require a concrete
  reason in the brief. (10.04)
- No resident service. `hud_create` starts the watcher on demand. It reacts to job-file and herdr events,
  reaps
  finished jobs and exits when none is open. Keep statusline and panel at least as fast as what they replace.
  (11.03, 10.04)
- Done means the owner can install and use it, not that tests are green. (10.04)

## 5. Milestones

- **M1, usable.** Repo `./install` (core + Claude, pi, Codex), `hud uninstall` (§2.4); MCP and skill
  registered in all three clients; `hud panel`; M1's six tools work for imp, reviewer and sonic via herdr.
  Claude statusline at claude-hud parity; pi footer replaces p10k-footer (§2.2.1). Owner installs and uses
  it. (10.01)
- **M2, clean.** Right after M1, acceptance: retired execution stack (R6b slice L), old role facade and its
  identity/release checks (replaced by the thin layer), old hud-mcp default managed surface and `role-main`,
  and their tests removed. (11.07)
- **M3, extend.** Browser tasks and oracle jobs. (11.07)
- **M3b, AI-THIN.** Small-model display text (§2.2.8). The owner tries real jobs on the real panel.
  Card and result lines are one sentence each; keywords scan at a glance. (11.05, 20.04, 22.11)
- **M4, project view.** Project after other open items, without waiting for Matt's skills. Frozen close:
  whole-project review and fixes; three last slices (panel reloads itself after a new build, Settings shows
  model calls per feature, one test snapshot-update command); release. New ideas go to M5 candidates,
  not M4. (12.05)
- **0.1.x**: 0.1.1 CLI workers and `hud trust`; 0.1.2 `hud setup` (`.scratch/hud-setup/spec.md`);
  0.1.3 Project hub (`.scratch/project-hub/spec.md`); 0.1.4 roles apart from harnesses
  (`.scratch/role-bind/spec.md`). (13.03, 14.05)
- **0.2.0, MCP orchestration & Panel V2.** Current milestone. (22.07)
- **MCP-ORCH, orchestration mechanics into the HUD.** After WORKER-MCP, in order: launch facts (supported
  thinking per model, next place on failed launch, worker HUD home from job directory); derived keys, repair
  of closed jobs, one send to multiple jobs and `retry_of`; standing brief and convention without per-harness
  delivery text (that goes into tool results); leases; project scope and restart recovery; HUD-run checks;
  MCP tasks; coalesce settlement notices arriving within seconds, with questions still immediate.
  (21.11, 21.12, 22.06)
  - MCP tasks for declaring clients (today Claude Code): first verify wake, cancel and `/tasks`. One task
    per worker turn (`hud_create`, `hud_send`, `hud_respond`) until report or question. Result: state,
    the hud_read call, one-line summary and check outcome, sent after HUD-run checks finish; not a read. Cancel closes the job. (20.09, 21.12, 22.06, 22.15, 22.21)
  - Excludes general plan execution. Fixed HUD flows (land, scouted dispatch, ticket queue) chain their
    listed steps, stop at the first judgement point or after two failed repairs, and hand back to the main
    session in one notice (22.19). Also excludes a resident server
    (on-demand watcher with short-lived helpers suffices) and project notes (only if repeated answers remain
    after the standing brief). Done: The owner runs a real project day; compare its counts with the
    2026-11-21 study using the same measures. (21.11)
- **M5 candidates (not scheduled; the owner picks):** retention period for job directories and model caches
  (owner sees the deletion list first); read transcripts tail-first on open for immediate status, filling
  in nesting behind; fold rarely changed Settings rows under Advanced. (12.07)

## 6. How work is done

- Follow `docs/delegation.md`. Each brief names the spec line served, what is out of scope, a size budget
  and a stop rule. Review at milestones and before the owner installs, not per package. Trying the build as
  owner is the main review. (10.05)
