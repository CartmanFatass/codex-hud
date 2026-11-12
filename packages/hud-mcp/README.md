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
no external tools. The installer builds both output trees and registers the MCP
and delegation skill in the chosen clients. Keep the checkout/extraction directory:
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
| `hud_roster` | No arguments. Returns role definitions, model/thinking assignments, accepted options and the dispatch convention with its source path. |
| `hud_create` | Required `role`, `request_key`, `task`; optional `cwd`, display-only `package` and pi launch options below. Writes a brief and job record, opens a herdr tab and returns `job`, `task_dir`, `agent`. Repeating a request key returns the original job unchanged, even if options differ; it does not relaunch an uncertain attempt. |
| `hud_read` | Optional `job`, `wait_ms` (0–120000). Without a job, lists the newest 20. With one, reads STATUS, report (up to 64 KiB) and unanswered questions; waiting stops at settlement, a question or the deadline. A settled report read stamps `read_at`; it is not acceptance. |
| `hud_send` | Required `job`, `message_key`, `text`. Queues a message while a pi job works, or continues it during `idle_grace` if its role allows. The message key deduplicates attempts, including failed/uncertain ones. Browser roles cannot continue. |
| `hud_respond` | Required `job`, `request_id` (`qN`), `answer`. Writes `qa/qN.answer.md` once; an existing answer is not overwritten. |
| `hud_close` | Required `job`. Calls `pi-role-reap` for early cleanup; safe to repeat. Normal finished-job cleanup belongs to the watcher. |

Pi-only `hud_create` options are `model`, `thinking`, boolean `lens`, `mcp`, `tps`,
`ui_ext`, `skills`, `split`, and `pi_args`. Omitted switches keep pi-role defaults;
`split` defaults to the role file. `ui_ext: false` disables UI extensions;
`skills: true` includes personal skills. `split: true` reserves a helper pane to
the right of the primary worker. `pi_args` passes at most 128 strings of at most
4096 characters verbatim after `--`, never through a shell. `--orchestrator` and
`--notify` overrides are reserved and rejected. Browser roles reject pi launch options.

## Roles and convention

Bundled JSON files in `roles/` supply defaults. `$HUD_HOME/roles/*.json` overrides
by role name. A pi definition names `pi_role`, `split`, `can_continue`, and optional
`model`/`thinking`; absent model/thinking comes from the pi-roles role file.
A browser definition names its `tool` and applicable `provider`, `kind`, `model`,
`thinking` or `effort`. `hud_roster` reports configured assignments, not proof that
an external tool is installed or logged in.

The first `hud-convention.md` found in the working directory, HUD home, then this
package replaces the convention whole. The MCP interprets neither package labels
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

Settled job directories are removed **one day after closure** on a later watcher
scan (or the next create if the watcher exited); there is no dedicated expiry timer.
That removes reports and `hud_read` access too. Pi history lives in pi's default
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/<cwd-dir>/`; job `sessions/` directories
link to the primary/helper files. Before deleting a legacy job, the watcher moves
real JSONL session files from `sessions/` and `.dispatch/*/sessions/` into pi's
store. It keeps the job if preservation fails, and never deletes session-link targets.
