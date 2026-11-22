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
**hud_send**, **hud_respond**, **hud_close**, **hud_lease**, and **hud_tickets**. Call `hud_roster` when project dispatch context is missing or stale.
It returns role availability, continuation, effective `runs_on` and the convention. For presets, fallbacks,
model/thinking sources and accepted options, pass `detail: true`. The MCP omits an unchanged convention on
subsequent roster calls in the same session; role rows are always refreshed.
Bundled role JSON is overridden by `$HUD_HOME/roles/*.json` by role name, then by a
registered project's `.hud/roles`. The first `hud-convention.md` in a registered
project's `.hud/`, the cwd, HUD home, then the package wins whole.
See [Project workers](#project-workers).

Claude Code sessions that negotiate MCP tasks see a task under `/tasks` for a new `hud_create`, single-job
`hud_send` (including a repair), or `hud_respond` that resumes work. Claude Code wakes on a settled report,
question, failure or stop without Monitor. The notification names the job, role and state, with a report path and
one-line summary or the question ID and text. It does not mark a report read; collect it with `hud_read({job})`.
A successful fan-out send keeps the job’s existing active task instead of starting a new one.
Cancelling a still-current task stops the worker like `hud_close`; repeating cancel or cancelling an old task does
nothing. Dispatch failures, duplicates and fan-out sends return immediately. Use `hud_read` for jobs without a
task and to recover after an MCP restart. Task clients do not get `hud_wait`, `changes`, `watcher_alive`, or the
`hud watch` delivery hint.

For other clients, MCP tool responses carry `changes`: one line per state change of the jobs this pane dispatched since
the last response (omitted when there is none). Panel, statusline, pi footer, MCP and `hud watch` derive a job's
state through one shared `jobRow`, so they agree. `hud watch` defaults to actionable events: new questions
(with text, options, default and `hud_respond` reply), settlement/unread reports, blocks and new quiet-worker
reasons. It skips working starts/resumes, answered questions and already-reported closure; `--verbose` keeps
all MCP change lines. On start it catches up pending questions, unread settled reports and unread failures/blocks.
It scopes to `HERDR_PANE_ID` (`--all`: every pane), reading nothing at rest beyond a 30 s rescan. Claude Code
without tasks runs it under Monitor; re-arm after expiry. Codex receives the same quiet events automatically through
`codex queue`: create/send starts a detached `hud watch --queue`, with catch-up and no event lines on stdout.
It exits when the pane is gone/no longer Codex, or after 10 minutes with no unsettled job, unread attention/report
or unanswered question. The pi HUD package delivers actionable notices natively, waking an idle main session
or delivering before the next model request after the current tool batch, without touching the editor draft.
No Monitor or panel is needed; pi workers do not start this watch. A pane-scoped watch records `$HUD_HOME/watchers/<pane>.pid`
while active. `hud_roster` and `hud_create` report `watcher_alive` when the caller has a pane; a live watch
suppresses direct pushes. `hud_roster` and the first `hud_create` result in a session give a delivery hint
for the caller's harness (or general guidance when the harness is unknown).
Without an active MCP task or live watch, CLI and pi worker questions go directly to the Codex thread queue; other main sessions
receive typed questions and can use `hud_wait` for settlement. Queue delivery uses the pane's Codex
process `CODEX_HOME` (default `~/.codex`), not the MCP account. A missing thread id or any queue failure falls
back to typing that line, which can touch a draft or fire prompt hooks. Stale PIDs never suppress delivery.
MCP `changes` stays the fuller, query-only stream; a `report` token always means unread. With live events, keep
working until notified instead of polling or waiting. A report-ready notice leaves the report unread; collect it explicitly.

`hud_create` takes `role`, `task`, optional `cwd` and display-only `package`. The optional `request_key`
defaults to a hash of the caller pane, role, cwd and task. By default it dispatches on the role's first available place (`runs_on`).
`hud_create({retry_of: job})` starts a new job using a failed or stopped job's brief and options; explicit fields
can override them. It selects an available place through the role or preset chain unless you supply `on`.

Pass `checks` for up to five shell commands you would otherwise run yourself in the job's `cwd`. The HUD runs them
in order with `bash -lc` after a declared pi or CLI settlement, with a ten-minute timeout per command. Retries and
closed-job repairs inherit them. `hud_read({job})` shows pass/fail and a bounded failure tail; a new turn or rewritten
report marks the previous results stale. `hud watch` adds `checks 2/3` on settlement or in a follow-up notice when the
results arrive. The job card and Inspector show the same count of passed/total checks (`✓` pass, `✗` fail, `↻` running,
`~` stale). Checks do not settle jobs or decide acceptance.

Pass `preset` to use the first available, non-exhausted place in a named role preset
without editing role files. Alternatively, pass `on` to override the harness/provider
(defaults from shipped `harnesses.json` overridden by `$HUD_HOME/harnesses.json`).
`preset` and `on` are mutually exclusive. A repeated explicit key returns the original job; a derived key
only reuses a job created within the last 10 minutes. Use these overrides only on user request. A detailed job read or peek shows the selected `preset`.
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

When a role has `thinking_choices`, choose a level for each task using the purposes on its `hud_roster` row (`hud_create`) or in `hud_sonic`. Sonic ships with `low` for mechanical lookups, `high` for multi-file surveys or small doc patches, and `max` for tracing causes or cross-checking claims. The choices are inherited when an overriding role file omits them. Other supplied levels are refused; an allowed choice that the selected model does not support maps to the nearest supported level. Omission keeps the configured default.

Pass context as `context_files` (up to 32 paths resolved against `cwd`) and `from_jobs` (up to 16 job IDs,
each referring to its `report.md` in `$HUD_HOME/jobs`). Use readable UTF-8 text files that resolve inside `cwd`
or `$HUD_HOME/jobs`, respectively; invalid references return `invalid_arguments` before dispatch. Pi and CLI
workers read the paths listed after the task in their briefs. Browser (`bro`) briefs send the labeled file contents
to the browser service (64 KiB per file, 256 KiB total; larger context returns `context_too_large`). The optional
project-root `.hud/brief.md` is included automatically only for registered projects: a reference after the task
for local workers, or its contents within the same byte limits for browser jobs. Keep it safe to send to the selected
browser service. Attaching an upstream report does not mark it read or close its worker.

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
`imp` (`pi` implementer), `reviewer` (`pi` reviewer -> `agy` Hydrogen high), `sonic`, `oracle` (`cli` `claude` `fable` high -> `pi` `architect`; `hud_create` also takes `architect` for it unless a role file defines one),
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

Main sessions in herdr and workers use `hud_lease({name, release?, wait_s?})` before using a named shared resource.
Waits stay inside the caller's turn (120 seconds by default, capped at 300; `0` checks once). Use the resource
only on `granted: true`; otherwise `held_by` gives the holder and acquisition time. Release with `release: true`
when done; releasing someone else's lease is a no-op. Leases are scoped to the caller's repository, shared by the main checkout and its linked
worktrees (cwd outside Git), and the next acquisition reclaims a lease left by a terminal worker or an exited process. No background process
or time expiry is involved; the tool uses util-linux `flock`.

`hud_peek({ job })` returns compact `status` and progress without fetching the pane. Request `lines` (1–120) to
fetch the pane tail as `pane_lines`; if unavailable, that field is `null` with a `pane_reason`. `detail: true` adds
launch `diagnostics`. Peeking does not read the report, mark the job seen or close the worker. Workers
can use `hud_progress` to log milestones (one line, up to 240 characters;
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
Workers finish with `hud_report`, which publishes the report without repeating it in chat. Claude and Codex
use their HUD MCP and pass the token from the prompt they are answering; pi has native tools and needs no token.
Antigravity and Grok Build use the fallback commands in their briefs. Workers use `hud_sonic` to start sonic
sub-tasks without waiting, then collect their reports; HUD prompts once if they finish without collecting.
`hud_send` queues a message for a working pi or CLI job, or continues an eligible role during idle grace while
its report is still unread. A single send to a job closed by reading its report starts a repair with references to its
brief and report, returning the new job ID as `continued_as`. Use `jobs` instead of `job` to send only to working
jobs; the response lists `sent` job IDs and `skipped` entries with reasons. An explicit `message_key` deduplicates sends;
if omitted, the same job and text are treated as a retry only within 10 minutes. Workers ask with `hud_ask`; the question arrives through
an active MCP task or the `QUESTION` notice, and `hud_respond` answers it. A synchronous question waits up to 20 minutes;
pi can ask asynchronously and continue unrelated work. A blocked CLI marks the job as needing the owner; task clients can see it
in `hud_read`, and other clients receive it through `changes` or their live job notices. `hud_respond` writes a
`qN.answer.md` once. `hud_close` reaps early; normal cleanup belongs to the watcher. The owner can also answer
an open question from the panel (`1`–`4` or `d` on its expanded question); the session hears it as one `changes` / `hud watch` line,
`[role@job] ANSWERED qN from panel: <answer>`, read from `$HUD_HOME/panel-actions.jsonl` (answers made while the
reader runs; a question answered earlier is simply gone).
The main session chooses all next steps; the MCP never chains work.
See [the MCP README](../packages/hud-mcp/README.md) for the delegation tool arguments.

`hud_tickets` provides the ticket method in every client without a separate skill. `cwd` defaults to the server's
working directory; pass the project directory to target another project.

- **`guide`** (or no `op`): returns the slicing method and local ticket template as Markdown.
- **`add`**: pass `feature` (lowercase letters, digits and hyphens) and `tickets: [{title, blocked_by, what, acceptance, status?}]`.
  `blocked_by` lists numbers from existing tickets in the feature or earlier drafts in this call; use `[]` for no blockers.
  An unknown blocker rejects the entire batch without writing. `acceptance` is a list of checklist item strings.
  The result lists the assigned numbers and paths as `tickets: [{number, path}]`.
- **`update`**: pass `feature`, `ticket` (number), and `status` and/or `tick` (1-based checklist item numbers).
  Unknown tickets or items are refused; other lines are unchanged.
- **`sync`**: runs `hud tickets sync` for the given project and returns its output lines in `output`.

The default status is `ready-for-agent`; other allowed labels are `needs-triage`, `needs-info`, `ready-for-human`,
and `wontfix`. This is a main-session tool. For GitHub-mirrored `.scratch/`, `add` and `update` refuse:
edit GitHub Issues with `gh`, then call `hud_tickets` with `op: "sync"`.

Jobs are plain files in `$HUD_HOME/jobs/<job>/`. Pi history stays in
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/<cwd-dir>/`; job `sessions/` links to
primary/helper files. A CLI job's supervisor only observes; only facts end a job: the
worker's recorded pid gone (or replaced), its tab closed, or a dispatch rejected before input (`failed`, or
`closed` when a new report is on disk). Each dispatch and `hud_send` starts a turn (`turn.json`). With `advisory`
trust, on a turn that never issued a receipt, a new report settles the turn when herdr is not `working` and the report
has been stable for 10 s, provided there is no live in-turn child. Such children also defer quiet decisions and
automatic close. `hud_report` (or the fallback `hud-progress --done`) binds the CLI report's signature to the turn in the worker's prompt.
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
(shipped and `$HUD_HOME/roles`), project roles with their ordered `run` chains,
the enabled set, invalid role files, skills and worker-skill links. Skill roots come from `$HUD_HOME/setup.json`
`skill_roots` (defaulting to `~/.pi/agent/skills`, `~/.claude/skills` and
`~/.agents/skills`), always followed by the checkout's `integrations/skills`. A skill is a directory with `SKILL.md`; its name is the
frontmatter `name`. Each skill includes `model_invocable`: false when that
frontmatter has `disable-model-invocation: true`. Pi still loads such a skill, but
leaves it out of the model's skill list, so a worker will not pick it by itself.

`--apply` reads a plan and writes under the project's `.hud/`, which is meant to
be committed:

```
.hud/project.json          enabled roles, and the links, role files and prompts apply made
.hud/roles/<name>.json     a project chain or a pi role that differs from its reference
.hud/skills/<name>         symlink to the skill directory (workers only)
.hud/agents/<role>.md      optional worker-only prompt
.hud/hud-convention.md     optional copy of the shipped convention
.hud/brief.md              optional standing brief (add manually; not managed by setup)
```

The plan is version 1: `roles` (enabled names), `pi_roles` (pi tuning only: `from`,
`pi_role`, `model`, `thinking`, `split`, `can_continue`, `skills`), optional `runs`
(role name to a non-empty ordered list of places), `skills` (name to an absolute
skill directory), `agents` (role to markdown) and `convention` (`keep` or
`copy-default`). `runs` can name reference roles or copies in `pi_roles`. If both
fields name a role, `runs` sets its order and `pi_roles` fills in defaults for each
pi place. It prints `removed`, `wrote`, `linked`,
`skipped (exists)`, `registered`, or `no changes`. The same plan again changes
nothing. A file or link apply did not make is left in place and reported as skipped.

Applying records the root in `$HUD_HOME/projects.json`. Project config loads only
after that, including the standing brief. `--remove` drops the registration and
leaves `.hud/` alone; the standing brief is no longer used.

A registered project's role file may list pi and CLI places in `run` and in
`presets[].run`. A CLI place accepts only `harness: "cli"`, `agent`, `model` and
`thinking`; no extra arguments. Browser (`bro`) places are not allowed.
Worker tuning (settings, skills and prompts) is still pi only; setup does not edit
any CLI's own files or run `hud trust`. If a CLI place needs a trust grant for the
project directory, run `hud trust <dir>` yourself.

## Home

Home shows needs-you questions, package lanes with compact job cards, native
session lanes. It observes files and never briefs or chains work; its only
actions on a job are the owner's three micro-actions (see [Keys](#keys)).
Running jobs with unanswered questions need you; an unanswered question left on a
finished job does not. A report is not proof of success, and display labels are not
acceptance or a merge decision. Unknown evidence stays unknown.

Cards have a title and two fixed sentence rows; `┃ …` holds space until text is
available. Enter expands the complete sentence and factual details in place.
Brief headings supply job titles; otherwise a model name or first task line fits
the width. Only the newest current settled card initially expands, until its fold
time; explicit choices win for that panel lifetime. Enter on a lane folds it.
Question slabs show answer keys beside the expanded options; `o` still opens the question file.

**Sonic children.** A `sonic` job a HUD job dispatched (its `parent_job`) is not a card: it is one row under the parent's
card, `├─ ⚡ sonic · short title  3m ◉` (the last `└─`, ascii `|-` and `` `- ``), with its elapsed time and state glyph, in
Classic and in Split's preview. A parent folded to its title row hides the rows and says `⚡ N sonic` (the ones still
running) on its right. A `/` filter that matches a sonic job keeps its parent with it.

**Panel lifetime.** Jobs settled before the panel opened are excluded, including
their decisions and model inputs; `a` cannot reveal them. Active/unknown jobs stay
eligible regardless of age. Build reload preserves the original opening time.
Native agents and Project's STATE slice lookup keep their own scope.

**Card lifetimes.** Settled HUD/native cards fold to one row after 5 minutes and
hide after 15 by default; failed/stopped cards stay at least 30, and a failure the
model ranking protects leaves Home after a day unless it still asks. Settings → Panel
changes both. A hide time below fold time counts as fold time. Running/asking cards
stay. `a` reveals hidden cards in place as muted one-row titles; Enter
expands them. The job scan considers the newest 200 directories.

Answered questions are still collected but have no Home block or dedicated panel view.
The Inspector still lists job files, including answers and their default/departure marks.
A review verdict requires its recorded accept/changes-required line and settled output,
not merely helper exit.

**Native agents on Home.** Claude/Codex main sessions get their own lanes, labeled
`subagents` in Split. Children indent once; deeper descendants say `↳ parent`. A hidden parent never hides a live
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
Waiting block. The footer shows `✓ N done today` from 56 columns, `✓ N` below 56, and no count at zero.

**Spare rows.** Cards get space first. Remaining rows show, top to bottom: STATE's
waiting items (a row each, up to five, then `+N more`), the newest landed work (three rows at 38–55
columns, five wider; at `slice` Home uses ledger order), then at the
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
  and how much work is still to try (`4 · 5 to try`; the second number follows the Acceptance setting, across all milestones). An item whose text does not
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
- **Latest**: the newest landed work (to try or accepted), newest first by known commit date;
  three rows at 40 columns, five wider;
- one row per page with a one-line summary: **Progress** (to try, blocked, working: the milestone is already on the project name row, and the last facts drop first on a short row; the
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

**Detail.** Settings → Panel → **Detail** (`acceptance` in `hud-settings.json`) defaults to `task`.
Progress shows one row per milestone, with the worst state's mark first and a slice count per state.
A `—` or empty milestone keeps each slice separate. Tickets shows one row per `.scratch` feature,
with resolved/total (including dropped tickets as resolved) and the oldest open ticket's status.
Enter in Classic or the Split preview shows the members with their usual details. Hub counts features
and tasks; Waiting's to-try count is the number of tasks with pending slices. Space, `y` and `n` mark,
accept and flag only a task's `try` slices. A filter matching one member still shows the whole task or feature.
Home and the HTML board still use the setting for their to-try rows. Watch/MCP notices and brief generation
are unchanged. Set `slice` for the previous per-slice and per-ticket views.

**To try only (Classic).** Enter or a click on the to-try count (`2 to try`, a stop of its own), or `t`, filters the
page to what is still to try: the header `Only to try ── n` replaces everything below the crumb, then
the acceptance rows. At `slice`, these are the ledger's slices in state `try` grouped by
milestone, newest first: the newest is open (`◇ DATA-ONE  text  1d`), each older one
a folded row (`▸ M3b  ◇ 1  19d`) that Enter opens. With the model on and a brief stored, a slice is one row: its id and its brief's first sentence (cut with `…`). Without a brief (model off, pending or failed) it shows its whole ledger text, wrapped under its id (a break falls at a space or after a `/`, `-`, `_` or `.`, never inside a word); a briefed row whose id leaves little room for its sentence (a long id) puts the sentence on its own line under the id; a panel
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

- **Needs attention**: roles with exhausted places that are enabled, with no available place, or with a missing selected preset, plus invalid role files. A role reads `imp [daily] → agy`; when a reason needs attention, it is explained underneath. An invalid file opens with Enter or `o`.
- **Healthy**: folded to role names. Enter shows one row per role with its next target and, on project-owned roles, a `project` tag. Only named presets other than `default` get a preset tag; a file chain without a selector has no tag either.
- **Leases**: when the selected project has active leases, one read-only row per lease shows its name, holder and age.
- **Usage** and **Files**: both folded. Usage opens quota windows, pi spend and dispatch health. Files opens the convention, instructions, pi definitions, ignored configuration, native agents, and local presence checks for keys, browser and harnesses.

The role row names the next model when it fits whole; otherwise it shows the harness (and provider for pi, when known). A known inherited model is muted. Split previews the selected role's numbered chain and source; Enter focuses its places and Esc returns to the list. Classic expands the numbered chain and its source under the role with Enter. `o` on a role or place opens its source. Chain marks: `◉` next, `○` standby, `⊘` switched off, `✗` exhausted and `−` not installed. `x` clears a real quota mark, even on a switched-off place; it does not turn that place on.

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

Role files may carry `presets`: `[{ "name": "short-token", "run": [...] }]`, whole ordered place lists validated like `run`. Names are unique per file, 1–32 characters from `[A-Za-z0-9._-]`. Presets merge by name from shipped → owner → registered project. At each layer, `hidden_presets` removes inherited names, then local definitions replace or append names. The winning role file's `active_preset` selects a name; `null` selects the file's own `run`. Without this field, the file chain still runs and the first exact normalized match still identifies the preset. If an explicitly selected name is missing, the file chain runs and Control and the roster report the missing name. A detailed `hud_roster` returns the effective `run`, `preset` and merged `presets`. `hud_create(preset: …)` uses that named chain for one job without saving it.

On a **role row**, `c`/`C` immediately selects the next/previous named preset, wrapping in displayed order (from the file chain, first/last). `p` opens one list including the file chain and any preset named `default`: type to filter, ↑↓ to choose, Enter to apply, Esc or Ctrl+C to cancel. The list shows where each chain runs next; an all-off preset remains selectable and shows **none**. `N` starts a draft copied from the current chain; `I` starts empty. Enter a unique name and press Enter to open the draft. `R` renames the selected named preset on Enter. `D` previews deletion of the selected named preset and the file chain that will run next; Enter confirms, Esc cancels. Selection, copy, rename and deletion never launch a job or overwrite `run`. Quota marks stay with their places.

Only explicit edits write the global owner role file (`$HUD_HOME/roles`, atomically, mode 0600), even when viewing a registered project. An inherited rename or deletion hides the old name in the owner layer instead of changing a shipped file. Project-pinned roles show the source and a lock; `o` opens the file but the panel offers no preset or place edits there. Shipped imp presets: `default`, `hydrogen`; reviewer: `default`, `pi`; oracle: `fable`, `architect` (the former architect role's pi setup). No separate architect HUD role remains.

Enter on a role focuses its chain in place (Split preview or Classic expansion). It stays read-only
until you make a change. `i` adds a place at the end; Enter on a place edits it. In the sheet, move
between Target, Model or Flow kind, Thinking (or browser Effort) where applicable, and Done. Enter
opens a field's list; type to filter, use ↑↓ or PgUp/PgDn to select, and press Enter to fill it. Esc
cancels the field or the sheet. Off targets cannot be selected; missing executables are marked.
Existing off places remain in the chain. Replacing a target that has launch options (`skills`,
`pi_args`, `args`, `split: true` or other fields the sheet cannot preserve) is refused; `o` opens its source.

`K`/`J` move a place earlier/later and `Del` removes it. The **Not saved** draft shows its next
place separately from the saved chain. `s` saves the whole nonempty chain and selects it; if validation
or the write fails, or if the role changed on disk, the draft stays open. To leave a dirty draft,
confirm **Discard edits?** with Enter or resume with Esc. Panel reload waits until the draft is closed.
Outside a draft, `x` clears the selected place's quota mark and `o` opens the role file. `r` refreshes model lists.

Press `m` on a role row to change the `◉` place (or place 1 if none can run). Press `m` on a place or
click its model field (`[model ▾]`) to change that place directly. Pi, CLI and AI Studio use the same
picker. Enter saves immediately to the active named preset or file chain and keeps the cursor where
it was. If a draft is open, Enter changes only the draft; `s` still saves it.
Flow has no model, and project-locked places show plain text and cannot be edited.

When unset, the model field shows the effective model in muted text if known, or just `[▾]`.
Unset thinking likewise shows the known value in muted text or stays blank. If you open Edit place
with Enter, its Model field still fills the form: choose Done to put the place in the draft, then `s` to save.
With an empty query, the picker starts with the current model, compatible models from this role's other
presets (tagged except for `default`), the previous model from the last quick save for this place (`was`,
kept only for this panel session), and a clear row when applicable. The picker fills the panel body
below the tabs in Classic and Split without zooming. For CLI and AI Studio it stays a single list at
any width, showing model IDs from the catalog and available discovery, with no provider groups or
facts strip. In pi, the pinned models also stay in their groups.
Pi providers used by role or preset places (including resolved defaults for unset places) are open below: the
current provider first, then by number of uses. The `▸` row groups the other providers; Enter or a click
opens or closes them together. Individual headers are not selectable. With no providers in use, all groups are open.
At 100 columns or more, the pi list has columns for context, max output, thinking, images and HUD state.
The read-only right column wraps the full model ID and shows those facts, whether it is current,
which roles and presets use it, list age, and what Enter will do. Below 100 columns, the bottom strip
shows one row of facts and wraps the full ID above it if it was shortened. Missing pi facts show `?`.

Type to filter full model IDs (`provider/model` for pi). Every space-separated term must match, ignoring
case (for example, `gpt mini`). Results are one flat list. Pi ranks providers in use first; all lists
rank matches at the start of names, after separators, or inside words, then alphabetically. One click
on a model sets it. The wheel scrolls three list rows at a time, keeping the selection visible. ↑↓
move without recentering the list,
and PgUp/PgDn move one visible list window less one row. Enter sets. Esc clears a typed filter first,
then closes without setting; clicking `esc cancel` or pressing Ctrl+C closes immediately. `◉` marks the current
assignment and `›` marks the cursor. A long model ID is shortened in the middle in the list.
Pi rows mark exhaustion with `✗` and time to reset. `⊘` means off and `?` means an unknown provider.
One muted line names off providers; their models are not offered. A read-only current model stays
visible; if its provider is off, the wide detail explains why the place is skipped. Enter on a read-only
current row in the wide view closes the picker without writing; in the narrow view it does nothing.
The clear row, when eligible, removes the explicit model. It is labelled by the resulting model and its
source when known (for example, `role's model (gpt-6.2-sol)`), or `clear` otherwise. No pi match writes nothing; manual model IDs in role files and
one-job overrides still work. The old `catalog.pi.include` key no longer filters the picker and is
left untouched in existing configuration. While the picker is open, printable keys (including `q`
and `r`) type into the filter; Backspace edits it.

The bounded list commands (`pi --list-models`, `agy models`, `grok models`) run when Control opens
with an absent or stale pi list (one-day cache), or on `r` in Control outside the picker or Ctrl+R
(`^R`) inside it. Overlapping refreshes coalesce; typing, redraws and ticks never run them. The same
cache under `$HUD_HOME/display` holds the last good results and pi model facts; older caches still open.
The wide pi picker shows the list age. The picker flags a failed refresh or a stale list when that
status is available. Without a successful pi list the picker labels the limited offline catalog. A successful empty pi list is shown as
empty. Other harnesses' fields use their separate catalogs, merging discovered models where supported,
then shipped and owner catalog models, then models from owner role files. A chain save updates only its
owner role file, keeping unrelated fields and presets. `x` writes `$HUD_HOME/exhausted.json`, not the
role. The next `hud_roster` and `hud_create` read these same files.

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
the rest, each group newest first. Enter or one click opens that project's hub. From a hub opened this way, Esc
returns to the list. On the Project tab's root hub, Esc does nothing. The cursor marks both rows of an
entry. The list is read only while it is visible: for each listed project STATE and
tickets as Home reads them (cached by file signature) and, in one pass over the newest
64 job directories, the unsettled jobs per root, at most once every five seconds while
the list stays open (opening it again reads at once). No Git, no roles, no full collection;
the shown project's own full collection pauses while the list is open. The last-touched
time reads `12m`, `3h`, `4d` (`12分`, `3小时`, `4天` in Chinese).
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

On a to-try task row, or on a slice row in the to-try view, Space toggles a mark (`▣`, or `*` with text icons).
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
OAuth footer shows percent used. The tightest window leads with a bar and time to reset (`7d ████░░░░░░ ≈43% (2d4h)`);
when there is room, the other window follows. A reading from the current request takes precedence and has no `≈` (`5h 11%`).
Stale estimates are dim and end in `?`; a window past its reset shows `↻`. Other routes such as `oapi` do not show subscription quota.
Open **Proxy readings** for both windows and their reset times, source, last success and error, and next eligible attempt.
If the proxy pauses for sign-in, sign in to the bound profile and turn Auto-refresh off and back on. Experiments off stops refreshes.

**API grants** shows the two ledgers together. The pi footer shows only the enabled ledger for the current API route,
with a bar for the share spent, approximate dollars left and days to renewal (`API ████████░░ ≈$12.34 (12d)`, for example).
`openai-api` counts `oapi` requests; `anthropic-api` counts only
requests the installed pi HUD can identify as direct Anthropic API-key usage. Claude OAuth, third-party gateways,
and unknown routes are not charged. The Claude Code status line is unchanged. Turning Experiments off preserves
both ledgers and stops collection.

The panel keeps footer hints whole: the selected row's actions take priority, then Enter with its
verb, `Esc back` where applicable, and page actions. Hints drop from the right to make room, but
`? help` stays last. Movement, tab switching and the Settings shortcut remain available without taking
footer space. An editor or picker that owns the keyboard shows its own hints without `? help`; Help
itself shows `Esc back`. For example, a running HUD job offers `g job tab` and `X stop`, a to-try row
has `Space mark  y accept  n flag`, and a Control role shows `⏎ chain` in either layout. `o file` opens
a row's file.
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
| Enter, `i` `Del` `K` `J`, `s`, `x`, `r` | Control: focus the chain / edit the place; add / remove / move up / move down; save the draft; clear the saved place's quota mark; refresh model lists |
| `c` / `C`, `p` | Control role row: next / previous named preset, or filter presets and choose a name or Custom |
| `N`, `I`, `R`, `D` | Control role row: start a copied or empty draft, rename the selected preset, or preview and confirm deletion |
| `h` | Control: switch Roles / Harnesses (or click the view heading) |
| Space / Enter, Del, `i` | Harnesses: toggle; remove (= off); Add back (type to filter, Enter restores, Esc cancels). Enter on Off folds or expands it |
| `m` | Control role or place: choose a model directly (or click `[model ▾]`). Type to filter, ↑↓ to pick, Enter to save (or fill an open draft). In the picker, one click sets, Esc clears then closes, and Ctrl+R refreshes the lists |
| Up/Down (`j`/`k`), PgUp/PgDn, Home/End (`G` is End) | Move/page/first/last |
| `g` | On a HUD job's card (Home, either layout, or its Inspector): focus that job's herdr tab, the `TAB` in its `SESSION.txt`; a tab already closed says `tab closed`. Everywhere else it does nothing: the first row is the Home key |
| `1`–`4` / `d` | On a HUD job's open question (`qN.md` with options or a default) once its slab is expanded (Enter; always in the Inspector), where the options are numbered `[1]`…: `1`–`4` pick that option and `d` the worker's default, with no key before. Writes `qN.answer.md` once (as `hud_respond`; an existing answer stands, `Already answered`) and shows nothing else. A collapsed question takes no digit |
| `X` | On an unsettled HUD job: a one-row prompt `Stop <role> <id>?  y confirm · Esc cancel` above the page. `y` or Enter stops it as `hud_close` does (a CLI job in its idle grace is first asked to quit with `STATUS.json.close-requested`, then `pi-role-reap <dir>` runs and the panel reads again); any other key cancels |
| Enter | Expand/collapse card, question or lane; in Project open a page, then fold, show a ticket or open a row's file |
| `o` | Open question + answer, else report, else brief; native transcript; in Project the row's file |
| `v` | Inspector |
| `a` | Show/hide older job cards |
| `>` / `<` | Home: next / previous card that needs you (asking, failed or stalled) |
| Space | Toggle a mark on the to-try row under the cursor; elsewhere on Home, open Inspector |
| `y` / `n` | Accept / flag marked to-try rows, or the current row if none are marked (`n` means nothing else on any page) |
| `b` | Toggle model text (also in Settings → Models). The top row shows `models off` when model text is off and the label fits; click it to turn model text back on |
| `w` | Home, Project: write the shown project's [review board](#review-board) (HTML) and open it |
| `/` | Filter rows live on Home (either layout), Project Progress and Project Tickets: a one-row bar `/ query▌  N matches` under the header. A case-insensitive substring over, on Home, a card's package, title, role, harness, model-sentence keywords and status word (`asking`, `failed`, `working`, `stalled`, `done`); on Progress a slice's id, milestone, text, role and state (`working`, `blocked`, `to try`, `accepted`, `todo`); on Tickets a ticket's feature, number, title, status and blocker. Only matching rows are drawn, so ↑↓, Enter and Split's preview move over them; a matching card older than Home's fold or hide time stays (shown as its one row, muted), and the waiting, progress and older-count blocks, STATE's Next and its summary are left out while it is on. While typing every printable key goes to the query (`g`, `X`, `w`, `r`, digits, `=`, `-`, `q` do nothing else; Left, Right and Tab wait); Backspace edits; Enter stops typing and keeps the filter; Esc stops typing, then clears it (Split's preview gives Esc back to the list first). Another tab, page, project, Help or the Inspector clears it. Kept across the panel's reload |
| `,`, `?` | Settings, Help. From Settings, Help returns to the same draft and selection |
| Esc | With a `/` filter, first stops typing, then clears it; then back (a Project page returns to the hub, the Projects list to the hub, a hub opened from the list to the list); dirty Settings ask save/discard/continue. At the root of Home, Project, Control or EXP, Esc does nothing |
| `q` | Close panel |

Mouse clicks select a row/button, a second click on the selected item runs Enter's
action (Project hub links, Inspector file links and Home progress-block links open
on one click), clicking the top crumb goes back, clicking a tab switches tabs, and
wheel scrolling moves the viewport without moving the selection. The model picker is an exception:
one click sets a model and scrolling keeps the selection visible.

### Split layout

The saved setting `panelLayout` (`classic` by default; Settings → Panel → Layout) can be `split`:
Home, Project and Control become **a list above and a preview of the cursor row below**
(`docs/design/panel-v8/`, option 2). The preview uses Classic's cards and sentences; a question slab doesn't repeat the lane name from its preview rule.

- **Home.** One row per package lane and per block (Waiting for you,
  Progress), always the same height, whatever runs: mark, name, phase, then the state
  of the lane's most important job. A question or a failure keeps a reason row, so what
  needs you is always on screen; the cursor starts on the first such row. Below the
  list the preview shows that row: the question's slab and the lane's cards, the
  waiting items with the newest landed work, or the progress block.
  On a short panel blank rows go first, then the preview from its bottom; the list
  never gives way (a very short panel scrolls it with its cursor). A lane at work that
  the cursor is not on shows, in the row's free cells, the marked keywords of its
  model sentence (else its reason or the phases so far); when the width leaves under
  six cells, nothing.
- **Project hub.** Waiting for you and the pages are the list; the preview of the
  cursor row is that page's substance (Progress: summary, bar, work to try, Now,
  latest accepted). Rows in those two state groups keep their marks and ages without repeating the state word. Enter on a page opens it, as before. A waiting item shows its whole text, wrapped, and a slice to try its
  brief's first sentence (or, without a brief, its whole text wrapped); the preview scrolls with PgUp/PgDn when it is long.
- **Progress.** One ledger list (working, blocked, to try, todo; accepted, Next and
  History are one row each) with the cursor slice explained underneath: its whole ledger
  text and state (on the preview rule). On the list row, the mark carries the state and the ledger text is cut at a word boundary. For a slice to try with a stored brief, the list still shows its first sentence instead; the preview shows the brief and acceptance steps with the ledger text folded below them (Enter on the slice takes the keys into the preview, Enter on the fold row unfolds it; `o` opens STATE.md). In the hub's
  Progress preview, Space starts on the highlighted to-try row and moves the keys into
  the preview. Without Space marks, `y` / `n` on the hub preview act on the next row to try.
- **Control.** Roles on top (Needs attention first), with the selected role's detail and chain below. Enter focuses the chain and opens the place sheet on the next Enter. Drafts and discard confirmation stay in the preview. On a role row, `c` / `C` switch presets and `p` opens the preset list. `h` switches to Harnesses, with switch facts and next-job effects in the preview; `i` opens Add back in the preview.
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

Press `?` for shortcuts grouped by where they work. From Project or Control, Help
opens at that tab’s section; from Home, EXP or Settings it opens at Everywhere.
The Split shortcuts appear only in the Split layout. Marks are grouped by jobs,
slices, answers and places. At 80 columns and wider, Marks sit to the right of the
shortcuts. Scroll with ↑↓, PgUp/PgDn or the wheel to reach the **Backup skills**
section; Esc, `?` or Enter returns to the previous page.

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

The selected card/question expands above facts: role/harness, model/effort,
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

One master controls job/native names and sentences, Inspector decision titles,
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
| Decision title | Only for the inspected job's answered questions in Files: question and answer, 4096 bytes each; ≤8-word title plus localized fields |
| Outcome label | Final state + first 12 report lines (4096-byte head), once per settlement |
| Kind label | First two brief paragraphs (1500-byte head), once per running/job settled within one day |
| Looping label | Last 12 public tool/result pairs (600 chars each part) from the same safe tail; after 3 quiet minutes, at most once per 5 minutes, unchanged input never repeats |
| Question category | 4096-byte head of the job's current open question |
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
`«!opinion»` (and short Chinese `「…」`) share painting across cards and the Inspector;
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
**Default status line** from the same picker. EXP’s **Track native status line**
switch only records when MyHUD was last seen for each local profile; it does not
change what Codex displays.

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
