# hud-mcp

The local stdio MCP for Claude Code, Codex and pi. It records plain-file jobs and
launches roles through herdr; it does not choose a workflow or chain roles.
The main session decides what to do next. The implementation is
[`src/mcp/thin-main.ts`](../../src/mcp/thin-main.ts).

## Prerequisites and setup

- Node **≥24.0.0** (Node 24 is the tested supported line); see the
  [runtime evidence](../../docs/ARCHITECTURE.md#3-launch-and-installation).
- herdr, with the caller's `HERDR_PANE_ID` available for job creation.
- For pi roles: the pi coding-agent CLI and the separately installed **pi-roles**
  bundle (`pi-role`, `pi-role-reap` and its helper scripts). The HUD does not bundle
  pi-roles or install/authenticate pi for you.
- For browser roles: the external **`jev-ask`**, **`jev-aistudio`** or **`jev-flow`**
  CLI used by that role, with Chrome, login and keys configured through those tools.
  `jev-ask` serves ChatGPT/Gemini, `jev-aistudio` AI Studio, and `jev-flow` image/video
  jobs. The CLIs own browser operations, not the HUD. Jev/Decision API also names
  the HUD's structured decision providers; panel labels do not need a browser.

From the repository root:

```sh
./install --with claude,pi,codex
```

Select `browser,herdr` too for their prerequisite checks; those extensions install
no external tools. The installer builds the HUD and MCP together into `dist/` and registers the MCP,
the delegation skill and the hud-setup skill in the chosen clients. Keep the checkout/extraction directory:
installed commands and client bindings point into it. See
[installer extensions](../../install.d/README.md).

From the repository root, build with `npm run build` (the MCP emits to `dist/mcp/`),
then run the stdio entry with `node packages/hud-mcp/bin/hud-mcp.mjs`. `HUD_HOME` defaults to `~/.hud`.
Stdout is newline-delimited JSON-RPC; diagnostics go to stderr.

## Tools

On first dispatch (or when project context is stale), call `hud_roster` with the job's `cwd`. With valid context,
go straight to `hud_create`. Follow the caller-specific `hint` in `hud_roster` or the session's first `hud_create`
result. With live delivery, keep working until the report-ready notice, then collect with `hud_read`; the notice
itself does not read the report. Without live delivery, use `hud_wait` where available.

Claude Code sessions that negotiate the `2026-07-28` MCP tasks extension receive a task for each new
`hud_create`, single-job `hud_send` (including repairs), or `hud_respond` that resumes work. Dispatch errors,
duplicate calls that start no work, and `hud_send({jobs:[…]})` still return immediately. Claude polls the task
and notifies the session when the turn settles, asks a question, fails, or stops. A task result gives the job ID,
role, state, and a report path with a one-line summary or the question ID and text. The report remains unread;
collect it with `hud_read`. Cancel from `/tasks` to stop a still-current worker turn, like `hud_close`; repeating
cancel or cancelling a finished or superseded task does nothing. After MCP restarts, unknown tasks fail with a
`hud_read` hint; jobs are not stopped. Use `hud_read` for jobs without a task. These sessions do not get
`hud_wait`, `changes`, `watcher_alive`, or a Monitor hint.

Both `hud_read` list views use the caller's project root (the main checkout for linked worktrees).
A read by job ID can still collect a job from any project. A main-session MCP call or `hud watch` scan
adopts same-project jobs whose previous caller pane is gone, redirecting their events and questions to the new pane.

| Tool | Arguments and behaviour |
|---|---|
| `hud_roster` | Optional `cwd` (default: server cwd). Returns role availability and reasons, effective `runs_on` (including model/thinking when known), continuation, invalid role files, convention and project. `detail: true` adds the full role definitions, sources, fallbacks, presets, exhausted marks and accepted options. The server omits the unchanged convention (`convention_unchanged: true`) on later calls in the same session; roles are always refreshed. The optional `convention_version` input remains supported for older clients. |
| `hud_create` | Normally requires `role` and `task`; optional `cwd` (roles resolve against that project; default: the server's cwd), display-only `package`, `idle_grace_s` (CLI-only integer 60–3600, overrides the role for this job), `on` (harness/provider override), `kind` (`image` or `video` for `flow`), and `model`/`thinking` for a `pi` or `cli` place. Pi launch switches are below. Uses the role's first available place (`runs_on`) unless overridden by `on`. Writes a brief and job record, opens a herdr tab and returns `job`, `task_dir`, `agent`. A key is derived from the caller pane, role, cwd and task unless you pass `request_key`. Repeating an explicit key returns the original job, even if options differ; a derived key only reuses a job created within the last 10 minutes. `retry_of` instead dispatches a failed or stopped job's brief and options as a new job. Supplied fields override the originals; unless you supply `on`, retry uses the role or preset chain rather than pinning the previous harness. |
| `hud_read` | Without a `job`, defaults to `view: "compact"` (running jobs and jobs that need attention); use `view: "recent"` for the newest 20 full rows. `view` is list-only. With a `job`, optional `wait_ms` (0–120000) and `full` (boolean); returns status, any progress and unanswered questions, and the unread report (up to 64 KiB). `detail: true` includes launch details (e.g. preset, model source, CLI `idle_grace_s`, pi switches and diagnostics); it still collects the report. Already read: `report_unchanged: true`, no body (`full: true` includes it again). Waiting stops at settlement, a question or the deadline. Every returned report body stamps `read_at` (including during work/idle grace), not acceptance. Reading a settled pi or CLI report closes its worker. Reading a failure/block separately marks that attention seen. |
| `hud_wait` | Optional `jobs` (job IDs; omitted: the caller session's jobs that are unsettled when the call starts), `mode` (`any` by default, or `all`), and integer `wait_ms` (0–120000; default 60000; `0` checks once). Watches job files without blocking other calls. `any` wakes on settlement or attention; `all` waits for every target to settle but wakes early on a question, block, orchestrator wait or failure. Returns `ready`, `timed_out`, `triggered` (job IDs that met the wake condition) and compact `jobs` rows. No targets returns ready with empty lists. It does not read bodies, mark anything seen or close workers. |
| `hud_peek` | Required `job`. Returns a compact `status` row and progress, without fetching the pane. Request `lines` (integer 1–120) for recent output from the worker's `LEFT` herdr pane, or `detail: true` for launch `diagnostics`. If a requested pane is unavailable, `pane_lines` is `null` with `pane_reason`. Does not read reports, mark anything seen or close the worker. |
| `hud_send` | Pass `text` and either `job` or `jobs`. A single send queues a message for a working pi or CLI job, continues it in `idle_grace` if the role allows and its report is unread, or starts a repair if the worker closed after its report was read. A repair returns the create result plus `continued_as` (the new job ID) and references the earlier brief and report. `jobs` only sends to working jobs and returns `sent` job IDs and `skipped` entries (`{job, reason}`); it never creates repairs. An explicit `message_key` deduplicates attempts, including failed or uncertain ones; if omitted, the same job and text are treated as a retry only within 10 minutes. |
| `hud_respond` | Required `job`, `request_id` (`qN`), `answer`. Writes `qa/qN.answer.md` once; an existing answer is not overwritten. |
| `hud_close` | Required `job`. Calls `pi-role-reap` for early cleanup; safe to repeat. Normal finished-job cleanup belongs to the watcher. |

`hud_lease({name, release?, wait_s?})` is available in both main sessions (identified by their herdr pane) and workers
(identified by job ID). Use the shared resource only after `{granted:true}`. Contention returns
`{granted:false, held_by:{holder,since}}` after waiting inside the current turn (default 120 seconds, capped at 300;
`0` checks once). Use `release:true` when done: this returns `{released:true}` for the holder and `{released:false}`
for anyone else, with `held_by` if another live holder has it. The same name is independent per repository; the main checkout
and its linked worktrees share one (cwd outside Git). The next acquisition reclaims a lease when its worker is closed, failed or stopped, or its
recorded process is gone. Lease operations require util-linux `flock` on `PATH`; there is no background process or expiry.

`on` selects a harness or browser provider (`pi`, `agy`, `claude`, `codex`, `grok`, `chatgpt`, `gemini`, `argon`, `flow`) using defaults from shipped [`harnesses.json`](harnesses.json) overridden by `$HUD_HOME/harnesses.json`. Explicit `model` and `thinking` override a `pi` or `cli` place for this job only. `kind` selects `image` (default) or `video` for `flow`. `idle_grace_s` is CLI-only; pi overrides refuse because pi grace follows the model's cache lifetime inside pi-roles, and browser jobs have no idle grace. Other `hud_create` options are `pi`-only: boolean `lens`, `mcp`, `tps`, `ui_ext`, `skills`, `split`, and `pi_args`. Omitted switches keep pi-role defaults; `split` defaults to the place. `ui_ext: false` disables UI extensions; `skills: true` includes personal skills. `split: true` reserves a helper pane to the right of the primary worker. `pi_args` passes at most 128 strings of at most 4096 characters verbatim after `--`, never through a shell. `--orchestrator` and `--notify` overrides are reserved and rejected. Browser (`bro`) roles reject pi launch options. CLI places require `instructions/<instructions>.md` (shipped: `implementer.md`, `reviewer.md`, `oracle.md`), else `hud_create` returns `unsupported_harness`.

`hud_create` and `hud_sonic` start report the ordered `attempts` (`index`, `place`, and `reason` on failure) and
`used_place` (the chosen place, or `null` when none started). Only a confirmed pre-input failure falls through to
the next available place. This does not create a new job. An explicit `on` selects one place; an explicit `preset`
limits attempts to its chain.

Pass `checks` to `hud_create` for commands the main session would otherwise rerun itself (at most five nonempty
strings, each up to 4096 characters). They are stored on the job and inherited by `retry_of` and closed-job repairs.
After a declared pi or CLI settlement the watcher starts a short-lived helper; it runs the commands in order with
`bash -lc` in the job's actual `cwd` (including its managed worktree), with a ten-minute timeout per command.
It writes `checks.json` with the turn, report signature, state and each command's exit code, duration and last
2 KiB of combined output. `hud_read({job})` shows pass/fail, failure tails and whether the results are stale (the turn
or report changed). `hud watch` appends `checks 2/3` at settlement if ready, or in a follow-up notice. The watcher
waits for the helper before reaping; check results never settle, accept or fail a job and are not sent to the worker.

For `hud_create` context, pass `context_files` (up to 32 paths resolved against the job's `cwd`) or `from_jobs`
(up to 16 job IDs `j[0-9a-f]{16}`, each referring to `$HUD_HOME/jobs/<id>/report.md`), not file bodies.
Missing files, non-text files, and paths or symlinks resolving outside their respective roots return
`invalid_arguments` before launch. Pi and CLI briefs carry a `## Context References` block right after the task; the worker reads
those files directly. `job.json` records the resolved `context_files` and the `from_jobs` IDs. Browser (`bro`)
briefs instead inline the labeled file bodies and send them to the selected browser service (64 KiB per file,
256 KiB total; exceeding either returns `context_too_large`). For a registered project, local briefs reference its
optional `.hud/brief.md` after the task, and browser briefs inline its contents in the same bounded context block. Keep it safe to send to the selected browser service. Attaching a report does not
mark it read or close its worker. A repeated request key does not revalidate attachments.

`isolation: "worktree"` (default `"none"`) runs the job in a fresh linked checkout of `cwd`'s Git repository:
`<repo>-wt/<slug>-<id6>` beside the main checkout, branch `wt/<slug>-<id6>` from `cwd`'s HEAD, `node_modules` linked
from the main checkout when present, and the CLI's existing trust of the main checkout copied to it. It is refused for
browser places and outside Git with `invalid_arguments`; `job.json` records `worktree`. `hud_read(job)` then adds
`worktree` (including the checkout path) and `git_summary` (`branch`, `base_head`, `head`, `ahead_commits`, `changed_files`, `dirty`). After the job is closed and
reaped, the watcher removes the checkout and its branch only when it has no changes of any kind and its HEAD is the
base or already merged into the main checkout, without force; otherwise it keeps both and records
`worktree_kept_reason` in `job.json`.

Both list views return a newest-first `jobs` snapshot without reading report or question bodies or marking them seen.
Compact rows show `job`, `role` and `state`, plus `report_unread: true`, `blocked: true`, pending `question_ids`
and a block, wait or failure `reason` when applicable. Closed jobs with unread reports still appear; use `recent`
for history or fields such as `open_questions`. The per-session `changes` stream is independent of the snapshot.

## Worker tools

With `HUD_JOB_DIR` set, only worker tools are exposed, scoped to that job. The HUD home is inferred
from that directory, so `HUD_HOME` need not be forwarded. Claude and Codex use MCP;
pi loads the native worker extension and uses pi-roles' native ask. Antigravity and Grok Build get the
fallback `hud-ask.mjs`, `hud-sonic.mjs` and `hud-progress.mjs` commands in their briefs. For leases without MCP,
run `node packages/hud-mcp/bin/hud-lease.mjs [--dir <own job dir>] [--release] [--wait-s N] <name>` from the
HUD release, or use the script's absolute path. `--dir` defaults to `HUD_JOB_DIR`.

- `hud_report({text, turn})` on CLI, `hud_report({text})` on pi: atomically publishes `report.md` and returns its path.
  Use the turn token from the CLI prompt you are answering. No final chat marker is needed.
- `hud_ask({question, default, options?, context?})`: asks the orchestrator. Pi also accepts `mode: "async"`;
  continue only unrelated work until the native answer arrives.
- `hud_sonic({task})`: starts one sonic child without waiting for its report. Collect with
  `hud_sonic({wait: [ids], timeout_s?})`; omit the ids for all uncollected children. It returns report paths and bodies,
  still-working ids and any failures. `timeout_s: 0` checks once. Sonic cannot start sonic. Sonic starts return the
  effective `thinking` (mapped to the nearest supported level when known) and `thinking_source`.
- `hud_progress({message})` publishes a milestone. It stores one line of up to 240 characters as `{at,text}` in the
job's `progress.jsonl`, retaining the newest 50. `hud_read({ job })` and `hud_peek` return the latest 10 in
append order as `progress` and the newest entry as `latest_progress`. Ordinary reads omit these fields when empty. Milestones do not appear in
list/wait rows or trigger `changes` / `hud watch` events.
- `hud_lease({name, release?, wait_s?})` takes or releases a project-local lease as described above. Take the lease
  named in the brief before using that resource.

## Roles and convention

Bundled JSON files in `roles/` define logical roles: `role`, `instructions`, `can_continue`, optional `idle_grace_s`, and `run`, an ordered list of places (`pi`, `cli`, or `bro`). Legacy single-place role files still load (`run[0]`), and `"harness": "jev"` loads as `"bro"`. `$HUD_HOME/roles/*.json` overrides by role name. A project registered in `$HUD_HOME/projects.json` may add `<root>/.hud/roles/*.json` after those (project wins by name; pi only) and hide roles with `.hud/project.json`. An unregistered project's config is ignored (`project_config_ignored`), but its standing brief still applies. A registered project's `.hud/hud-convention.md` is the first convention file.

A `pi` place names `pi_role` (defaults to `instructions`), `split`, optional `skills` (non-empty strings), and optional `model`/`thinking`; absent model/thinking comes from the pi-roles role file. Each skill name resolves to `<root>/.hud/skills/<name>` (a symlink apply made); an absolute path is used as given. Each resolved directory is passed as `--skill` after pi-role's `--`. A missing or broken link is skipped and recorded on the job; the launch continues. When `.hud/agents/<role>.md` exists, it is passed as `--append-system-prompt`. `hud_read({job, detail:true})` and `hud_peek({job, detail:true})` show `role_skills`, `skipped_skills` and `worker_prompt` for that job. A `cli` or `bro` place that names `skills` is invalid and skipped.

A `bro` place names its `tool` (`jev-ask`, `jev-aistudio`, `jev-flow`) and applicable `provider`, `kind`, `model`, `thinking` or `effort`. Shipped browser roles: `pro` (`chatgpt`, `gemini`, `argon` in order) and `flow` (`jev-flow`, default `kind: "image"`). `hud_roster` checks executable availability on `PATH` and active `$HUD_HOME/exhausted.json` marks (quota/rate-limit failures expire at the reported reset, or after 1 hour if no reset is known).

A `cli` place sets `harness` to `cli` and names `agent` (`grok`, `agy`, `claude` or `codex`), optional `model` and `thinking` (omitted: that CLI's own default), and optional `args` (extra CLI arguments appended verbatim, never a shell string). Top-level `can_continue` and optional `idle_grace_s` (default 600) control continuation. An invalid file is skipped and listed (`invalid`: path and a short reason). It does not hide the other roles or remove an earlier valid role of the same name. Shipped local roles: `imp` (`pi` implementer), `reviewer` (`pi` reviewer -> `agy` Hydrogen high), `sonic`, and `oracle` (`cli` `claude` `fable` high -> `pi` `architect`).

Optional `presets` is an array of `{ "name": "short-token", "run": [...] }`: names are unique per file, 1–32 characters from `[A-Za-z0-9._-]`, and runs validate like the role's run. Presets merge by name from shipped, owner, then the project file in force; the more specific file wins, and omitting `presets` keeps inherited ones. On the Control plane `c`/`C` applies the next/previous preset as the owner's run, preserving other fields; project-pinned roles refuse edits. The row shows the matching name or `custom`. Imp ships `default`, `hydrogen`; reviewer `default`, `pi`; oracle `fable`, `architect` (the former role's pi setup). There is no separate shipped `architect` HUD role. `hud_create` accepts `preset` for a one-job override when the user asks.

Register your own as `$HUD_HOME/roles/<name>.json`. A file there overrides a bundled role of the same name. A front-end design role with a fallback:

```json
{
  "role": "design",
  "instructions": "implementer",
  "can_continue": true,
  "idle_grace_s": 600,
  "run": [
    { "harness": "cli", "agent": "claude", "model": "sonnet", "thinking": "high", "args": [] }
  ]
}
```

List models with `grok models`, `agy models`, `claude --help` (model aliases) or
`codex -m`. The HUD passes only the model flag, the effort flag, that CLI's
permission-bypass flag, and `args`. It never passes a home, session, config-dir,
profile or settings flag, never sets those environments, and never answers a
directory-trust dialog with trust. If one is shown, the launch declines it and
fails, naming `hud trust <cwd>`. `hud trust <dir>` adds that directory to the grok,
agy and claude trust files after a backup; codex is skipped. Dispatch never trusts.
Sessions stay in each CLI's own store; nothing is copied into the job directory. herdr
starts the CLI through the interactive shell, so shell functions in that shell
(for example one that selects a Codex account) apply as usual.

The first `hud-convention.md` found in a registered project's `.hud/`, the working
directory, HUD home, then this package replaces the convention whole. The MCP interprets neither package labels
nor a particular role's responsibilities.

## Jobs and watcher

`$HUD_HOME/jobs/<job>/` holds `job.json`, `brief.md`, `STATUS.json`, `SESSION.txt`,
`report.md` and `qa/` pairs. Pi-roles owns pi lifecycle and grace; the browser
wrapper records browser-job STATUS and saves the CLI result. A pre-start failure closes the launch tab and
uses a startup error from the pane if herdr gave only a timeout. Mutations serialize
within an MCP process; waiting reads do not block answers. A report is unread when its mtime is newer than
`read_at` (or no stamp exists). HUD readers use the on-disk report, not the worker's final chat message.

For clients without MCP tasks, MCP tool responses carry the session's `changes` since its last call (omitted when empty).
`hud watch` under a command monitor pushes less: full one-line questions, settlements/unread reports,
new blocks and new quiet-worker reasons, not working starts/resumes, question-count drops or already-reported
closure. On start it catches up pending questions, unread settled reports and unread failures/blocks.
Re-arm after expiry; `--verbose` prints all MCP change lines, `--all` watches every pane. A `report` token means
unread. Claude Code without MCP tasks can run `hud watch` under Monitor. Codex receives these quiet lines automatically through
its own queue: create/successful send starts one detached `hud watch --queue` per pane, without event stdout.
It catches up and exits when the pane is gone/no longer Codex, or after 10 minutes without unsettled jobs,
unread attention/reports or unanswered questions. The pi HUD package sends native notices that wake an idle main
session or arrive before the next model request after the current tool batch. Pane-scoped watches register
`$HUD_HOME/watchers/<pane>.pid` and remove it at exit. Other main sessions keep typed questions and can use
`hud_wait` for settlement or attention.

`hud_create` starts the on-demand `hud-watch.mjs` if needed. It reacts to job-file
and herdr tab-close events, invokes `pi-role-reap` when a pi report in idle grace
is read or after normal closure, and exits when no open job or failed-job deadline remains.
The read-close reason is `closed after report read`. Pi declares completion natively at `agent_settled`
with a report changed since `before_agent_start`. Pi's pending-message and turn-start signals are internal to
Pi; the watcher's pi-roles STATUS and herdr checks do not identify delivery of a queued `hud_send`. A prior
turn can settle before the queued prompt reaches Pi, even after HUD recorded the send time. Unread pi reports
keep the pi-roles deadline. Pi's `hud_report` captures descendants before native shutdown; pi-roles still declares
settlement. A snapshot write failure returns nonzero; a complete staged snapshot is recoverable if only the
final rename failed. If the recorded root is gone and no matching proof can be recovered, cleanup remains
unresolved and the slow retry stays armed. After a partial read-close, cleanup of captured descendants of a
confirmed-dead root does not depend on the report still qualifying.
Closing reaps the recorded worker and only descendants with captured PID/start-time ancestry; unverified
processes are left alone and noted in `watch.log`. Each signal rechecks `/proc` start time, but Node's
numeric PID kill is not atomic with that check: exit and PID reuse between the check and signal remain
possible. Snapshot or cleanup failures retry on the slow tick. Failed tabs are retained for two hours
before automatic reap. Failed file watching falls back to polling
and retries the watch. `watch.pid` and `watch.log` live under HUD home.

A CLI job has one supervisor (`hud-cli.mjs`); it only observes, and its one pure
`judge` (`src/mcp/cli-judge.ts`) decides every state. Only facts end a job: the worker's
recorded pid gone or replaced, its tab closed, or dispatch rejected before input
(`failed`, or `closed` when a new report is on disk). Dispatch and every non-duplicate
`hud_send` write `turn.json` before the prompt (internal continuations also start a new turn).
The worker's `hud_report` call (or fallback `--done --turn` command) writes a private `done.json` receipt with the prompt's turn sequence and
send time, the current report signature, and the receipt time. A matching receipt for a fresh report settles
without waiting for leftover children or herdr idle. A new turn invalidates the old receipt; a report rewrite
on a declared turn reopens it. If the turn stays quiet for the role's grace period without a fresh matching
receipt, it goes to `waiting_orchestrator` (`hud_send` to continue or `hud_close` to stop), without settling
or calling the Decision API. Terminal output does not affect receipt validity.
`idle_grace` keeps a continuable worker with an unread report; reading
the report or reaching the deadline quits and reaps it. An unread deadline close has `exit_reason` `settled`.
For a turn that never issued a receipt, a live in-turn child still defers CLI settlement, the quiet decision
and automatic close. With `advisory` trust, the ordinary no-child path requires herdr not `working` and a fresh report
stable for 10 s. A turn quiet past
the grace without a report gets one Decision API choice (see the reference); anything
unclear is `waiting_orchestrator` with a reason. Herdr's status alone never fails a live worker.
CLI `state_trust` has two levels: `advisory` keeps those timings, while `turn`, after herdr has been seen `working`
in the current turn and is now `done` or `idle`, settles a stable new report in 2 s or reaches the no-report quiet
decision after 10 s (the post-decision wait is unchanged).
Defaults are `turn` for `claude`, `codex` and `grok`, and `advisory` for `agy`; set, for example,
`{"grok":{"state_trust":"advisory"}}` in `$HUD_HOME/harnesses.json` to override one agent without replacing its other defaults.
`hud_roster({detail:true})` shows the effective level, dispatch freezes it in `job.json`, and old jobs without it use `advisory`.
The supervisor wakes on herdr pushes, file changes (including `job.json` when a report is read) and its own deadlines,
plus a 30 s tick that re-reads the status once, and writes STATUS only on change.
`agent_session_id` is that CLI's own session id, refreshed when the supervisor sees
a transition; STATUS never carries pi's `session_id`.

A synchronous `hud_ask` writes `qa/qN.md` and waits for `qa/qN.answer.md` for up to 20 minutes,
then returns the answer or the proposed default.
CLI and pi questions for an active MCP task are delivered through task completion instead of typing into the pane.
Other questions use a live pane-scoped `hud watch` first; without one, a Codex main session receives
one queued line via `codex queue --thread … --message …`, using `CODEX_HOME` from its pane's Codex process
(default `~/.codex`), never a shell function. Other agents, a missing thread id or any queue failure fall back
to typing. A queue failure reports that fallback; the queue watcher keeps running. Successful queue delivery
leaves input drafts untouched and avoids typed-input prompt hooks. Stale PIDs never suppress delivery. The watch carries the question text (first 2 KiB), options, default, full-text
path and `hud_respond` reply, so another read is unnecessary. Answer with `hud_respond`. A mid-turn `blocked` status marks the job as needing the
owner; the session learns it from `changes` or `hud watch`. `hud_close` stops a working CLI job, or quits one that is in idle grace.

While a CLI job is open, the watcher also checks that the supervisor is alive.
`HUD_WATCH_CLI_CHECK_MS` is that interval in milliseconds (default 30000). A dead
supervisor with a live worker leaves the job `waiting_orchestrator` ("supervisor exited;
worker still running"); `hud_send` to it starts a new supervisor. With the worker gone
too, the job closes with a new report or fails without one.

Settled job directories are removed **one day after closure** on a later watcher
scan (or the next create if the watcher exited); there is no dedicated expiry timer.
That removes reports and `hud_read` access too. Pi history lives in pi's default
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/<cwd-dir>/`; job `sessions/` directories
link to the primary/helper files. Before deleting a legacy pi job, the watcher moves
real JSONL session files from `sessions/` and `.dispatch/*/sessions/` into pi's
store. CLI and browser sessions stay in their own stores and are not moved. It keeps
the job if preservation fails, and never deletes session-link targets.
