# hud-mcp

The local stdio MCP for Claude Code, Codex and pi. It records plain-file jobs and
launches roles through herdr; it does not choose a workflow or chain roles.
The main session decides what to do next. The implementation is
[`src/thin-main.ts`](src/thin-main.ts).

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
no external tools. The installer builds both output trees and registers the MCP,
the delegation skill and the hud-setup skill in the chosen clients. Keep the checkout/extraction directory:
installed commands and client bindings point into it. See
[installer extensions](../../install.d/README.md).

For development, build with `npm run build:hud-mcp`; run the stdio entry with
`node packages/hud-mcp/bin/hud-mcp.mjs`. `HUD_HOME` defaults to `~/.hud`.
Stdout is newline-delimited JSON-RPC; diagnostics go to stderr.

## Six tools

Call `hud_roster` before dispatching; use the returned roles and convention rather
than assuming a role's model or workflow.

| Tool | Arguments and behaviour |
|---|---|
| `hud_roster` | Optional `cwd` (default: the server's cwd). Returns role definitions (`instructions`, ordered `run` places, merged `presets` (names and runs), `preset` (matching name or null), `runs_on`, `exhausted` marks), model/thinking assignments, accepted options, invalid role files, the dispatch convention with its source path, and `project` (`root`, `registered`). |
| `hud_create` | Required `role`, `request_key`, `task`; optional `cwd` (roles resolve against that project; default: the server's cwd), display-only `package`, `idle_grace_s` (CLI-only integer 60–3600, overrides the role for this job), `on` (harness/provider override), `kind` (`image` or `video` for `flow`), and `model`/`thinking` for a `pi` or `cli` place. Pi launch switches are below. Uses the role's first available place (`runs_on`) unless overridden by `on`. Writes a brief and job record, opens a herdr tab and returns `job`, `task_dir`, `agent`. Repeating a request key returns the original job unchanged, even if options differ; it does not relaunch an uncertain attempt. |
| `hud_read` | Optional `job`, `wait_ms` (0–120000), `full` (boolean). Without a job, lists the newest 20 with `open_questions` and `report_unread`. With one, returns STATUS, unanswered questions, effective CLI `idle_grace_s` and the unread report (up to 64 KiB); already read: `report_unchanged: true`, no body (`full: true` includes it again). Waiting stops at settlement, a question or the deadline. Every returned report body stamps `read_at` (including during work/idle grace), not acceptance; sends preserve it until a newer report appears. Reading a failure/block separately marks that attention seen. |
| `hud_send` | Required `job`, `message_key`, `text`. Queues a message while a `pi` or `cli` job works, or continues it during `idle_grace` if its role allows. The message key deduplicates attempts, including failed/uncertain ones. Browser (`bro`) roles cannot continue. |
| `hud_respond` | Required `job`, `request_id` (`qN`), `answer`. Writes `qa/qN.answer.md` once; an existing answer is not overwritten. |
| `hud_close` | Required `job`. Calls `pi-role-reap` for early cleanup; safe to repeat. Normal finished-job cleanup belongs to the watcher. |

`on` selects a harness or browser provider (`pi`, `agy`, `claude`, `codex`, `grok`, `chatgpt`, `gemini`, `argon`, `flow`) using defaults from shipped [`harnesses.json`](harnesses.json) overridden by `$HUD_HOME/harnesses.json`. Explicit `model` and `thinking` override a `pi` or `cli` place for this job only. `kind` selects `image` (default) or `video` for `flow`. `idle_grace_s` is CLI-only; pi overrides refuse because pi grace follows the model's cache lifetime inside pi-roles, and browser jobs have no idle grace. Other `hud_create` options are `pi`-only: boolean `lens`, `mcp`, `tps`, `ui_ext`, `skills`, `split`, and `pi_args`. Omitted switches keep pi-role defaults; `split` defaults to the place. `ui_ext: false` disables UI extensions; `skills: true` includes personal skills. `split: true` reserves a helper pane to the right of the primary worker. `pi_args` passes at most 128 strings of at most 4096 characters verbatim after `--`, never through a shell. `--orchestrator` and `--notify` overrides are reserved and rejected. Browser (`bro`) roles reject pi launch options. CLI places require `instructions/<instructions>.md` (shipped: `implementer.md`, `reviewer.md`, `oracle.md`), else `hud_create` returns `unsupported_harness`.

## Roles and convention

Bundled JSON files in `roles/` define logical roles: `role`, `instructions`, `can_continue`, optional `idle_grace_s`, and `run`, an ordered list of places (`pi`, `cli`, or `bro`). Legacy single-place role files still load (`run[0]`), and `"harness": "jev"` loads as `"bro"`. `$HUD_HOME/roles/*.json` overrides by role name. A project registered in `$HUD_HOME/projects.json` may add `<root>/.hud/roles/*.json` after those (project wins by name; pi only) and hide roles with `.hud/project.json`. An unregistered `.hud/` is ignored (`project_config_ignored`). A registered project's `.hud/hud-convention.md` is the first convention file.

A `pi` place names `pi_role` (defaults to `instructions`), `split`, optional `skills` (non-empty strings), and optional `model`/`thinking`; absent model/thinking comes from the pi-roles role file. Each skill name resolves to `<root>/.hud/skills/<name>` (a symlink apply made); an absolute path is used as given. Each resolved directory is passed as `--skill` after pi-role's `--`. A missing or broken link is skipped and recorded on the job; the launch continues. When `.hud/agents/<role>.md` exists, it is passed as `--append-system-prompt`. `hud_read` shows `role_skills`, `skipped_skills` and `worker_prompt` for that job. A `cli` or `bro` place that names `skills` is invalid and skipped.

A `bro` place names its `tool` (`jev-ask`, `jev-aistudio`, `jev-flow`) and applicable `provider`, `kind`, `model`, `thinking` or `effort`. Shipped browser roles: `pro` (`chatgpt`, `gemini`, `argon` in order) and `flow` (`jev-flow`, default `kind: "image"`). `hud_roster` checks executable availability on `PATH` and active `$HUD_HOME/exhausted.json` marks (1 hour TTL on quota/rate-limit failure; HUD does not auto-retry, and failure reasons name the next available place).

A `cli` place sets `harness` to `cli` and names `agent` (`grok`, `agy`, `claude` or `codex`), optional `model` and `thinking` (omitted: that CLI's own default), and optional `args` (extra CLI arguments appended verbatim, never a shell string). Top-level `can_continue` and optional `idle_grace_s` (default 600) control continuation. An invalid file is skipped and listed (`invalid`: path and a short reason). It does not hide the other roles or remove an earlier valid role of the same name. Shipped local roles: `imp` (`pi` implementer -> `pi` Grok 4.7), `reviewer` (`pi` reviewer -> `agy` Hydrogen high), `sonic`, and `oracle` (`cli` `claude` `fable` high -> `pi` `architect`).

Optional `presets` is an array of `{ "name": "short-token", "run": [...] }`: names are unique per file, 1–32 characters from `[A-Za-z0-9._-]`, and runs validate like the role's run. Presets merge by name from shipped, owner, then the project file in force; the more specific file wins, and omitting `presets` keeps inherited ones. On the Control plane `c`/`C` applies the next/previous preset as the owner's run, preserving other fields; project-pinned roles refuse edits. The row shows the matching name or `custom`. Imp ships `default`, `grok` (high), `hydrogen`; reviewer `default`, `pi`; oracle `fable`, `architect` (the former role's pi setup). There is no separate `architect` HUD role or `hud_create` preset parameter.

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
wrapper records browser-job STATUS and saves the CLI result. Mutations serialize
within an MCP process; waiting reads do not block answers. A report is unread when its mtime is newer than
`read_at` (or no stamp exists). CLI/pi briefs tell workers to write the file and end with only
`report written: <path>`; HUD readers use the file, not that final chat line.

Every MCP response carries the session's `changes` since its last call (omitted when empty).
`hud watch` under a command monitor pushes less: full one-line questions, settlements/unread reports,
new blocks and new quiet-worker reasons, not working starts/resumes, question-count drops or already-reported
closure. On start it catches up pending questions, unread settled reports and unread failures/blocks.
Re-arm after expiry; `--verbose` prints all MCP change lines, `--all` watches every pane. A `report` token means
unread. Claude Code runs `hud watch` under Monitor. Codex receives these quiet lines automatically through
its own queue: create/successful send starts one detached `hud watch --queue` per pane, without event stdout.
It catches up and exits when the pane is gone/no longer Codex, or after 10 minutes without unsettled jobs,
unread attention/reports or unanswered questions. Pane-scoped watches register `$HUD_HOME/watchers/<pane>.pid`
and remove it at exit. Other main sessions keep typed questions and `hud_read` with `wait_ms`.

`hud_create` starts the on-demand `hud-watch.mjs` if needed. It reacts to job-file
and herdr tab-close events, invokes `pi-role-reap` after settlement/grace, and
exits when no open job or failed-job deadline remains. Failed tabs are retained
for two hours before automatic reap. Failed file watching falls back to polling
and retries the watch. `watch.pid` and `watch.log` live under HUD home.

A CLI job has one supervisor (`hud-cli.mjs`); it only observes, and its one pure
`judge` (`src/cli-judge.ts`) decides every state. Only facts end a job: the worker's
recorded pid gone or replaced, its tab closed, or dispatch rejected before input
(`failed`, or `closed` when a new report is on disk). Dispatch and every non-duplicate
`hud_send` write `turn.json` before the prompt. With `advisory` trust, a report that differs from the turn's
baseline settles the turn once herdr is not `working` and the report has been stable
for 10 s: `idle_grace` when the role can continue, otherwise `/quit` and closed.
Unused grace sends `/quit` when no child process newer than the turn is alive, and
closes with `exit_reason` `settled`; the watcher then reaps the tab. A turn quiet past
the grace without a report gets one Decision API choice (see the reference); anything
unclear is `waiting_orchestrator` with a reason. Herdr's status alone never fails a live worker.
CLI `state_trust` has two levels: `advisory` keeps those timings, while `turn`, after herdr has been seen `working`
in the current turn and is now `done` or `idle`, settles a stable new report in 2 s or reaches the no-report quiet
decision after 10 s (the post-decision wait is unchanged).
Defaults are `turn` for `claude`, `codex` and `grok`, and `advisory` for `agy`; set, for example,
`{"grok":{"state_trust":"advisory"}}` in `$HUD_HOME/harnesses.json` to override one agent without replacing its other defaults.
`hud_roster` shows the effective level, dispatch freezes it in `job.json`, and old jobs without it use `advisory`.
The supervisor wakes on herdr pushes, file changes and its own deadlines,
plus a 30 s tick that re-reads the status once, and writes STATUS only on change.
`agent_session_id` is that CLI's own session id, refreshed when the supervisor sees
a transition; STATUS never carries pi's `session_id`.

The worker asks with `hud-ask` (the brief names it by absolute path). That writes
`qa/qN.md` and blocks until `qa/qN.answer.md` or 20 minutes, then prints the answer or the default.
CLI and pi questions use a live pane-scoped `hud watch` first; without one, a Codex main session receives
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
