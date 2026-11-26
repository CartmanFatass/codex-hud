# HUD reference

Current controls for Claude Code, Codex and pi.
[中文](./reference.zh.md) · [Quick start](../README.md) · [Architecture](./ARCHITECTURE.md)

- [Installing](#installing)
- [Universal CLI and MCP](#universal-cli-and-mcp)
- [Claude Code mod](#claude-code-mod)
- [Project workers](#project-workers)
- [Home](#home)
- [Project](#project)
- [The panel](#the-panel): [Keys](#keys), [Inspector](#inspector), [Settings](#settings)
- [Execution decisions](#execution-decisions)
- [The bottom bars](#the-bottom-bars)
- [Machine-readable state](#machine-readable-state)
- [Configuration](#configuration)

Earlier activation, bootstrap and owned-worker designs live in git history and [dated reviews](https://github.com/CartmanFatass/codex-hud/tree/universal-hud/docs/reviews), not in the current setup instructions.

## Installing

Use **Node ≥24.0.0** (Node 24 is the tested supported line; see [runtime evidence](./ARCHITECTURE.md#3-launch-and-installation)).
From the checkout:

```sh
./install --with claude,pi,codex,browser,herdr
```

Choose any of **claude**, **claude-mod**, **pi**, **codex**, **agy**, **browser**, **herdr**; core is always included.
The installer checks Node before extension hooks/builds/changes, builds the HUD and MCP, and links commands into `~/.local/bin`.
A bare `./install` refreshes remembered extensions using the current client home settings.
For an install made with an older installer, specify its extensions with `--with` once.
The installer refreshes dependencies when it has no matching lockfile hash; `--skip-build` skips both dependency installation and the build.
Keep the checkout/extraction directory: installed commands and client bindings point into it.
No shell rc file is edited.

External tools are checked, not installed or authenticated.
Pi workers require `pi` on PATH; tab workers also require `herdr`. Core installs the worker extension under `$HUD_HOME/pi-worker/`, separate from interactive pi. No external role bundle is needed.
The herdr extension reports the PATH locations of `herdr` and `pi` (only missing herdr fails).
The browser extension requires `google-chrome` and `jev-ask`; it also reports optional `jev-aistudio` and `jev-flow`.
It writes no browser configuration and launches nothing.
Configure Chrome/login/keys through those external CLIs.
The panel and Decision API need no browser extension.

Ordinary `claude` uses the global HUD statusline unless an owner-defined non-HUD statusline already exists; ordinary `pi` loads the HUD footer.
Codex's pane-strip bar uses the installer's printed shell function (requires the `herdr-hud` fork with `pane_strip` support; no tmux):

```sh
codexH() { hud codex "$@"; }
codexH
```

The panel is opt-in: `/hud` toggles the same right-edge herdr dock in Claude, Codex and pi; it never opens at launch.
Uninstall with `hud uninstall` or `./install --uninstall`; `--with names` removes only those extensions, leaving core commands intact.
HUD data and unrelated owner settings remain.
Claude settings follow symlinks with a one-time plain backup; Codex backs up resolved `config.toml` before official MCP commands and warns if comments are dropped.
Pi registers delegation and display packages and excludes the old p10k-footer.

For Antigravity, put `agy` on `PATH`, then run `./install --with agy`.
It registers the HUD MCP, permission and hook, and leaves an existing non-HUD statusline alone.
It writes the main-session MCP instructions to `~/.gemini/antigravity-cli/mcp/hud/instructions.md` without replacing owner instructions.
Remove the integration with `./install --uninstall --with agy`.

See [installer extensions](../install.d/README.md) for backups and multiple Codex homes.

## Universal CLI and MCP

```sh
hud --help
hud --version             # print the version, build commit and build time
hud panel --help
hud panel                 # toggle the shared herdr dock; outside herdr, run here
hud panel --here          # run in this terminal without touching the dock
hud panel --width 64      # override the width if this toggle opens the dock
hud panel status          # report whether the shared dock is open
hud statusline --help
hud import --help
hud trust <dir>           # add the directory to grok, agy and claude trust lists
hud watch                 # pending questions and actionable events (--verbose: every change; --all: every pane)
hud act answer <job> <qN> <answer...>  # the owner's panel actions from a command: answer once, resuming a headless job
hud act try [--cwd DIR]   # Accept all pending tries, recorded in tries.jsonl; hud act retry|stop <job>
hud act stop --queued <job>...  # Cancel queued jobs by ID; never stop running workers
hud act stop --package LABEL --queued  # Only this caller pane's jobs in the current project
hud act stop|pause|resume <batch>  # the owner's control of a whole fixed batch, from any directory
hud doctor                # run the read-only local install preflight
hud doctor <jobId>        # print one job's local facts without changing it
hud stats [--days N] [--by role|model|route|feature]  # per-job usage and outcomes
hud day [--project]        # today's landings, worker outcomes, and flaky gates
hud setup --detect        # print this project's worker setup as JSON
hud setup --apply PLAN    # write .hud/ from a plan
hud setup --remove        # drop project registration; leave .hud/
hud tickets sync [--cwd DIR]  # mirror GitHub parent/sub-issues into .scratch/
hud board [--cwd DIR] [--out FILE] [--open]  # write the project's HTML review board, print its path
hud codex --model gpt-5    # Codex arguments pass through; bar runs on the herdr pane strip
```

`hud codex-hud` aliases `hud codex`.
Panel selection accepts `--root <namespace/session-id>` or `--harness claude|pi|codex --session ID --source ABS`; these select observations, not execution identity.
Without explicit selection, `HERDR_PANE_ID` permits a one-second `herdr pane current` lookup for the caller's Claude transcript or Codex session (`CODEX_THREAD_ID` fallback inside a herdr pane); no focused-pane guess or statusline-written binding is used.
Unavailable evidence leaves the jobs view unbound to a native session.

`hud doctor` checks Node, the local herdr fork (`herdr-hud`, confirmed by the running server's ping version and `agy_background_work` capability), the pi commands on PATH, installed dependency versions, client HUD bindings (resolved checkout and Node), registered project trust, the dist build stamp and live MCP/watcher generations, leases, and managed worktrees without owning job receipts.
It only checks the mode of `credentials.env` (0600 if present); it never opens the file.
Each failed check has one fix hint and any failure makes the exit status non-zero.
A service that starts on demand need not be running, but an older live process that does not report its generation cannot be verified.
The command does not apply any fixes.

`hud doctor <jobId>` reads one directory under `$HUD_HOME/jobs`.
It shows identity, the shared job state, raw `STATUS.json`, open questions, checks, last progress, stop/close markers and recorded process liveness when applicable.
For CLI workers it compares the turn, completion receipt and current report signature; it does not print the report body.
Missing or unreadable evidence is labeled.
The command changes nothing and does not contact herdr or the network.

`hud stats` is a read-only scoreboard for jobs created in the last seven local calendar days, including today (`--days` accepts 1–90).
The default groups by role, place and mode; `--by` can group by role, model, route tier/mode or ticket feature.
It shows median dispatch-to-settlement time, question and sonic counts, land repairs, and harness-reported tokens and USD.
`hud day` lists today's landings and workers' declared one-line summaries, failures and stops, gate tests that passed on immediate rerun, and today's worker time and cost by role.
`--project` scopes the digest to the current checkout's project, including from a linked worktree.
The commands merge retained jobs, monthly archives and land receipts, without double-counting a job; known/observed counts and scan limits are shown.
Missing cost is unknown, not free: sums include only jobs with reported totals, and harness-reported USD is not necessarily a bill.

The MCP exposes **hud_roster**, **hud_create**, **hud_read**, **hud_wait**, **hud_peek**, **hud_send**, **hud_respond**, **hud_close**, **hud_land**, **hud_workflow**, **hud_lease**, **hud_objective**, **hud_schedule**, and **hud_tickets**.
Call `hud_roster` when project dispatch context is missing or stale.
It returns role availability, continuation, effective `runs_on` and the convention.
For presets, fallbacks, model/thinking sources and accepted options, pass `detail: true`.
The MCP omits an unchanged convention on subsequent roster calls in the same session; role rows are always refreshed.
Bundled role JSON is overridden by `$HUD_HOME/roles/*.json` by role name, then by a registered project's `.hud/roles`.
The first `hud-convention.md` in a registered project's `.hud/`, the cwd, HUD home, then the package wins whole.
See [Project workers](#project-workers).

Use `hud_schedule` in a main session for private owner dates across projects. An item records **when** something happens; a `hud_objective` request records that someone is **waiting** for the owner. Passing a date never creates a request or closes the item.
- `add`: `date` (`YYYY-MM-DD` or `YYYY-MM`) and one line of `text` (at most 160 characters, in the panel language). Optionally link a registered `project` directory and an existing `objective` in it. If the project is later unregistered, the item stays on the schedule without its link. The response includes the item ID.
- `move`: `id` and a new `date`. `done`: `id` to close the item; an optional `note` is not saved.
- `list`: open items sorted by due date, with `stage`, a `due` flag, and a signed `days_until_due` countdown. Stages use the local calendar: `overdue` after the due date, `today` on it, `soon` in the preceding seven days, and `far` earlier. A month item is due on the month's last day and is `soon` during that month before then. `due: true` lists only `today` and `overdue` items.

The MCP writes `$HUD_HOME/schedule.json` atomically at mode `0600`, without project receipts or commits. It allows at most 200 open items, subject to the 64 KiB file limit. A write prunes items that have been done for at least 30 days.

Main-session tool results use compact `key: value` text in every client.
Nested rows stay JSON, and status events appear in a trailing `changes:` list.
The formatter omits empty/default or repeated fields and shows at most five `changed_files` paths alongside the total; full reads still include the worker's `report_meta.files` and any paging fields.
Errors stay JSON.
Set `HUD_MCP_JSON=1` in the MCP server environment for JSON result fields in tests.
The JSON-RPC envelope, task protocol and worker tools are unchanged.

Without [mod-owned wake](#claude-code-mod), Claude Code sessions that negotiate MCP tasks see a task under `/tasks` for a new `hud_create`, single-job `hud_send` (including a repair), or `hud_respond` that resumes work.
Claude Code wakes on a settled report, question, failure or stop without Monitor.
A report notice gives the job ID, role, state, the `hud_read` call and a one-line summary (the worker's summary or, failing that, report prose).
If the job has HUD-run checks, the notice waits for them and includes the number passed.
Questions do not wait: their notices give the question ID and text.
MCP delivers one result per task; only the client can combine those notices into a single wake.
The notice does not mark a report read; collect it with `hud_read({job})`.
Launch details remain in `hud_read({job, detail:true})`.
A successful fan-out send keeps the job’s existing active task instead of starting a new one.
The same caller can poll existing worker and land tasks after an MCP restart until their task TTL expires.
Cancelling a still-current task on its original connection stops the worker like `hud_close`; repeating cancel, cancelling an old task or cancelling from a fresh connection does nothing.
To start several unrelated jobs with individual MCP tasks, send one `hud_create` per job in parallel. The fixed `items` flow below instead returns one batch ID (also in a task session).
`hud_create({jobs})` returns an error without creating any jobs.
Dispatch failures, duplicates and fan-out sends return immediately.
Batch `hud_send({messages})` and `hud_respond({answers})` still return per-item results in input order.
For each new turn started by one of those batches, the live MCP connection delivers the same compact notice (waiting for checks on report, immediate on question, failure or stop) once to the caller pane (or in `changes` if delivery fails), and falls back to normal `hud-notify`/`changes` delivery if the connection ends first.
Use `hud_read` for jobs without a task or whose task has expired.
Task clients do not get `hud_wait`, `changes` (beyond panel and undelivered batch notices), `watcher_alive`, or the `hud watch` delivery hint.

For other clients, MCP tool responses carry `changes`: one line per state change of the jobs this pane dispatched since the last response (omitted when there is none).
Panel, statusline, pi footer, MCP and `hud watch` derive a job's state through one shared `jobRow`, so they agree.
`hud watch` defaults to actionable events: new questions (with text, options, default and `hud_respond` reply), settlements and unread reports, failures, stalls, stops, failed checks, blocks and new quiet-worker reasons. It also delivers land results and owner decisions.
Routine `still working` checkpoints and individual queue positions do not wake the caller. Check the panel, `hud_peek` or `hud_read` for progress; `hud_create` returns a queued job's position.
Quiet watch also skips working starts/resumes, answered questions and already-reported closure; `--verbose` keeps all MCP change lines and Sonic checkpoints.
Both `hud watch` and `changes` append a current worker summary, clipped to 140 characters.
Unread report notices point to `hud_read job=<id>` (`mode: "full"` for the whole report), not to a file.
The watch groups settlements arriving within three seconds into one notice; questions are delivered immediately.
Once three ordinary top-level jobs with the same package are running or queued, quiet watch treats them as a batch until the last member settles.
It summarizes batch settlements at most once every five minutes and sends a final tally with a hint to list unread reports.
Failures (including failed checks), stalls and requests for input still arrive individually. A rollup does not mark reports read.
Batch tracking belongs to the watch: after a restart, the three-live-job threshold is evaluated against its current snapshot.
On start the watch catches up pending questions, unread settled reports and unread failures/blocks.
It scopes to `HERDR_PANE_ID` (`--all`: every pane), reading nothing at rest beyond a 30 s rescan.
Claude Code without tasks or mod-owned wake runs it under Monitor; re-arm after expiry.
Codex receives the same quiet events automatically through `codex queue`: create/send starts a detached `hud watch --queue`, with catch-up and no event lines on stdout.
The watcher exits when the pane disappears or changes agent, or after 10 minutes with no unsettled job, unread attention/report or unanswered question.
Antigravity uses the same detached watcher: events reach a working session through its `PreInvocation` hook and are typed into the prompt when idle.
The pi HUD package delivers actionable notices natively, waking an idle main session or delivering before the next model request after the current tool batch, without touching the editor draft.
No Monitor or panel is needed; pi workers do not start this watch.
A pane-scoped watch records `$HUD_HOME/watchers/<pane>.pid` while active.
`hud_roster` and `hud_create` report `watcher_alive` when the caller has a pane; a live watch suppresses direct pushes.
`hud_roster` and the first `hud_create` result in a session give a delivery hint for the caller's harness (or general guidance when the harness is unknown).
Without an active MCP task or live watch, CLI and pi worker questions go directly to the Codex thread queue; other main sessions receive typed questions and can use `hud_wait` for settlement.
Queue delivery uses the pane's Codex process `CODEX_HOME` (default `~/.codex`), not the MCP account.
A missing thread id or a queue failure falls back to typing. When herdr advertises guarded prompts, typed notices require an idle agent, an empty prompt, the pane at the bottom of scrollback and a brief pause in keyboard input.
A refusal writes nothing; the existing sender can retry without rerunning the Codex queue.
Standalone `hud-ask` and `hud-notify` do not start a retry process, so a refused notice remains available through HUD reads.
Older herdr servers that do not advertise the guard still use legacy typing, which can touch a draft or fire prompt hooks.
Stale PIDs never suppress delivery.
MCP `changes` stays the fuller, query-only stream; a `report` token always means unread.
With live events, keep working until notified instead of polling or waiting.
A report-ready notice leaves the report unread; collect it explicitly.

**Fixed batches.** `hud_create({role:"sonic", items:[{brief_file:"briefs/a.md"},{task:"Label the second file",package:"labels"}], max_parallel:4})` returns a batch flow ID and its scale before the main run. Supply 1–512 independent items, each with exactly one `task` or `brief_file`. Shared `cwd`, `package`, `context_files`, `mode`, `isolation`, `scouts`, `prewalk`, `checks`, `experiment` and `arm` apply to every member. An item’s package overrides the shared label. A `request_key` deduplicates submission. Imp and frontend-imp default to a separate managed worktree for each item; specify `isolation:"worktree"` for code changes by other roles.

The scale lists the item count, role, selected presets (`null`: the configured run without a named preset), role cap, effective `max_parallel`, and maximum, median and total estimated input bytes. HUD counts the UTF-8 brief, explicit context files and existing literal project file paths it recognizes in the brief (once per file per item, relative to `cwd`, not glob/recursive inputs or explicit output paths). Use `context_files` for inputs not named literally. The private manifest records the brief text, paths and size calculation. HUD runs the largest item assigned to each preset as a pilot, pinning each member to its planned preset; a refused placement never switches to an unpiloted preset. The remaining briefs stay in manifest order until every pilot has settled with a report. No coordinator model is launched. Ordinary jobs have priority over manifest waiters, and across batches at most the role cap minus two members run. A cap of 1–2 leaves no batch slots; zero is uncapped, so set `max_parallel` to bound the run.

Read `hud_read({job:flow})` for totals, failure groups, and the result index: each item’s job ID, state, report path, reported files and failure reason. This does not collect the individual reports. Watch delivers questions, not per-member starts, queue positions, checkpoints or settlements. The first failure of each reason is announced; repeats are folded. A failed/stalled pilot, two consecutive failures, or at least two failures making up 20% of settlements pauses admission. A breaker notice groups reasons with counts and examples. Already running jobs finish; further failures while paused update the index silently. Completion delivers one totals line and a hint for listing unread reports.

The batch runs independently of the main session that started it. Closing that pane or its MCP does not cancel the run. A main session in the same project can read the batch ID or control it; undelivered notices wait on the run for the next project reader.

`hud_create({batch:flow,action:"pause"|"resume"|"stop"|"retry_failed"})` acts on the whole batch. Pause keeps waiters; stop cancels them without touching admitted jobs. Resume acknowledges failed pilots and continues in order. Retry-failed runs all currently failed items again as new jobs with the snapshotted briefs and placements, keeping their previous job IDs/reasons in the same index. Failed pilots run again before the remainder. Resume and retry reset the breaker window. Inactive batch receipts and their state directories follow the job retention window.

The owner pauses, resumes or stops a whole batch with the same control, never one confirmation per job: `X` on its row in the panel's [Jobs](#home) page, or `hud act stop|pause|resume <batch>` from any directory. The command runs at once, with no prompt, and prints the new state and totals; after a stop with members still running it names their jobs (`hud act stop <job>` stops one). It exits 1 and changes nothing when the batch's state does not take the action (pause needs a working batch, resume a paused one, stop one that has not completed). Retry-failed stays with the main session. Jobs created one by one are not a batch: `hud act stop --package LABEL --queued` cancels their queued ones.

`hud_create` takes `role`, `task` (or `brief_file`: a readable UTF-8 path within `cwd`, up to 256 KiB, mutually exclusive with `task`), optional `cwd` and display-only `package`, and optional `ticket` (`feature/NN`) to link progress.
`slice` is a legacy target label.
Pass `preview` to name an HTML file (`.html` or `.htm`, up to 16 MiB) the job will write at a path relative to its working directory.
Optional `experiment` and `arm` tags (up to 64 characters each) are stored in job and archive records, inherited by retries and repairs, and never shown in the panel.
In sessions without MCP tasks, pass `jobs: [...]` instead of single-create fields to dispatch several jobs in one call; each item accepts the same fields as a single create, returns its result in input order, and one item's error does not block the others (each created job keeps its own notice).
The optional `request_key` defaults to a hash of the caller pane, role, cwd and task.
By default it dispatches on the role's first available place (`runs_on`).
`hud_create({retry_of: job})` starts a new job using a failed or stopped job's brief and options; explicit fields can override them, subject to the same rules as a new create.
A `general` retry keeps the original `on` only if the job also pinned `model` and the retry does not pass `on`, `preset`, or `model`.
Otherwise, unless the retry supplies `on`, it selects an available place through the role or preset chain.

When prewalk is enabled for a role (owner role `"prewalk": "on"|"off"`, shipped defaults: `imp`, `oracle`, `frontend-imp` on; `reviewer`, `sonic` off; global **Settings → Models → Auto prewalk**, `autoPrewalk`, default on), HUD runs prewalk before starting the target:
- **Scouts**: the dispatching session must pass `scouts: [{kind: "code"|"docs"|"web", ask: string}]` (0–3 items; the same kind may repeat; `[]` starts the target directly with no scouts; omitting `scouts` returns an immediate `invalid_arguments` error unless `prewalk: false`). Roles with prewalk off (or when `autoPrewalk` is off) also accept `scouts` on explicit request; non-empty `scouts` is rejected for `sonic` or alongside `prewalk: false`. Each scout starts a parallel headless `sonic` job with its kind prompt (`code`: checkout-only files/symbols/commands/tests with `path:line`; `docs`: checkout-only project spec/design docs/tickets/decisions with `path:line`; `web`: primary external docs/specs/repos/release notes with URLs, public-only queries), the caller's `ask` as the question, and the bounded target brief (≤16,000 chars) as context. No Decision API call is made for scouts.
- **Pick**: when the owner role declares a `pool`, HUD picks pool entries (or project design) unless `prewalk: "off"`, `prewalk: false`, `autoPrewalk` is off or `poolPick` is off.

`hud_create` returns the target job ID or one MCP task immediately when scouts run; HUD waits until every scout settles (each bounded only by sonic's own `max_s`, stall and looping limits), reserves one of the 16 `from_jobs` slots per scout, attaches arrived reports via `from_jobs`, and leaves a failure note in the target brief for any failed scout without blocking the target. There is no separate scout notice, and nothing chains after the target. Passing `prewalk: false` skips prewalk (scouts and pool pick) for that job. The `hud_create` receipt, `job.json` and archive record `prewalk: [{kind, source, ask?, job?, result, ms, ...}]` with `source: "caller"` and `ask` truncated to 200 characters for scouts (old records without `ask` or with `decision`/`default` stay readable). A browser target receives attached reports and pool files subject to the usual context byte limits.
An MCP disconnect does not cancel an accepted scouted dispatch; the watcher can resume it. An explicit job stop still cancels it before the target launches.

Pass `checks` for up to five shell commands you would otherwise run yourself in the job's `cwd`.
The HUD runs them in order with `bash -lc` after a declared pi or CLI settlement, with a ten-minute timeout per command.
Retries and closed-job repairs inherit them.
`hud_read({job})` shows check outcomes; `mode: "full"` includes the bounded failure tail; a new turn or rewritten report marks the previous results stale.
`hud watch` includes available results (e.g. `checks 2/3`) on settlement. A later failing result wakes the caller immediately; a passing result alone does not.
The Inspector show the same count of passed/total checks (`✓` pass, `✗` fail, `↻` running, `~` stale).
Checks do not settle jobs or decide acceptance.

Role files and Control decide where each role runs.
Only `general` accepts `preset`, `on`, `model` or `thinking`, for one job when the user requests it.
For `general`, `preset` selects the first available, non-exhausted place in a named preset without saving it.
Alternatively, `on` overrides the harness/provider (defaults from shipped `harnesses.json` overridden by `$HUD_HOME/harnesses.json`).
`preset` and `on` are mutually exclusive.
`model` and `thinking` override the selected `pi` or `cli` place.
Other roles reject these four fields before launch, including in batch items and retry overrides.
A detailed job read or peek shows the selected `preset`.
Only `general` can also set `instructions: "imp"` (or another role visible in `hud_roster`).
The borrowed role's instructions replace general's on the selected pi or CLI worker. Both pi modes keep the selected place's model and thinking; borrowing can tighten the read-only guard. A pi tab uses the borrowed role's pi profile for tab behavior.
The job keeps general's placement and concurrency slot.
`hud_read` shows `instructions_from`; retrying as general and resuming the native session retain the borrowed role.
A repeated explicit key returns the original job; a derived key only reuses a job created within the last 10 minutes.
`kind` selects `image` (default) or `video` for `flow`.
Optional `idle_grace_s` (integer 60–3600) overrides CLI grace for this job; pi/browser overrides refuse (pi tab grace follows the model's cache lifetime).
Pi-only overrides: boolean `lens`, `mcp`, `tps`, `ui_ext`, `skills`, `split`, plus `pi_args` (≤128 strings, ≤4096 chars each, verbatim, no shell).
Headless and tab jobs both load the HUD worker extension explicitly. TPS is recorded in the native session unless disabled. Tabs load the HUD footer by default; `ui_ext: false` skips it, and headless jobs never load it. Split defaults to the place; `skills: true` includes personal skills.
MCP never auto-loads from ambient configs. Request it with `mcp: true` on the job or place, a role MCP server list, or an explicit `--mcp-config` argument. Requested MCP/lens attachments must be available under `$HUD_HOME/pi-worker/optional/` (`pi-mcp-adapter` / `pi-lens`).
A `pi_role` must be one of `sonic`, `implementer`, `reviewer`, `architect` (oracle), or `general`. In both modes the HUD profile supplies omitted model and thinking; `general` leaves those fields to pi.
A true split reserves a right helper pane.
`--orchestrator`/`--notify` pi-argument overrides refuse.
Only `general` accepts caller Pi model/provider and thinking flags.
Retrying as another role drops the old placement overrides.
Browser (`bro`) places reject pi options.

For a continuable role on pi, Claude Code or Antigravity (`agy`), `hud_create({role, task, mode: "headless"})` opens no tab.
Progress and Stop work as usual.
Each turn runs in a new process on the same native session and appends output to `stdout.jsonl` and `stderr.log`.
Pi keeps its session under the job’s `sessions/`; Claude Code and Antigravity keep theirs in their native stores.
Headless CLI turns use the same prompts and worker MCP setup as tab workers: Claude Code gets the job’s `--mcp-config`; Antigravity uses its installed `hud` server and inherits the job environment.
The job has no tab to focus. Open it from Jobs; the Inspector’s `Output` section shows the newest lines of `stdout.jsonl` (tool calls, assistant text and errors, up to 12 rows; labelled `live` while the job runs) and follows the log at the panel's collection cadence; Stop (`X`) works as for any job.
A question ends the turn; `hud_respond` or an answer from the panel restarts it with the decision. Pi writes the question and tool result before ending, and verifies the session ID and file before accepting the answer.
Headless reviewer tools are read-only except for writing the report. The oracle guard also allows scratch writes under `/tmp`, `/dev/shm`, and the job directory, outside the repository. The Bash guard blocks recognized Git mutations, in-place edits, and installs; it is a backstop, not a shell sandbox.
With a valid report declaration, the worker closes at turn end even if the report is unread.
Follow-ups sent while a headless worker is running queue in send order for its next turn, alongside the answer if it asked.
After closure, follow-ups and land repairs resume that session within `resume_s`, otherwise they start a repair job.

Sonic runs one non-interactive pi query, with no worker tab or pane.
A main session uses `hud_create`; a worker uses `hud_sonic` and collects the result.
Both use a normal job directory: `stdout.jsonl` and `stderr.log` hold pi's output; `report.md` normally holds the declared result.
If the runner disappears without an exit receipt, `STATUS.json` records its exit code or signal when known, a bounded stderr tail, and whether a parent session restart was observed.
If the session tail contains assistant text and no report exists, HUD saves that text in `report.md` marked partial; the job remains failed.
Sonic can publish milestones and take a lease, but it cannot ask questions or receive follow-ups.
There is no idle grace.
The sonic role file accepts `check_s` (600), `stall_s` (180) and `max_s` (1800), all positive whole seconds; `hud_roster({detail:true})` shows the effective values.
At each checkpoint HUD stops a repeating query (`looping`), or records a progress line and lets the same pi process continue.
When no stdout growth or worker progress arrives for `stall_s` while an unbounded tool call (no declared timeout) is still running, HUD ends only that tool's process tree, records a progress line (for example `ended a silent tool after 180 s: bash`), and lets pi continue with the tool error.
If no tool is running (or the same tool call stalls again, or a tool's declared timeout expires), HUD stops the sonic job as `stalled`; the hard cap stops it as `timeout`.
Sonic gives pi automatic compaction one `stall_s` window to finish. In pi 1.6.0, Haiku at `max` thinking has reached `compaction_start` without a matching `compaction_end` before that window expired. Pi's built-in summarizer waits for the whole model response without forwarding summary deltas to JSON stdout; silence alone cannot distinguish slow summarization from a hung request. HUD lets compaction finish, or stops the job with a reason naming threshold or overflow compaction and the expired window. The hard cap still applies.
These failures retain partial stdout and the latest progress line.
To retry a stopped query, use `hud_create({role:"sonic", retry_of:job})`.
The new job resumes a private copy of the stopped job’s `sonic-session.jsonl` with a short continuation naming the stop reason.
If the session is unavailable or rejected before input, pi gets the original brief plus up to 8 KiB from the end of the partial report (or stdout if there is no report).

Pi notifies workers when a sonic child is ready, unless a `hud_sonic` wait in the same session collects its report.

Callers leave sonic's thinking at the role default (`high` as shipped).
The optional **Sonic auto-thinking** setting (`sonicAutoThinking`, off by default) sends the task to the Decision API to choose `none`, `low`, `high` or `max` using the role file's `thinking_choices`.
Use `none` for running an exact command and reporting its output, copying exact text, or listing files; narrow fact lookups in named files use `low`.
Pi calls `none` `off`.
If no key is available, the call cap is reached, the decision times out (about five seconds), or the provider refuses or returns an invalid answer, the role default applies.
Neither `hud_create` for `sonic` nor `hud_sonic` accepts a thinking override.
Dispatch records and returns the effective level after nearest-supported mapping and its `thinking_source` (`default`, `decision` or `explicit`).

**Sonic placement** (`sonicPlacement` in Settings → Models) defaults to `fixed`, which uses the active preset.
For `even`, use the **Sonic even pool** row (`sonicEvenPool`): choose a preset with ←/→ and press Enter to include or exclude it.
Across `hud_create` for `sonic`, `scout`, and worker `hud_sonic`, HUD rotates round-robin through the pool in pool order, keeping the last used index in a private state file under `$HUD_HOME` (`even-sonic.json`).
It skips unavailable or exhausted presets, reports them, wraps around, and uses the active preset if the pool is empty or unavailable.
If a startup attempt is refused for quota before the brief is taken, HUD marks that place exhausted and tries the next available pool preset on the same job. Exhausted presets rejoin automatically when their marks expire.
The job record includes `route.placement: "even"`, `route.preset` for the preset that ran, and the skipped startup preset and reason if there was a fallback. Explicit retries keep the chosen preset.
Sonic still accepts no placement fields from callers.

When a sonic job settles with a report, HUD checks its `path:line` and `path:line-line` citations once mechanically at settlement (no model call or network, and not retroactively on already-reaped jobs) and records `citations: {total, verified, failed: [{ref, reason}]}` on `job.json` and the monthly archive (with at most 20 failures).
Each citation resolves directly against the job's working directory (falling back to its worktree or project root if needed) or as an absolute path inside those roots; if a bare or partial relative path misses directly, HUD resolves it against `git ls-files` in that root only when exactly one tracked file matches, failing multiple tracked matches as `ambiguous_path` and zero matches as `missing_file`.
A resolved citation is verified when the file exists inside those roots, the line range exists, and any text quoted in backticks on the same row appears (whitespace-normalised) within ±3 lines.
Checking stops after 200 citations and reads at most the first 256 KiB of the report; reports with no citations record `total: 0`.
HUD does no analysis on these counts and the panel does not show them.

When a sonic job settles, HUD also records mechanical read-volume facts on `job.json` and the monthly archive (no model call, not shown in the panel): `reads: {tool_calls, tool_result_bytes, by_tool: {name: {calls, bytes}}, truncated?}` counted once in a single streaming pass over the sonic's pi session (`sonic-session.jsonl` when headless, or the tab session file), plus `brief_bytes` and `report_bytes` from `brief.md` and `report.md` when present. `by_tool` keeps the top 10 tools by result bytes; counting stops after 50 MiB with `truncated: true`, and a missing or unreadable session records `reads: null` without error.

**Imp placement** (`impPlacement` in Settings → Models) defaults to `fixed`, which uses the active preset.
For `even`, use the **Even pool** row (`impEvenPool`): choose a preset with ←/→ and press Enter to include or exclude it.
HUD rotates round-robin through the pool in pool order, keeping the last used index in a private state file under `$HUD_HOME` (`even-imp.json`), skipping and reporting unavailable or exhausted presets, wrapping around, and falling back to the active preset if the pool is empty or unavailable.
As for Sonic, a startup quota refusal marks the place exhausted and moves the same job to the next available preset. An exhausted preset rejoins automatically when its mark expires.
The create result and job record include `route.placement: "even"` and `route.preset` for the preset that ran, with the skipped startup preset and reason on a fallback. The Inspector shows `Placement: even` and the preset.
Queueing and overflow keep the initial selection, but a queued even job can move on if quota rules that preset out at launch. Explicit retries and land repair keep the preset from the source job.
Legacy `impRouting: true` loads as `auto`; `false` loads as `fixed`.

**Auto** uses one Decision API judgment at dispatch.
The winning `imp` role file must define `routing`; the block is not inherited from a lower-priority role file.
For example:

```json
"routing": {
  "light": { "preset": "hydrogen", "use": "Small edits on an existing pattern" },
  "standard": { "use": "An ordinary end-to-end slice" },
  "hard": { "preset": "astra", "use": "Cross-module or process lifecycle work" },
  "modes": { "headless": "Likely one shot", "tab": "Likely questions, long runs, or the owner wants to watch" }
}
```

Only configured tiers are offered.
Auto-routing chooses the `light` or `hard` role preset; the detailed roster shows these for information, not as `hud_create` inputs for `imp`.
`standard` has no `preset` and follows the active Control choice.
Routing sends at most the first 4000 characters of the brief and the named local ticket (`feature/NN`, up to 4 KiB), the relative names (up to 512 characters each) and byte sizes of up to 32 `context_files`, and the configured use texts.
It does not send context bodies, the standing brief, prior reports, or preset/model IDs.
The chosen descriptions become the one-line reason.

An unavailable tier falls back to the standard chain; failed or timed-out decisions use the active preset in a tab.
If an automatic standard/headless launch is rejected before input, HUD tries the active preset in a tab.
Explicit `mode: "tab"` or `mode: "headless"` wins and routing then chooses only the tier.
Automatic headless runs only on a supported continuable place (pi, Claude Code, or Antigravity); otherwise HUD uses a tab.
Overflow to `general` keeps the imp chain.
`retry_of` keeps the tier without another decision, and a light job's land repair starts on standard.
The job record, create result and per-job `hud_read` show `route` with `tier`, `mode`, `reason`, `source`, and any `fallback` or `mode_reason`; Inspector shows the route and why: tier and headless marks in its header and a `Route: light · headless — <reason>` row.

Soft per-role concurrency caps (`roleCaps`, defaults `imp: 3`, `general: 3`, other roles uncapped; `0` means unlimited) are counted machine-wide over jobs in a working state (excluding `queued`, `idle_grace`, `done`, `closed`, `failed` and `stopped`). Top-level headless sonic jobs count toward `roleCaps.sonic`; worker sonic children and prewalk scouts neither use nor wait for a slot.
With **imp→general overflow** (`impOverflow`, on by default), an `imp` create at its cap uses a free `general` slot while retaining the `imp` chain (with the selected placement).
It is counted as `general` and returns `overflowed: true` and `overflow_from: "imp"`.
When no slot is free, `hud_create` (including items past the cap in a batch) creates the job as `queued` with its full brief and options and returns `queued: true` and its 1-based `queue_position` (shown in notices and the panel).
The watcher starts the oldest queued job when a slot frees or a cap is raised in Settings, picking the first available place at start time.
`hud_close` (or panel `X`) removes a queued job: its work never started and it has no worker.
To cancel several in one call, pass `jobs: [id, ...]`, or `package: "sample", state: "queued"` (optionally `preset`) for your session's jobs in the current project. Both batch forms return per-job results and counts. Nonqueued jobs and jobs already claimed to start are skipped; only the single `job` form can close a running worker.

Pass context as `context_files` (up to 32 paths resolved against `cwd`) and `from_jobs` (up to 16 job IDs, each referring to its `report.md` in `$HUD_HOME/jobs`).
Use readable UTF-8 text files that resolve inside `cwd` or `$HUD_HOME/jobs`, respectively; invalid references return `invalid_arguments` before dispatch.
Pi and CLI workers read the paths listed after the task in their briefs.
Browser (`bro`) briefs send the labeled file contents to the browser service (64 KiB per file, 256 KiB total; larger context returns `context_too_large`).
Any `sonic` report attached through `from_jobs` (including a scout dossier) is prefixed with a one-line reminder in the brief's language that sonic facts are unverified starting points and code behind any decision must be read directly.
The optional project-root `.hud/brief.md` is included automatically only for registered projects: a reference after the task for local workers, or its contents within the same byte limits for browser jobs.
Keep it safe to send to the selected browser service.
Attaching an upstream report does not mark it read or close its worker.

`isolation: "worktree"` runs the job in its own linked Git checkout beside the repository (`<repo>-wt/<slug>-<id6>`, branch `wt/<slug>-<id6>` from HEAD, `node_modules` linked, the CLI's trust of the main checkout copied).
It is refused for browser roles and outside Git.
`hud_read` in full mode adds the `worktree` receipt (including the checkout path) and `git_summary`.
Its `overlaps` lists other managed jobs and paths they also changed, excluding committed paths whose versions already match the main checkout's HEAD.
An empty list means no overlaps found, `null` means the job's own Git summary failed, and `overlaps_incomplete` flags partial coverage.
After the job closes, the watcher removes the checkout and branch only if the worktree is clean and its branch is unchanged, merged, or every slice commit has a patch-equivalent commit on the base branch.
It keeps dirty worktrees and those with unpicked or amended patches, recording `worktree_kept_reason`, including up to five paths that made the worktree dirty.
A later scan can reconsider an unpicked branch if the base HEAD changed; regular scans don't retry dirty checkouts.
A registered project's `worktree.disposable` in `.hud/project.json` lists globs of **ignored** build outputs that cleanup may discard (for example `["dist/**"]`, default `[]`).
A `dir/**` glob covers hidden descendants too.
When tracked files live under `node_modules/`, worktree setup links the untracked entries from the main checkout and cleanup treats ignored entries under `node_modules/` as removable dependency state.
Other ignored files and untracked or tracked changes are preserved.
Project lists these checkouts as the jobs' own, not as unlisted worktrees.

Call `hud_land({ job })` on a successfully settled managed worktree (`idle_grace`, `done` or `closed`) in any registered project.
HUD uses the job's own main checkout, not the caller's. Configure `land` in that checkout's `.hud/project.json`, for example:

```json
{"land":{"base":"main","gate":["npm test"],"after":["npm run build"],"push":true,"wrapper":"tools/env.sh","timeout_s":900}}
```

HUD queues behind the `main-checkout` lease and runs the gate in a fresh detached checkout.
At every `main-checkout` lease handoff (including release for repair or red-train fallback), queued Markdown ticket edits have priority in a bounded batch: running land, then pending edits, then the next land. A land that is mid-gate is not interrupted, and edits arriving after the handoff snapshot wait for the next handoff so a steady stream of edits cannot starve lands.
If the job is already based on the current tip, HUD tests the job's exact commit; otherwise it cherry-picks only commits not reachable from the base.
Commands are shell strings; the optional wrapper is an executable relative to the main checkout, passed `sh -c <command>` in the target checkout.
Each `gate` and `after` command, including an immediate rerun, has its own `timeout_s` deadline (default 900 seconds).
At the deadline HUD kills the command's process group, records `timeout` with up to 40 lines of failure output, and releases the lease without dispatching a repair.
A red gate command, including one reporting a Node.js per-test timeout, gets one immediate rerun there.
If the output has Node.js `test at <file>:…` failure locations, HUD reruns only those files with `node --test` through the same wrapper; otherwise it reruns the whole command.
If the rerun passes, HUD continues and names the flaky tests in the notice when available.
When the main checkout's `.hud/project.json` configures `"flakes": {"feature": "test-flakes"}` (absent = off), after releasing the `main-checkout` lease the land flow appends each rerun-pass case (test name, file, flow id and log path) to that feature's newest open running-list ticket—creating a new one when the newest is done, claimed or already ready—and commits only that ticket path under the `main-checkout` lease.
Unidentified gate failures (no parsed test case) are recorded with the command, flow and log but do not trigger the repeat rule; only named tests repeat.
When a named test repeats or the list reaches four cases, the ticket becomes `ready-for-agent` and HUD dispatches through the queue-capable ticket admission path (with project- and attempt-scoped request keys). Both flake collection and ticket queues wait for the project's active flake imp before admitting another running list.
A refused ticket edit (such as a hand edit on the running list), a dispatch refusal, or a promoted list waiting behind an active flake imp leaves the land green and the edit intact, and records `flake_collection` as pending on the land receipt (tied to the promoted ticket until it is admitted or independently resolved).
HUD retries from the recorded rerun on the next land, on relevant input changes seen by the unattended service, or on the service's periodic fallback (normally 30 seconds while pending, including for quota expiry). Retrying does not rerun the gate or rewrite an unchanged receipt.
Watcher flow retention keeps a land flow receipt and its gate log(s) while `flake_collection` is pending, and prunes the family normally once collection succeeds or the target ticket is independently resolved. A missing or unreadable checkout or ticket does not resolve a pending dispatch, even when flake collection is disabled.
On a persistent red gate or a cherry-pick conflict, HUD sends the failing step and up to 40 lines (8 KiB) of its failure output to the source worker with instructions to rebase onto the current base, fix and commit.
It uses the same native-resume window as `hud_send`; if it cannot continue the source worker, it creates a local job of the same role with `retry_of`, in the source checkout.
The checkout lease is released during repair.
A fresh settlement starts a fresh integration and gate; a worker question goes to the main session and ends the flow.
There are at most two worker repairs.

Each failing gate run (first run or immediate rerun) keeps a private excerpt of up to 8 KiB beside the flow receipt: blank lines and HUD panel frames are removed, and the first recognized Node.js test assertion or error from each failing file takes priority over stack traces or other output.
If no assertion block is recognized, the excerpt keeps the last nonblank output lines.
Repair prompts use the same evidence from the command that failed.
`hud_read` shows the paths under `reruns`, and the terminal notice links the excerpts.
Successful runs write no excerpt.
Excerpts are kept with their flow receipt and swept if it is removed.

On green, HUD folds the update to the job's local `ticket` (`feature/NN`), if present, into the last tested commit in the integration checkout.
The ticket is marked `done` by default, or `ready-for-human` if it says `**Owner try:** yes`.
Its acceptance boxes are ticked, and a comment says `Landed in this commit`, with the replay base and passed/total gate commands.
On the base branch, `git blame -- <ticket-path>` identifies the commit that added that line; `hud_read` on the flow also returns its `landed_sha`.
This does not update `STATE.md` or use the owner's index.
HUD fast-forwards the checked-out base only when touched paths are clean and either the base tip is unchanged or every new base commit touches only unrelated paths; in the latter case it cherry-picks the tested commits onto the new base tip in a fresh detached checkout and reapplies the ticket update (refusing on any overlap or conflict), and notes the replay in the notice.
HUD reuses the green gate only if the candidate tree matches the tested tree or differs only in plain ticket or `STATE.md` metadata (including `docs/handoff/STATE.md`).
Otherwise it reruns the gate on the exact candidate before fast-forward.
If the base advances again during that gate, HUD can replay and recheck the new candidate, up to two absorbed base moves per attempt. `hud_read` and the terminal notice report `base_moves` when nonzero.
A persistent replay gate failure stops the land without dispatching a repair.
HUD then runs `after` in the main checkout (when an `after` main build command matches the integration checkout's tested build inputs, compiler and config exactly, HUD publishes the tested `dist` through `scripts/build.mjs`'s staged publisher instead of recompiling).
If pushing is enabled, HUD pushes only the approved landed SHA to the base branch on `origin`, even if the local branch has since advanced.
The checked-out base must still contain the landed commit and the landed paths must be clean.
HUD then removes the integration checkout and, when clean and still at the exact source commit this flow landed, the job worktree and branch (even if the cherry-picked patch differed from the source).
A cleanup error after landing still completes the flow with `cleanup_note` rather than failing it.
A failure after fast-forward includes the landed SHA.

The main `after` build checks the native statusline's source and binary hashes before publishing it to `dist/native/`.
It uses the tested artifact when valid, otherwise keeps a matching local artifact or builds one with Cargo.
If Cargo is unavailable and no matching artifact exists on a supported platform, the build still succeeds and the land result reports once (`after_note`) that the TypeScript statusline stays in use.

The call returns a flow ID (one task for MCP-task clients) without waiting for the gate.
The helper loads one build before running any steps.
If it cannot load the build, the flow fails with `HUD was rebuilt; retry the land`. A ticket queue still running the old land protocol reports the same failure; restart it before retrying.
Calling `hud_land` again returns the existing flow if it is active or has already fast-forwarded the base.
If it failed or was cancelled before fast-forward, the call starts a new flow, keeps the old receipt under its original ID and removes the old integration worktree once it holds the lease.
If Git refuses the fast-forward and HUD verifies that the base tip and touched paths are unchanged, a new call can retry. If the fast-forward result is unknown (for example, the helper dies before recording it or Git times out), the call returns the failed receipt rather than retrying an unknown checkout change.
`hud_read({job: "<flow ID>"})` gives any attempt's state, current step and per-step wall-clock `timings` (including reruns and skipped `after` rebuilds).
The receipt records `tested_tree` (the latest green tree) and `published_tree` (the candidate tree, even if fast-forward or push does not happen).
While another land holds the lease, the queued flow names the holder in `hud_read` and in its Inspector; when the holder is in the gate, it also shows the step number and elapsed minutes.
One terminal notice per attempt reports the SHA or the failing step, up to three known failing tests, and up to 40 lines of failure output, with one line per repair attempt.
The helper survives a watcher restart; an interrupted helper is reported, not replayed.
Receipts live under `$HUD_HOME/flows/`.

A role JSON file sets `role`, `instructions`, `can_continue`, optional `idle_grace_s` (CLI quiet-job grace, default 600), optional `resume_s` (default 1620 seconds; `0` disables native resume), and ordered `run` places across `pi`, `cli` (`grok`, `agy`, `claude` or `codex`), and `bro` (`jev-ask`, `jev-aistudio`, `jev-flow`); legacy single-place files load as `run[0]` and `"harness": "jev"` loads as `"bro"`.
Set `"tab_visible": true` at the top level to start that role's interactive CLI and pi workers with visible tabs. This does not focus them or change headless jobs.
Shipped roles: `imp` (`pi` implementer), `reviewer` (`pi` reviewer -> `agy` Hydrogen high), `lead` (`cli` `claude` `claude-opus-5-5` high with the HUD MCP tools), `sonic`, `oracle` (`cli` `claude` `fable` high -> `pi` `architect`; `hud_create` also takes `architect` for it unless a role file defines one), plus the optional `council`, `pro` (`chatgpt`, `gemini`, `argon`) and `flow` (`jev-flow`) roles.

### Composed workflows

Main can call `hud_workflow({op: "plan", graph, cwd})` with a version-1 JSON object (or JSON text), or `hud_workflow({op: "plan", template: "my-recipe", cwd, params})` with a TOML template. Templates are named `<name>.toml` under the registered main checkout's `.hud/workflows/` (first choice), then `$HUD_HOME/workflows/`. The shipped names `batch`, `prewalk`, `land`, `council` and `ticket-queue` are reserved for their existing entry points. A whole field like `run = "{argv}"` can take a typed value from `params`; HUD does not interpolate within prose or argv.

`plan` launches nothing. It returns a proposed `run`, normalized plan, per-step scale, `cost`, `cost_reasons`, and SHA-256 `hash`. It snapshots brief-file content and named check argv. Review the plan and then call `hud_workflow({op: "start", run, hash, confirm: true})` within 30 minutes. A costly run also needs the owner to run `hud workflow allow RUN HASH` in their shell; the grant is one-time, expires after 30 minutes, and applies only to that proposal. The main session asks rather than issuing its own approval. `/council` still authorizes only a standalone council. Costly means any council, `pro`, `flow`, or browser place (including preset fallbacks), or total fan-out above 50 Sonic items, 2 MiB of Sonic inputs, or 12 non-Sonic items. Counts include all possible branches before a decision, so splitting work across steps in one run does not avoid approval.

Graphs have named `steps`, with `needs` prerequisites and optional `from` references to ancestors. `job` takes `role`, `task` or `brief_file`, and optional `isolation`; `batch` takes one `role` and inline `items`, and pilots the first item before admitting the remainder within role reservations. `council` uses the configured council defaults. `land` takes `job: "build"` naming an ancestor worktree job. The sealed land helper is never replayed automatically or by `retry_failed`. A `check` also takes `job: "build"` and runs in that job's actual checkout. Give exactly one of `run: ["npm", "test"]` or `use: "test"` (from the registered project's `.hud/project.json`, e.g. `"commands": {"test": ["npm", "test"]}`). HUD invokes literal argv without a shell; no shell placeholders. Exit 0 passes. `repair: 1` or `2` can return a failing check's step, error and last 40 output lines (up to 8 KiB) to the non-Sonic source worker or its same-role replacement on that worktree before rechecking. An unknown check outcome pauses rather than rerunning automatically. Reports pass by reference (up to 16 job IDs; larger batches use their private result index). Check evidence passes by private receipt path.

For build → check → review → hand-back → land, set each step's `needs` to the preceding step; use `from: ["build", "check"]` on review. The hand-back takes `ask`, `options: ["land", "stop"]`, and `to: "main"` for a main decision. It pauses with `{request_id, step, ask, choices, refs}` and emits one wake line. Answer `hud_respond({job: run, request_id, answer: "land"})`; only the first valid answer is written. Set `when: {step: "accept", is: "land"}` on the land step. A step behind a skipped required prerequisite is also skipped; mark a prerequisite `optional: true` for a join that can proceed without it. Without `to: "main"`, a one-decision lead receives the question, choices, escalation rule, and selected report/check/index references. It declares a choice and reason in its report and is closed; an escalation or a missing valid decision hands the question back to main.

Use `hud_workflow({op: "status", run})` for the run and step receipts, and `hud_workflow({op: "control", run, action})` with `pause`, `resume`, `stop` or `retry_failed`. A pause/stop admits no further steps and does not undo admitted work. Resume does not answer an open hand-back; after a required failure it skips that path, while `retry_failed` makes a new attempt at the failed step if replay is allowed. Worker questions and failures remain actionable; routine child settlements are folded into the run's end notice.

**Workflow acceptance (`lead`) and ticket-queue runs.** `hud_tickets({op: "run", feature})` runs the shipped `ticket-queue` workflow (`packages/hud-mcp/workflows/ticket-queue.toml`): `tickets` (`imp` batch with `each = ["job", "land"]`) → `review` (independent milestone `reviewer` step) → `accept` (`handback` step, default `to = "lead"`). Before starting, `hud_tickets` `op: "run"` (and `hud unattended on`) verify that every role the run needs (`imp`, `reviewer`, and `lead` when the hand-back target is `lead`, plus `frontend-imp` if a `ready-for-agent` ticket requests it, including dependency-blocked successors in the feature or selected active Objectives) is enabled in the project and refuse with the `hud setup` fix before dispatching anything. A deterministic ticket check also refuses the run and lists gaps if any `ready-for-agent` ticket lacks a goal (`What to build`), acceptance items, valid `Blocked by` references, or a `Live try:` / `How to try:` line (or `Live try: none`), or has an empty `Approved removals:` header. Ticket workers receive a run rule to proceed on the ticket, spec and their own default, record assumptions as `Assumed:` lines (moved to the run's `todo`), ask only when no safe default exists, use `Blockers:` only for an owner decision needed before landing (scope, value trade-off, visible deletion, or irreversible act), and write `Blockers: none` otherwise. A pending live try or owner try is never a blocker: put it on a `Try:` line or elsewhere in the report. Workers include a `Removes:` line (`none`, named removals, or `ambiguous: <detail>`). A report with more than three `Assumed:` lines or one mentioning `scope` goes to a temporary one-decision `lead` by default or with `handback_to: "lead"`. Its packet includes the run and ticket IDs, feature or Objective, ticket goal and path, trigger, relevant `Assumed:` and `Blockers:` lines, worker report and checkout paths, source commit, and decision rules. `continue` allows landing without a main wake; a `hold` for a visible deletion or `docs/spec.md` change records the worker report signature and source head and requests owner approval, and other holds go to repair. On resuming an ordinary queue via `hud_tickets` `op: "run"`, a held item whose report signature or source head changed is un-held and judged again like a new turn; an unchanged assumption hold stays held and pauses the run after independent work drains, with a manual-resolution notice (worker correction, `hud_land`, or stop). With `handback_to: "main"`, the assumption trigger still pauses without waking main (empty `notices`). A worker or reviewer question starts a temporary one-decision `lead` job (unless `handback_to: "main"` is set or `ask: false` on the step) that answers (delivery/resume verified, bounded retries then hold/escalate) and is immediately closed through normal HUD closure (`hud-reap`/herdr); if herdr refuses closure, the run records `unclosed_leads` and holds instead of presenting the lead as closed. At `accept`, a fresh one-decision `lead` receives a compact packet built from the run record (goals, live-try lines, declared choices, configurable `escalation_rule`, report/check/review refs, held/failed/blocked items, prior decisions and `todo`), declares `Decision: finish | repair | escalate` with `Reason:` and optional `Todo:` lines via `hud_report`, and is closed through herdr before the runner acts. `repair` loops through `tickets` → `review` → `accept` for newly added repair tickets admitted by the same run (verified admitted, bounded to at most 2 repair rounds, then holds/escalates). `lead` runs outside role-cap reservations, is cheap-class, gets no `hud_land` tool, and never edits `docs/spec.md`. Runs survive closure of the dispatching main session: leads open in the project's herdr workspace, and the one end notice (including verdict and todo count) or escalation waits on the run record for the next main session reading the project (`hud_read({job: <flow>})` lists `verdict`, `todo`, `decisions`, `reviews`, `repair_rounds`, `handback`, `held_items`, `failed_items`, `blocked` and derived `pause_notice`). Pass `escalation_rule` on `hud_tickets` `op: "run"` to customize when a lead escalates; `handback_to: "main"` or `to = "main"` on a hand-back step wakes main directly. To answer a paused main hand-back, call `hud_respond({job: <flow>, answer: "<choice>[: <reason>]"})` (or put the optional reason after a newline) without `request_id`: `finish` records the verdict and completes the run; `repair` (after adding repair ticket(s) to the feature via `hud_tickets`) loops `tickets` → `review` → `accept` within the same run, bounded to at most 2 repair rounds like a lead decision; `escalate` pauses with the reason for the owner.

**Report blockers and try notes.** `Try:` lines and `Blockers:` lines that only say a live, owner, or acceptance try is pending go to the run's `todo` without delaying landing. Other `Blockers:` lines go to the same temporary lead check, even if final acceptance is set to main. The lead's decision is recorded with kind `blocker`; `continue` adds the blocker text to `todo` and allows landing subject to the normal gates. If the lead escalates, only that ticket and its dependents wait. The queue stays working and dispatches and lands independent tickets in ordinary and unattended runs. Main gets one notice naming the held ticket and its request ID. After the owner decides, use `hud_respond({job: <flow>, request_id: <id from the notice>, answer: "resume: <reason>"})` to approve that ticket's exact report and source commit, not the rest of the queue. If the report or commit changes it is judged again. On a `handback_to: "main"` queue started without an enabled lead, a report that requires lead triage cannot auto-land; enable the lead with `hud setup`.

**Council** requires a fresh owner grant, separate from enabling the role. In the Claude mod or pi, type `/council <request>` to grant once and send that text to the main session as a council request. In Codex or Antigravity, select `council` in Control → Roles and press **g**; alternatively, run `hud council allow` in your shell. The panel and shell authorize only: give the main session your request separately. One private record in `$HUD_HOME` applies across sessions and projects, expires after 30 minutes, and replaces any unused grant. Starting the first member spends it; a refusal or failure before any member starts does not. The council receipt and archive record `grant: {via, created_at}`. On `owner_grant_required`, the caller must ask the owner, never grant itself permission.

**Council** is for an explicit owner request for independent plans. `hud_create({role: "council", task, cwd})` starts the configured `members` in parallel (default: `fable`, `astra`, `carbon`, with `oracle` instructions). Use `brief_file` instead of `task`, or pass `context_files` and `from_jobs`. In `$HUD_HOME/roles/council.json`, define ordinary named `presets` and choose the `members` and `synthesizer` defaults; either choice can be overridden per call (2–5 member names). By default the main session converges the member plans and accepts the result. To delegate synthesis for one call, pass `synthesizer: "pro"` or `synthesizer: "fable"` (Fable high). HUD refuses unavailable choices before launching anyone. Local members get the original context references; browser members get the borrowed instructions and a GitHub index instead of original attachment bodies. The index uses the repository, commit and paths from local remote-tracking evidence, without fetching; changed, untracked and unverifiable files are marked `local-only`.

A detached workflow runner collects the reports and finishes the council even if the creating MCP session exits. Read the result using the same parent job ID. After all members settle, two or more reports suffice. The synthesis brief names failures and requests one converged plan, a disagreement table with choices and reasons, and open questions. Browser synthesis requires `pro` enabled and gets the original task, GitHub index, member reports and standard standing brief (64 KiB per inlined file, 256 KiB total; `context_too_large` fails the council). Local synthesis gets the member reports and original `context_files` as references. With `synthesizer: "main"`, no synthesis job starts: `hud_read({job})` returns the member IDs, digests and synthesis instructions, and settles an open council parent (`closed`, `members collected by main`) once every member has settled (the watcher settles stuck pre-existing records with a prior read on its next pass). `hud_close` on a council parent closes the parent and any still-running members through normal closure without requiring `SESSION.txt`. Otherwise read the synthesis like any job report (`mode: "full"` for the text). Only the council delivers a notice or MCP task; nothing chains after it.

Optional roles are off by default: `hud_roster` omits them and `hud_create` refuses them with an enablement hint.
An existing valid role file under `$HUD_HOME/roles` enables the role by name unless an explicit switch says otherwise.
A `cli` place requires `instructions/<instructions>.md` (shipped: `implementer.md`, `reviewer.md`, `oracle.md`, `lead.md`), otherwise `hud_create` returns `unsupported_harness`.
Quota or rate-limit failures mark the place exhausted in `$HUD_HOME/exhausted.json` for 1 hour so the next dispatch falls back; HUD never auto-retries.
Register custom roles as `$HUD_HOME/roles/<name>.json`, for example a design role with `"agent": "claude"` and a Claude model alias.
List models with `grok models`, `agy models`, `claude --help` or `codex -m`.
The HUD passes only the model flag, the effort flag, that CLI's permission-bypass flag, `args`, and the HUD worker binding.
A native resume adds the recorded session identifier; launches keep the configured CLI home.
HUD never trusts a directory while dispatching: a trust dialog is declined and the launch fails, naming `hud trust <cwd>`.
Sessions stay in each CLI's own store.
Managed CLI and Pi tabs require the HUD herdr fork (`herdr-hud`): the running server's ping version must contain `-hud` and set `capabilities.agy_background_work` to `true`. Dispatch refuses stock herdr rather than falling back to a shell launch; upgrade the running fork if the capability is missing. The fork starts the worker directly with HUD's environment, without sourcing shell startup files. This requirement does not change headless launches, browser shells, or the shell in a split Pi helper pane. Close any old shell-launched CLI or Pi worker manually; HUD will not take ownership of it.

After a direct start, HUD reports a short task title for the herdr sidebar (ticket title, then package or brief title, up to 28 columns). Custom sidebar rows and grouped sidebars use `hud_role`, `hud_ticket` (when linked), `hud_icon` (the same one-cell role glyph used in the bar and Home, in the Icons setting at dispatch), `hud_group` (the job's registered project name — the same name the panel shows — or project directory name), and `hud_subgroup` (the ticket's feature slug from `feature/NN`, else the package label, else the parent job's subgroup for Sonic children and prewalk scouts, else omitted). Main-session panes known to HUD in a registered project (via `hud-mcp`, `hud watch` including the Claude mod and queue watcher, the pi extension, or `codex-hud`) also report `hud_group` so the main session sits in its project's group without renaming the pane or changing its display title. This best-effort metadata does not rename managed agents, and older herdr forks without grouped sidebar ignore the extra tokens harmlessly.

`hud trust <dir>` adds that directory to the trust files of grok, agy and claude after a backup under `$HUD_HOME`.
A missing CLI file is not created.
Codex is skipped.

`hud_read({})` (or `view: "compact"`) lists active project jobs and the caller's settled jobs with unread reports, newest first.
It shows `job`, `role`, `state` and, when applicable, `report_unread: true`, `blocked: true`, pending `question_ids` and a block, wait or failure `reason`.
To keep the snapshot near 2 KiB, older unread reports fold into `older_unread_reports`; active jobs stay visible.
Worker-started children appear as `child_count` on their parent.
Use `view: "recent"` for the newest 20 full rows, including child jobs and handled history.
Both views can include a settled job's current `summary` (up to 120 characters; no file list).
Neither marks anything read; `changes` still includes events for jobs hidden from the snapshot.
`view` cannot be combined with `job` or `jobs`.

`hud_wait({ jobs?, mode?, wait_ms? })` watches several jobs at once.
Omit `jobs` to take the caller session's unsettled jobs at the start of the call.
`mode: "any"` (default) returns when one settles or needs attention; `"all"` waits for every target to settle, but a question, block, orchestrator wait or failure returns early.
`wait_ms` is an integer from 0 to 120000 (default 60000; `0` checks once).
The response includes `ready`, `timed_out`, `triggered` job IDs and compact `jobs` rows.
No targets returns ready with empty lists.
Waiting does not read report or question bodies, mark anything seen or close workers; use `hud_read` with a job ID to collect the report.

Main sessions in herdr and workers use `hud_lease({name, release?, wait_s?})` before using a named shared resource.
Waits stay inside the caller's turn (120 seconds by default, capped at 300; `0` checks once).
Use the resource only on `granted: true`; otherwise `held_by` gives the holder and acquisition time.
Release with `release: true` when done; releasing someone else's lease is a no-op.
Leases are scoped to the caller's repository, shared by the main checkout and its linked worktrees (cwd outside Git).
A waiter wakes on release and reclaims a lease left by a terminal worker or an exited process.
No background process or time expiry is involved.

`hud_peek({ job })` returns compact `status` and progress without fetching the pane.
Request `lines` (1–120) to fetch the pane tail as `pane_lines`; if unavailable, that field is `null` with a `pane_reason`.
`detail: true` adds launch `diagnostics`.
Peeking does not read the report, mark the job seen or close the worker.
Workers can use `hud_progress` to log milestones (one line, up to 240 characters; newest 50 stored).
Peek and full-mode reads show the newest 10 as `progress`; ordinary reads show only `latest_progress`; ordinary reads omit empty progress, and list/wait rows omit all progress.
Milestones do not emit watch events.

`hud_read({ job })` returns state and a `digest` for an unread report.
Its `result` is the signature-bound worker summary when current and settled.
Otherwise it uses the same fallback as the task notice: the first prose line in the first 2 KiB, skipping headings and blank lines, or `Report ready` if there is none.
The digest gives the `hud_read` hint, byte size, Git changed-file count for a managed worktree, and explicit `Verdict:` and `Blockers:` lines when present in the first 64 KiB.
The report-ready notice and digest name the copied `preview_path` and note any missing file or failure to copy or open (`preview_error` in the digest).
The response keeps open questions, one line per completed check and the latest milestone.
For worktrees it lists up to 20 changed paths, then `+N more`, and warns about overlaps.
Already-read reports return `report_unchanged: true` without reopening the body. A replacement is unread even if its modification time matches the collected file’s. Older receipts without a file stamp use `read_at` alone.
`mode: "full"` (or `full: true`) returns the report even if already read, its `report_path`, and the usual metadata, progress, checks and worktree diagnostics.
Report text is capped at 24 KiB per page after JSON escaping.
If more remains, the result includes `report_bytes` (total file size), `report_truncated: true` and `next_offset`.
Pass that byte offset to `hud_read({ job, mode: "full", offset: next_offset })` and append each `report` until `next_offset` is absent.
Use `jobs: [id, …]` instead of `job` to get results in input order; all use the same mode, and an unknown ID returns an error only for that entry.
Continue each paged report separately.
`detail: true` includes launch diagnostics such as effective CLI `idle_grace_s` and `launch_agent_args` (bounded arguments from recent CLI tab starts, not the submitted prompt).
Failed launches keep a short `exit_reason` and the command output in `stderr_tail`.
Use peek instead when you do not want to collect.
`wait_ms` waits at most 120000 ms, stopping at settlement, a question or timeout.
Collecting either the digest or the report body stamps `read_at` (including during work and idle grace), not acceptance.
With a current-turn declaration, the worker process and pane close at turn end, even if the report is unread.
If herdr still reports no turn end, the CLI worker closes 10 seconds after declaration as long as the report still matches its receipt. This lets close-time reaping clean up a daemon that keeps the pane working.
An open question or open or uncollected sonic child holds closure.
Jobs launched before this change keep their original idle grace.
Reading a failure/block separately marks that attention as seen.
Workers finish with `hud_report`, which publishes the report without repeating it in chat.
They may supply a one-line `summary` (up to 160 Unicode code points) and a `files` list of up to 50 relative paths.
Reviewers (`role: "reviewer"`) may also declare `findings: {blocker, major, minor}` (non-negative integers) and `reviewed: {base, head}` (40-hex commit SHAs, same meaning as `git rev-list base..head`) in `hud_report` or via `hud-progress --done --findings '<json>' --reviewed '<json>'`; invalid values or declarations from other roles are dropped with a warning without failing the report.
If `hud_create` did not set `preview`, the worker can supply it in `hud_report` (or `hud-progress --done --preview <path>`).
On declaration HUD copies the self-contained HTML to `<project root>/tmp/preview/<job>/<basename>` so it survives landing.
A rewritten preview is copied and opened again on report; another report for the same job with an unchanged preview does not reopen it.
Claude and Codex use their HUD MCP and pass the token from the prompt they are answering; pi has native tools and needs no token.
Antigravity and Grok Build use the fallback commands in their briefs.
Both `hud_report` and `hud-progress --done` refuse to declare a report while the managed worktree has uncommitted changes.
Ignored files do not block the report, and a clean worktree may report a no-op without making a commit.
For a committed branch, the report tool attempts a merge preview against the current base tip.
If it detects conflicts, it refuses once per job, listing the conflicting paths and asking the worker to rebase onto the given commit and rerun tests.
A later report is not blocked by this preview; `hud_land` still performs its own replay and repair.

A registered main checkout can set `worker_checks` in `.hud/project.json`, for example `"worker_checks": { "imp": ["npm run build", "npm run build:test"] }`.
For the named code role, HUD runs the commands in order in the managed worktree before publishing a report, using `land.wrapper` if configured.
Read-only roles and worktrees without new commits skip them.
The commands share a 60-second limit.
The first failure or timeout refuses that report attempt and returns the failing command and up to 2 KiB of trailing output to the same worker.
The worker can fix the failure and retry, or report while blocked with a nonblank `skip_checks_reason` (`hud-progress --done --skip-checks-reason` for the fallback).
That reason appears in the `hud_read` digest.
These checks are separate from `hud_create` checks and the land gate.

Workers use `hud_sonic` to start sonic sub-tasks without waiting, then collect their reports; HUD prompts once if they finish without collecting. The reminder does not count as collection.
`hud_send` queues a message for a working pi or CLI job when the transport accepts it.
If a tabbed worker is blocked on a client prompt, the send returns `worker_blocked` and `queued: false`. Resolve the prompt and send again with a new `message_key`.
After a worker closes on its report, HUD checks the clock and native session.
Within `resume_s`, it can open the same pi, Claude, Codex or Antigravity session in a new pane in the same checkout, as a new turn of the same job (`continuation: "resumed"`).
After the window or if native resume is unavailable, it starts a repair with references to the original brief and report (`continuation: "repair"`, new job ID in `continued_as`).
Repairing a managed-worktree job—or retrying a failed repair with `retry_of` without overriding `cwd` or `isolation`—reuses the source worktree if it still exists and is clean; otherwise it creates a fresh worktree.
Use `jobs` instead of `job` to send one text only to working jobs; the response lists `sent` job IDs and `skipped` entries with reasons.
Use `messages: [{job, text, message_key?}]` to send distinct messages (including native resumes and closed-job repairs) in one call, returning `messages` in input order with per-item errors.
An explicit `message_key` deduplicates sends; if omitted, the same job and text are treated as a retry only within 10 minutes.
Workers ask with `hud_ask`; the question arrives through an active MCP task or the `QUESTION` notice, and `hud_respond` answers it.
A synchronous question waits up to 20 minutes; pi can ask asynchronously and continue unrelated work.
If an async decision goes unacknowledged for 20 seconds and pi is idle, HUD surfaces it as undelivered. The job stays waiting and can accept a late acknowledgement without resending the decision.
A blocked CLI marks the job as needing the owner; task clients can see it in `hud_read`, and other clients receive it through `changes` or their live job notices.
`hud_respond` writes a `qN.answer.md` once (or pass `answers: [{job, request_id, answer}]` to answer several in one call, returning `answers` in input order with per-item errors). For a ticket-queue run paused at a `handback_to: "main"` step, pass `job: <flow>` (`q...`) and `answer: "<choice>[: <reason>]"` (or a newline before the reason) without `request_id`.
`hud_close` reaps early.
A stopped Pi worker is recorded as `stopped` even if it exits during startup without publishing its final status.
Normal cleanup belongs to the watcher, which also records `stopped` on its next scan if a stop was requested and the recorded Pi process is gone.
If an unfinished tabbed Pi worker and its pane disappear without a shutdown status, the watcher records `stopped` with `process exited without a report`, even without a stop request.
The owner can also answer an open question from the panel (`1`–`4` or `d` on its expanded question); the session hears it as one `changes` / `hud watch` line, `[role@job] ANSWERED qN from panel: <answer>`, read from `$HUD_HOME/panel-actions.jsonl` (answers made while the reader runs; a question answered earlier is simply gone).
With the `herdr` extension installed (`./install --with herdr`), the `hud.select-send.send` herdr plugin action opens a small popup composer for the active pane selection. If there is no selection or the composer cannot open, the action requests a herdr notification and sends nothing.
The composer shows the exact excerpt plus one question line, refreshing to the latest text if `stale_content` occurs. Confirm with Enter to send the excerpt and its source (`project`, `pane`, `job` if a worker pane, `time`) to the job's dispatcher or the project's main session via HUD's normal delivery path (active pane watcher via `panel-actions.jsonl`, or `notify`). If direct guarded typing is refused, the popup stays open and retries within a 10-minute window; press Esc while waiting to cancel without sending. No retry helper or retry file is created. Only the temporary action-to-composer handoff uses `$HUD_HOME/select-send/` (`0600`, pruned by count and age).
The installer prints an optional `prefix+a` binding for this action; see [the herdr integration guide](../integrations/herdr/README.md#selection-to-main-plugin-plugin).
See [Send a pane selection to a worker](#send-a-pane-selection-to-a-worker) for direct replies.
The main session chooses next steps outside fixed HUD flows it starts.
See [the MCP README](../packages/hud-mcp/README.md) for the delegation tool arguments.

`hud_tickets` provides the ticket method in every client without a separate skill.
`cwd` defaults to the server's working directory; pass the project directory to target another project.

- **`guide`** (or no `op`): returns the slicing method and local ticket template as Markdown.
- **`ready`**: lists unblocked `ready-for-agent` tickets with no live job as `tickets: [{ticket, path, title, what}]`.
  `what` is one line from the ticket's What to build section.
  Pass `ticket` (`feature/NN`) and `path` (as `brief_file`) to `hud_create`.
  The live job claims the ticket in Project diagnostics without a claim commit; `hud_land` folds the ticket update into the landed commit (`done` by default; `ready-for-human` with `**Owner try:** yes`) without touching `STATE.md`.
- **`run`**: pass `feature` and optional `max_parallel` (default for new queues: imp role cap) to dispatch ready tickets and land clean reports until the batch finishes or needs main. `**Role:** frontend-imp` selects that role, and `**Main review:** yes` stops auto-land. A worker question stops the batch; `hud_respond` to that question resumes it (`queue_resumed`).
  Start the queue even if another feature's tickets have not landed. `run` rejects an unknown cross-feature blocker; known blockers appear under `queued` with the tickets waiting on them. A queue with only these waits stays `working`. It rechecks on land events and blocker edits, and starts each ticket once all blockers have cleared. A cross-feature blocker marked `wontfix` clears the wait just as `done` does; a blocker awaiting an owner try does not.
  After addressing a failure, call `run` again with the same project and `feature`. A new queue attempt keeps existing jobs and completed lands, and retries eligible lands that failed before fast-forward without dispatching their tickets again. It keeps the previous `max_parallel` unless you override it. If `run` replaces a paused run, `hud_respond` on the old run’s hand-back returns `superseded_run` and names the successor.
  On an ordinary feature queue paused for an assumption, `run` with the same `feature` accepts the report and source commit that caused the pause. The assumed lines stay in `todo`; a changed report or commit is judged again. Answer an escalated report blocker with `hud_respond` on the existing run; independent work keeps going.
  `run` with the same `feature` and `cancel: true` stops new dispatches and lands; it leaves existing jobs and lands alone. Pass `run` (a run ID, or pass the run ID as `feature`) with `cancel: true` to cancel a working or paused run in this project, including an unattended run, without signalling any process.
- **`add`**: pass `feature` (lowercase letters, digits and hyphens), `tickets: [{title, blocked_by, what, acceptance, status?, owner_try?, live_try?, approved_removals?, objective?}]` and optionally a top-level `objective`, which applies to every draft without its own.
  When `what` contains a `Live try:` field and `live_try` is omitted, `add` moves it to its own `**Live try:**` line.
  `blocked_by` lists local numbers (existing tickets or earlier drafts in this call) or existing `feature/NN` references; use `[]` for no blockers.
  An unknown blocker rejects the entire batch without writing.
  `acceptance` is a list of checklist item strings.
  Optional `owner_try` writes `**Owner try:** yes` or `no` under Status (`yes` opts into an owner try; `no` or omitted lands as `done`).
  The result lists the assigned numbers and paths as `tickets: [{number, path}]`.
  With an `objective`, `add` also appends the feature to each named Objective's `Features` in `.hud/objectives.md`, through the `hud_objective` writer (not committed). It does so before writing tickets: an unknown ID or a record that cannot be edited rejects the batch.
  Without one, if the project has `.hud/objectives.md` and no Objective lists the feature, the tickets are still written and the result adds a `warning` naming the feature and the existing Objective IDs.
- **`update`**: pass `feature`, `ticket` (number), and any of `status`, `owner_try`, `tick` (1-based checklist item numbers), `blocked_by` (replacement blockers) or `objective`; or pass `updates: [{feature?, ticket, status?, owner_try?, tick?, blocked_by?, objective?}]` (item `feature` overrides top-level `feature`) to apply several updates in input order and return `updates` with per-item errors.
  An invalid acceptance item reports the valid range and leaves that ticket unchanged, even if other ticks in the same update are valid.
- **`sync`**: runs `hud tickets sync` for the given project and returns its output lines in `output`.

The default status is `ready-for-agent`; other allowed labels are `needs-triage`, `needs-info`, `ready-for-human`, `claimed`, `done`, and `wontfix`.
For `add` and `update`, `objective` sets the `**Objective:** <id>` header field. The ID must exist in the project's `.hud/objectives.md`; an unknown ID leaves the ticket unchanged. Only `add` also edits the Objective's `Features`.
A new `hud_create` with an explicit ticket snapshots its Objective ID and current title. The Inspector and job archive show this snapshot; retries, repairs and Sonic children keep it, even after a rename. Jobs with no recorded link stay unattributed.
This is a main-session tool.
In Git, `add`, `update`, and unattended acceptance write only under the main-checkout lease. With no backlog, no waiting land, and a free lease, `add` and `update` return their results immediately. Otherwise they return `state: queued` and a `receipt`, without assigned paths or item outcomes.
Queued edits survive MCP restarts and run in admission order per project, rechecking the checkout when the lease is granted. At every `main-checkout` lease handoff, edits pending at that moment drain in a bounded batch before the next waiting land takes the lease (order: running land, then pending edits, then the next land); edits arriving after the handoff wait for the following turn so edits cannot starve lands. A completion notice points to `hud_read({job: receipt})` for numbers and paths, per-item outcomes, or an error. If a write was interrupted and no commit can be confirmed, inspect the checkout before retrying.
The queue holds up to 64 pending edits (128 KiB per request) and 128 receipts total, pruning the oldest finished receipts first.
Each edit that changes tickets makes one local commit containing only those ticket files; a batch uses the first changed ticket in `tickets: <feature>/<NN> <op>`.
Commit or resolve hand edits to a ticket before asking HUD to change it. Unrelated staged and unstaged changes are left alone.
For GitHub-mirrored `.scratch/`, `add` and `update` refuse: edit GitHub Issues with `gh`, then call `hud_tickets` with `op: "sync"`.

Jobs are plain files in `$HUD_HOME/jobs/<job>/`.
Tabbed pi history stays in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/<cwd-dir>/`; job `sessions/` links to primary/helper files. Headless pi keeps its native session file in the job directory.
`job.json` records known native sessions as `sessions: [{harness, id, path?}]`, including repair continuations; reopening the same session does not duplicate it.
A CLI supervisor matches root exit events by launch and terminal identity. If it misses the event, it checks the recorded PID and start time; confirmed death without an exit event is an unknown exit, not a successful close. Losing a tab address alone does not end the job.
Each CLI dispatch and `hud_send` starts a turn (`turn.json`). If Herdr refuses the send before input, HUD keeps the worker's previous turn.
`hud_report` (or the fallback `hud-progress --done`) binds the CLI report's signature to the turn in the worker's prompt.
An undeclared report follows the quiet rule using herdr's turn status. Antigravity's status includes its in-turn background work; HUD does not separately scan CLI workers for background children.
A continuation invalidates an old receipt; rewriting a declared report requires a fresh receipt for that turn.
If a rewritten report stays quiet for the role's grace, it goes to `waiting_orchestrator` without settling or calling the Decision API.
Terminal output does not affect the receipt.
With a matching CLI receipt, closure follows a confirmed turn end or the 10-second post-declaration fallback. Pi uses its native settled turn with a changed report.
Open questions and uncollected sonic results do block it.
The watcher reaps the worker and descendants with captured ancestry, records that unverified processes were left alone, and retries unresolved cleanup on the slow tick.
Herdr's status alone never fails a live worker.
A turn quiet past the idle grace without a report gets one Decision API choice among fixed actions (keep waiting, one fixed prompt to write the report, `failed` only with a quota line on screen, or hand to the main session); below 0.8 confidence or on any error it goes to the main session.
Anything unclear is `waiting_orchestrator` with a reason.
CLI `state_trust` has two levels: `advisory` keeps those timings, while `turn`, after herdr has been seen `working` in the current turn and is now `done` or `idle`, settles a stable new report in 2 s or reaches the no-report quiet decision after 10 s (the post-decision wait is unchanged).
The default is `turn` for `agy`, `claude`, `codex` and `grok`; set, for example, `{"grok":{"state_trust":"advisory"}}` in `$HUD_HOME/harnesses.json` to override one agent without replacing its other defaults.
`hud_roster({detail:true})` shows the effective level, dispatch freezes it in `job.json`, and old jobs without it use `advisory`.
The supervisor wakes on herdr pushes, file changes and its own deadlines, plus a 30 s tick that re-reads the status once; it writes STATUS only when the row changes.
The on-demand watcher starts on `hud_create`, `hud_read`, `hud_send`, `hud_respond` or `hud_land` if needed.
It reaps finished tabs through HUD's bundled `hud-reap`, keeps failed tabs for two hours, and exits with no open job or pending failed-job deadline. Reaping requires launch ownership evidence; matching a tab label is not enough. Managed CLI and Pi jobs use the fork's launch and terminal IDs and the worker's exact PID and start time. A browser shell or split Pi helper must retain its original PID, start time and executable, own the foreground process group, and have no other live process in its terminal session except exact members recorded in a browser worker's startup snapshot. A shell waiting in a builtin such as `read` is indistinguishable under this rule. `hud-reap <job-dir> --after-pid PID` waits up to 30 seconds without acting, then refuses if STATUS names a different worker.
Managed CLI and pi worker panes can also wait on native permission menus. The watcher handles recognized menus independently of `hud unattended`: it reads the visible prompt on the job's own blocked herdr pane, never an owner pane or scrollback. A low-risk operation must be confined to the job's own managed worktree, task directory, scratchpad or dedicated temp directory, be reversible or regenerable, and involve no network writes, secrets, `git push`, installs or other paths. The local proof is deliberately narrow: `rm -f <directory>/*.png` in a verified job scratchpad or dedicated temp directory, or in the job's managed worktree when every matching file has the same content in Git's index. Untracked files elsewhere in the job's task directory or worktree are not eligible. `$S` is accepted only if that command assigns it a literal absolute path; an environment value is not proof. Wrapped commands, duplicate permission headings and other ambiguous prompts or operations are not auto-approved. Pi itself has no per-tool permission menu by default; a pi extension must expose a recognized blocked menu to participate.

The configured Decision API can recommend approve or hand to main with a reason; it cannot override the local proof. Missing credentials, errors and timeouts leave only that proof in force. HUD presses only a one-time approval, never always-allow or an automatic denial. Other supported prompts go to the dispatching main session through the ordinary watch/changes/notice path, with the prompt, recommendation and a `hud_respond` action (`request_id: "perm-…"`, `answer: "approve"` or `"decline"`). When the option cannot be mapped safely, main must inspect the native menu. Main decides whether to escalate to the owner. The bar's `Main` count and the job detail mark this as main load, not an owner question.

The job's private `permissions.json` keeps up to 12 recent prompts, decisions, reasons and outcomes, bounded by 64 KiB. The Inspector shows the latest decision on one line; `hud_read` full view includes its full text. Before answering, HUD re-reads the visible menu and requires the same menu fingerprint and selected option. A changed menu goes to main for inspection rather than receiving keys. The recheck and send are separate herdr requests; herdr has no conditional key send. HUD records the attempt before sending keys. If the pane stays blocked, a reflow or identical-looking menu is not permission to send again, even after a watcher restart or lost reply. An ambiguous transition goes to main for manual reconciliation; a new automatic answer requires observing the pane unblock first. The client's own timeout still applies.

The watcher learns of a HUD runner's exit through a socket close, not a periodic scan.
Pi tab workers have no such runner; their liveness and pending stop/read-close checks use `HUD_WATCH_CLI_CHECK_MS` (default 30000).
A dead supervisor with a live worker leaves the job `waiting_orchestrator` ("supervisor exited; worker still running"); the watcher rechecks this unsupervised worker with exponential backoff.
`hud_send` to it starts a new supervisor.
Settled directories normally expire from live `$HUD_HOME/jobs/` **one day after closure** on a later watcher scan, not a dedicated expiry timer; pruning moves their data into the compressed cold archive before removal so `hud_read` can still read old reports.
An unresolved owner hold in a current ordinary ticket queue keeps the source job, report and worktree until the hold is resolved or the run is stopped or superseded; a missing or unreadable ticket file does not clear the hold.
To resolve it by landing manually, wait for `hud_land({job})` to succeed before resuming with `hud_tickets({op: "run", feature})`. Once that land succeeds, the checkout is released while the job report and completed land receipt stay until the resumed queue finishes, stops or is superseded; the successor includes the ticket in milestone review and acceptance using that job's completed land receipt, not the ticket's status.
Lands that did not resolve a hold follow normal job and receipt retention even if the queue is still open.
A headless pi job with a native session file stored only in its job directory stays for at least **seven days after settlement**.
Before deleting a legacy pi job it moves real JSONL sessions to pi's store; CLI and browser sessions stay in their own stores.
Invalid cwd, destination conflicts or failed moves retain the job.
Removing session links never removes their targets.
On a scan after `resume_s` expires, the watcher moves `stdout.jsonl` and `stderr.log` from cleanly settled jobs (`done` or closed with a report) into the job's cold raw archive before unlinking the live copies.
Sonic and older jobs without `resume_s` get the default 1620 seconds.
Failed or stopped jobs keep their raw logs in the live job directory until directory expiry.
At settlement the watcher saves a bounded, best-effort snapshot of native usage in the job directory before raw logs can be pruned.
It reads pi session entries, CLI result streams, or native transcript usage records; it never prices missing tokens or treats a truncated per-request transcript as a total.
Before deleting an expired job directory, the watcher writes its compressed cold archive under `$HUD_HOME/archive/cold/YYYY-MM/` (zstd-compressed POSIX tar, directories `0700`, files `0600`, atomic temp-file + rename, idempotent on re-run sweeps):
- `<job>.text.tar.zst`: text records and artifacts (`job.json`, `STATUS.json`, `usage.json`, `brief.md`, `report.md`, `report-meta.json`, `checks.json`, `qa/*`, `worker-tree.json`, progress/permission receipts, and the job's `flows/f*` and `flows/j*` receipts and gate logs). Text members are never deleted.
- `<job>.raw.tar.zst`: raw transcripts (`stdout.jsonl`, `stderr.log`, `sonic-session.jsonl`, and any remaining local session copies), merged with any logs moved early after `resume_s`.
- `<flow>.text.tar.zst`: standalone flow runs not owned by one job (`q*` ticket queues, `b*` batches, `w*` composed workflows, including their `flows/<flow>/` files and sidecars).

If any cold-archive write fails, the watcher keeps the source files in place and retries on a later sweep; repeated sweeps merge without duplicating or truncating entries. Raw archive size is capped by `$HUD_HOME/config.json` → `retention.coldRawCapGB` (default `20`, measured in GiB, enforced when a raw member is written): oldest `.raw.tar.zst` members are deleted first, and `.text.tar.zst` members are never deleted. Neither watcher refresh scans nor panel reads scan `$HUD_HOME/archive/cold/`. `hud_read({job})` falls back to `<job>.text.tar.zst` when the live job directory is gone, returning the report digest or paginated full report (including `offset`). Use `hud archive list [--month YYYY-MM] [--json]` and `hud archive extract <id> [--out DIR] [--part all|text|raw] [--force] [--json]` to inspect or extract archived jobs and flows.

Before deletion it also appends prose-free job facts to `$HUD_HOME/archive/YYYY-MM.jsonl`, including ticket, route, question count, land outcome, available usage and the worker's bounded declared summary with home paths removed.
The line includes `sessions`, `retry_of`, `dispatcher: {harness, id}` and the status flag `output_written` when recorded.
Session paths are recorded as observed; the underlying files may later move or disappear.
`questions: [{id, asked_at, answered_at?, answered_by?, used_default?}]` records the modification times of question and answer files, who answered (`orchestrator` via `hud_respond`, or `owner` from the panel or `hud_respond` with `by: "owner"`), and whether the answer matched the question's default or the question timed out onto it, without their text.
`land` keeps its attempt, repair and rerun counts. Its `created_at` comes from the published attempt, or the latest attempt if none published.
`land.attempt_details` records each attempt's number, state, known timestamps, published SHA if any, and repair and rerun counts.
`repair_details: [{attempt, step_kind, step, outcome}]` uses `conflict` for cherry-pick and `gate` otherwise.
`rerun_details: [{attempt, step, passed_unchanged, tests?}]` records known rerun results and the recorded flaky command or test names for unchanged reruns that passed.
When present, archive lines also record placement, worktree and stop facts: `model_source`, `thinking_source`, `imp_preset`, `requested_on`, `requested_model`, `had_worktree`, `worktree_removed_at`, `worktree_kept_reason`, and `stop_origin: {actor, prior_state, at}` (`mcp`, `panel`, or `pane_vanished`, recorded once when a working job is stopped or its pane vanishes).
For reviewer jobs that declare them, `job.json` and the archive line also keep `findings: {blocker, major, minor}` and `reviewed: {base, head}` unchanged (omitted when undeclared or dropped).
For settled sonic jobs, `job.json` and the archive line also keep `reads` (or `null` when the session was missing or unreadable), `brief_bytes`, and `report_bytes` when recorded.
Older archive lines may omit the new fields.
The monthly fact rows store neither the brief nor the report body; append failures do not delay deletion, and HUD does not expire the fact archive.
In the same housekeeping pass, once a job directory is gone, the watcher archives settled land receipts, gate logs and sidecars in `$HUD_HOME/flows/` into the job's `<job>.text.tar.zst` (and standalone expired `q*`/`b*`/`w*` flows into `<flow>.text.tar.zst`) before unlinking them after a day without changes.

### Unattended service

From a registered project with a working land configuration and herdr/worker harnesses, run `hud unattended on --objective <id> [--objective <id>...]`. The IDs are local to that project. Before enabling, HUD checks the land configuration and project trust for the CLI harnesses the implementer, reviewer and lead can use, including eligible fallbacks and the configured implementer routing pool. If trust is missing, HUD prints the exact `hud trust` command for you to run; it does not grant trust itself. A second `on` replaces the selection without starting another service. `hud unattended status` shows the exact process identity, selected Objectives, runs, policy hand-backs and scheduler diagnostics. Settings → Panel → Unattended uses the last selection; the CLI sets the selection the first time. Neither activity nor presence can switch the service on. It survives main and MCP exit, but does not auto-start after reboot. The resident wakes on ticket, Objective, flow and job-index changes with a coarse reconciliation fallback (minutes, not seconds), runs one readiness pass per admission batch, and skips ticket body reads on unchanged ticks.

The unit of work is **one active ticket-queue run per `(project, Objective)`**, over all ready tickets belonging to that Objective, with the normal `max_parallel`. A paused or waiting run still owns its Objective, and unattended does not re-admit a ticket that already has a job in an open run. HUD uses an explicit `Objective:` link or, if absent, the feature's unique Objective, and requires that Objective to be selected and active. Tickets must pass the normal ticket check, including a `Live try:` line (which can be a checklist item). `Blockers: none` and `Removes: none` are explicit declarations, ignoring case and trailing punctuation. Instead of a per-ticket pre-land lead, deterministic gates run before landing each settled ticket: any `docs/spec.md` diff holds the item (the landing path also re-checks `docs/spec.md` at publication time); the settled worker report must include an explicit `Removes:` line tied to the exact source head (missing line holds, never treated as `none`), and named removals are matched against the ticket's optional `Approved removals:` text — unapproved removals hold for the owner, and only a declared ambiguity starts a temporary `lead` check. Under the unattended escalation rule, a scope-tagged assumption or more than three `Assumed:` lines also goes to a temporary one-decision `lead` (`continue` lands the item; `hold` becomes an owner hold only when the verdict names a visible deletion or `docs/spec.md` change, otherwise repair). Baseline cost for N clean slices is **N + 2** sessions (N implementers + 1 milestone reviewer + 1 acceptance lead).

A held item stays on the item with its reason; it and its dependents are excluded from shared admission everywhere (including ordinary feature queues), while unrelated ready items in the Objective keep draining. If a ticket's dispatch is refused for trust after preflight, HUD holds it rather than retrying it. Retention pins a held item's source job, report and worktree until the hold clears. The `lead` role has no `hud_land` tool, and `startLand` refuses an unattended job unless called by its own run with the approved head — explicit manual `hud_land` by main or the panel stays available for held items. When no runnable or active work remains and there is no outstanding report-blocker decision, the run runs one milestone `reviewer` over the landed commits and one `lead` acceptance. A lead `finish` records durable acceptance per landed ticket (comment with run ID and verdict, status `done`), which both readiness and the board read (outside unattended runs, `Owner try: yes` behaviour is unchanged). Lead `repair` adds repair tickets admitted by the same run (verified admitted, bounded to 2 rounds on the run, then holds for the owner); a failed ticket's dependents are listed as blocked rather than silently stranded. Newly ready work after a run closes starts the next run.

Home shows the selected Objectives, running count and hand-backs, and the bar shows `Unatt` in the notice zone. Open a Home hand-back to see the ticket, run record and worker report. Answer an escalated report blocker with `hud_respond` as above, or resolve a hold through the normal manual workflow (for example, review and land the held job yourself or mark the ticket `wontfix`). Unresolved holds stay visible after turning the service off and, for holds that don't keep the run open, after it closes. `hud unattended off` stops new runs without stopping or signalling active runs; they retain their normal workflow steps. `hud unattended cancel <run>` (or main's `hud_tickets` `op: "run"` with `cancel: true` and `run: <id>`) cancels a working or paused unattended run without signalling any process, leaves its holds and evidence visible, and frees the Objective for a new run.

## Claude Code mod

`integrations/claude-mod/` is a Claude Code function-hooks plugin (`hud-mod`) that keeps the main session's context lean.
Run `./install --with claude,claude-mod` to install it alongside the Claude integration.
The `claude-mod` extension registers this checkout as the `myhud-local` marketplace and installs `hud-mod@myhud-local` in Claude's user scope.
Selecting `claude` alone does not install the mod.
To try it, run `claude --plugin-dir integrations/claude-mod`.
The panel uses the shared herdr dock.

- **Event wake.**
  In an interactive herdr main session the mod starts `hud watch --mod` in a HUD project or on the first HUD tool call.
  It sends the quiet watch's actionable job notices, batch tallies, land results and panel decisions, not routine checkpoints or queue positions.
  Settlements share a three-second window; questions do not wait for it.
  One batch submits a prompt when idle, without editing the draft.
  During work the mod appends a merged note; on interruption it parks pending events for the next prompt rather than waking again.
  On takeover, open questions, unobserved failures, and unread reports for the caller's jobs settled in the last two hours (or since the previous mod watch's last recorded delivery) are shown individually.
  Older unread reports share one count.
  While the mod owns wake, tools omit `changes`, no MCP tasks are created, and no panel messages are typed; `hud_create({jobs})` works.
  After ten minutes with nothing pending the child exits.
  A HUD call starts it again, as does a new panel decision in a sleeping HUD project.
  A dead watch leaves `changes` and `hud_wait` available.
  Sessions without the mod keep their existing MCP task or Monitor delivery.

- **Merged notices.**
  Within one turn a HUD line already delivered by a Monitor row, the wake lane or compact MCP `changes` is not repeated.
  A later Monitor row of the same task shrinks to its new lines without task id and summary (`(HUD events already shown this turn)` when none).
  The mod removes already-shown `changes` lines without reformatting the rest of the tool result.
  Rows that are not HUD lines are untouched.
- **Owner band.**
  Above the prompt the mod shows one row for explicit owner waiting items, cut to the band's width in the panel's language, and nothing otherwise.
  `? N waiting for you · <first item> [Open]` counts the same open STATE requests as the Project overview; Open shows the dock without toggling it closed.
  A press answers with a toast, never a model turn.
  Running workers, failures and worker questions are not shown in the band; main still receives job events.
  The watch sends a `band` record after `ready` and again only when it changes; the band is drawn from the session's state with no I/O and stays empty while a survey holds it.
  One toast (`Needs you: …`) appears when a new waiting item arrives, once per record and never for what was already there when the watch started.
  The band refreshes while the watch runs; after the ten-minute idle exit it updates at the next restart (a HUD call or panel decision).
- **Owner commands.**
  In an owner session (not a worker's) the mod declares slash commands that run at once, even mid-turn, and print for the owner only: their output is shown and goes in no model request, and no MCP schema is added.
  The exception is `/council <request>`: it authorizes one council and submits the request to the main session.
  `/hud` toggles the dock and reports whether it opened or closed (in herdr; elsewhere the command handles it). `/hud on`, `/hud off` and `/hud status` open, close or report its state.
  `/jobs` lists running jobs and unread reports and `/jobs <id>` peeks one, without marking a report read.
  `/answer <job> <qN> <answer>`, `/try` (Accept all), `/retry <job>` and `/stop <job>` run `hud act`, so they do what the panel does: an answer writes `qa/qN.answer.md` once, resumes a headless job and tells the main session (`ANSWERED qN from panel`); a retry records the request for the main session to decide; `/stop` asks first unless the job is finished.
  `/land <job>` starts the land flow itself with `hud_land` on the session's HUD connection, asking first when the job's report is unread.
  There is no per-slice try action.
- **Dispatch convention.**
  The mod shortens only the shipped convention in `hud_roster`; project and owner conventions pass through unchanged.
  In the main session, new `imp` and `frontend-imp` jobs require explicit `isolation` (not retries), read-only roles use no worktree, and new tickets require explicit `owner_try`.
  A model call to `hud_close` on a running job asks the owner first.
  While the mod watch is live, use its events instead of another `hud watch`, `hud_wait`, or `hud_read` with positive `wait_ms`.
- **Report reads.**
  `Read`, `Grep`, or a `cat`/`head`/`tail`/`less`/`sed`/`awk`/`grep`/`rg` command on `…/jobs/<id>/report.md` is refused with `Read HUD job reports with hud_read job=<id> (mode: "full" for the whole report), not from the file.` Other reads pass.
  A worker session (`HUD_JOB_DIR` set) has no `hud_read` and may read the file, as `from_jobs` hands reports to workers as files.

## Project workers

A registered project can opt into scratch cleanup in `.hud/project.json`, for example `"scratch": {"paths": ["tmp/tasks"], "keep_days": 7}`.
Only designate directories holding disposable data.
At most once an hour, during an on-demand scan, the watcher removes top-level entries in those directories whose newest file is older than `keep_days` (default 7).
It refuses `..` path components, paths outside the project root, and the root itself.
It never follows symlinks and logs the number of entries removed in `$HUD_HOME/watch.log`.

```sh
hud setup --detect [--cwd DIR]
hud setup --apply PLAN.json [--cwd DIR]
hud setup --remove [--cwd DIR]
```

Non-interactive.
The `hud-setup` skill, installed beside `hud-delegate` for Claude, Codex and pi, asks; these commands only read or write.

`--detect` prints one JSON document and writes nothing.
It names the git root of `--cwd` (or `--cwd` itself), whether that root is registered, reference roles (shipped and `$HUD_HOME/roles`), project roles with their ordered `run` chains, the enabled set, invalid role files, skills and worker-skill links. `pi.installed` and `pi.path` report whether `pi` is on PATH and its resolved location (or `null`).
Optional roles in the inventory carry an `enabled` flag; enabling one is a machine-wide choice in Control, not a project setup change.
From a registered main checkout, `proposed_disposable` lists suggested globs for ignored leftovers in kept worktrees.
Skill roots come from `$HUD_HOME/setup.json` `skill_roots` (defaulting to `~/.pi/agent/skills`, `~/.claude/skills` and `~/.agents/skills`), always followed by the checkout's `integrations/skills`.
A skill is a directory with `SKILL.md`; its name is the frontmatter `name`.
Each skill includes `model_invocable`: false when that frontmatter has `disable-model-invocation: true`.
Pi still loads such a skill, but leaves it out of the model's skill list, so a worker will not pick it by itself.

`--apply` reads a plan and writes under the project's `.hud/`, which is meant to be committed:

```
.hud/project.json          enabled roles, and the links, role files and prompts apply made
.hud/roles/<name>.json     a project chain or a pi role that differs from its reference
.hud/skills/<name>         symlink to the skill directory (workers only)
.hud/agents/<role>.md      optional worker-only prompt
.hud/hud-convention.md     optional copy of the shipped convention
.hud/brief.md              optional standing brief (add manually; not managed by setup)
```

The plan is version 1: `roles` (enabled names), `pi_roles` (pi tuning only: `from`, `pi_role`, `model`, `thinking`, `split`, `can_continue`, `skills`), optional `runs` (role name to a non-empty ordered list of places), `skills` (name to an absolute skill directory), `agents` (role to markdown), `convention` (`keep` or `copy-default`), and optional `disposable` (only globs the owner accepts).
Apply adds these globs to `worktree.disposable`; it does not run cleanup or remove existing globs.
`runs` can name reference roles or copies in `pi_roles`.
If both fields name a role, `runs` sets its order and `pi_roles` fills in defaults for each pi place.
It prints `removed`, `wrote`, `linked`, `skipped (exists)`, `registered`, or `no changes`.
The same plan again changes nothing.
A file or link apply did not make is left in place and reported as skipped.

Applying records the root in `$HUD_HOME/projects.json`.
Project config loads only after that, including the standing brief.
`--remove` drops the registration and leaves `.hud/` alone; the standing brief is no longer used.

A registered project's role file may list pi and CLI places in `run` and in `presets[].run`.
A CLI place accepts only `harness: "cli"`, `agent`, `model` and `thinking`; no extra arguments.
Browser (`bro`) places are not allowed.
Worker tuning (settings, skills and prompts) is still pi only; setup does not edit any CLI's own files or run `hud trust`.
If a CLI place needs a trust grant for the project directory, run `hud trust <dir>` yourself.

## Home

Home is a portfolio. When unattended mode is on, its status line sits directly below the tabs, followed by the pinned request area (zero rows, no heading and no placeholder when empty, replacing the old **Waiting** section). On **Home** it lists open requests across all registered projects as `? project › Objective  sentence…  work waits age`; on **Project** and its sub-pages (including Objective details) it lists only the selected project's requests as `? Objective  sentence…  work waits age` (no project name); **Execution** and **Control** show no request rows. The sentence sits on the same row when at least 24 cells remain, otherwise on a second row cut to one row; when narrow, `work waits` leaves before a project or Objective name is cut below 8 cells, and age stays. Up to four requests are shown at a time, followed by `N more requests` (`另 N 个请求` in Chinese), which Enter or a click expands in place. Moving up from the first body row reaches the last request row. Requests come from `## Waiting for the owner` in `docs/handoff/STATE.md` (or root `STATE.md`). Main opens a request with `hud_objective` (`op: "request"`) only when the owner needs to decide or act. Say what is needed, why now and where to look; answer in the responsible main session and have it record the answer with `op: "resolve"`.

A bullet may start with an ISO date (`2026-11-23`). Only `(work waits)` raises its rank: work is waiting for the owner's answer. `(waits on feature/NN, …)` marks a dependency, not a higher rank, and clears the request when all named tickets are done or dropped. After waited-on requests, order by project priority (`high`, `normal`, `low`), then oldest dated first. Undated requests come after dated requests at the same rank and keep their file order. `?N` tab badges stay: **Home** counts open requests across all registered projects and **Project** counts the selected project (using the every-tab light project overviews off Home). The owner band and the HTML export stay project-scoped. Press Enter on a request row or click it to open its full text in that project's Waiting page (`o` opens `STATE.md`).

Ordinary questions, failures, blockers and completions go to main, not to the owner as HUD alerts. An original worker question stays in Jobs → Inspector, and `hud_respond` still sends the answer and continues the worker.

Under **Active today** (`今日活跃项目`, with its count), Home lists registered projects **active today**: a HUD job started, settled or landed today, STATE or Objectives was updated today, a job is running or queued, or an owner request is open. Today starts at local midnight. Job activity uses the bounded live job window and archived job and landing receipts. The remaining registrations, including quiet, paused or unavailable projects, are behind `▸ N other projects` (`▸ N 个其他项目`) at the end of the list. Press `a`, or select the row and press Enter, to expand them below it (`▾`). Press `a` again to fold them. This choice resets when the panel restarts. When no project is active today, only the fold row appears under Active today.

Within each group, projects with open owner requests come first. Next are projects with active stance, ordered by owner priority (`high`, `normal`, `low`) and then by most recent activity. Projects that have records but no declared stance sort with active projects at normal priority. Maintenance comes next, then paused, each by most recent activity. Projects without Objectives or STATE follow, and unavailable roots come last. Ties keep registration order. The sort uses the same activity timestamp as the header age, not the age text, and does not change the order of the request list.

Each active project uses at most three rows (plus its opt-in Advisor line when active): a header (`mark name · stance ── role load age`), one current-goal row, and one recent result row. The header shows `?` when an owner request is open, `●` for running jobs, `○` when no running jobs are observed, or `✗` for an unavailable root. Started jobs waiting for main still count as running; queued jobs and native transcript threads do not. The header also shows non-active stance, non-normal priority, running and queued HUD jobs by role, and the age of the latest STATE or Objective update where known. The `idle` word appears only when the job scan confirms no running jobs and the header has no paused or maintenance stance. Unavailable roots show only the name and unavailable status.

The current-goal row shows `▸ id (+N)  one-line title` at every width (40–100 columns), where `(+N)` counts the project's other eligible Objectives (omitted when zero). Objectives blocked on an owner request come first, followed by Objectives with live or queued jobs, working ticket queues or working unattended runs. Other open Objectives sort by their most recent observed ticket change, landing or dated result. Paused Objectives go last among the open Objectives unless blocked, and ties keep Objective file order. An open Objective whose listed features are all known to have no open tickets is hidden from Home's goal row and `(+N)` count, but remains on Project. A done Objective is eligible only while its dated result is at most three days old (newest first). Home does not show per-Objective ticket bars, done/total counts, the **Unlinked** row, or the multi-row **Recent advice** block.

A dated result at most three days old appears on one row `✓ result excerpt  age` beneath the goal when the row budget allows (from the current goal when it has one, otherwise the project's newest recent result, including completed-ticket Objectives). A date is known only if the full result matches a digest or a complete short result in the bounded receipt history.

Without `objectives.md`, Home shows one dim STATE **Now** line when available instead of inferring an Objective. If both records are absent, it shows `no Objectives or handoff notes` and uses the latest observed HUD job activity for the header age. There is no age when no dated job is observed in the bounded job window.

Below the project list and fold row, **Today** (`今日`) shows one line across registered projects with no running count, for example `Today 12 landed · 1 failed` (`今日 12 已落地 · 1 失败`). Landings and failures count since local midnight; a stopped job is not a failure. Counts of zero are omitted, and there is no Today row when both counts are zero. A `~` marks a count from a history scan that reached its limit. Use `hud day` and `hud stats` for details.

**Schedule** lists open `hud_schedule` items by due date, with calendar-day countdowns. Today is highlighted and overdue is amber. A linked due item shows the project and, on narrow panels, its Objective when recorded. The dim quiet line lists available projects with no running job and a Home activity age over 14 days; paused and maintenance projects are skipped. The Home tab's calendar badge counts overdue and due-today items, even if the card is folded. It is separate from `?N` and never adds to Waiting or the bar's owner count. Home only reads the schedule: main uses `hud_schedule` to add, move or mark an item done. Enter or click a linked schedule item to open its project; an unlinked item can only be selected.

Short panels fold the cards before taking space from the projects. The last card row to go is the Schedule summary when something is due. Only then does Home drop result rows, then goal and note rows to leave one header row per project (no ticket bars or counts). Requests, visible projects and the fold row stay in the list even when it needs to scroll. Enter or click a project header to open its Project tab without granting worker access; Enter or click a goal or result row to open that Objective's page.

Press `v` or click **Jobs** for one plain row per retained HUD job of the calling pane, including queued, settled and Sonic child jobs. Press Enter or click a row for the [Inspector](#inspector), where reports and job actions live.

[Fixed batches](#universal-cli-and-mcp) of this project (and the calling pane's) head the list, one row each, unfinished ones first and newest first: the flow ID's first eight characters, `Batch`, `done/total`, then failed, running, waiting and cancelled counts as far as they fit, the role when there is room, and the state (`working`, `paused` in the attention colour, `stopping` while a stopped batch's members finish, `stopped`, `done`). A pause that nobody asked for shows its reason on up to two lines below. An ended batch stays listed for an hour after its last change. Waiting items have no job rows, so the batch row is where they show.

On a working or paused batch row, `X` opens one prompt above the list for the whole batch: `Batch <id>: stop cancels N waiting; M running finish.` with `p pause  s stop  Esc cancel`, or `r resume  s stop  Esc cancel` when paused. `p`, `r` or `s` acts at once; any other key or a click cancels (`q` still closes the panel). Running members are never stopped by it. If the batch changed state in the meantime and the action no longer applies, the panel says `Batch unchanged: <state>`.

## Project

Project → **Working tree** includes the Git diagnostics formerly on the separate Changes page: branch and HEAD, ahead/behind, staged/unstaged/untracked counts, and each worktree's path, branch and observed dirty state. The worktree probe runs only on that page. Unknown, stale and incomplete readings are not treated as clean. The probe does not fetch or run repository filters.

Project opens to the selected project's pinned requests below the project strip (zero rows when empty), then the header: declared stance, non-normal priority, update age, and links to **Tickets** (`t`), **Worktree** (`b`, only with Git facts), and **Docs** (`d`). Click a link or use its key; Esc or the crumb returns to the overview. Docs opens `STATE.md` when available. There is no separate Progress page or `p` shortcut on Project. Job rows are on **[Execution](#execution-page)**, not on the Project overview or Working tree.

In a registered project, main keeps `.hud/objectives.md` in Git. An optional header such as `**Stance:** active · **Priority:** high` declares stance (`active`, `paused`, `maintenance`; otherwise unknown) and priority (`high`, `normal`, `low`; otherwise `normal`). Each `## <id>: <title>` section has a unique lowercase slug (`[a-z0-9-]+`) and a `**State:** active|paused|done` line. Optional single-line fields are `**Next:**`, `**Result:**`, `**Features:**` (comma-separated `.scratch` feature slugs) and `**Evidence:**` (comma-separated repo paths, URLs or commit hashes). A linked request that work waits on marks the Objective as blocked in its detail without changing its declared state. When there is no Objective record, Project shows the available STATE **Now** and **Next** notes (up to two lines each).

Under **Objectives**, each open Objective shows its ID, an aggregate ticket bar, done/non-dropped ticket count, and an activity note. Ticketless Objectives have a dotted track; incomplete coverage has no count. The first tier that applies wins: live jobs or landing gates on linked tickets; a job or run that ended in the last 24 hours (newest first, with the observed result where known); an open request or pending owner try (requests first); then quiet work by latest activity. A muted one-line subtitle shows the title, or the result when recent work has a dated Objective result. Subtitles drop first when the viewport is short. The cursor starts on the first request, else the first Objective.

Done and paused Objectives, and Objectives whose linked tickets are all done or dropped, share one **Done/paused** fold. A live job, active landing gate or open request keeps an Objective out of the fold; the last landing folds it as soon as all its tickets are resolved. Enter expands the fold in place, newest first.

One **Unlinked** row summarizes scanned features outside the Objectives that have open tickets or live jobs. Enter opens their list, and Enter on a feature opens its Feature page (`o` opens its first unfinished ticket file, or the latest ticket if all are finished).

Press Enter on a Project Objective, a Home goal or recent Result row, or an Inspector job's Objective fact row to open the Objective sub-page (`‹ project › id`, with state and `done/total` tickets on the right; `[ ]` is disabled while this project's requests stay pinned at the top). The page shows the Objective title (up to 3 rows), next step (`›`), result (`✓` with age when dated), linked **Features** (`slug bar done/total note` with bars up to 24 cells and right-hand activity notes such as live, gate, just-landed ticket number, unlanded, failed or to-try counts, with no nested job rows), and every **Evidence** entry. Use ↑/↓ to select a feature or evidence entry, Enter to open a scanned feature's Feature page (`o` opens its first unfinished ticket file, or the latest ticket if all are resolved) or open an evidence entry, and Esc to return to the row and scroll that opened the page. Repo-relative files and reports written as `$HUD_HOME/jobs/<id>/report.md` (or the corresponding absolute report path) open in `$EDITOR`; commit hashes open `git show` in the Objective's project. Evidence marks missing files and displays URLs in full without launching them.

Press Enter on a feature row on the Objective page, the Unlinked list, or the **Tickets** page (`t`) to open the **Feature** sub-page (`‹ project › [objective ›] slug` at ≥ 56 columns; the project name leaves below 56 columns, with `done/total` tickets on the right; `[ ]` is disabled while this project's requests stay pinned at the top). The page shows the feature's stacked ticket bar with a legend of counts, followed by **Tickets** ordered **to try → working → blocked → ready → queued** (by number) **→ done** (newest first) **→ dropped**, with no separate running or recently-ended job sections. Each ticket takes one row with its state mark, state word, blockers (`← NN`), and—when a live or ≤ 24 h job exists for the ticket—its observed job status on the right (for example `◐ working 14m`, `Gate 2/3`, `◒ not landed 40m`, `✓ landed 30m`). Press Enter on a ticket with a live or retained job to open that job's Inspector (Esc returns to the ticket row); without one, Enter expands or folds the ticket's checklist and `Landed` / latest comment inline. `o` always opens the ticket file. On a live tab job's ticket row, `g`, `P` and `H` focus, pin or hide its tab as on Execution. Esc or the crumb returns to the feature row and scroll that opened the page.

Use `hud_objective` with `op: "set"`, `cwd`, `id` and any changed fields (`title` and `state` required on creation; `features` and `evidence` are arrays). Omitted fields are untouched; an empty string or array clears an optional field. Use `op: "project"` with `stance` and/or `priority` for the header. The tool writes atomically but does not commit. It appends one receipt per material call (creation, state, title, then result, in that order if several apply) to private `$HUD_HOME/events/YYYY-MM.jsonl`, separate from the job archive. These small monthly append-only files are not automatically pruned. A changed result includes a bounded excerpt and a digest of its full text, regardless of the primary change kind. Hand edits are visible but do not create receipts.

Use `hud_objective` with `op: "request"`, `cwd`, `text` (one line), optional `objective` (an existing ID), and `waits: true` if work is waiting. It appends a dated `[rN]` bullet under `## Waiting for the owner`, with optional `(objective <id>)` and `(work waits)` markers. The request drill-down retains the request ID and current Objective title. Use `op: "resolve"`, `cwd`, `request` (e.g. `r3`), and optional `resolution` (`resolved` by default, or `withdrawn`) and `note` to remove it. Both operations append a request receipt to the same events archive with project, request ID, Objective if linked, whether work waited, change, time and known caller identity. Resolving does not mark tickets. Legacy hand edits to STATE still work without receipts.

Each Project page keeps its own cursor and scroll, even across panel reloads. Esc or the crumb (`‹ Project › Page`) returns to the overview.
Enter on `N more` reveals the remaining requests. Enter on a request opens its whole text, including continuation lines; Esc or the crumb returns to its row, and `o` opens STATE.md. Old accept records can still settle legacy slice IDs.

Facts come from `docs/handoff/STATE.md` (root `STATE.md` fallback), `docs/spec.md`, reviews, roles/convention/instructions and Git/worktrees.
No milestone or completion is guessed.
Key rows contain names/presence only; Browser ✓ means Chrome and `jev-ask` exist on PATH, not a running/logged-in browser.

Tickets use `.scratch/<feature>/issues/<NN>-<slug>.md`.
The list shows scanned features with open tickets, then the newest finished features to fill 16 slots.
The scan enumerates feature names, checks up to 256 for an `issues` directory, then reads up to 64 of those directories by recency, at most 64 files per feature and 512 total, up to 64 KiB per file.
In the Tickets diagnostics, totals are marked `Partial` if a cap or a failed read leaves the scan incomplete.
Required: matching `# NN: title`, `**Blocked by:**`, `**Status:**`.
`hud tickets sync [--cwd DIR]` mirrors GitHub Issues one way into `.scratch/` via `gh` (open parent issues with sub-issues, plus already-mirrored parents so closed features receive their final state), writing `.gitignore` (`*`), `spec.md` and numbered ticket files with a generated marker; it refuses if `.scratch/` holds non-generated ticket files.
A recorded acceptance or done/closed/complete/resolved status completes a ticket, as does a fully checked nonempty checklist unless it awaits a try.
Dropped tickets count as resolved on the Tickets page.
A ticket ID in the latest 64 commit subjects can show a ticket as landed and release its dependents; it shows **to try** only with `**Owner try:** yes`. Legacy pending records remain readable.
Local numbers/titles and `feature/NN` blockers resolve across the scanned project.
Waiting only for ordinary predecessors or known cross-feature blockers is **Queued**. An unknown blocker or a stalled predecessor in the same feature is **Stalled**.
Working jobs and managed worktrees are linked at read time, never written back to the tracker.
Ticket claims use a bounded lookup of the newest 64 top-level jobs and up to 64 of their children. The Objective activity notes reuse Execution's bounded recent job and run evidence.
**Tickets page**: one row per `.scratch` feature, with resolved/total (including dropped tickets as resolved) and the oldest open ticket's status.
**Accept all** appears here when there are pending tries. Select it and press Enter (or click the selected row) to accept all observed pending tickets in the displayed project in one `$HUD_HOME/tries.jsonl` record. If the read is partial, only the tickets found are included. The action does not write to project files; `hud watch` and MCP `changes` receive one line. Old records remain readable.
Press Enter on a feature row to open its **Feature** sub-page: stacked ticket bar, count legend, and **Tickets** ordered **to try → working → blocked → ready → queued** (by number) **→ done** (newest first) **→ dropped**, with blockers (`← NN`) and observed live or ≤ 24 h job status on the right of each ticket row.
On a ticket with a live or retained job, Enter opens that job's Inspector (`g`, `P` and `H` control a live job's tab); without one, Enter expands or folds the ticket's checklist (`✓` / `○`) and `Landed` / latest comment (`## Comments`) inline. `o` always opens the ticket file.
`/` filters the Tickets list by feature slug or ticket number, title, status or blocker; the active filter survives opening a Feature (and its Inspector) and returns on Esc, and clears when leaving Tickets.

**Control tab.**
Control is a main tab after Project.
It names and follows the project selected in Project; `[`/`]` change that same selection without changing Home's root.
Control reads that root's role and file facts without collecting its Git status, worktrees or tickets.
The Roles view starts with:

- **Needs attention**: roles with exhausted places that are enabled, with no available place, or with a missing selected preset, plus invalid role files.
  A role reads `imp [daily] → agy`; when a reason needs attention, it is explained underneath.
  An invalid file opens with Enter or `o`.
- **Healthy**: folded to role names.
  Enter shows one row per role with its next target and, on project-owned roles, a `project` tag.
  Only named presets other than `default` get a preset tag; a file chain without a selector has no tag either.
- **Leases**: when the selected project has active leases, one read-only row per lease shows its name, holder and age.
- **Usage** and **Files**: both folded.
  The reported job-usage block uses the same retained-job, archive and land data as `hud day`, with cost coverage and today's totals by role and by role/place/mode.
  Usage opens quota windows, pi spend and today's per-role dispatch health (one row per role that never wraps: counts as words while every role's row fits, else as `✓ ✗` marks, and a row still too wide drops its `avg`, then its `quiet`; place names cut at the end with `…`; split into per-place sub-rows for launches, launch failures, hand-offs to main and quota marks when a role used 2+ places or had a launch failure or quota mark; display only).
  Files opens the convention, instructions, pi definitions, ignored configuration, native agents, and local presence checks for keys, browser and harnesses.

The role row names the next model when it fits whole; otherwise it shows the harness (and provider for pi, when known).
A known inherited model is muted.
Enter expands the numbered chain and its source under the role; Esc returns to the list.
`o` on a role or place opens its source.
Chain marks: `◉` next, `○` standby, `⊘` switched off, `✗` exhausted and `−` not installed.
`x` clears a real quota mark, even on a switched-off place; it does not turn that place on.

**Harnesses** (`h` from Roles, or click the Harnesses heading) lists the pi runner, compiled CLI agents, browser tools and pi providers for **this machine, all projects**.
Space or Enter toggles the selected switch; Del removes an enabled entry by turning it off, not uninstalling it.
Enter on **Off** expands or folds the disabled entries.
`i` opens **Add back**: type part of a switch ID, use ↑↓ to select, Enter to restore or Esc to cancel.
Presence is separate from the switch: installed means the executable was found, and a provider being listed is not proof of login or quota.
A provider under an off runner keeps its switch and shows `pi off`.
`jev-ask` switches both ChatGPT and Gemini; `jev-aistudio` switches Argon.
`r` refreshes the local model lists.

An explicit switch action writes only the `disabled` property in `$HUD_HOME/harnesses.json` (atomically, mode 0600), retaining other keys and leaving every role file byte-for-byte unchanged.
IDs are `pi`, `pi:<provider>`, `cli:<agent>` and `bro:<tool>`; absent means on, including newly discovered or unlisted targets.
`cli:grok` and `pi:xai` are independent.
Invalid or unreadable switch data is a configuration error, not an all-on default.

Roles, `hud_roster` and `hud_create` use the same next-place evaluation: off, live quota and missing executables are skipped in order.
With `pi:xai` off, `imp [daily]` can go to `agy` without changing the preset or deleting the pi place.
Restoring xai lets it return to its original position, but not until any real quota mark is cleared or expires.
A pi provider comes from a qualified explicit or HUD pi profile model, a unique exact bare model match in the unfiltered cache, or pi settings when no model is set.
Unknown providers are shown and do not block dispatch.
`pi_args` are not read for attribution.
The same policy applies to `general`’s per-job `preset`, `on` and `model` overrides; an explicit off target is refused, not silently rerouted.
If no place can run, `hud_create` returns `no_available_place` before creating a job.

A role file can name additional MCP servers for Claude and Codex CLI workers, for example `"mcp_servers": ["chrome-devtools"]`.
Omit the field or use `[]` to load only the HUD worker MCP.
Claude takes the named entries from `mcpServers` in the user's `.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when set) and starts with a strict, job-private config.
An unknown Claude server name fails that launch attempt.
Codex disables unlisted servers with per-run overrides; named servers keep their configured state.
If HUD cannot read a Codex configuration layer it leaves MCPs as configured and records `mcp scope not applied` in the launch diagnostics.
HUD does not edit harness configuration to scope MCPs.

Claude appends the role file to its system prompt, and Codex uses developer instructions.
Grok appends role text as rules when it contains no control characters; otherwise it prepends the instructions to the first message or points to the role file if it cannot inline them.
Claude uses that same fallback if the role path contains a control character.
Herdr cannot encode control characters (including newlines and tabs) in CLI startup arguments; other such arguments make HUD skip that place rather than change the argument.
Agy has no equivalent system-prompt flag or strict MCP selector: it uses its configured MCPs and prepends the role instructions and, in a registered project, `.hud/brief.md`.
Text inlined in the first message must be under 16 KiB and contain no NUL; otherwise the message points to the corresponding file.
This also applies to the assembled `brief.md` for all four CLIs.

Role files may carry `presets`: `[{ "name": "short-token", "run": [...] }]`, whole ordered place lists validated like `run`.
Names are unique per file, 1–32 characters from `[A-Za-z0-9._-]`.
Presets merge by name from shipped → owner → registered project.
At each layer, `hidden_presets` removes inherited names, then local definitions replace or append names.
The winning role file's `active_preset` selects a name; `null` selects the file's own `run`.
Without this field, the file chain still runs and the first exact normalized match still identifies the preset.
If an explicitly selected name is missing, the file chain runs and Control and the roster report the missing name.
A detailed `hud_roster` returns the effective `run`, `preset` and merged `presets`.
Only `general` can use `hud_create(preset: …)` to select a named chain for one job without saving it.

In **Control → Roles**, off optional roles are listed under **Optional roles**.
Select `council`, `pro` or `flow` and press Space (or click the footer's **Space on/off**) to toggle it for all projects.
This atomically writes `$HUD_HOME/role-switches.json` (mode 0600) without touching role files.
To set it by hand, use a JSON object such as `{ "pro": true, "flow": false }`; remove a key to fall back to whether an owner role file defines it.
A project's role allowlist still applies; it cannot turn a globally off role on.

On a **role row**, `c`/`C` immediately selects the next/previous named preset, wrapping in displayed order (from the file chain, first/last).
`p` opens one list including the file chain and any preset named `default`: type to filter, ↑↓ to choose, Enter to apply, Esc or Ctrl+C to cancel.
The list shows where each chain runs next; an all-off preset remains selectable and shows **none**.
`N` starts a draft copied from the current chain; `I` starts empty.
Enter a unique name and press Enter to open the draft.
`R` renames the selected named preset on Enter.
`D` previews deletion of the selected named preset and the file chain that will run next; Enter confirms, Esc cancels.
Selection, copy, rename and deletion never launch a job or overwrite `run`.
Quota marks stay with their places.

Only explicit edits write the global owner role file (`$HUD_HOME/roles`, atomically, mode 0600), even when viewing a registered project.
An inherited rename or deletion hides the old name in the owner layer instead of changing a shipped file.
Project-pinned roles show the source and a lock; `o` opens the file but the panel offers no preset or place edits there.
Shipped imp presets: `default`, `hydrogen`, `astra`; reviewer: `default`, `pi`; oracle: `fable`, `architect` (the former architect role's pi setup).
No separate architect HUD role remains.

Enter on a role opens its chain in place.
It stays read-only until you make a change.
`i` adds a place at the end; Enter on a place edits it.
In the sheet, move between Target, Model or Flow kind, Thinking (or browser Effort) where applicable, and Done.
Enter opens a field's list; type to filter, use ↑↓ or PgUp/PgDn to select, and press Enter to fill it.
Esc cancels the field or the sheet.
Off targets cannot be selected; missing executables are marked.
Existing off places remain in the chain.
Replacing a target that has launch options (`skills`, `pi_args`, `args`, `split: true` or other fields the sheet cannot preserve) is refused; `o` opens its source.

`K`/`J` move a place earlier/later and `Del` removes it.
The **Not saved** draft shows its next place separately from the saved chain.
`s` saves the whole nonempty chain and selects it; if validation or the write fails, or if the role changed on disk, the draft stays open.
To leave a dirty draft, confirm **Discard edits?** with Enter or resume with Esc.
Panel reload waits until the draft is closed.
Outside a draft, `x` clears the selected place's quota mark and `o` opens the role file.
`r` refreshes model lists.

Press `m` on a role row to change the `◉` place (or place 1 if none can run).
Press `m` on a place or click its model field (`[model ▾]`) to change that place directly.
Pi, CLI and AI Studio use the same picker.
Enter saves immediately to the active named preset or file chain and keeps the cursor where it was.
If a draft is open, Enter changes only the draft; `s` still saves it.
Flow has no model, and project-locked places show plain text and cannot be edited.

When unset, the model field shows the effective model in muted text if known, or just `[▾]`.
Unset thinking likewise shows the known value in muted text or stays blank.
If you open Edit place with Enter, its Model field still fills the form: choose Done to put the place in the draft, then `s` to save.
With an empty query, the picker starts with the current model, compatible models from this role's other presets (tagged except for `default`), the previous model from the last quick save for this place (`was`, kept only for this panel session), and a clear row when applicable.
The picker fills the panel body below the tabs.
For CLI and AI Studio it stays a single list at any width, showing model IDs from the catalog and available discovery, with no provider groups or facts strip.
In pi, the pinned models also stay in their groups.
Pi providers used by role or preset places (including resolved defaults for unset places) are open below: the current provider first, then by number of uses.
The `▸` row groups the other providers; Enter or a click opens or closes them together.
Individual headers are not selectable.
With no providers in use, all groups are open.
At 100 columns or more, the pi list has columns for context, max output, thinking, images and HUD state.
The read-only right column wraps the full model ID and shows those facts, whether it is current, which roles and presets use it, list age, and what Enter will do.
Below 100 columns, the bottom strip shows one row of facts and wraps the full ID above it if it was shortened.
Missing pi facts show `?`.

Type to filter full model IDs (`provider/model` for pi).
Every space-separated term must match, ignoring case (for example, `gpt mini`).
Results are one flat list.
Pi ranks providers in use first; all lists rank matches at the start of names, after separators, or inside words, then alphabetically.
One click on a model sets it.
The wheel scrolls three list rows at a time, keeping the selection visible.
↑↓ move without recentering the list, and PgUp/PgDn move one visible list window less one row.
Enter sets.
Esc clears a typed filter first, then closes without setting; clicking `esc cancel` or pressing Ctrl+C closes immediately.
`◉` marks the current assignment and `›` marks the cursor.
A long model ID is shortened in the middle in the list.
Pi rows mark exhaustion with `✗` and time to reset.
`⊘` means off and `?` means an unknown provider.
One muted line names off providers; their models are not offered.
A read-only current model stays visible; if its provider is off, the wide detail explains why the place is skipped.
Enter on a read-only current row in the wide view closes the picker without writing; in the narrow view it does nothing.
The clear row, when eligible, removes the explicit model.
It is labelled by the resulting model and its source when known (for example, `role's model (gpt-6.2-sol)`), or `clear` otherwise.
No pi match writes nothing; manual model IDs in role files and one-job overrides still work.
The old `catalog.pi.include` key no longer filters the picker and is left untouched in existing configuration.
While the picker is open, printable keys (including `q` and `r`) type into the filter; Backspace edits it.

The bounded list commands (`pi --list-models`, `agy models`, `grok models`) run when Control opens with an absent or stale pi list (one-day cache), or on `r` in Control outside the picker or Ctrl+R (`^R`) inside it.
Overlapping refreshes coalesce; typing, redraws and ticks never run them.
The same cache under `$HUD_HOME/display` holds the last good results and pi model facts; older caches still open.
The wide pi picker shows the list age.
The picker flags a failed refresh or a stale list when that status is available.
Without a successful pi list the picker labels the limited offline catalog.
A successful empty pi list is shown as empty.
Other harnesses' fields use their separate catalogs, merging discovered models where supported, then shipped and owner catalog models, then models from owner role files.
A chain save updates only its owner role file, keeping unrelated fields and presets.
`x` writes `$HUD_HOME/exhausted.json`, not the role.
The next `hud_roster` and `hud_create` read these same files.

**Switching projects.**
With more than one project a pinned one-row **project strip** sits directly under the tabs on **Project** and **Execution** (not **Home** or **Control**), replacing the old folded `▾ project i/n` picker header.
The strip lists the panel's own project first followed by the existing roots in `$HUD_HOME/projects.json` (deduplicated, never re-sorted by activity) so `[` and `]` always step to the neighbour on screen.
Each entry shows `?` for an open owner request, else `●` for live work, else no mark (idle names muted); the current project sits on the title surface and a rule fills any remaining width.
When the strip is wider than the pane, idle projects fold from the end into `+N`, then names shorten to 8 cells, and only then marked projects fold with `+N` carrying their strongest mark (`?` over `●`); the current project always stays visible.
Clicking a project name switches to it directly; clicking `+N` (or moving up onto `+N` and pressing Enter) opens the grouped **Projects list** (`‹ Projects` replaces the tabs and strip; Esc or a click on the crumb returns to the tab that opened it).
`[` and `]` step through projects on Project (hub and sub-pages, where the crumb shows the project's name and cursor, scroll and folds start fresh), Execution and Control (which keeps `[ ]` without the strip).
The choice belongs to the panel and survives its reload, not Settings.
Home's progress block always shows the panel's own project, and opening that block returns to it.
The panel keeps one collector per visited project (at most four, the panel's own never dropped, the oldest other one first) and collects only the shown one in full.
With one project there is no strip and no Projects list.

**Projects list.**
Groups are Needs you (STATE waiting items), Running, and Quiet.
Entries show counts and, when known, time since the last change to STATE.md or a ticket file.
Quiet projects take one row and show their milestone or `no STATE.md` when known.
Within each group the panel's own project comes first, then projects with waiting items, then those with running jobs, then the most recently touched.
Enter or one click opens the project (on the tab that opened the list); Esc returns to the list from a Project hub opened that way.
On the root hub, Esc does nothing.
The light per-project facts behind the strip marks and Projects list (STATE and tickets as Home reads them, cached by file signature, plus one pass over recent jobs for unsettled live work per root) refresh on every visible tab at most once every five seconds, off the paint path: Home reuses its portfolio reads, Help and Settings modals pause them, and opening the Projects list reads at once while pausing the shown project's full collection (no Git, no roles).
The last-touched time reads `12m`, `3h`, `4d` (`12分`, `3小时`, `4天` in Chinese).
A project without STATE.md has no STATE link in Docs; the other Project pages still work.

On a page Enter folds a header, shows a ticket's detail or opens a row's file, and `o` opens it in `$EDITOR` (default vim), in a herdr tab that closes with the editor; failed workspace lookup falls back to a split.
Home, Project, Execution and Control retain separate cursor/scroll state.
Full Project collection runs while the hub or a page is visible, not behind modals; Home reuses only cached STATE/ticket reads.
Git is gated to at most once per five seconds.
Reads do not start a browser or MCP.

### Execution page

Execution is its own top tab (`Execution·N` / `执行·N`, where `N` is the current project's live running, waiting and queued jobs, omitted at 0). It shows the panel's current project (the same project as the Project tab; `[` and `]` switch project on both tabs) and its live and recently ended work from every session and pane. It is the only place with execution detail: Home and the Projects list do not show it. A job belongs to the project when it works inside the project directory, in a worktree HUD manages for it, or its record names the project (a Sonic child working in its parent's worktree).

- **Readout:** how many jobs are running, waiting and queued. `Partial` says some job records were not read.
- **Workflow** (`工作流`): one Hairline metro map per open project flow above Workers, paused and held flows first, then working flows oldest first. Each flow has a one-line header (state glyph, kind, name, status and elapsed time), a 1–3 lane map (light solid `─│╭╮╰╯` in `muted` for travelled segments, dashed `╌╎` in `frame` for segments ahead, neutral line for every flow, colour only for state), and one detail line for the station under the cursor (or the station that changed last when the cursor is elsewhere). Stations show worker (`○ ◉ ●`), review (`◇ ◈ ◆`), acceptance/synthesis (`☆ ✪ ★`), asking (`?`), held (`!`), failed (`✗`), lease wait (`◷`), stalled (`◍`), stopped (`⊘`), unknown (`◌`), land gate (`‹▮◉▯›`, scaled to 5 cells when a gate has more than 5 commands) and repair loops (`stalled` line, `↻` without colour, `%` in ASCII). For narrow widths, settled stations fold to `●×N`, not-started waves fold to `○×M`, waves wider than 3 lanes keep the two most urgent and group the rest, batch pools render as one pill (`▐●×… ◉×…▌`), and council members merge into the synthesis station. In ASCII (`icons = text`), `=`/`-` and `|`/`:` draw lines, `.`/`'` turn corners, `{#@.}` draws gates and `×` is omitted; in theme `none`, `▸ ◂` (`> <` in ASCII) bracket the selected station. A contextual 0–2 row legend lists non-obvious marks on screen once below the last flow; `?` help holds the full legend (including `○ ◉ ●` and fold marks) and map keys. No open flows means no Workflow section. Flow records are read through the header cache before rendering.
- **Workers:** one framed card per live job, those asking for an answer or waiting for the main session first, then running (oldest first), then queued. The top edge has the state mark, role, model, preset (when the record names one), state and elapsed time. The bottom edge says who started it and whether it is a `tab`, `headless` or `queued` job. An open question shows under the title. A parent card summarizes direct children on one line; the full list is in its Inspector. Tab workers show their latest progress line; headless jobs show their last three progress lines or, if they have reported none, the newest lines of their output.
- **Recently ended** (`刚结束`): jobs, queues, batches and councils that ended in the last 24 hours, newest first. Each ended flow has one row instead of repeating its member jobs. Jobs show `failed` or `stopped` from their recorded state, `landed` when a land record names a landed commit, `not landed` for a worktree job without one, or `done` when there was nothing to land. An unreadable or inconclusive landing record leaves the result blank. Execution includes job directories touched within the 24-hour window without a count cap; the date shown is the recorded settlement, not the directory time. `Partial` indicates incomplete coverage. With no live jobs or open flows, only recent outcomes show; if there are none, the page says `No running or waiting jobs`.

While the cursor is on a workflow map, `←`/`→` move between stations and `↑`/`↓` move across lanes before leaving the map to the flow header or next item; `Tab`/`Shift+Tab` always switch tabs. Clicking a station cell selects it and updates the detail line; a second click or Enter opens the Inspector for a station with a retained job, or Run Detail from a flow header or recent flow row. Esc returns to the same target. `X` on a working or paused batch header opens its pause/resume/stop controls. `g` peeks/focuses the selected worker's herdr tab, `P` pins it visible, and `H` hides it again, from a worker card, map station or Inspector, with the same conditions as in [Inspector](#inspector). Headless and queued jobs have no tab. Execution does not periodically read worker panes; on-demand pane reads stay in `hud_peek` and pane-selection sends.

### Send a pane selection to a worker

In the herdr selection composer, press Tab to open the target picker, use ↑/↓ to choose a target, then Enter to select it. Main is the default. The list also shows the project's working pi, Claude Code and Codex tab workers with their role and ticket or package when known. Headless jobs are not offered: their queue would need to resume them after the current turn. If the selected job has ended, the composer offers main; it never sends there until you confirm again, and it never resumes or repairs the worker.

A direct worker send adds an excerpt ID to the confirmed excerpt, source and question sent to the worker's conversation. The worker can answer without ending the turn using `hud_progress({reply_to: "<excerpt ID>", message: "<answer>"})`. An ordinary progress message, a wrong ID or a reply from a different job cannot mark an excerpt answered. Inspector keeps the excerpt and matching answer together under **Selections**; Execution shows compact cards for the project, including `queued`, `answered`, `target ended` and `delivery unknown`. The newest 64 direct sends are kept privately in `$HUD_HOME/selection-excerpts.json`, independently of their source panes. Sending to main does not add an excerpt card.

The same plugin also defines the pane action `hud.select-send.investigate` (**Investigate this**, `contexts = ["pane"]`). It reads the pane's visible output (`pane.read`, falling back to `recent`), opens the composer on the project's working-job picker (working jobs only; closed targets are refused and never fall back to main), pre-fills the owner line with `Investigate this`, and delivers through the same excerpt-record and reply path.

## Review board

`hud board [--html] [--cwd DIR] [--out FILE] [--open]` writes the project's review board: one static HTML file for a browser, with no script, font, image, link or network request (its Content-Security-Policy allows inline style only) and every project string escaped.
Sections: the header (project, branch with changed/ahead/behind, milestone, time written, and counts by ticket state); **Needs you** (only explicit STATE requests, in the same order as the panel); **To try** (read-only ticket cards grouped by feature: feature, age, commit, ticket text and checklist, and per-file `--numstat` bars); **In flight** (working and blocked tickets, running jobs with role, model and elapsed time); **Tickets** (per-feature meters, unfinished tickets with their checklists); and the **latest milestone review**. Worker questions are not exported.
Sections with nothing in them are left out.
The page follows the system light/dark setting, or the Auto / Dark / Light switch at its top (pure CSS), and reads from phone width up.

It collects once, as Project does: no HTTP server and no model call.
The caller pane's jobs appear only inside herdr (`HERDR_PANE_ID`).
The file is `$HUD_HOME/display/board-<project>.html` unless `--out` names one, written 0600 to a temp name and renamed, so a link at the target is replaced, never followed.
The command prints the path.
`--open` then runs `wslview`, else `xdg-open`, detached; with neither on `PATH` it only says so on stderr (exit 0).

In the panel `w` (Home or Project, not in a picker or Settings) does the same for the project shown, opens it the same way and shows `Board saved: <file>` at the top until the next key.

## The panel

In herdr, the running HUD fork must advertise the `dock` capability. `/hud` or `hud panel` toggles one shared right-edge panel for the whole herdr session, not one per pane or harness. `hud panel open`, `close` and `status` act on that same dock. If the running fork has no dock, upgrade it or run `hud panel --here`; outside herdr `hud panel` already uses the current terminal. HUD-managed workers cannot run the panel (`panel_worker_forbidden`).

The dock stays open across tab and workspace changes. Session-specific views use the caller that opened it; switching clients doesn't rebind the running panel. Close and reopen it from another session to change that binding. Opening a file or commit from within the dock creates a regular tab in the active workspace.

### Control resources

Open **Control → Resources** for Codex native status-line tracking, the pi subscription proxy and API grants. Press `h` in Control to cycle Roles → Harnesses → Resources, or click a heading.
Each feature is off until enabled in Resources. Existing feature settings and ledgers carry over unchanged; the old `experiments` preference is ignored.
Use ↑/↓ to select and Enter to edit or open an account; Enter saves, and Esc cancels.
For calibration, Enter first previews the change, then Enter saves the new base.
Settings apply to all projects on this machine, and are stored under `$HUD_HOME/exp/`.
Codex profile choices are local; Resources does not change CLI configuration.

In **pi subscription proxy**, choose a Codex profile and turn on Auto-refresh.
When pi draws its HUD footer, a due refresh uses that profile's existing login to read quota from Codex; it sends no prompt and does not run while pi is unused.
The `openai` OAuth footer shows percent used.
The tightest window leads with a bar and time to reset (`7d ████░░░░░░ ≈43% (2d4h)`); when there is room, the other window follows.
A reading from the current request takes precedence and has no `≈` (`5h 11%`).
Stale estimates are dim and end in `?`; a window past its reset shows `↻`.
Other routes such as `oapi` do not show subscription quota.
Open **Proxy readings** for both windows and their reset times, source, last success and error, and next eligible attempt.
If the proxy pauses for sign-in, sign in to the bound profile and turn Auto-refresh off and back on.
Turning off Auto-refresh stops proxy refreshes.

**API grants** shows the two ledgers together.
The pi footer shows only the enabled ledger for the current API route, with a bar for the share spent, approximate dollars left and days to renewal (`API ████████░░ ≈$12.34 (12d)`, for example).
`openai-api` counts `oapi` requests; `anthropic-api` counts only requests the installed pi HUD can identify as direct Anthropic API-key usage.
Claude OAuth, third-party gateways, and unknown routes are not charged.
The Claude Code status line is unchanged.
Turning off an API grant stops collection for that account and preserves its ledger.

### Frame and reload

Home, Project, Execution and Control are the main tabs.
The panel keeps footer hints whole: the selected row's actions take priority, then Enter with its verb, `Esc back` where applicable, and page actions.
Hints drop from the right to make room, but `? help` stays last.
Movement, tab switching and the Settings shortcut remain available without taking footer space.
An editor or picker that owns the keyboard shows its own hints without `? help`; Help itself shows `Esc back`.
For example, a running HUD job offers `g job tab` (if it has a tab) and `X stop`, the Accept all row shows `⏎ accept all`, and a Control role shows `⏎ chain`.
`o file` opens a row's file.
The fixed words (`Usage`, `unparseable JSON`, `(no key)`) follow the panel language, and a quota figure says whether it is what is `used` or what is `left`.
There is no Agents pane, layout selector, Timeline, activity hub or agent log.
Each page retains its scroll/selection.
Icons (Settings → Display → Advanced → Icons, `icons`) are `nerd` (the default), `unicode` or `text`; an old or unknown saved value loads as the default.
The bar (including the pi footer), Home and the herdr sidebar share these one-cell role glyphs. `nerd` uses Font Awesome glyphs from the Basic Multilingual Plane, available in Nerd Fonts such as MesloLGS NF.

| Role | `unicode` | `text` (ASCII) | `nerd` |
| --- | --- | --- | --- |
| imp | `⚒` | `I` | U+F0AD (wrench) |
| frontend-imp | `✎` | `F` | U+F1FC (paint brush) |
| general | `✦` | `G` | U+F013 (cog) |
| oracle | `◈` | `O` | U+F0EB (light bulb) |
| reviewer | `⚖` | `R` | U+F002 (search) |
| lead | `★` | `L` | U+F005 (star) |
| other | `•` | `.` | `•` |
| sonic | `ϟ` | `*` | U+F0E7 (bolt) |

The panel's job state icons also follow the saved setting. `nerd` uses U+F059 (asking: question circle, amber), U+F057 (failed: times circle, red), U+F0E0 (unread report: envelope, green), U+F058 (done: check circle), U+F252 (queued: hourglass half), U+F186 (stalled: moon) and U+F04D (stopped: stop); `unicode` uses `? ✗ ✓● ✓ ○ ◷ −` and `text` uses ASCII letters and words.

After a new installed entry is stable for two seconds, a bounded child import validates it before the panel restarts in the same terminal.
Selection, scroll, diagnostic folds, Settings cursor and opening time survive; herdr keeps the dock's width and mode.
A saved Skills tab from an older build falls back to Home; a saved Project/Control page reopens on Control and a saved Project/Execution page reopens on Execution.
Unsaved Settings delay reload; a bad build leaves the old panel and a dim notice.
Bars are separate and need restarting for new code.
Quiet, positively idle observations can back off to five-second collection; input/redraw remain independent.

### Keys

Standalone panels consume their own keys and SGR mouse events directly.

| Key | Action |
|---|---|
| Tab/Shift-Tab, Left/Right, a click on the tab | Cycle Home → Project → Execution → Control. Digits switch no tab. `Execution·N` (`执行·N`) counts the current project's live jobs (running, waiting, queued), omitted at 0; `?N` counts open owner requests (Home: all registered projects; Project: the selected project); Home's separate calendar badge counts due and overdue schedule items |
| `[`, `]` | Project, Execution or Control: previous/next project (not on the Projects list) |
| Enter, `i` `Del` `K` `J`, `s`, `x`, `r` | Control: focus the chain / edit the place; add / remove / move up / move down; save the draft; clear the saved place's quota mark; refresh model lists |
| `c` / `C`, `p` | Control role row: next / previous named preset, or filter presets and choose a name or Custom |
| `N`, `I`, `R`, `D` | Control role row: start a copied or empty draft, rename the selected preset, or preview and confirm deletion |
| `h` | Control: cycle Roles → Harnesses → Resources (or click the view heading) |
| Space / Enter, Del, `i` | Harnesses: toggle; remove (= off); Add back (type to filter, Enter restores, Esc cancels). Enter on Off folds or expands it |
| `m` | Control role or place: choose a model directly (or click `[model ▾]`). Type to filter, ↑↓ to pick, Enter to save (or fill an open draft). In the picker, one click sets, Esc clears then closes, and Ctrl+R refreshes the lists |
| Up/Down (`j`/`k`), PgUp/PgDn, Home/End (`G` is End) | Move/page/first/last |
| `g` / `P` / `H` | Execution tab or Inspector: `g` focuses the job's herdr tab (as a temporary peek that re-hides when focus leaves on a fork with `hidden_tabs_peek`, or revealing it on older forks); `P` pins it visible (`tab.set_hidden` `false`, requires `hidden_tabs_peek`); `H` hides it (`tab.set_hidden` `true`, requires `hidden_tabs`). Headless jobs have no tab |
| `1`–`4` / `d` | On a HUD job's open question (`qN.md` with options or a default) in Inspector, where the options are numbered `[1]`…: `1`–`4` pick that option and `d` the worker's default, with no key before. Writes `qN.answer.md` once (as `hud_respond`; an existing answer stands, `Already answered`) and shows nothing else. A collapsed question takes no digit |
| `X` | Execution or Jobs, on a working or paused batch row: the one prompt for the whole batch (`p` pause or `r` resume, `s` stop; any other key cancels). Inspector, on an unsettled HUD job: a one-row prompt `Stop <role> <id>?  y confirm · Esc cancel` above the page. `y` or Enter stops it as `hud_close` does (a CLI job in its idle grace is first asked to quit with `STATUS.json.close-requested`, then the bundled `hud-reap` runs and the panel reads again); any other key cancels |
| Enter | Home: open the project or the request in its Project tab; Jobs and the Execution tab: open Inspector (or Run Detail on a workflow row); Project: open a page, fold, show a ticket, open a file or run the selected Accept all action |
| `o` | Inspector or Project diagnostics: open the file |
| `v` | Home: open Jobs |
| `n` | Jobs or Inspector: show this session’s native subagents |
| `w` | Home, Project, Execution, Control: write the shown project's [review board](#review-board) (HTML) and open it |
| `t` / `b` / `d` | Project overview: open Tickets / Working tree (with Git facts) / Docs |
| `/` | Filter Tickets by a case-insensitive substring. Backspace edits, Enter keeps the query, Esc stops editing then clears it. Leaving the view clears it; reload retains a kept query |
| `,`, `?` | Settings, Help. From Settings, Help returns to the same draft and selection |
| Esc | With a `/` filter, first stops typing, then clears it; then back (a Project page returns to the hub, the Projects list to the hub, a hub opened from the list to the list); dirty Settings ask save/discard/continue. At the root of Home, Project, Execution or Control, Esc does nothing |
| `q` | Close panel |

Mouse clicks select a row/button, a second click on the selected item runs Enter's action (Home requests and projects, Project hub links, job rows and Inspector file links open on one click), clicking the top crumb goes back, clicking a tab switches tabs, and wheel scrolling moves the viewport without moving the selection.
The model picker is an exception: one click sets a model and scrolling keeps the selection visible.

### Help

Press `?` for shortcuts grouped by where they work.
From Project, Execution or Control, Help opens at that tab’s section; from Home or Settings it opens at Everywhere.
Marks are grouped by route (the tier bars `▂ ▄ ▆` and `∅` for headless; ASCII `- = #` and `h`), slices, answers and places.
`g` peeks/focuses the job's herdr tab; `P` pins it visible; `H` hides it again. Headless jobs show Output instead.
At 80 columns and wider, Marks sit to the right of the shortcuts.
Scroll with ↑↓, PgUp/PgDn or the wheel; Esc, `?` or Enter returns to the previous page.

See [Optional skills](optional-skills.md) for the skills shipped but not installed.
Ask the main session to read one when needed.

### Inspector

A job's Inspector shows the original open question and report text (up to 4 KiB; open the report file for the rest), the worker's signature-checked declared summary, role/harness, model/effort, package, state, checks, flow, local timestamps and recorded progress. **Files** includes the brief, questions and answers, reviews and report. Tab selects a file or a Sonic child job; Enter opens it. With no file selected, `o` opens the report or another collected job file. With no Git diff, **Reported files** shows up to 12 worker-listed paths, not verified changes. A headless job's **Output** follows the newest displayable lines of `stdout.jsonl`.

When the running herdr fork advertises `hidden_tabs`, interactive CLI and pi worker tabs start hidden unless the role sets `"tab_visible": true`. The workspace tab bar shows a hidden-tab count instead of their labels. On a fork that also advertises `hidden_tabs_peek`, pressing `g` in Inspector or Execution focuses the job's tab as a temporary peek (it hides again when focus leaves), pressing `P` pins it visible (`tab.set_hidden` `false`) so it stays in the tab bar after focus leaves, and pressing `H` hides the same tab without stopping the worker. Without `hidden_tabs_peek`, `g` keeps today's behaviour (revealing and focusing on a `hidden_tabs` fork, or focusing visible tabs on an older fork) and `P` reports that pinning is unavailable; without `hidden_tabs`, tabs start visible and hiding is also unavailable. A crash does not reveal a hidden tab: it stays available through Inspector until the usual failure retention ends.

Press `n` or click **subagents** from Jobs or a job Inspector to inspect the calling session's native Claude or Codex tree. It is scanned only while that view is open; incomplete coverage is marked. The tree shows the role and started, activity and ended times when observed. Tab selects a native transcript; Enter or `o` opens it. Esc returns to Jobs or the job Inspector.

### Settings

| Group | Rows |
|---|---|
| Display | Theme, Language; in **Advanced**: Bar style, Icons |
| Panel | Width, Dock mode, Notifications, Open previews; in **Advanced**: Refresh, Mouse |
| Models | Decision API, Quiet job, Sonic auto-thinking, Auto prewalk, Pool pick, Imp placement (and Even pool in even mode); in **Advanced**: Decision cap (with hourly counter) |
| Workers | All in **Advanced**: imp cap (`roleCaps.imp`, default 3), general cap (`roleCaps.general`, default 3), imp→general overflow (`impOverflow`, default on) |
| Codex | Bar on launch |

Common rows are open; the 8 rarely changed rows above fold under one **Advanced** row at the bottom (collapsed on each open; Enter, Left/Right or click expands or collapses it, and `*`/highlight mark folded unsaved or non-default values).
Expanded rows show their source group prefix so `r` still resets that row's group (pressing `r` on the Advanced row shows a hint).
Up/Down selects; Left/Right or Enter changes; `s` saves, `r` resets only this group.
Dirty leave asks Save and leave / Discard changes / Continue editing (default); failed saves retain the draft.
Theme and Icons preview in the draft itself.
No Reset all or picture.

Width presets: 40/48/56(default)/64/80/100; saved 16–200 load, 0 means default. Herdr clamps the requested width to the available space.
**Dock mode** (`dockMode`) defaults to `overlay`: the panel covers the right edge without resizing the main pane or reflowing its text. `push` makes room by shrinking the main pane. Saving either a changed mode or width applies both to the open dock immediately. Neither setting resizes a terminal running `hud panel --here`.

**Open previews** (`openPreviews`, on by default) opens copied report previews in the default browser with `explorer.exe` and `wslpath -w` on WSL, or `xdg-open` elsewhere.
Off still copies the file and gives its path in the notice.

Themes: `terminal` (default), `titanium`, `mocha`, `arctic`, `ember`, `contrast`, `latte`, `paper`, `none`.
Each has its own Home/Project/Inspector inks; latte/paper are light, none/`NO_COLOR` emits no colour.
Preferences save privately to `$HUD_HOME/hud-settings.json` or `HUD_SETTINGS_PATH`; saved display values override environment defaults.
Retired keys `panelLayout` (including `split`), `tasks`, `cardStallMinutes`, `cardFoldMinutes`, `cardHideMinutes` and the old display-model keys (`modelEnabled`, `model`, `modelCallsPerHour`, `summaryIntervalMinutes`, `briefingApiBase`) are ignored on load and omitted on save. Existing job records, caches and assets are not deleted.

## Execution decisions

No display surface calls a text model or the Decision API. Interface labels are localized, but worker questions, reports and declared summaries, ticket titles, routing reasons, landed rows and waiting items keep their source text. Control's model picker still discovers available model IDs.

**Quiet job** (`quietJobDecision`, on by default) controls whether the CLI supervisor sends a quiet worker's pane tail to the Decision API after idle grace; off hands the job to main without sending the tail. This switch is independent of Sonic auto-thinking (`sonicAutoThinking`, off by default) and Imp placement in `auto` mode. Settings → Models selects the primary Decision API provider. **Decision cap** (`decisionCallsPerHour`) offers 600, 2000 or unlimited (0, the default).

**Advisor shadow** (`advisorShadow`, off by default) scans `SKILL.md` files under the absolute directories listed in `advisorSkillDirs` (default empty), indexing frontmatter `name` and `description` (at most 300 bytes each, capped at 200 skills and 64 KiB, rebuilt only when a directory's mtime changes). On a new owner-typed message in a tracked main session (Claude Code and pi first), when the message does not already name a skill path, it asks the Decision API for one fixed choice (`NONE` by default, or one indexed skill name) from the secret-scrubbed message, previous assistant reply (each at most 2000 characters) and skill index, skipping repeats of the same skill in the same session for 30 minutes and allowing at most one recommendation per message. A match is shown only—`skill: <name>` in the bottom bar notice zone for 10 minutes after quota notices, and `<name> — <absolute SKILL.md path>` under the session's project in the panel, where Enter or click copies the path via OSC 52 (`clip.exe` fallback on WSL)—and is never injected into any session, prompt or hook output. HUD appends `{kind: "advice", session, project, skill, path, at, ms}` once to `$HUD_HOME/events/<YYYY-MM>.jsonl` and records panel copies in `$HUD_HOME/panel-actions.jsonl`.

With the same switch on, `advisorRulesFile` can point to an absolute Markdown file (default `""`, no rule checks). Write one sentence per rule as `- R2: State which checks you ran.`; use unique IDs of `R` followed by digits. A rule may name a built-in local check as `- R1 (check: chinese-reply): <sentence>`; the sentence is kept for display. Built-in checks are `chinese-reply` (strips fenced code blocks, inline code spans, `KEY=value` assignments, URLs, file paths, CLI flags and identifier-looking tokens, then hits when at least 40 non-Han letters remain and Han characters are under 30% of letters+Han) and `no-secrets` (hits when the secret scrubber would redact something in the reply; env var names, credential file paths and masked values are not secrets). Rules without `(check: …)` go to the Decision API; rules naming an unknown check are skipped and counted as invalid without being sent to the model. Other lines are ignored. A missing or unreadable file, or one over 30 rule lines or 8 KiB, disables rule checks. In a running session the advisor checks the file's mtime and reloads when it changes.

On reply completion in a main session (Claude Code with the HUD mod, or pi at `agent_end`; no rule checks in bare Claude Code), the advisor runs any built-in checks locally first and asks the Decision API once per reply for a batch of yes/no judgments on the remaining model-judged rules (skipping the Decision API call when every rule is check-based). No is the default unless the reply plainly breaks the rule. Local and model hits merge into one notice and event per reply: rule hits appear as `rules: R2 R5` for 10 minutes in the bottom bar's notice zone, beside any skill recommendation when space allows, and Home shows each matched ID and sentence under the session's project. No hit adds no notice; it does not clear an earlier one. Nothing is injected into a session, prompt or hook output. HUD appends `{kind: "rule_hits", session, project, rules, at, ms}` to `$HUD_HOME/events/<YYYY-MM>.jsonl` only on a hit. Completed evaluations with no hit increment the month's `rule_no_hits` number in `$HUD_HOME/events/advisor-counters.json` once per reply (latest 12 months with counts); timeouts and unavailable Decision results do not increment it.

Recent advice events are still recorded in `$HUD_HOME/events/<YYYY-MM>.jsonl` while advisor shadow is on, but Home no longer renders a multi-row **Recent advice** block; only the per-project active advisor line appears on Home.

The hourly counter reads `display/model-cache/decision-api/calls.json` across processes on one HUD home. Fallback HTTP attempts count separately; unlimited still counts (`n/∞`). Recent historical calls still count until they age out.

**Outbound material** (never private reasoning, ciphertext or referenced file bodies):

| Decision | Input |
|---|---|
| Quiet-job choice | Last 60 pane lines (≤12,000 chars) of a CLI worker, job state, role, agent, minutes quiet and whether the report prompt was sent; at most once per idle grace without a report, ≤3 per supervisor run |
| Worker permission choice | Fixed rules and structural local proof only: the literal operation shape `rm -f <directory>/*.png` and root category, or absent proof. No pane text, arguments, paths, environment values or file contents. Uses the shared Decision API cap and a five-second deadline. |
| Sonic auto-thinking | First 4000 characters of the task as data, plus the Sonic role scope and thinking purposes. No standing brief, referenced context or reports |
| Imp auto routing | First 4000 characters of the dispatch brief, up to 4 KiB/4000 characters of the named local ticket, and up to 32 context-file relative names (512 characters each) and byte sizes; configured tier and mode purposes. No context bodies, standing brief, prior reports or preset/model IDs |
| Role pool pick | First 4000 characters of the dispatch brief as untrusted data; role and project name (checkout basename, not its path); up to 64 pool filenames, titles, `Kind`, `Status` and `Fits` fields (≤400 bytes read per entry); and the first 8 KiB of `README.md` as selection criteria. Facts are capped at 48 KiB together. No pool directory path, entry bodies, project design file or other references |
| Advisor shadow: skills | Secret-scrubbed latest owner message and previous assistant reply (≤2000 characters each) from a tracked main session, plus up to 200 indexed skill `name` and `description` entries (≤300 bytes each, ≤64 KiB total). No skill file paths, bodies or full transcripts |
| Advisor shadow: rules | Latest owner message (first 2000 characters), completed assistant reply (last 4000 characters) and model-judged rule IDs and sentences (≤30 rule lines from an ≤8 KiB file; rules with built-in `(check: …)` run locally and are not sent, and no call is made when every rule is check-based), secret-scrubbed and quoted as untrusted data. No rules file path, other lines or full transcript |

### Prewalk (scouts and pool picks)

Prewalk has two types, both governed by the owner role file’s `"prewalk": "on"|"off"` (allowed only under `$HUD_HOME/roles`, never `.hud/roles`; shipped defaults: `imp`, `oracle` and `frontend-imp` on, `reviewer` and `sonic` off) and **Settings → Models → Auto prewalk** (`autoPrewalk`, on by default), plus per-job `prewalk: false`:

- **Scouts**: when prewalk is enabled for the role and `autoPrewalk` is on (and `prewalk: false` is not passed), `hud_create` requires `scouts: [{kind: "code"|"docs"|"web", ask: string}]` (0–3 items; same kind may repeat; `[]` skips scouts and starts the target directly; omitting `scouts` returns an immediate validation error). Roles with prewalk off also accept `scouts` on explicit request. HUD starts each scout in parallel as headless `sonic` with its kind prompt (`code` and `docs` search only inside the checkout; `web` uses Sonic’s credential-gated web tools and forbids private content in search queries), the caller’s `ask`, and the bounded target brief (≤16,000 chars) as context. No Decision API call is made for scouts. HUD waits until every scout settles under sonic’s own limits (`max_s`, stall, looping); arrived reports attach via `from_jobs`, and failed scouts leave a note without blocking the target.
- **Pool picks**: an owner role file under `$HUD_HOME/roles` can declare `"pool": {"dir": "/path/to/styles", "max": 4}`. HUD reads the Markdown pool without modifying it; a project can override the role’s launch chain but not its pool.

1. If the owner role sets `"prewalk": "off"`, caller passes `prewalk: false`, **Settings → Models → Auto prewalk** (`autoPrewalk`) is off, or **Settings → Models → Pool pick** (`poolPick`, on by default) is off, HUD skips the pick entirely.
2. If the brief names pool entries by filename or stem, HUD attaches those without a Decision API call (`source: brief`).
3. Otherwise, a registered project can declare `"design": "docs/design.md"` in `.hud/project.json`. HUD attaches that repo-relative file instead of pool entries, without a Decision API call (`source: project`, `need: existing`). The file must resolve inside the checkout. An unavailable configured path is recorded as failed (`result: failed`), not replaced by pool entries.
4. Otherwise HUD requests one fixed-choice judgment. `need: existing` means the brief changes or extends a UI with its own look; HUD attaches nothing and shows `pick: none (existing look)`. `need: new` means a new page, app or sample without a look. The judgment also selects `pool_kind: personal` (a working tool) or `showcase` (for an audience). For `new`, HUD takes up to `max` ranked entries, drops unknown or contradictory entries (`Kind: either` fits both), and orders the survivors by their links in the pool README, preserving rank for unlisted entries. If none survive, it attaches nothing. An unavailable Decision API, including timeout, records `result: failed` and attaches nothing.

Local workers get read references; browser workers get bounded inline context. When a pool pick ran, the `hud_create` receipt shows a one-line `pick_summary`, for example `pick: personal · layout-swiss-editorial + theme-dark-near-black`. The receipt, `job.json` and archive record all prewalk steps in `prewalk: [{kind: 'code'|'docs'|'web'|'pool', source, ask?, job?, result, ms, ...}]` (scouts record `source: 'caller'` and `ask` truncated to 200 characters; pool picks fold `need`, `pool_kind`, `entries` and `dropped` into the `kind: 'pool'` entry; old records without `ask` or with `decision`/`default` stay readable).

## The bottom bars

Claude and Antigravity statuslines, the pi footer and the Codex pane-strip bar use the same facts and layout:

```text
model effort │ context %/window │ repo branch(dirty) │ quota │ ~N t/s │ notices ··· MCP n  skills n
```

Context is ten cells, green below 70%, yellow from 70%, red from 85%, measured against the client's compaction window when known.
Claude/Codex show only their own tightest quota window, blue then magenta from 75%, red from 90%; pi has session cost instead (in its top-right editor ribbon, not duplicated below).
Missing facts are absent.
The notice zone is, in order: native approvals, even-pool quota exclusions, machine-wide HUD load, local CPU/RAM, then recent client events (a Claude or Codex subagent starting, finishing or failing, and Claude skill loads, three minutes each).
A preset in the project's Imp or Sonic even pool that cannot launch because of quota appears as `⚠ imp fast: quota` (text: `!`; Nerd Font: U+F071). The bar shows the first and adds `+N` for the others. The notice disappears as the presets rejoin.

`⚒3  ✦2  ◈1  ★1  ϟ4  ◷2` counts HUD jobs across all projects under the same `$HUD_HOME`: one icon and running count per role, followed by the queue clock only when jobs are waiting to start. The Icons setting selects Unicode, text (`I3  G2  O1  L1  *4  Q2`) or Nerd Font glyphs.
Panes show the same counts, even if a pane has no jobs of its own. Model, context, project and quotas are still session-local.
Workers waiting for main still count as running; their questions are not owner requests and do not add a badge. Settled jobs and native subagents are not counted.
Active `hud_land` flows appear after the running roles and before the queue clock, or on their own if there are no jobs. For example, `⇡ gate 2/3 1m` shows the second of three gate steps and its elapsed time in whole minutes (`<1m` under a minute); `wait` means waiting for the main-checkout lease and `land` covers the other steps. `⇡3` means three active lands and the details are for the oldest. Text uses `L` and Nerd Font uses U+F126. Finished lands and ticket queues are not counted.
If no jobs are running or queued and no lands are active, or the census is missing, stale or incomplete, the segment is absent.

`C12%  M75%  S20%` reports local CPU, RAM and swap use. These letters stay the same in every icon set and use distinct colours unless the theme is `none`. In WSL these are Linux guest readings, never Windows host readings.
CPU is the change in aggregate `/proc/stat` ticks since the previous sample. A single private sample lives at `$HUD_HOME/display/cpu-sample.v1.json`.
The first reading, a gap of more than 30 seconds, or unusable counters leaves CPU blank; the bar does not wait for a second sample.
RAM used is `MemTotal − MemAvailable` from `/proc/meminfo`. RAM and swap are rounded to whole percentages; swap appears only when at least 10% of swap is used. Missing readings are omitted.

Open approvals are pinned first, the first one named (`! Approve: Bash`) and `+2` for the others, `! 3 needs` when even that does not fit; nothing open, nothing pinned.
No clock, task count, hooks count, tool-at-work or idle fallback.

- Claude statusline: `~N t/s` estimates the latest response from transcript output tokens and elapsed time since its prompt or tool result.
  On Linux x64/WSL, the installed `hud-statusline` launcher can render the compact `line` and `p10k` looks with a native binary.
  It reads fresh stdin every time.
  Missing or stale work/cache evidence, an unavailable binary, live transcript notices or quota exhaustion marks, forwarding, admin commands and `--details`/`--source` use the TypeScript renderer, which also omits unavailable machine counts.
  Claude quota facts are still published locally; stdin is not stored for replay.
  A source install can build the binary with Cargo; a Linux x64 release built with Cargo carries it, so Cargo is not needed on the receiving machine.
- Antigravity statusline: the same `hud-statusline` command shows its model, context, recognized quota readings (`5h 80% left`) and the same machine-wide job counts, without reading its transcript or forwarding its payload.
  `--details --lang en|zh` also shows reported input and output totals.
  With the Linux x64 native binary, the launcher reuses the last line for the same agy process and working directory, refreshing roughly once a second during redraws.
  A change may appear on the next refresh; without the binary, TypeScript renders each call.
- Codex bar: `~N t/s` shows the existing output-rate estimate from the rollout.

Settings → Bar style offers `line` (default) and `p10k`.
Both fit on one row; saved retired styles load as `line`.
With colour disabled, the bar uses `line`.
`barFields` selects from `model,context,project,quota,tps,notice,loaded` without reordering them.
If you use a field allowlist, include `tps` to show the rate.
Narrow bars (a main pane beside the open panel is 144 columns on a 184-column terminal) give up, cheapest first: the loaded counts; both gauges' cells together; the quota's reset and the branch's `↑n`; a subagent's title (a few words, then none); the rate; swap, then local CPU/RAM; the older of two subagent items; the effort; the context's window (`41%`); the branch; the quota; the project; the context.
The model is never dropped.
Machine load drops land elapsed time, then the land step, keeping its icon and count. The machine and local load segments then tighten their spaces to one as needed. When more room is needed, local load drops swap before dropping the whole segment; machine load drops the queue before dropping the whole segment. Icons and their numbers stay together.
pi keeps the same editor ribbon in both styles, and other extensions' statuses remain visible.
The bars stay English-only apart from a subagent's own description.

### Herdr pane strips for Claude Code, pi and Antigravity

With a herdr fork that advertises `pane_strip`, open **Settings → Herdr pane strips**, turn on a client, and save.
Each switch is off by default and affects only that client's main sessions, not HUD workers or the Codex bar.
The strip mirrors the compact HUD statusline on an extra bottom row, fitted to the pane's inner width on resize.
The native line and pi's editor ribbon stay in place. Turning the switch off and saving returns the row to the PTY.

In pi, the existing HUD display extension (`hud-display`) owns the strip while its footer is shown.
In Claude and Antigravity, the existing `hud` MCP connection owns it; connect the MCP server if your client starts it lazily.
These two clients need the HUD `hud-statusline` configured, and the strip appears after its next compact refresh.
Opted-in Claude uses the TypeScript renderer for both copies, so they share the same readings; Antigravity keeps its native launcher's refresh cache.
Only compact render facts, not statusline stdin, are shared in bounded private local files. No new service runs.

### Codex native status line

In ordinary Codex with the `hud` MCP server registered, open `/experimental`, turn on **Custom status line**, then restart Codex.
Open `/statusline` → **Choose a status line provider** → **MyHUD**.
To switch back, select **Default status line** from the same picker.
The **Track native status line** switch in **Control → Resources** only records when MyHUD was last seen for each local profile; it does not change what Codex displays.

The compact footer puts model and effort, context, then quota first.
It shows the same per-role HUD job counts and optional queue clock, followed by available Linux/WSL load readings.
On a narrow footer, Codex cuts the right end with `…`; `codexH`'s pane-strip bar keeps its width-aware layout.

### pi controls

Panel controls affect the shared herdr dock; footer controls affect the current pi session. Neither changes saved panel preferences:

| Command | Action |
|---|---|
| `/hud`, `/hud toggle` | Toggle the panel (it never opens automatically) |
| `/hud on`, `/hud off` | Open/close the panel, independently of the footer |
| `/hud status` | Report panel state |
| `/hud reconnect` | Rebind after a canceled session transition; preserves this session's footer on/off choice |
| `/hud help` | Show panel/footer command help |
| `/hud footer on`, `/hud footer off` | Restore/hide the entire HUD footer and editor ribbon, session-local |

Segment/group changes below persist to `$HUD_HOME/config.json` → `piFooter`; if saving fails, the change applies only to this session and a warning is shown.
`/hud footer` or `/hud footer list` lists enabled segments by group and the config path.
`/hud footer reset` restores all segments to on.
`/hud footer band on|off` switches the ribbon group; `/hud footer footer on|off` switches the bottom group.
`/hud footer on|off|toggle <segment...>` changes named segments, or use `all` (for example, `/hud footer off lens viz`, `/hud footer on all`).
Bare `/hud footer on|off` is the session-local whole-frame switch, not a persisted group change.

Bottom-group ids: `model thinking path git mcp skill lens viz statuses context`.
Ribbon-group ids: `session cache tokens tps ttft cost time`.
These are segment visibility controls, not a way to enable unavailable facts.
Context is in the bottom group but is stored as `piFooter.band.context`; the other ids use `piFooter.footer` or `piFooter.band` according to their group.

## Machine-readable state

The active Codex bar/panel writes private atomic snapshots to `$HUD_HOME/display/state/<pane-id>.json` (sanitized) when facts change (at most once/second).
`hud codex --json` reads this pane's snapshot:

```sh
hud codex --json | jq '.context.percent, .agents.active, .attention[].label'
```

Version 2 carries session/project/context/quota/tokens/agents/attention, optional health/rate evidence, and bar field columns (`bar.segments`, empty for panels).
Agent, subtask and guardian-review counts are separate.
Missing facts are absent, not zero.
Writer ownership follows the atomic file's device/inode; an outgoing writer cannot delete a replacement snapshot.
There is no owner sidecar.

**Output throughput.**
The native Inspector may show estimated `~42 tok/s`: current turn output delta / elapsed time minus the union of fully known tool waits, including initial latency/stalls.
It is not exact request decoding speed.
Two counter samples are needed; unchanged counters do not refresh it.
Old samples say last, not live.

## Configuration

`HUD_HOME` defaults to `~/.hud`; `HUD_SETTINGS_PATH` overrides the settings file.
`CODEX_HOME` defaults to `~/.codex`, read for transcripts/Codex config, not HUD state.

| Environment | Meaning |
|---|---|
| `HUD_BAR_STYLE`, `HUD_BAR_FIELDS` | Bar defaults (also `CODEX_HUD_BAR_STYLE`, `CODEX_HUD_BAR_FIELDS`) |
| `CODEX_HUD_THEME`, `CODEX_HUD_ICONS` | Theme/icon defaults |
| `NO_COLOR` | Any non-empty value disables colour, even with saved settings |
| `CODEX_HUD_STATUSLINE` | 1 default; 0 disables the Codex pane-strip bar on launch, wins over Bar on launch (also `HUD_STATUSLINE`) |
| `CODEX_HUD_TREE_WIDTH` | Initial panel width when no saved settings |
| `CODEX_HUD_CWD`, `CODEX_SESSIONS_PATH` | Explicit workspace/session directory |
| `CODEX_HUD_NOTIFY`, `CODEX_HUD_NOTIFY_DESKTOP`, `CODEX_HUD_NOTIFY_COOLDOWN` | Notification opt-ins, cooldown (300 seconds default) |
| `CODEX_HUD_PROFILE` | 1 writes stage timing summaries to `display/profile.log` |
| `CODEX_HUD_FONT_DIR` | Override optional `bin/codex-hud-fonts` install/check directory |
| `HUD_HEAP_CAPS` | V8 heap caps for panel (`128/4`) and `hud-watch`/`hud-mcp` (`96/2`); `off`/`default`/`0` restores Node defaults, or `<old>[/<semi>]` MB |

Notifications default off.
They report native session failures and approvals through tmux, optionally desktop OSC/notify-send. They do not announce routine completions or HUD worker questions, auto-approve, or retry. Delivery to main is unchanged.

**Credentials.**
`$HUD_HOME/credentials.env` must be a regular 0600 file (not a symlink/FIFO).
`NAME=VALUE`, optional quotes/export, no interpolation; environment wins per name, no implicit client/jev key import.
Sonic registers `deepseek_search` and `deepseek_fetch` when `DEEPSEEK_SEARCH_API_KEY` is present in this file. To migrate an old raw key, run `hud import preview --deepseek-key --from ~/.config/deepseek-search/api-key`, then replace `preview` with `apply`. Existing keys win. Search sends the query, optional original question, count and content flag to DeepSeek; fetch sends the page URL. Neither tool attaches the brief. Treat results as untrusted web content.

Known keys include `MISTRAL_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, and `TYPESAFE_API_KEY`. Anthropic is an exception to the environment override: HUD reads `ANTHROPIC_API_KEY` only from `$HUD_HOME/credentials.env`.

**Decision API.**
`$HUD_HOME/config.json` has `decisions.primary` (default `openai`) and optional `decisions.fallback`: `gemini`, `openai`, `anthropic`, or `typesafe`.
Settings → Models saves the primary provider, not keys. Anthropic uses Claude Haiku 5.5 (`claude-haiku-5-5`) via the Messages API at low effort, sending the same Decision API inputs as the other providers.
Automatic fallback picks the first other keyed provider in Gemini → OpenAI → Anthropic → TypeSafe order; one fallback for missing credentials, quota/auth/5xx/timeout, not malformed/refused answers.
Gemini quota replies cool down the process for the server delay or 60 seconds.
Browser CLIs own their own configuration independently.

**Explicit import.**
`hud import preview`/`apply` reads only named old files (plus legacy HUD `jev.env` when present), never guesses a Codex home.
Existing values win; apply backs up changed targets privately and output lists names, never values.
`--pi-footer` imports an explicitly named p10k-footer JSON.
Sources are old `hud-settings.json` and `.env` files; old jev-ask TOML is refused (browser CLIs keep their own configuration).

```sh
hud import preview --from /tmp/synthetic-old/hud-settings.json
hud import apply --from /tmp/synthetic-old/hud-settings.json
```

**Codex config.**
The display reads model/effort, compaction window, quota evidence, MCP and skills from Codex's config/transcripts; it does not edit them.
Client MCP registration belongs to the explicit installer, not the read-only display loop.
