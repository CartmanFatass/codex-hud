# HUD reference

Current controls for Claude Code, Codex and pi. [中文](./reference.zh.md) ·
[Quick start](../README.md) · [Architecture](./ARCHITECTURE.md)

- [Installing](#installing)
- [Universal CLI and MCP](#universal-cli-and-mcp)
- [Project workers](#project-workers)
- [Home](#home)
- [Project](#project)
- [The panel](#the-panel): [Keys](#keys), [Inspector](#inspector), [Changes summary](#changes-summary), [Settings](#settings)
- [LLM](#llm)
- [The bottom bars](#the-bottom-bars)
- [Machine-readable state](#machine-readable-state)
- [Configuration](#configuration)

Earlier activation, bootstrap and owned-worker designs live in git history and
[dated reviews](https://github.com/CartmanFatass/codex-hud/tree/universal-hud/docs/reviews),
not in the current setup instructions.

## Installing

Use **Node ≥24.0.0** (Node 24 is the tested supported line; see
[runtime evidence](./ARCHITECTURE.md#3-launch-and-installation)). From the checkout:

```sh
./install --with claude,pi,codex,browser,herdr
```

Choose any of **claude**, **pi**, **codex**, **browser**, **herdr**; core is always
included. The installer checks Node before extension hooks/builds/changes, builds
the HUD and MCP, and links commands into `~/.local/bin`. `--skip-build` uses existing
build output. Keep the checkout/extraction directory: installed commands and client
bindings point into it. No shell rc file is edited.

External tools are checked, not installed or authenticated. herdr/pi-roles/pi are
separate prerequisites for workers. The herdr extension reports their PATH locations
(only missing herdr fails). The browser extension requires `google-chrome` and
`jev-ask`; it also reports optional `jev-aistudio` and `jev-flow`. It writes no
browser configuration and launches nothing. Configure Chrome/login/keys through
those external CLIs. The panel and Decision API need no browser extension.

Ordinary `claude` uses the global HUD statusline unless an owner-defined non-HUD
statusline already exists; ordinary `pi` loads the HUD footer. Codex's tmux bar
uses the installer's printed shell function:

```sh
codexH() { hud codex "$@"; }
codexH
```

Only the panel is opt-in: `/hud` opens it in Claude, Codex and pi; it never opens
at launch. Uninstall with `hud uninstall` or `./install --uninstall`; `--with names`
limits extension removal. HUD data and unrelated owner settings remain. Claude
settings follow symlinks with a one-time plain backup; Codex backs up resolved
`config.toml` before official MCP commands and warns if comments are dropped.
Pi registers delegation and display packages and excludes the old p10k-footer.
See [installer extensions](../install.d/README.md) for backups and multiple Codex homes.

## Universal CLI and MCP

```sh
hud --help
hud panel --help
hud panel                 # beside the caller in herdr, otherwise in this terminal
hud panel --here          # no split
hud panel --width 64      # this open only, until a changed Width is saved
hud statusline --help
hud import --help
hud trust <dir>           # add the directory to grok, agy and claude trust lists
hud watch                 # pending questions and actionable events (--verbose: every change; --all: every pane)
hud setup --detect        # print this project's worker setup as JSON
hud setup --apply PLAN    # write .hud/ from a plan
hud setup --remove        # drop project registration; leave .hud/
hud tickets sync [--cwd DIR]  # mirror GitHub parent/sub-issues into .scratch/
hud board [--cwd DIR] [--out FILE] [--open]  # write the project's HTML review board, print its path
hud codex --model gpt-5    # Codex arguments pass through to the tmux launcher
```

`hud codex-hud` aliases `hud codex`. Panel selection accepts
`--root <namespace/session-id>` or `--harness claude|pi|codex --session ID --source ABS`;
these select observations, not execution identity. Without explicit selection,
`HERDR_PANE_ID` permits a one-second `herdr pane current` lookup for the caller's
Claude transcript or Codex session (`CODEX_THREAD_ID` fallback inside a herdr pane); no focused-pane guess or statusline-written binding is used.
Unavailable evidence leaves the jobs view unbound to a native session.

The MCP exposes **hud_roster**, **hud_create**, **hud_read**, **hud_wait**, **hud_peek**,
**hud_send**, **hud_respond**, **hud_close**. Call `hud_roster` when project dispatch context is missing or stale.
It returns role availability, continuation, effective `runs_on` and the convention. For presets, fallbacks,
model/thinking sources and accepted options, pass `detail: true`. When refreshing, pass the prior
`convention_version` only if you still have its text; a match omits the convention, never the fresh role rows.
Bundled role JSON is overridden by `$HUD_HOME/roles/*.json` by role name, then by a
registered project's `.hud/roles`. The first `hud-convention.md` in a registered
project's `.hud/`, the cwd, HUD home, then the package wins whole.
See [Project workers](#project-workers).

Every MCP response also carries `changes`: one line per state change of the jobs this pane dispatched since
the last response (omitted when there is none). Panel, statusline, pi footer, MCP and `hud watch` derive a job's
state through one shared `jobRow`, so they agree. `hud watch` defaults to actionable events: new questions
(with text, options, default and `hud_respond` reply), settlement/unread reports, blocks and new quiet-worker
reasons. It skips working starts/resumes, answered questions and already-reported closure; `--verbose` keeps
all MCP change lines. On start it catches up pending questions, unread settled reports and unread failures/blocks.
It scopes to `HERDR_PANE_ID` (`--all`: every pane), reading nothing at rest beyond a 30 s rescan. Claude Code
runs it under Monitor; re-arm after expiry. Codex receives the same quiet events automatically through
`codex queue`: create/send starts a detached `hud watch --queue`, with catch-up and no event lines on stdout.
It exits when the pane is gone/no longer Codex, or after 10 minutes with no unsettled job, unread attention/report
or unanswered question. The pi HUD package delivers actionable notices natively, waking an idle main session
or delivering before the next model request after the current tool batch, without touching the editor draft.
No Monitor or panel is needed; pi workers do not start this watch. A pane-scoped watch records `$HUD_HOME/watchers/<pane>.pid`
while active. `hud_roster` and `hud_create` report `watcher_alive` when the caller has a pane; a live watch
suppresses direct pushes and the `hud_create` Monitor hint.
Without a live watch, CLI and pi worker questions go directly to the Codex thread queue; other main sessions
receive typed questions and can use `hud_wait` for settlement. Queue delivery uses the pane's Codex
process `CODEX_HOME` (default `~/.codex`), not the MCP account. A missing thread id or any queue failure falls
back to typing that line, which can touch a draft or fire prompt hooks. Stale PIDs never suppress delivery.
MCP `changes` stays the fuller, query-only stream; a `report` token always means unread. With live events, keep
working until notified instead of polling or waiting. A report-ready notice leaves the report unread; collect it explicitly.

`hud_create` takes `role`, `request_key`, `task`, optional `cwd` and display-only
`package`. By default it dispatches on the role's first available place (`runs_on`).
Pass `preset` to use the first available, non-exhausted place in a named role preset
without editing role files. Alternatively, pass `on` to override the harness/provider
(defaults from shipped `harnesses.json` overridden by `$HUD_HOME/harnesses.json`).
`preset` and `on` are mutually exclusive. A repeated key returns the original job
unchanged, not a second launch. Use these overrides only on user request. A detailed job read or peek shows the selected `preset`.
`model` and `thinking` override the selected `pi` or `cli` place for this job;
`kind` selects `image` (default) or `video` for `flow`. Optional `idle_grace_s` (integer 60–3600) overrides
CLI grace for this job; pi/browser overrides refuse (pi grace follows the model's cache lifetime in pi-roles).
Pi-only overrides:
boolean `lens`, `mcp`, `tps`, `ui_ext`, `skills`, `split`, plus `pi_args` (≤128
strings, ≤4096 chars each, verbatim, no shell). Omitted switches keep pi-role
defaults; split defaults to the place. `ui_ext: false` disables UI extensions;
`skills: true` includes personal skills. A true split reserves a right helper pane.
`--orchestrator`/`--notify` pi-argument overrides refuse. Browser (`bro`) places
reject pi options.

Pass context as `context_files` (up to 32 paths resolved against `cwd`) and `from_jobs` (up to 16 job IDs,
each referring to its `report.md` in `$HUD_HOME/jobs`). Use readable UTF-8 text files that resolve inside `cwd`
or `$HUD_HOME/jobs`, respectively; invalid references return `invalid_arguments` before dispatch. Pi and CLI
workers read the paths listed after the task in their briefs. Browser (`bro`) briefs send the labeled file contents
to the browser service (64 KiB per file, 256 KiB total; larger context returns `context_too_large`). Attaching
an upstream report does not mark it read or close its worker.

`isolation: "worktree"` runs the job in its own linked Git checkout beside the repository (`<repo>-wt/<slug>-<id6>`,
branch `wt/<slug>-<id6>` from HEAD, `node_modules` linked, the CLI's trust of the main checkout copied). It is
refused for browser roles and outside Git. `hud_read` of that job adds the `worktree` receipt (including the checkout path) and `git_summary`. After the job closes, the
watcher removes the checkout and branch only when nothing in it changed or its commits are already merged into the
main checkout, never with force; otherwise it keeps them and records `worktree_kept_reason`. Project lists these
checkouts as the jobs' own, not as unlisted worktrees.

A role JSON file sets `role`, `instructions`, `can_continue`, optional `idle_grace_s`
(default 600), and ordered `run` places across `pi`, `cli` (`grok`, `agy`, `claude`
or `codex`), and `bro` (`jev-ask`, `jev-aistudio`, `jev-flow`); legacy single-place
files load as `run[0]` and `"harness": "jev"` loads as `"bro"`. Shipped roles:
`imp` (`pi` implementer -> `pi` Grok 4.7), `reviewer` (`pi` reviewer -> `agy` Hydrogen high), `sonic`, `oracle` (`cli` `claude` `fable` high -> `pi` `architect`; `hud_create` also takes `architect` for it unless a role file defines one),
`pro` (`chatgpt`, `gemini`, `argon`), and `flow` (`jev-flow`). A `cli` place requires `instructions/<instructions>.md`
(shipped: `implementer.md`, `reviewer.md`, `oracle.md`), otherwise `hud_create` returns
`unsupported_harness`. Quota or rate-limit failures mark the place exhausted in
`$HUD_HOME/exhausted.json` for 1 hour so the next dispatch falls back; HUD never
auto-retries. Register custom roles as `$HUD_HOME/roles/<name>.json`, for example
a design role with `"agent": "claude"` and a Claude model alias. List models with
`grok models`, `agy models`, `claude --help` or `codex -m`. The HUD passes only
the model flag, the effort flag, that CLI's permission-bypass flag and `args`.
It never passes a home, session or config flag, never sets those environments,
and never trusts a directory while dispatching: a trust dialog is declined and the
launch fails, naming `hud trust <cwd>`. Sessions stay in each CLI's own store.
herdr starts the CLI through the interactive shell, so that shell's functions apply.

`hud trust <dir>` adds that directory to the trust files of grok, agy and claude
after a backup under `$HUD_HOME`. A missing CLI file is not created. Codex is skipped.

`hud_read({})` (or `view: "compact"`) lists running jobs and jobs that still need attention, newest first. It shows
`job`, `role`, `state` and, when applicable, `report_unread: true`, `blocked: true`, pending `question_ids` and a
block, wait or failure `reason`. A closed job with an unread report still appears. Use `view: "recent"` for the
newest 20 full rows, including handled history. Neither list marks anything read; `changes` still includes events
for jobs hidden from the snapshot. `view` cannot be combined with `job`.

`hud_wait({ jobs?, mode?, wait_ms? })` watches several jobs at once. Omit `jobs` to take the caller session's
unsettled jobs at the start of the call. `mode: "any"` (default) returns when one settles or needs attention;
`"all"` waits for every target to settle, but a question, block, orchestrator wait or failure returns early.
`wait_ms` is an integer from 0 to 120000 (default 60000; `0` checks once). The response includes `ready`, `timed_out`,
`triggered` job IDs and compact `jobs` rows. No targets returns ready with empty lists. Waiting does not read
report or question bodies, mark anything seen or close workers; use `hud_read` with a job ID for the full result.

`hud_peek({ job })` returns compact `status` and progress without fetching the pane. Request `lines` (1–120) to
fetch the pane tail as `pane_lines`; if unavailable, that field is `null` with a `pane_reason`. `detail: true` adds
launch `diagnostics`. Peeking does not read the report, mark the job seen or close the worker. Pi and CLI workers
can use the optional `hud-progress.mjs` command in their briefs to log milestones (one line, up to 240 characters;
newest 50 stored). Peek and single-job read show the newest 10 as `progress` and the last as `latest_progress`;
ordinary reads omit empty progress, and list/wait rows omit all progress. Milestones do not emit watch events.

With a `job`, `hud_read` reads STATUS, open questions and an unread report (up to 64 KiB). A report is unread when
newer than `read_at`, or when no `read_at` exists. Already-read reports return `report_unchanged: true` without a
body; `full: true` includes it again. `detail: true` includes launch diagnostics such as effective CLI `idle_grace_s`;
use peek instead when you do not want to collect. `wait_ms` waits at most 120000 ms, stopping at settlement, a
question or timeout. Every returned report body stamps `read_at` (including during work and idle grace), not
acceptance. A settled pi or CLI worker closes when its current turn's report is read (`closed after report read`);
reading an earlier turn's report after a continuation does not close the worker. An unread report keeps the usual
idle deadline. Reading a failure/block separately marks that attention as seen.
Workers write the report file, run the `hud-progress --done` command named in their brief or prompt,
then finish with just `report written: <path>`, not a second copy in chat.
`hud_send` queues a message for a working pi or CLI job, or continues an eligible role during idle grace while
its report is still unread. Use a new job for a repair after reading a settled report; `message_key` deduplicates sends. CLI
workers ask through the same `QUESTION` line and `hud_respond` flow (`hud-ask`,
20 minutes, then the default). A blocked CLI marks the job as needing the owner;
the session learns it through `changes`, Claude's `hud watch`, Codex's automatic queue or pi's native HUD notices. `hud_respond` writes a
`qN.answer.md` once. `hud_close` reaps early; normal cleanup belongs to the watcher. The owner can also answer
an open question from the panel (`1`–`4` or `d` on its expanded question); the session hears it as one `changes` / `hud watch` line,
`[role@job] ANSWERED qN from panel: <answer>`, read from `$HUD_HOME/panel-actions.jsonl` (answers made while the
reader runs; a question answered earlier is simply gone).
The main session chooses all next steps; the MCP knows no workflow.
See [the MCP README](../packages/hud-mcp/README.md) for the tool arguments.

Jobs are plain files in `$HUD_HOME/jobs/<job>/`. Pi history stays in
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/<cwd-dir>/`; job `sessions/` links to
primary/helper files. A CLI job's supervisor only observes; only facts end a job: the
worker's recorded pid gone (or replaced), its tab closed, or a dispatch rejected before input (`failed`, or
`closed` when a new report is on disk). Each dispatch and `hud_send` starts a turn (`turn.json`). With `advisory`
trust, on a turn that never issued a receipt, a new report settles the turn when herdr is not `working` and the report
has been stable for 10 s, provided there is no live in-turn child. Such children also defer quiet decisions and
automatic close. `hud-progress --done` binds the CLI report's signature to the turn in the worker's prompt.
A continuation invalidates the old receipt; rewriting a declared report requires a fresh receipt for that turn.
If the turn stays quiet for the role's grace period without a fresh matching receipt, it goes to
`waiting_orchestrator` without settling or calling the Decision API. The main session can use `hud_send`
to continue or `hud_close` to stop. Changes in terminal output do not affect the receipt. With a matching
receipt (or pi's native settled turn with a changed report), leftover children do not block closure. For a
continuable worker, idle grace ends when the report is read or the deadline passes; a deadline close says `settled`.
The watcher reaps the worker and descendants with captured ancestry, records that unverified processes were left
alone, and retries unresolved cleanup on the slow tick.
Herdr's status alone never fails a live worker. A turn quiet past the idle grace without a report gets one Decision API choice
among fixed actions (keep waiting, one fixed prompt to write the report, `failed` only with a quota line on screen,
or hand to the main session); below 0.8 confidence or on any error it goes to the main session. Anything unclear is
`waiting_orchestrator` with a reason. CLI `state_trust` has two levels: `advisory` keeps those timings, while `turn`,
after herdr has been seen `working` in the current turn and is now `done` or `idle`, settles a stable new report in
2 s or reaches the no-report quiet decision after 10 s (the post-decision wait is unchanged).
Defaults are `turn` for `claude`, `codex` and `grok`, and `advisory` for `agy`; set, for example,
`{"grok":{"state_trust":"advisory"}}` in `$HUD_HOME/harnesses.json` to override one agent without replacing its other defaults.
`hud_roster({detail:true})` shows the effective level, dispatch freezes it in `job.json`, and old jobs without it use `advisory`.
The supervisor wakes on herdr pushes, file changes and its own deadlines,
plus a 30 s tick that re-reads the status once; it writes STATUS only when the row changes. The on-demand watcher starts on
create, reaps finished jobs through `pi-role-reap`, keeps failed tabs for two hours,
and exits with no open job or pending failed-job deadline. While a CLI job is open
it also checks the supervisor; `HUD_WATCH_CLI_CHECK_MS` (default 30000) is that
interval. A dead supervisor with a live worker leaves the job `waiting_orchestrator` ("supervisor exited;
worker still running"); `hud_send` to it starts a new supervisor. Settled directories, including reports and
`hud_read` access, expire **one day after closure** on a later watcher scan or next
create, not a dedicated expiry timer. Before deleting a legacy pi job it moves real
JSONL sessions to pi's store; CLI and browser sessions stay in their own stores.
Invalid cwd, destination conflicts or failed moves retain the job. Removing session
links never removes their targets.

## Project workers

```sh
hud setup --detect [--cwd DIR]
hud setup --apply PLAN.json [--cwd DIR]
hud setup --remove [--cwd DIR]
```

Non-interactive. The `hud-setup` skill, installed beside `hud-delegate` for Claude,
Codex and pi, asks; these commands only read or write.

`--detect` prints one JSON document and writes nothing. It names the git root of
`--cwd` (or `--cwd` itself), whether that root is registered, reference roles
(shipped and `$HUD_HOME/roles`), project roles, the enabled set, invalid role files,
skills and worker-skill links. Skill roots come from `$HUD_HOME/setup.json`
`skill_roots` (defaulting to `~/.pi/agent/skills`, `~/.claude/skills` and
`~/.agents/skills`), always followed by the checkout's `integrations/skills`. A skill is a directory with `SKILL.md`; its name is the
frontmatter `name`. Each skill includes `model_invocable`: false when that
frontmatter has `disable-model-invocation: true`. Pi still loads such a skill, but
leaves it out of the model's skill list, so a worker will not pick it by itself.

`--apply` reads a plan and writes under the project's `.hud/`, which is meant to
be committed:

```
.hud/project.json          enabled roles, and the links, role files and prompts apply made
.hud/roles/<name>.json     only a pi role that differs from its reference
.hud/skills/<name>         symlink to the skill directory (workers only)
.hud/agents/<role>.md      optional worker-only prompt
.hud/hud-convention.md     optional copy of the shipped convention
```

The plan is version 1: `roles` (enabled names), `pi_roles` (pi tuning only: `from`,
`pi_role`, `model`, `thinking`, `split`, `can_continue`, `skills`), `skills` (name
to an absolute skill directory), `agents` (role to markdown) and `convention`
(`keep` or `copy-default`). It prints `removed`, `wrote`, `linked`,
`skipped (exists)`, `registered`, or `no changes`. The same plan again changes
nothing. A file or link apply did not make is left in place and reported as skipped.

Applying records the root in `$HUD_HOME/projects.json`. Project config loads only
after that. `--remove` drops the registration and leaves `.hud/` alone. A clone's
`.hud/` does nothing until the owner runs setup there.

Tuning is pi only. Other harnesses' roles can be shown or hidden; their files are
not edited. This command does not run `hud trust`. If a chosen CLI role's directory
is untrusted, run `hud trust <dir>` yourself.

## Home

Home shows needs-you questions, package lanes with compact job cards, native
session lanes, then **Decided for you**. It observes files and never briefs or chains work; its only
actions on a job are the owner's three micro-actions (see [Keys](#keys)).
Running jobs with unanswered questions need you; an unanswered question left on a
finished job does not. A report is not proof of success, and display labels are not
acceptance or a merge decision. Unknown evidence stays unknown.

Cards have a title and two fixed sentence rows; `┃ …` holds space until text is
available. Enter expands the complete sentence and factual details in place.
Brief headings supply job titles; otherwise a model name or first task line fits
the width. Only the newest current settled card initially expands, until its fold
time; explicit choices win for that panel lifetime. Enter on a lane folds it.

**Sonic children.** A `sonic` job a HUD job dispatched (its `parent_job`) is not a card: it is one row under the parent's
card, `├─ ⚡ sonic · short title  3m ◉` (the last `└─`, ascii `|-` and `` `- ``), with its elapsed time and state glyph, in
Classic and in Split's preview. A parent folded to its title row hides the rows and says `⚡ N sonic` (the ones still
running) on its right. A `/` filter that matches a sonic job keeps its parent with it.

**Panel lifetime.** Jobs settled before the panel opened are excluded, including
their decisions and model inputs; `a` cannot reveal them. Active/unknown jobs stay
eligible regardless of age. Build reload preserves the original opening time.
Native agents and Project's STATE slice lookup keep their own scope.

**Card lifetimes.** Settled HUD/native cards fold to one row after 5 minutes and
hide after 15 by default; failed/stopped cards stay at least 30. Settings → Panel
changes both. A hide time below fold time counts as fold time. Running/asking cards
stay. `a` reveals hidden cards/decisions in place as muted one-row titles; Enter
expands them. The job scan considers the newest 200 directories.

**Decisions.** Answered QA pairs show question/answer, alternative and why; `≠`
requires a recorded departure from an explicit default, not ambiguous free text.
Only an explicit `One-way: true` pins a departure. Ordinary decisions hide after
30 minutes, departures after two hours. A review verdict requires its recorded
accept/changes-required line and settled output, not merely helper exit.

**Native agents on Home.** Claude/Codex main sessions get their own lanes. Children
indent once; deeper descendants say `↳ parent`. A hidden parent never hides a live
child. pi helpers already appear as HUD jobs. Claude reads metadata and bounded
forward transcript batches, retaining public Agent/Task nesting. Replay preserves
known completion ages and blocks model requests until caught up. Growth after
completion reopens an agent; fresh finished metadata or a caught-up public
`end_turn` with no open calls settles it again. Incomplete reads cannot prove idle.
`o` opens the transcript; there is no native conversation-switch control.

**Recommended mode.** Default keeps factual order. Recommended sends up to 200
cards' bounded display facts to the selected Decision API for 0–4 ranking, at most
once per two minutes per changed board. Questions, failures and human-needed cards
are protected; native subtrees remain together. Low-ranked settled cards join the
older fold, visible with `a`. A separate chat call writes a short progress brief
at Summary interval. No key/error means default order; a pending/failed brief keeps
the last good text and valid ranking. Models off hides both.

**Top line.** `? 5 waiting for you · 0 running` counts STATE's "Waiting for the owner" items
with the job questions (the same items as the Project tab's count); `✓ Nothing needs you`
shows only when both are zero. With waiting items, Enter or a click opens the Project hub on its
Waiting block. The footer's `✓ n done today` is absent at 0.

**Spare rows.** Cards/decisions get space first. Remaining rows show, top to bottom: STATE's
waiting items (a row each, up to five, then `+N more`), the newest landed slices (three at 38–55
columns, five wider; Home reads no commit dates, so later ledger rows come first), then at the
bottom the progress block: STATE's Now summary (up to three wrapped rows), a six-state progress
bar/legend and up to six open tickets per feature. The block counts the current milestone's
slices exactly as the Project hub does; with no current milestone it counts the whole ledger and
is titled `All slices`. The block takes its rows before the two lists, which take what is left.
As height falls the latest list shrinks first, then waiting, tickets, the summary's extra
rows, legend, summary, bar and the block. Enter or a click on a waiting item opens its page (Esc
returns to its row on the hub), on the Waiting header the hub's Waiting block, on the latest or progress block the Project Progress page; on a ticket row, the Tickets page.

## Project

Project is a hub with one page per section, laid out as a timeline: what waits for you,
what is happening, what landed, then where each page stands. Top to bottom the hub has:

- the project's name row (the panel's directory name; see Switching projects below) with the
  current milestone;
- **Waiting for you**: STATE's waiting items, folding with Enter (an item ending `(waits on ID, feature/NN)` drops out by itself once those slices are accepted or dropped and those tickets done); the header says how many there are
  and how many slices are still to try (`4 · 5 to try`: the ledger's slices in state `try`, whatever the milestone; the Progress row and the Projects list say the same number). An item whose text does not
  fit one row flows on under its first word, whole, into the hub's spare rows, top down (what the owner tries is
  never cut to a name); a panel too short for that cuts it to one row, before Latest or the page rows give way,
  except the item the cursor is on, which keeps its whole text. Enter or a
  click on an item opens its whole text on a page (`‹ Project › Waiting`): the bullet as STATE
  writes it, continuation lines included, in its own words and order (a line that continues a
  sentence flows on; a numbered or `-` line starts a paragraph of its own). The page scrolls with the
  movement keys and the wheel; Esc or a click on the crumb returns with the cursor on the same item;
  `o` opens STATE.md. No model call;
- **Now**: a row per working or blocked slice (`◐ ID  text`, then the job's role and minutes,
  `asking ?`, `blocked`, or what is out of step), then the project's unsettled HUD jobs that no
  slice shows (`◉ role  title  age`). A slice's text goes on its row only when it fits whole.
  Worktrees with no ledger row are not work in flight: they are counted on the Working tree row.
  With nothing in flight it says `Nothing in progress`;
- **Latest**: the newest landed slices (to try, accepted), newest first by the commit date the
  ledger read already has (`◇ ID  text  to try 10h`; with the model on, a to-try slice's text is its brief's first sentence, cut with `…` to the room); three rows at 40 columns, five wider;
- one row per page with a one-line summary: **Progress** (milestone, to try, blocked, working: the last facts drop first on a short row; the
  current milestone's bar under it), **Tickets** (done/total, working, blocked; absent when the
  project has no tickets), **Working tree** (worktrees with no ledger row, branch, changed, worktrees,
  ahead/behind, editing jobs; its page lists the unlisted ones), and **Docs** (spec milestone, newest review). A row too short for its facts drops the last ones, never part
  of one.

A panel shorter than the hub loses **Latest** first (to its newest rows, then whole), then the
bar and the blank rows between blocks; Waiting for you, Now and the page rows stay (the page
scrolls with the cursor when even those do not fit). Enter or one click opens a page; its crumb row
`‹ Project › Page` replaces the tabs, and Esc or a click on the crumb returns to the
hub with the cursor on that page's row. Each page keeps its own cursor and
scroll, also across the panel's self-reload.

Facts come from `docs/handoff/STATE.md` (root `STATE.md` fallback), `docs/spec.md`,
reviews, roles/convention/instructions and Git/worktrees. No milestone or completion
is guessed. Key rows contain names/presence only; Browser ✓ means Chrome and
`jev-ask` exist on PATH, not a running/logged-in browser.

**Progress page.** STATE's Now summary (two rows at most), then the current milestone (`Milestone:`,
or the whole ledger when none is current): its name, a bar and `accepted/total`, the states
that have slices (`1 working  1 blocked  2 to try  3 todo`, none with a zero), and one row for
what the earlier milestones accepted (`✓ 24 accepted in 5 earlier milestones`). Then three sections:

- **Now**: ledger slices in `working`/`blocked` (drift marks mean a missing worktree or a
  non-active ledger state, never a write back to STATE; worktrees with no ledger row are on
  the Working tree page), each with its
  job's line from Home's card text, then the project's HUD jobs that have not settled
  and no slice shows (role, title, age). A job's title is the workboard's description, else its
  `job.json` title, else the first heading (or line) of its `brief.md`, from the collector's
  signature-cached, size-bounded read (full collection only). Each such row is a stop of its own: Enter or `o`
  opens its report, else its brief, and a long list pages by keyboard.
- **Next**: STATE's `## Next`, the first two bullets of at most two rows each (Enter on a cut one,
  `…`, shows all of it, again folds it; a bullet that fits opens STATE.md) and a `2 more` row that
  shows the rest (`fewer` folds them again).
- **History**: the last seven days in full, newest first, as a dated feed: a row per landed
  slice (`◇`/`✓`, its id, its text and its age, `to try 1d` or `3d`), where Enter shows its
  milestone, commit and day. Older work is one row per milestone (`▸ M4  ✓ 7 accepted  ◇ 1 to try  15–24d`,
  with the span of days) that Enter opens into its slices; a slice with no commit date is never
  guessed and sits under its milestone. The date is the ledger row's last hash (7-40 hex) read
  through the safe Git policy, in the one batched `git log` the collector already runs.

**To try only.** Enter or a click on the to-try count (`2 to try`, a stop of its own), or `t`, filters the
page to what is still to try: the header `Only to try ── n` replaces everything below the crumb, then
the ledger's slices in state `try` (never matched by their words, whatever the milestone) grouped by
milestone, newest first: the newest is open (`◇ DATA-ONE  text  1d`), each older one
a folded row (`▸ M3b  ◇ 1 to try  19d`) that Enter opens. With the model on and a brief stored, a slice is one row: its id and its brief's first sentence (cut with `…`). Without a brief (model off, pending or failed) it shows its whole ledger text, wrapped under its id (a break falls at a space or after a `/`, `-`, `_` or `.`, never inside a word); a briefed row whose id leaves little room for its sentence (a long id) puts the sentence on its own line under the id; a panel
too short for all of them keeps two rows for those slices the cursor is not on. Enter on a slice shows its milestone, commit and
day and, with a brief, the whole **brief** (what changed in plain words, at most two sentences) and numbered **acceptance steps**
(how to try it, at most four); the original ledger text, written for agents, is folded under them (`▸ Ledger line`, Enter unfolds it). `t`, Enter or a click on the header, or Esc
returns to the full feed with the cursor and scroll where they were; leaving the page or switching project clears the
filter. No extra read: the ledger is the one already parsed.

Rows wrap onto a second row rather than cut their only line at 40 columns. Enter or `o`
on a row opens STATE.md; on a fold, Enter folds and `o` folds only where the row has no file.

Tickets use `.scratch/<feature>/issues/<NN>-<slug>.md`, at most 16 features ×64 files,
64 KiB each. Required: matching `# NN: title`, `**Blocked by:**`, `**Status:**`.
`hud tickets sync [--cwd DIR]` mirrors GitHub Issues one way into `.scratch/` via `gh`
(open parent issues with sub-issues, plus already-mirrored parents so closed features
receive their final state), writing `.gitignore` (`*`), `spec.md` and numbered ticket files
with a generated marker; it refuses if `.scratch/` holds non-generated ticket files.
Done means done/closed/complete status or all checkboxes checked (at least one).
Otherwise unfinished/unresolved dependencies block; no blockers means ready.
Numbers/titles resolve within that feature; unknown status text stays dim.
A job with the matching package and ticket number/filename adds role/state/age,
never completion. The newest-64-directory job lookup is shared with slice blocks.
**Tickets page**: a done/total meter for every ticket and a short code for each feature (`hp hub-pages 4/7`),
then the tickets in lanes by state across features, one row each (`◐ hp 06 Projects list  imp 12m  1/3`:
state mark, the feature's code, number and title; on the right what matters for the lane, then
checked/total). **For you** comes first: tickets waiting on a person (`needs-triage`, `needs-info`,
`ready-for-human`) with their latest comment under the row, whatever else holds them. **Working** holds
tickets that are claimed or have a live job; **Ready** the rest that can start; **Blocked** names its
blockers (`← 03 ●`, the mark that of the blocker); **Done** starts folded (Enter opens it).
Enter on a ticket shows its checklist (✓ / ○) and latest comment (the last bullet under
`## Comments`) under it, a second Enter folds it; `o` opens the ticket file.

**Control tab.** Control is a main tab after Project. It names and follows the project selected in Project; `[`/`]` change that same selection without changing Home's root. Control reads that root's role and file facts without collecting its Git status, worktrees or tickets. The Roles view starts with:

- **Needs attention**: roles with exhausted places that are enabled, or with no available place, plus invalid role files. A role reads `imp [daily] → agy`; when a reason needs attention, it is explained underneath. An invalid file opens with Enter or `o`.
- **Healthy**: folded to role names. Enter shows one row per role, with its active preset or `Custom`, the next target, and a `project` tag on project-owned roles.
- **Usage** and **Files**: both folded. Usage opens quota windows, pi spend and dispatch health. Files opens the convention, instructions, pi definitions, ignored configuration, native agents, and local presence checks for keys, browser and harnesses.

Split previews the selected role's next model, thinking, source and numbered chain; Enter focuses its places and Esc returns to the list. Classic expands the numbered chain and its source under the role with Enter. `o` on a role or place opens its source. Chain marks: `◉` next, `○` standby, `⊘` switched off, `✗` exhausted and `−` not installed. `x` clears a real quota mark, even on a switched-off place; it does not turn that place on.

**Harnesses** (`h`, or click the Roles / Harnesses headings) lists the pi runner, compiled CLI agents,
browser tools and pi providers for **this machine, all projects**. Space or Enter toggles the selected
switch; Del removes an enabled entry by turning it off, not uninstalling it. Enter on **Off** expands
or folds the disabled entries. `i` opens **Add back**: type part of a switch ID, use ↑↓ to select,
Enter to restore or Esc to cancel. These controls work in Classic and Split. Presence is separate
from the switch: installed means the executable was found, and a provider being listed is not proof
of login or quota. A provider under an off runner keeps its switch and shows `pi off`. `jev-ask`
switches both ChatGPT and Gemini; `jev-aistudio` switches Argon. `r` refreshes the local model lists.

An explicit switch action writes only the `disabled` property in `$HUD_HOME/harnesses.json`
(atomically, mode 0600), retaining other keys and leaving every role file byte-for-byte unchanged.
IDs are `pi`, `pi:<provider>`, `cli:<agent>` and `bro:<tool>`; absent means on, including newly
discovered or unlisted targets. `cli:grok` and `pi:xai` are independent. Invalid or unreadable
switch data is a configuration error, not an all-on default.

Roles, `hud_roster` and `hud_create` use the same next-place evaluation: off, live quota and missing
executables are skipped in order. With `pi:xai` off, `imp [daily]` can go to `agy` without changing
the preset or deleting the pi place. Restoring xai lets it return to its original position, but not
until any real quota mark is cleared or expires. A pi provider comes from a qualified explicit or
pi-role model, a unique exact bare model match in the unfiltered cache, or pi settings when no model
is set. Unknown providers are shown and do not block dispatch. `pi_args` are not read for attribution.
The same policy applies to a requested `preset` and to resolved `on` and `model` overrides; an explicit
off target is refused, not silently rerouted. If no place can run, `hud_create` returns
`no_available_place` before creating a job.

Role files may carry `presets`: `[{ "name": "short-token", "run": [...] }]`, whole ordered place lists validated like `run`. Names are unique per file, 1–32 characters from `[A-Za-z0-9._-]`. Presets merge by name from shipped → owner → project file in force; more specific wins, omission inherits. `hud_roster` returns `presets` and `preset` (matching name or null). Pass a name from `presets` to `hud_create` to use it for one job only.

On a role or place row, `c`/`C` applies the next/previous preset in one step (from `Custom`, first/last), writing its run to the owner's file and keeping other fields, including presets. Exhausted marks remain per place. Project-pinned roles refuse as for other edits; `o` opens the file. Shipped imp presets: `default`, `grok` (high), `hydrogen`; reviewer: `default`, `pi`; oracle: `fable`, `architect` (the former architect role's pi setup). No separate architect HUD role remains.

On a place row (Control only): `p`/`P` next/previous harness (`pi`, then each CLI agent for a
role that has CLI instructions; a browser role walks chatgpt, gemini, aistudio) with that harness's
default model from `harnesses.json`; `e`/`E` thinking (a Flow place: image/video with `m`). Each cycle
passes through "unset" (the role's or harness's own default) before it wraps. `i` adds a fallback at
the end (the first harness not yet listed, else another model of the same one); `Del` removes the
place (one always stays); `K`/`J` move it earlier/later; `x` clears its exhausted mark; `r` refreshes
model lists from `pi`, `agy` and `grok`.

`m` (or `M`) picks the model in a picker that replaces the page: on `pi` the **provider** first, then
that provider's models; on another harness its models at once (a harness with a single model or none
cycles it as before). One line a row at 40 columns: the section row names the role, place and
provider (`imp · pi › openai ─ model`), under it the current model, a filter line (`/ text▌ 2/4`) and
the entries around the picked one (`◉` marks the current one; at the providers each shows its count).
Typing filters the entries live (substring, any case); ↑↓/PgUp/PgDn pick; Enter on a provider opens
it and on a model sets it; the first model row, `default`, unsets the model; text no model matches is
set as typed (`⏎ openai/new-model`: on `pi` within the provider, or a whole `provider/model` typed at
the providers); Tab shows every provider and model instead of the curated ones; ← or Backspace on an
empty filter goes back to the providers; Esc, Ctrl+C or a click leaves the picker, writing nothing.
Every key is the picker's while it is open (`q` types a `q`).

The curated list is what the owner uses, not all of `pi`'s ~170 models: per provider, only the models
its patterns name, and of those only the newest of each family (a family is the id with its version
numbers and date stamps removed: `claude-opus-4-5`, `4-6`, `5`, `5-5` are one, newest `5-5`; a dated
snapshot loses to the undated id of its version). A role's current model is always offered, even
when curation would hide it. The patterns are `catalog.pi.include`, shipped in `catalog.json`
(`arena` `*`, `mistral` `deepseek*`, `anthropic` `*opus*`, `openai` `gpt-6*`) and overridable per
provider in `$HUD_HOME/harnesses.json`: `{"catalog":{"pi":{"include":{"arena":["*"],"openai":["gpt-6*"]}}}}`
(`*` and `?` globs on the name after `provider/`, any case).

For `pi`, `agy` and `grok`,
models come first from each harness's own list command (`pi --list-models`, `agy models`,
`grok models`), run only when Control opens or on `r` (never on Home or on the refresh tick)
and cached under `$HUD_HOME/display` for a day (failed or missing commands fall back silently);
next come shipped `catalog.json` and `$HUD_HOME/harnesses.json`'s `catalog` key (which `claude`
and `codex` always use), then any models set in `$HUD_HOME/roles/*.json`; the picker curates that
merged list and never changes it. A change writes `$HUD_HOME/roles/<role>.json` (atomic, 0600, seeded from
the shipped role, other fields and place keys kept) or `$HUD_HOME/exhausted.json`; the next `hud_roster`
and `hud_create` read them, so the page shows what the next job uses. A role from the project's file
cannot be changed here, and `p`/`P` refuses to replace a place whose file sets launch options
(`split`, `skills`, `args`...), since it would rebuild them: both say so in a line at the top
until the next key, and `o` opens the file.

**Switching projects.** With more than one project the hub's name row reads `name ▾ project i/n`
and `[` and `]` step through the panel's own project and the existing roots in
`$HUD_HOME/projects.json` (deduplicated, at most 16). Enter or a click on the name row
opens the **Projects list** (`‹ Projects` replaces the tabs; Esc or a click on the crumb
returns to the hub).
On a page `[`/`]` work too and its crumb shows the project's name; its cursor, scroll and
folds start fresh. The choice belongs to the panel and survives its reload, not
Settings. Home always stays on the panel's own project, and opening Home's progress block
returns to it. The panel keeps one collector per visited project (at most four, the
panel's own never dropped, the oldest other one first) and collects only the shown one.
With one project there is no `▾ project i/n` and no list.

**Projects list.** Two rows per project: its name, current milestone, `?` the count of
STATE's waiting items and `◉` the count of unsettled HUD jobs under its root; then what it is
doing now (`◐ A-ONE, A-TWO working`: the slices working, else blocked, else the newest landed
one `◇ B-TWO to try`, else the newest accepted `✓ D-ONE accepted`, in ledger order) and the time
since it was last touched (STATE.md or a ticket file, whichever is newer; a ledger commit date
would need Git). At 80+ columns the project's stacked bar leads the row. A project without
STATE.md shows `no STATE.md` and its open tickets. Order:
the panel's own project, then projects with waiting items, then with running jobs, then
the rest, each group newest first. Enter or one click opens that project's hub (Esc or clicking the top crumb on
that hub goes back to the list; on a hub not reached from the list Esc goes to
the panel's main tab or exits the standalone panel). The cursor marks both rows of an
entry. The list is read only while it is visible: for each listed project STATE and
tickets as Home reads them (cached by file signature) and, in one pass over the newest
64 job directories, the unsettled jobs per root, at most once every five seconds while
the list stays open (opening it again reads at once). No Git, no roles, no full collection;
the shown project's own full collection pauses while the list is open. The last-touched
time reads `12m`, `3h`, `4d` (`12分钟`, `3小时`, `4天` in Chinese).
A project without STATE.md says `no STATE.md` on Progress; its other pages work.

On a page Enter folds a header, shows a ticket's detail or opens a row's file, and `o`
opens it in `$EDITOR` (default vim), in a herdr tab that closes with the editor; failed workspace lookup falls back to a
split. Home, Project and Control retain separate cursor/scroll state. Full Project collection
runs while the hub or a page is visible, not behind modals; Home reuses only cached
STATE/ticket reads.
Git is gated to at most once per five seconds. Reads do not start a browser or MCP.

## Review board

`hud board [--html] [--cwd DIR] [--out FILE] [--open]` writes the project's review board: one static HTML file for a
browser, with no script, font, image, link or network request (its Content-Security-Policy allows inline style only) and
every project string escaped. Sections: the header (project, branch with changed/ahead/behind, milestone, time written, and a
stacked bar of working / blocked / to try / accepted / todo); **Needs you** (STATE's waiting items and open job questions
with their options and default, when there are any); **To try** (one card per slice: milestone, age, commit, the stored model
brief with numbered steps, else the ledger line, the `.scratch/` tickets its line names, and per-file `--numstat` bars);
**In flight** (working and blocked slices, running jobs with role, model, elapsed time and current sentence); **Tickets**
(per-feature meters, unfinished tickets with their checklists); and the **latest milestone review**. Sections with nothing
in them are left out. The page follows the system light/dark setting, or the Auto / Dark / Light switch at its top (pure
CSS), and reads from phone width up.

It collects once, as Project does: no HTTP server and no model call. To-try briefs appear only when the panel has already
stored them (the same cache and Model text switch as the panel); the caller pane's jobs appear only inside herdr
(`HERDR_PANE_ID`). The file is `$HUD_HOME/display/board-<project>.html` unless `--out` names one, written 0600 to a temp
name and renamed, so a link at the target is replaced, never followed. The command prints the path. `--open` then runs
`wslview`, else `xdg-open`, detached; with neither on `PATH` it only says so on stderr (exit 0).

In the panel `w` (Home or Project, not in a picker or Settings) does the same for the project shown, opens it the same way and
shows `Board saved: <file>` at the top until the next key.

## Panel layouts

Settings → Panel → **Layout** (`panelLayout` in `hud-settings.json`: `classic`, `split`) chooses how Home, Project and
Control are laid out; saving switches the open panel at once, no restart. **Classic** is the default described above.
**Split** puts a list over a preview of the selected row (see [Split layout](#split-layout)).

Settings → Panel → **Project layout** (`projectLayout` in `hud-settings.json`: `timeline`, `board`, `inbox`) arranges
the Project tab's pages in both Classic and Split without changing Home, Control, Tickets, counts or keys; saving applies live.
**Timeline** is the default. **Board** draws a milestone map (one row per milestone, one cell per slice with `n/m`, age
and `+N` when full), a `latest` line, a one-row legend, In flight and gauge page rows on the hub; opens the current
milestone into its slices in cell order on Progress (older milestones as map rows, jobs outside the ledger, Next); and draws the Projects list as a one-row-per-project table (`ms`, `ledger`, `?`,
`◉`, `age`). **Inbox** opens the hub with a ranked Needs you list (questions and STATE's waiting items, to-try slices
newest first, tickets asking for an answer, blocked slices, roles at their limit, each with its reason word on the
right and the same `N · M to try` header figures as Timeline), followed by Running, a `last accepted` line and the page
rows; orders Progress as To try (every milestone, newest first), Blocked, Working, Next and Done folded to one row;
groups the Projects list into Needs you, Running and Quiet (one row per quiet project); and keeps Timeline's Tickets.
Enter on an Inbox role alert opens that role on Control; `o` still opens its file.

In Classic's to-try view and on Split's to-try rows, Space toggles a mark (`▣`, or `*` with text icons).
`y` accepts and `n` flags the marked rows, or the current row if nothing is marked. All affected slices go into
one record in `$HUD_HOME/tries.jsonl` and produce one line in `hud watch` and MCP `changes`. Recording a result
or leaving the view clears the Space marks.

## The panel

### Frame and reload

Home, Project, and Control are the default main tabs. Settings → Panel → **Experiments** (`experiments` in `hud-settings.json`,
off by default) adds the experimental **EXP** tab. Use ↑/↓ to select and Enter to edit or open an account;
Enter saves, and Esc cancels. For calibration, Enter first previews the change, then Enter saves the new base.
The form is the same in Classic and Split. Settings apply to all projects on this machine, and are stored under
`$HUD_HOME/exp/`. Codex profile choices are local; EXP does not change CLI configuration.

In **pi subscription proxy**, choose a Codex profile and turn on Auto-refresh. When pi draws its HUD footer, a due refresh uses
that profile's existing login to read quota from Codex; it sends no prompt and does not run while pi is unused. The `openai`
OAuth footer shows approximate remaining quota (`5h ≈72%`); a reading from the current request takes precedence (`5h left 72%`).
Other routes such as `oapi` do not show it. Old readings are marked stale, and a window past its reset says `refresh pending`.
Open **Proxy readings** for both windows and their reset times, source, last success and error, and next eligible attempt.
If the proxy pauses for sign-in, sign in to the bound profile and turn Auto-refresh off and back on. Experiments off stops refreshes.

**API grants** shows the two ledgers together. The pi footer shows only the enabled ledger for the current API route
(`API ≈$12.75`, for example), not subscription quota. `openai-api` counts `oapi` requests; `anthropic-api` counts only
requests the installed pi HUD can identify as direct Anthropic API-key usage. Claude OAuth, third-party gateways,
and unknown routes are not charged. The Claude Code status line is unchanged. Turning Experiments off preserves
both ledgers and stops collection.

Inspector, Changes, Settings and Help share
one title band, exact-width rows and whole footer hints (rightmost hints drop when
narrow). Home, the hub and the Control plane footers show the keys of the selected row: a HUD
job's row adds `g job tab` and `X stop`, a to-try row `Space mark  y accept  n flag`, a role
`c C preset`, a place `i add  Del remove  K J move`; a key the row does not take is not listed.
One key means one thing on a page (`n` flags a to-try row and nothing else; `>` `<` move between
Home's cards that need you; `i` `Del` change places; `+` `=` `-` size Split's list), and the Help
page lists each key once. A row says its state once: a card's `[done]` mark is left out when its
state word says the same, and a Home lane's state word is on its row once. The fixed words
(`Usage`, `unparseable JSON`, `(no key)`) follow the panel language, and a quota figure says
whether it is what is `used` or what is `left`. There is no Agents pane, stacked/compact layout, Timeline, activity hub,
agent log, Summary or diagnostics page. Each page retains its scroll/selection.
Icons are `unicode` or `text`; old nerd/emoji values load as unicode.

After a new installed entry is stable for two seconds, a bounded child import
validates it before the panel restarts in the same pane. Selection, scroll, folds,
show-all, modal, Settings cursor, opening time and width override survive. A saved
Skills tab from an older build falls back to Home; a saved Project/Control page reopens on Control. Unsaved
Settings delay reload; a bad build leaves the old panel and a dim notice. Bars are
separate and need restarting for new code. Quiet, positively idle observations can
back off to five-second collection; input/redraw remain independent.

### Keys

Standalone panels consume their own keys and SGR mouse events directly.

| Key | Action |
|---|---|
| Tab/Shift-Tab, Left/Right, a click on the tab | Cycle Home → Project → Control → EXP (if enabled). Digits switch no tab: `f` opens Changes and `1`–`4` answer an open question. The tab's count is `?` and a number (`Project ?4`: what waits for you) |
| `f` | Changes summary (once `3`) |
| `[`, `]` | Project or Control: previous/next project (not on the Projects list) |
| `p` `e` (capitals back), `i` `Del` `K` `J`, `x`, `r` | Control plane: harness / thinking of the place under the cursor; add / remove / move up / move down a place; clear its exhausted mark; refresh harness model lists (`r`) |
| `c` / `C` | Control plane: apply the next / previous role preset |
| `h` | Control: switch Roles / Harnesses (or click the view heading) |
| Space / Enter, Del, `i` | Harnesses: toggle; remove (= off); Add back (type to filter, Enter restores, Esc cancels). Enter on Off folds or expands it |
| `m` (`M`) | Control plane: pick the model of the place under the cursor: provider, then model on `pi`; type to filter, ↑↓ pick, Enter sets (an open provider, or the model), Tab shows every model, ← back, Esc cancels |
| Up/Down (`j`/`k`), PgUp/PgDn, Home/End (`G` is End) | Move/page/first/last |
| `g` | On a HUD job's card (Home, either layout, or its Inspector): focus that job's herdr tab, the `TAB` in its `SESSION.txt`; a tab already closed says `tab closed`. Everywhere else it does nothing: the first row is the Home key |
| `1`–`4` / `d` | On a HUD job's open question (`qN.md` with options or a default) once its slab is expanded (Enter; always in the Inspector), where the options are numbered `[1]`…: `1`–`4` pick that option and `d` the worker's default, with no key before. Writes `qN.answer.md` once (as `hud_respond`; an existing answer stands, `Already answered`) and shows nothing else. A collapsed question takes no digit |
| `X` | On an unsettled HUD job: a one-row prompt `Stop <role> <id>?  y confirm · Esc cancel` above the page. `y` or Enter stops it as `hud_close` does (a CLI job in its idle grace is first asked to quit with `STATUS.json.close-requested`, then `pi-role-reap <dir>` runs and the panel reads again); any other key cancels |
| Enter | Expand/collapse card, question, decision or lane; in Project open a page, then fold, show a ticket or open a row's file |
| `o` | Open question + answer, else report, else brief; native transcript; in Project the row's file |
| `v` | Inspector |
| `a` | Show/hide older jobs and decisions |
| `>` / `<` | Home: next / previous card that needs you (asking, failed or stalled) |
| Space | Toggle a mark on the to-try row under the cursor; on Home, open Inspector |
| `y` / `n` | Accept / flag marked to-try rows, or the current row if none are marked (`n` means nothing else on any page) |
| `b` | Model text master on/off (also the top-row models word) |
| `w` | Home, Project: write the shown project's [review board](#review-board) (HTML) and open it |
| `/` | Filter rows live on Home (either layout), Project Progress and Project Tickets: a one-row bar `/ query▌  N matches` under the header. A case-insensitive substring over, on Home, a card's package, title, role, harness, model-sentence keywords and status word (`asking`, `failed`, `working`, `stalled`, `done`; a decision's package and title); on Progress a slice's id, milestone, text, role and state (`working`, `blocked`, `to try`, `accepted`, `todo`); on Tickets a ticket's feature, number, title, status and blocker. Only matching rows are drawn, so ↑↓, Enter and Split's preview move over them; a matching card older than Home's fold or hide time stays (shown as its one row, muted), and the waiting, progress and older-count blocks, STATE's Next and its summary are left out while it is on. While typing every printable key goes to the query (`g`, `X`, `w`, `r`, digits, `=`, `-`, `q` do nothing else; Left, Right and Tab wait); Backspace edits; Enter stops typing and keeps the filter; Esc stops typing, then clears it (Split's preview gives Esc back to the list first). Another tab, page, project, Help or the Inspector clears it. Kept across the panel's reload |
| `,`, `?` | Settings, Help |
| Esc | With a `/` filter, first stops typing, then clears it; then back (a Project page returns to the hub, the Projects list to the hub, a hub opened from the list to the list); dirty Settings ask save/discard/continue; standalone main-page Esc exits |
| `q` | Close panel |

Mouse clicks select a row/button, a second click on the selected item runs Enter's
action (Project hub links, Inspector file links and Home progress-block links open
on one click), clicking the top crumb goes back, clicking a tab switches tabs, and
wheel scrolling moves the viewport without moving the selection.

### Split layout

The saved setting `panelLayout` (`classic` by default; Settings → Panel → Layout) can be `split`:
Home, Project and Control become **a list above and a preview of the cursor row below**
(`docs/design/panel-v8/`, option 2). Classic's cards, slab and sentences are the previews, unchanged.

- **Home.** One row per package lane and per block (Waiting for you, Decided for you,
  Progress), always the same height, whatever runs: mark, name, phase, then the state
  of the lane's most important job. A question or a failure keeps a reason row, so what
  needs you is always on screen; the cursor starts on the first such row. Below the
  list the preview shows that row: the question's slab and the lane's cards, the
  waiting items with the newest landed slices, the decisions, or the progress block.
  On a short panel blank rows go first, then the preview from its bottom; the list
  never gives way (a very short panel scrolls it with its cursor). A lane at work that
  the cursor is not on shows, in the row's free cells, the marked keywords of its
  model sentence (else its reason or the phases so far); when the width leaves under
  six cells, nothing.
- **Project hub.** Waiting for you and the pages are the list; the preview of the
  cursor row is that page's substance (Progress: summary, bar, slices to try, Now,
  latest accepted). Enter on a page opens it, as before. A waiting item shows its whole text, wrapped, and a slice to try its
  brief's first sentence on one row (or, without a brief, its whole text wrapped); the preview scrolls with PgUp/PgDn when it is long.
- **Progress.** One ledger list (working, blocked, to try, todo; accepted, Next and
  History are one row each) with the cursor slice explained underneath: its whole ledger
  text and, for a slice to try with a brief, its brief and acceptance steps with the original ledger text folded below them (Enter on the slice takes the keys into the preview, Enter on the fold row unfolds it; `o` opens STATE.md). A to-try slice's list row is its id and the brief's first sentence. In the hub's
  Progress preview, Space starts on the highlighted to-try row and moves the keys into
  the preview. Without Space marks, `y` / `n` on the hub still act on the next slice to try.
- **Control.** Roles on top (Needs attention first), with the selected role's detail and chain below. Enter focuses the places: ↑↓ selects one, `p m e i Del K J x` act on it, Esc returns; `c` / `C` apply a preset to the role from the list. `h` switches to Harnesses, with switch facts and next-job effects in the preview; `i` opens Add back in the preview.
- **Tickets, Working tree, Docs.** A row each, the ticket's checklist and latest
  comment or the fact's whole text underneath; Enter opens the file.

| Key | In Split |
|---|---|
| Up/Down | Move in the list (or in the preview, once Enter has taken the keys there) |
| PgUp/PgDn, wheel over the preview | Scroll the preview; the wheel over the list moves the cursor |
| Enter | A row with something to act on in its preview (cards, waiting items, places) moves the keys there; there Enter does what it does in Classic. Elsewhere as in Classic |
| `=` `+` / `-` | Grow the list / the preview by a row (the list's share stays between a fifth and four fifths of the rows and is kept when the panel reloads). The Control plane's place keys are `i` and `Del`, so these keys never mean two things there |
| Esc | Back from the preview to the list, then as in Classic |
| Click | Selects a row (or a preview row); a second click is Enter |

While the keys are in the preview the list shrinks to three rows around its cursor, so the preview has the rest; Esc brings the chosen share back.
A preview with more rows than fit shows a scrollbar in its last cell: a thumb (`┃`, `#` with text icons) over a dim track (`│`, `|`); its rows are laid out one cell narrower, so nothing is cut.

One waiting item's page and the Projects list are Classic's frames in either layout.

### Help

Press `?` for shortcuts, status marks and the **Backup skills** section. Scroll down
with the movement keys or wheel to see the list.

The section lists the shipped backup-skills catalog (`integrations/skills/backup-skills.json`):
Matt Pocock skills not installed: the adapted copies in `integrations/skills-optional/`
and the upstream text, which the main session reads when asked. Under a `Backup skills` header with the count, a muted line says what the list
is, then each skill's name and its whole one-line description in the panel's language.
Descriptions wrap, never cut, so the list reads at a 40-column panel. A panel under 103
columns (with the shipped names) stacks them: the name in the identifier ink on its own
row, the description under it two cells further in, nearly the panel's width. One of 103
or more puts the description beside the name in its own column, wrapped rows hanging
under the first. A name longer than the row breaks after a hyphen. Skill rows are
read-only, with no row actions, install state or adopted/dropped skills. A missing
or unreadable catalog shows a muted notice, an empty one another.

### Inspector

The selected card/question/decision expands above facts: role/harness, model/effort,
package, state/phase and observed local times. The Inspector and expanded running cards in both layouts show
one muted Milestone line when the worker has logged one, and an Activity row under it: ten one-minute
buckets (`▁▂▃▄▅▆▇█`, `..--==##` with text icons) of how often the panel saw the running worker write (session, status,
report or `hud-progress`), a quiet minute blank, eight sightings or more a full cell. The ring lives in the panel's memory
from when it first saw the worker, so there is none for a worker that has not written since, and none once it settles.
Files lists brief, QA, reviews and
report; Up/Down selects, Enter/`o` opens. Native cards list their transcript and
available context %, estimated tokens/s and cumulative tokens; missing values are
omitted, with no extra model request. No stage/log history or switch controls remain.

### Changes summary

`3` shows branch/HEAD, ahead/behind (unknown without upstream evidence), change
counts and one row per worktree with path/branch/dirty state. No file lists, diffs,
previews, staging, commits or checkout actions. Collection runs only while focused;
failed/stale Git status stays unknown, with repository filters and lazy fetching disabled.
Edits inside a submodule's working tree do not mark the Codex bar, pi footer or
Project dirty; a moved submodule commit does. The Changes view ignores submodules entirely.

### Settings

| Group | Rows |
|---|---|
| Display | Theme, Bar style, Icons, Language |
| Panel | Home mode, Layout, Width, Stall threshold, Fold after, Hide after, Notifications, Refresh, Mouse |
| Models | Model text, Model, Decision API, Call cap, Decision cap, Summary interval, separate hourly counters, Test API |
| Codex | Bar on launch |

All groups are open. Up/Down selects; Left/Right or Enter changes; `s` saves, `r`
resets only this group, `t` runs/cancels Test API. Dirty leave asks Save and leave /
Discard changes / Continue editing (default); failed saves retain the draft. Theme
and Icons preview in the draft itself. No Reset all, accordion or picture.

Width presets: 40/48/56(default)/64/80/100; saved 16–200 load, 0 means default.
Saving a changed width resizes every client's panel, preserving 41 columns for the
agent where possible. Window resizing reapplies it; border drags and unrelated saves
do not. Fold default 5 minutes, Hide default 15 (stored 1–1440). Stall threshold is
10 minutes (1–120); job session writes count as activity even with models off.

Themes: `terminal` (default), `titanium`, `mocha`, `arctic`, `ember`, `contrast`,
`latte`, `paper`, `none`. Each has its own Home/Project/Inspector inks; latte/paper
are light, none/`NO_COLOR` emits no colour. Preferences save privately to
`$HUD_HOME/hud-settings.json` or `HUD_SETTINGS_PATH`; saved display values override
environment defaults. Old card/layout/model-feature keys are ignored and dropped
on save, not migrated; existing user caches/assets are not deleted.

## LLM

One master controls job/native names and sentences, decision titles/details,
Decision labels and Recommended Home ranking/brief. Nothing writes workflow facts
or steers a worker. Off hides overlays and sends no requests; without a saved
preference, a Mistral/OpenAI/Gemini key defaults it on. Text requires a matching
chat-endpoint key; decisions require Gemini/OpenAI/TypeSafe separately.

| Setting | Key / default |
|---|---|
| Model text | `modelEnabled`, key-aware |
| Model | `model`, `deepseek-v4-1-flash-1017` |
| LLM cap | `modelCallsPerHour`, 60; 30/60/120/240/unlimited |
| Decision cap | `decisionCallsPerHour`, 0; 600/2000/unlimited |
| Summary interval | `summaryIntervalMinutes`, 5; 2/5/10/15/30 minutes (validated 1–120) |

Both caps use 0 for unlimited and still count calls (`n/∞`). Counts aggregate
panels on one HUD home. Text uses `display/model-cache/calls.json`; labels/ranking
use `display/model-cache/decision-api/calls.json`, including fallback attempts.
One line per counter lists this hour's features, largest first. Changed running
text follows Summary interval; final sentences and ranking keep two-minute floors.
One successful final sentence freezes that settlement; a continuation can settle anew.

**Outbound material** (public channels only; never reasoning, ciphertext or referenced files):

| Feature | Input |
|---|---|
| Thin-job sentence/name | Brief title/goal (1500-byte head), STATUS, open question (2 KiB), review verdict, four settled report lines, four public text/tool blocks from a 32 KiB working-session tail |
| To-try brief and steps | One per slice still to try, only while the Project tab shows it: its ledger line, the subjects and bodies of up to 5 commits it names (1200 chars each), up to 4 ticket files (3000 bytes each) under the `.scratch/<slug>/` it names; cached per slice by a hash of those inputs |
| Native sentence/name/result/cause | Name/role (80 chars each), public task/charge (400), report (600), action (200), result (8000 head/tail), error (2000); settled Codex may use a safe 32 KiB tail, Claude reuses collected text |
| Decision title/localized detail | Question and answer, 4096 bytes each; ≤8-word title plus faithful question/answer/instead/why |
| Outcome label | Final state + first 12 report lines (4096-byte head), once per settlement |
| Kind label | First two brief paragraphs (1500-byte head), once per running/job settled within one day |
| Looping label | Last 12 public tool/result pairs (600 chars each part) from the same safe tail; after 3 quiet minutes, at most once per 5 minutes, unchanged input never repeats |
| Question category | 4096-byte question head; ≤100 questions per observed job |
| Review severity | ≤24 list items (400 chars each) from newest 32 KiB review head or settled reviewer report |
| Home ranking/brief | ≤200 cards' ids, lanes, state, role (80), title (160), age, sentence/reason (240), question flag, outcome; no bodies |
| Quiet-job decision | Last 60 pane lines (≤12,000 chars) of a CLI worker, job state, role, agent, minutes quiet, background-child flag, whether the report prompt was sent; at most once per idle grace without a report, ≤3 per supervisor run |
| Test API | Fixed synthetic messages only |

Outcome/kind/looping/category/severity labels are display-only enums; language
changes translate locally. Failure shows no provider HTTP text. Private revision
caches survive reopen, as do sentence/title caches (200 records); unchanged inputs
make no new request. Sentences have at most three pending handles on the shared
single-flight text queue; Decision labels have a separate single-flight path.
Titles use effort none, sentences low, Home briefs high; no model-tier/effort selector.
Wrong-language text is rejected. Keyword marks `«keyword»`, `«+approve»`, `«-reject»`,
`«!opinion»` (and short Chinese `「…」`) share painting across cards/decisions/Inspector;
files/paths retain identifier ink. No recap, session-title or change-summary generator runs.

Configure text through the settings file, not a connection editor:

```json
{
  "modelEnabled": true,
  "model": "deepseek-v4-1-flash-1017",
  "modelCallsPerHour": 60,
  "briefingApiBase": "https://api.mistral.ai/v1"
}
```

Empty base uses Mistral. `POST <base>/chat/completions` receives only its exact
origin's matching `MISTRAL_API_KEY` or `OPENAI_API_KEY`; environment wins over HUD
credentials. Custom/HTTP/lookalike/nondefault-port origins get neither; userinfo
and redirects refuse. No matching key means no request. `CODEX_HUD_BRIEF_MODEL`
overrides the model id. Test API uses three fixed synthetic requests, the same
model/cap, 256-token answers plus reasoning allowance and 15-second timeouts;
master off/no key sends nothing, leaving Settings cancels.

## The bottom bars

Claude statusline, pi footer and Codex tmux bar share one facts renderer:

```text
model effort │ context %/window │ repo branch(dirty) │ quota │ ~N t/s │ notices ··· MCP n  skills n
```

Context is ten cells, green below 70%, yellow from 70%, red from 85%, measured
against the client's compaction window when known. Claude/Codex show only their
own tightest quota window, blue then magenta from 75%, red from 90%; pi has session
cost instead (in its top-right editor ribbon, not duplicated below). Missing facts
are absent. Agent/job start/done/failure and Claude skill-load notices stay three
minutes. An agent or job item names the work, never the model: its type or role and what it
works on (`[◐] imp 状态栏TPS`; a Claude subagent's Agent-call description, a HUD job's brief
heading else its package, a Codex subagent's label or task; left out when unknown), and a
finished or failed one how long it ran, fixed when it ended (`[✓] imp 状态栏TPS 12m`). `×n`
groups the same kind with the same words; the title is cut at 36 columns, then at a word
on narrow bars, before the item goes, and the type stays. A HUD job (its own tab) wears a boxed mark, `[◐]` `[✓]` `[✗]`, a
subagent inside the session a bare one; a settled job whose report is unread has a dot in it, `[✓●]`, until `hud_read` reads it.
Open approvals and job questions are pinned, the first one named (`! imp 首页修正 asks`) and `+2` for the others, `! 3 needs`
when even that does not fit; nothing open, nothing pinned. No clock, task count, hooks count, tool-at-work or idle fallback.

- Claude statusline: `~N t/s` estimates the latest response from transcript output tokens and elapsed time since its prompt or tool result.
- Codex bar: `~N t/s` shows the existing output-rate estimate from the rollout.

Settings Bar style: `line`, `p10k`, `gauge` (Gauge Plates), `tide`, `micro`, `stacked`,
`headline`, `triptych`. Stacked is two rows in Claude/pi; Codex falls back to line.
Tide tints need truecolor. Text icons/none keep meanings without colour. `barFields`
selects from `model,context,project,quota,tps,notice,loaded` without reordering them.
If you use a field allowlist, include `tps` to show the rate. Narrow bars (a main pane beside
the open panel is 144 columns on a 184-column terminal) give up, cheapest first: the loaded counts;
both gauges' cells together; the quota's reset and the branch's `↑n`; a notice's title (a few words,
then none); the rate; the older of two notices; the effort; the context's window (`41%`); the branch;
the quota; the project; the context. The model is never dropped, a job's role stays whole, and the
numbers keep their forms while a job starts: it takes room from titles, which take back what is left.
pi's ribbon follows the look;
other extensions' statuses remain visible. The bars stay English-only apart from a job's own title.

### EXP · Codex native status line (experimental)

In ordinary Codex with the `hud` MCP server registered, open `/experimental`,
turn on **Custom status line**, then restart Codex. Open `/statusline` →
**Choose a status line provider** → **MyHUD**. To switch back, select
**Default status line** from the same picker.

The compact footer puts model and effort, context, then quota first. A HUD work
reminder, when available, is scoped to the pane. On a narrow footer, Codex cuts
the right end with `…`; `codexH`'s tmux bar keeps its width-aware layout.

### pi controls

These controls affect the current pi session, not saved panel preferences:

| Command | Action |
|---|---|
| `/hud`, `/hud toggle` | Toggle the panel (it never opens automatically) |
| `/hud on`, `/hud off` | Open/close the panel, independently of the footer |
| `/hud status` | Report panel state |
| `/hud reconnect` | Rebind after a canceled session transition; preserves this session's footer on/off choice |
| `/hud help` | Show panel/footer command help |
| `/hud footer on`, `/hud footer off` | Restore/hide the entire HUD footer and editor ribbon, session-local |

Segment/group changes below persist to `$HUD_HOME/config.json` → `piFooter`;
if saving fails, the change applies only to this session and a warning is shown.
`/hud footer` or `/hud footer list` lists enabled segments by group and the config path.
`/hud footer reset` restores all segments to on. `/hud footer band on|off` switches
the ribbon group; `/hud footer footer on|off` switches the bottom group.
`/hud footer on|off|toggle <segment...>` changes named segments, or use `all`
(for example, `/hud footer off lens viz`, `/hud footer on all`). Bare
`/hud footer on|off` is the session-local whole-frame switch, not a persisted group change.

Bottom-group ids: `model thinking path git mcp skill lens viz statuses context`.
Ribbon-group ids: `session cache tokens tps ttft cost time`. These are segment
visibility controls, not a way to enable unavailable facts. Context is in the bottom
group but is stored as `piFooter.band.context`; the other ids use `piFooter.footer`
or `piFooter.band` according to their group.

## Machine-readable state

The active Codex bar/panel writes private atomic snapshots to
`$HUD_HOME/display/state/<tmux-session>.json` when facts change (at most once/second).
`hud codex --json` reads this directory's session snapshot:

```sh
hud codex --json | jq '.context.percent, .agents.active, .attention[].label'
```

Version 2 carries session/project/context/quota/tokens/agents/attention, optional
health/rate evidence, and bar field columns (`bar.segments`, empty for panels).
Agent, subtask and guardian-review counts are separate. Missing facts are absent,
not zero. Writer ownership follows the atomic file's device/inode; an outgoing
writer cannot delete a replacement snapshot. There is no owner sidecar.

**Output throughput.** The native Inspector may show estimated `~42 tok/s`: current
turn output delta / elapsed time minus the union of fully known tool waits, including
initial latency/stalls. It is not exact request decoding speed. Two counter samples
are needed; unchanged counters do not refresh it. Old samples say last, not live.

## Configuration

`HUD_HOME` defaults to `~/.hud`; `HUD_SETTINGS_PATH` overrides the settings file.
`CODEX_HOME` defaults to `~/.codex`, read for transcripts/Codex config, not HUD state.

| Environment | Meaning |
|---|---|
| `HUD_BAR_STYLE`, `HUD_BAR_FIELDS` | Bar defaults (also `CODEX_HUD_BAR_STYLE`, `CODEX_HUD_BAR_FIELDS`) |
| `CODEX_HUD_THEME`, `CODEX_HUD_ICONS` | Theme/icon defaults |
| `NO_COLOR` | Any non-empty value disables colour, even with saved settings |
| `CODEX_HUD_STATUSLINE` | 1 default; 0 disables Codex bar on new HUD sessions, wins over Bar on launch |
| `CODEX_HUD_TREE_WIDTH` | Initial panel width when no saved settings |
| `CODEX_HUD_CWD`, `CODEX_SESSIONS_PATH` | Explicit workspace/session directory |
| `CODEX_HUD_MOUSE`, `CODEX_HUD_AUTO_ATTACH` | Mouse policy, explicit auto-attach preference |
| `CODEX_HUD_NOTIFY`, `CODEX_HUD_NOTIFY_DESKTOP`, `CODEX_HUD_NOTIFY_COOLDOWN` | Notification opt-ins, cooldown (300 seconds default) |
| `CODEX_HUD_PROFILE` | 1 writes stage timing summaries to `display/profile.log` |
| `CODEX_HUD_FONT_DIR` | Override optional `bin/codex-hud-fonts` install/check directory |

Notifications default off. They report observed failures, approvals and completions
through tmux, optionally desktop OSC/notify-send; they never auto-approve or retry.

**Credentials.** `$HUD_HOME/credentials.env` must be a regular 0600 file (not a
symlink/FIFO). `NAME=VALUE`, optional quotes/export, no interpolation; environment
wins per name, no implicit client/jev key import. Known keys include
`MISTRAL_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `TYPESAFE_API_KEY`.

**Decision API.** `$HUD_HOME/config.json` has `decisions.primary` (default openai)
and optional `decisions.fallback`: gemini/openai/typesafe. Settings saves primary,
not keys. Automatic fallback picks the first other keyed provider in Gemini →
OpenAI → TypeSafe order; one fallback for missing credentials, quota/auth/5xx/timeout,
not malformed/refused answers. Gemini quota replies cool down the process for the
server delay or 60 seconds. Browser CLIs own their own configuration independently.

**Explicit import.** `hud import preview`/`apply` reads only named old files (plus
legacy HUD `jev.env` when present), never guesses a Codex home. Existing values win;
apply backs up changed targets privately and output lists names, never values.
`--pi-footer` imports an explicitly named p10k-footer JSON. Sources are old
`hud-settings.json` and `.env` files; old jev-ask TOML is refused (browser CLIs keep
their own configuration).

```sh
hud import preview --from /tmp/synthetic-old/hud-settings.json
hud import apply --from /tmp/synthetic-old/hud-settings.json
```

**Codex config.** The display reads model/effort, compaction window, quota evidence,
MCP and skills from Codex's config/transcripts; it does not edit them. Client MCP
registration belongs to the explicit installer, not the read-only display loop.
