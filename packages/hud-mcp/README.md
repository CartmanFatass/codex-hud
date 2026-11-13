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
| `hud_roster` | Optional `cwd` (default: the server's cwd). Returns role definitions, model/thinking assignments, accepted options, invalid role files, the dispatch convention with its source path, and `project` (`root`, `registered`). |
| `hud_create` | Required `role`, `request_key`, `task`; optional `cwd` (roles resolve against that project; default: the server's cwd), display-only `package`, and `model`/`thinking` for a pi or CLI role. Pi launch switches are below. Writes a brief and job record, opens a herdr tab and returns `job`, `task_dir`, `agent`. Repeating a request key returns the original job unchanged, even if options differ; it does not relaunch an uncertain attempt. |
| `hud_read` | Optional `job`, `wait_ms` (0–120000). Without a job, lists the newest 20. With one, reads STATUS, report (up to 64 KiB) and unanswered questions; waiting stops at settlement, a question or the deadline. A settled report read stamps `read_at`; it is not acceptance. |
| `hud_send` | Required `job`, `message_key`, `text`. Queues a message while a pi or CLI job works, or continues it during `idle_grace` if its role allows. The message key deduplicates attempts, including failed/uncertain ones. Browser roles cannot continue. |
| `hud_respond` | Required `job`, `request_id` (`qN`), `answer`. Writes `qa/qN.answer.md` once; an existing answer is not overwritten. |
| `hud_close` | Required `job`. Calls `pi-role-reap` for early cleanup; safe to repeat. Normal finished-job cleanup belongs to the watcher. |

`model` and `thinking` override a pi or CLI role for this job only. Other
`hud_create` options are pi-only: boolean `lens`, `mcp`, `tps`, `ui_ext`,
`skills`, `split`, and `pi_args`. Omitted switches keep pi-role defaults;
`split` defaults to the role file. `ui_ext: false` disables UI extensions;
`skills: true` includes personal skills. `split: true` reserves a helper pane to
the right of the primary worker. `pi_args` passes at most 128 strings of at most
4096 characters verbatim after `--`, never through a shell. `--orchestrator` and
`--notify` overrides are reserved and rejected. Browser roles reject pi launch
options. CLI roles accept only `model` and `thinking`.

## Roles and convention

Bundled JSON files in `roles/` supply defaults. `$HUD_HOME/roles/*.json` overrides
by role name. A project registered in `$HUD_HOME/projects.json` may add
`<root>/.hud/roles/*.json` after those (project wins by name; pi only) and hide
roles with `.hud/project.json`. An unregistered `.hud/` is ignored
(`project_config_ignored`). A registered project's `.hud/hud-convention.md` is
the first convention file. A pi definition names `pi_role`, `split`,
`can_continue`, optional `skills` (non-empty strings), and optional
`model`/`thinking`; absent model/thinking comes from the pi-roles role file.
Each skill name resolves to `<root>/.hud/skills/<name>` (a symlink apply made);
an absolute path is used as given. Each resolved directory is passed as `--skill`
after pi-role's `--`. A missing or broken link is skipped and recorded on the job;
the launch continues. When `.hud/agents/<role>.md` exists, it is passed as
`--append-system-prompt`. `hud_read` shows `role_skills`, `skipped_skills` and
`worker_prompt` for that job. A CLI or browser role file that names `skills` is
invalid and skipped.

A browser definition names its `tool` and applicable `provider`, `kind`, `model`,
`thinking` or `effort`. `hud_roster` reports configured assignments, not proof that
an external tool is installed or logged in.

A CLI definition sets `harness` to `cli` and names `agent` (`grok`, `agy`, `claude`
or `codex`), required `can_continue`, optional `model` and `thinking` (omitted: that
CLI's own default), optional `idle_grace_s` (default 600) and optional `args`
(extra CLI arguments appended verbatim, never a shell string). An invalid file is
skipped and listed (`invalid`: path and a short reason). It does not hide the other
roles or remove an earlier valid role of the same name. Shipped roles, all able to
continue, grace 600 seconds:

| Role | Agent | Model | Thinking |
|---|---|---|---|
| `grok-imp` | grok (Grok Build) | grok-4.7 | high |
| `agy-imp` | agy (Antigravity) | gemini-4-argon-high | CLI default |
| `claude-imp` | claude (Claude Code) | opus | high |
| `codex-imp` | codex (Codex CLI) | gpt-6.1-sol | high |

Register your own as `$HUD_HOME/roles/<name>.json`. A file there overrides a bundled
role of the same name. A front-end design role on a Claude model:

```json
{
  "role": "design",
  "harness": "cli",
  "agent": "claude",
  "model": "sonnet",
  "thinking": "high",
  "can_continue": true,
  "idle_grace_s": 600,
  "args": []
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
within an MCP process; waiting reads do not block answers.

`hud_create` starts the on-demand `hud-watch.mjs` if needed. It reacts to job-file
and herdr tab-close events, invokes `pi-role-reap` after settlement/grace, and
exits when no open job or failed-job deadline remains. Failed tabs are retained
for two hours before automatic reap. Failed file watching falls back to polling
and retries the watch. `watch.pid` and `watch.log` live under HUD home.

A CLI job has one supervisor (`hud-cli.mjs`). After the brief is submitted the
state is `working`. A following `done` with a changed, non-empty `report.md` enters
`idle_grace` when the role can continue; otherwise the supervisor sends `/quit` and
closes. A missing, empty or unchanged report fails the job. During grace, `hud_send`
continues a role that can continue; the next turn is judged against the report as it
was when that turn started. Unused grace sends `/quit`, waits until the agent has
left, and closes with `exit_reason` `settled`. The watcher then reaps the tab.
Herdr `idle` or `unknown` counts as an exit only when the agent is gone.
`agent_session_id` is that CLI's own session id, refreshed when the supervisor sees
a transition; STATUS never carries pi's `session_id`.

The worker asks with `hud-ask` (the brief names it by absolute path). That writes
`qa/qN.md`, pushes one `[tag] QUESTION qN: …` line to the orchestrator pane, and
blocks until `qa/qN.answer.md` or 20 minutes, then prints the answer or the default.
Answer with `hud_respond`. A mid-turn `blocked` status marks the job as needing the
owner and sends one `[tag] BLOCKED: <agent> is waiting for interactive input in pane
<pane>` line. `hud_close` stops a working CLI job, or quits one that is in idle grace.

While a CLI job is open, the watcher also checks that the supervisor is alive.
`HUD_WATCH_CLI_CHECK_MS` is that interval in milliseconds (default 30000). A dead
supervisor fails the job (`supervisor exited`) on the next check.

Settled job directories are removed **one day after closure** on a later watcher
scan (or the next create if the watcher exited); there is no dedicated expiry timer.
That removes reports and `hud_read` access too. Pi history lives in pi's default
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/<cwd-dir>/`; job `sessions/` directories
link to the primary/helper files. Before deleting a legacy pi job, the watcher moves
real JSONL session files from `sessions/` and `.dispatch/*/sessions/` into pi's
store. CLI and browser sessions stay in their own stores and are not moved. It keeps
the job if preservation fails, and never deletes session-link targets.
