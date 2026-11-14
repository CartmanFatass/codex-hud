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

Only the panel is opt-in: `/hud` opens it in Claude/pi, F12 in Codex; it never opens
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
hud setup --detect        # print this project's worker setup as JSON
hud setup --apply PLAN    # write .hud/ from a plan
hud setup --remove        # drop project registration; leave .hud/
hud codex --model gpt-5    # Codex arguments pass through to the tmux launcher
```

`hud codex-hud` aliases `hud codex`. Panel selection accepts
`--root <namespace/session-id>` or `--harness claude|pi|codex --session ID --source ABS`;
these select observations, not execution identity. Without explicit selection,
`HERDR_PANE_ID` permits a one-second `herdr pane current` lookup for the caller's
Claude transcript; no focused-pane guess or statusline-written binding is used.
Unavailable evidence leaves the jobs view unbound to a native session.

The MCP has exactly six tools: **hud_roster**, **hud_create**, **hud_read**,
**hud_send**, **hud_respond**, **hud_close**. Call `hud_roster` first for effective
roles, model/thinking sources, accepted options and the convention. Bundled
role JSON is overridden by `$HUD_HOME/roles/*.json` by role name, then by a
registered project's `.hud/roles`. The first `hud-convention.md` in a registered
project's `.hud/`, the cwd, HUD home, then the package wins whole.
See [Project workers](#project-workers).

`hud_create` takes `role`, `request_key`, `task`, optional `cwd` and display-only
`package`. It dispatches on the role's first available place (`runs_on`) unless
overridden with `on` (defaults from shipped `harnesses.json` overridden by
`$HUD_HOME/harnesses.json`). A repeated key returns the original job unchanged, not
a second launch. `model` and `thinking` override a `pi` or `cli` place for this job;
`kind` selects `image` (default) or `video` for `flow`. Pi-only overrides:
boolean `lens`, `mcp`, `tps`, `ui_ext`, `skills`, `split`, plus `pi_args` (≤128
strings, ≤4096 chars each, verbatim, no shell). Omitted switches keep pi-role
defaults; split defaults to the place. `ui_ext: false` disables UI extensions;
`skills: true` includes personal skills. A true split reserves a right helper pane.
`--orchestrator`/`--notify` pi-argument overrides refuse. Browser (`bro`) places
reject pi options.

A role JSON file sets `role`, `instructions`, `can_continue`, optional `idle_grace_s`
(default 600), and ordered `run` places across `pi`, `cli` (`grok`, `agy`, `claude`
or `codex`), and `bro` (`jev-ask`, `jev-aistudio`, `jev-flow`); legacy single-place
files load as `run[0]` and `"harness": "jev"` loads as `"bro"`. Shipped roles:
`imp` (`pi` implementer -> `cli` `agy`), `reviewer` (`pi` reviewer -> `cli`
`claude`), `sonic`, `architect`, `oracle` (`chatgpt`, `gemini`, `argon`), and
`flow` (`jev-flow`). A `cli` place requires `instructions/<instructions>.md`
(shipped: `implementer.md`, `reviewer.md`), otherwise `hud_create` returns
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

`hud_read` without a job lists the newest 20; with a job it reads STATUS, report
(up to 64 KiB) and open questions. `wait_ms` waits at most 120000 ms, stopping at
settlement, a question or timeout. Reading a settled report stamps `read_at`, not
acceptance. `hud_send` queues a message for a working pi or CLI job, or continues
an eligible role during idle grace; `message_key` deduplicates attempts. CLI
workers ask through the same `QUESTION` line and `hud_respond` flow (`hud-ask`,
20 minutes, then the default). A blocked CLI marks the job as needing the owner
and sends one notice naming the job and pane. `hud_respond` writes a
`qN.answer.md` once. `hud_close` reaps early; normal cleanup belongs to the watcher.
The main session chooses all next steps; the MCP knows no workflow.
See [the MCP README](../packages/hud-mcp/README.md) for the tool arguments.

Jobs are plain files in `$HUD_HOME/jobs/<job>/`. Pi history stays in
`${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/<cwd-dir>/`; job `sessions/` links to
primary/helper files. A CLI job's supervisor drives STATUS: working, idle grace,
`/quit` when grace ends unused, then closed with `settled`. Herdr `idle` or
`unknown` is an exit only when the agent is gone. The on-demand watcher starts on
create, reaps finished jobs through `pi-role-reap`, keeps failed tabs for two hours,
and exits with no open job or pending failed-job deadline. While a CLI job is open
it also checks the supervisor; `HUD_WATCH_CLI_CHECK_MS` (default 30000) is that
interval. A dead supervisor fails the job. Settled directories, including reports and
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
`skill_roots`, defaulting to `~/.pi/agent/skills`, `~/.claude/skills` and
`~/.agents/skills`. A skill is a directory with `SKILL.md`; its name is the
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
session lanes, then **Decided for you**. It only observes files, never sends work.
Running jobs with unanswered questions need you; an unanswered question left on a
finished job does not. A report is not proof of success, and display labels are not
acceptance or a merge decision. Unknown evidence stays unknown.

Cards have a title and two fixed sentence rows; `┃ …` holds space until text is
available. Enter expands the complete sentence and factual details in place.
Brief headings supply job titles; otherwise a model name or first task line fits
the width. Only the newest current settled card initially expands, until its fold
time; explicit choices win for that panel lifetime. Enter on a lane folds it.

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

**Spare rows.** Cards/decisions get space first. Remaining rows show STATE's Now
summary, six-state progress bar/legend and up to six open tickets per feature.
Tickets shrink first as height falls, then legend, bar, summary and the block.
Enter on the progress block opens the Project Progress page; on a ticket row, the
Tickets page, at that feature.

## Project

Project is a hub with one page per section. The hub's first row names the project
(the panel's directory name; see Switching projects below), then Waiting for you (STATE's waiting items, folds with
Enter), then one row per page with a one-line summary: **Progress** (milestone,
working, to try, blocked; a stacked bar under it), **Tickets** (done/total, working,
blocked; absent when the project has no tickets), **Working tree** (branch, changed,
worktrees, ahead/behind, editing jobs), **Docs** (spec milestone, newest review) and **Control
plane** (roles, keys present, browser). A row too short for its facts drops the last
ones, never part of one. Enter or one click opens a page; its crumb row
`‹ Project › Page` replaces the tabs, and Esc or a click on the crumb returns to the
hub with the cursor on that page's row. The pages hold the sections as before
(native agents under Control plane start folded). Each page keeps its own cursor and
scroll, also across the panel's self-reload.

Facts come from `docs/handoff/STATE.md` (root `STATE.md` fallback), `docs/spec.md`,
reviews, roles/convention/instructions and Git/worktrees. No milestone or completion
is guessed. Key rows contain names/presence only; Browser ✓ means Chrome and
`jev-ask` exist on PATH, not a running/logged-in browser.

**Progress page.** STATE's Now summary (two rows at most), the six-state bar and legend,
then milestone chips: the milestones of the ledger's second field in ledger order,
those before the current one (`Milestone:`) in brackets `[M3]`, the current one in
parentheses `(M4)`, the rest plain; rows with no milestone (`—`) have no chip. Too many
for two rows: the oldest give way, never the current one. Then four sections:

- **Now**: ledger slices in `working`/`blocked` (drift marks mean a missing or unlisted
  worktree or a non-active ledger state, never a write back to STATE), each with its
  job's line from Home's card text, then the project's HUD jobs that have not settled
  and no slice shows (role, title, age). A job's title is the workboard's description, else its
  `job.json` title, else the first heading (or line) of its `brief.md`, from the collector's
  signature-cached, size-bounded read (full collection only). Each such row is a stop of its own: Enter or `o`
  opens its report, else its brief, and a long list pages by keyboard.
- **Next**: STATE's `## Next`, a bullet at most two rows; Enter on a cut one (`…`) shows
  all of it, again folds it. A bullet that fits opens STATE.md.
- **To try**: `try` rows by milestone, newest milestone first and open, the others
  folded. A row is `ID · date commit` with its text on the rows under it. The date is the
  ledger row's last hash (7-40 hex) read through the safe Git policy; none when Git
  does not know it, never guessed.
- **Done**: `accepted` rows grouped the same way, every group folded; Enter opens one.

Rows wrap onto a second row rather than cut their only line at 40 columns. Enter or `o`
on a row opens STATE.md; on a fold, Enter folds and `o` folds only where the row has no file.

Tickets use `.scratch/<feature>/issues/<NN>-<slug>.md`, at most 16 features ×64 files,
64 KiB each. Required: matching `# NN: title`, `**Blocked by:**`, `**Status:**`.
Done means done/closed/complete status or all checkboxes checked (at least one).
Otherwise unfinished/unresolved dependencies block; no blockers means ready.
Numbers/titles resolve within that feature; unknown status text stays dim.
A job with the matching package and ticket number/filename adds role/state/age,
never completion. The newest-64-directory job lookup is shared with slice blocks.
**Tickets page**: one row per feature with a done/total meter, Enter folds its tickets;
Enter on a ticket shows its checklist (✓ / ○) and latest comment (the last bullet under
`## Comments`) under it, a second Enter folds it; `o` opens the ticket file.

**Control plane page.** Four groups, then the files as before (invalid or ignored role files, the
convention, pi role definitions, instruction files, native agents, keys, browser): **Roles** (imp,
reviewer, sonic, architect and any other role), **Project roles** (roles whose file comes from the
project's own `.hud/roles`, which wins), **Browser tasks** (roles that run only on browser places:
oracle, flow) and **Harnesses** (which of `pi`, `agy`, `claude`, `codex`, `grok`, `jev-ask`,
`jev-aistudio`, `jev-flow` this machine has, with the mark legend). A role is one row per place on one
line: the first is the primary, `↳` rows are its fallbacks in order. A row reads mark, role,
harness, model, thinking; marks are `◉` in use (where the next `hud_create` runs: the first place
that is installed and not exhausted), `○` standby, `✗` exhausted (rows of 56+ columns add the time
left) and `−` harness not installed. Rows of 80+ columns end with whose file is in force:
`default` (shipped), `yours` (`$HUD_HOME/roles/<role>.json`) or `project`. Enter and `o` open that
role file.

On a place row (Control plane only): `p`/`P` next/previous harness (`pi`, then each CLI agent for a
role that has CLI instructions; a browser role walks chatgpt, gemini, aistudio) with that harness's
default model from `harnesses.json`; `m`/`M` model from the catalog (a Flow place: image/video);
`e`/`E` thinking. Each cycle passes through "unset" (the role's or harness's own default) before it
wraps. `+` adds a fallback at the end (the first harness not yet listed, else another model of the
same one); `-` removes the place (one always stays); `K`/`J` move it earlier/later; `x` clears its
exhausted mark. The catalog is shipped `catalog.json` plus the `catalog` key of
`$HUD_HOME/harnesses.json`. A change writes `$HUD_HOME/roles/<role>.json` (atomic, 0600, seeded from
the shipped role, other fields and place keys kept) or `$HUD_HOME/exhausted.json`; the next `hud_roster`
and `hud_create` read them, so the page shows what the next job uses. A role from the project's file
cannot be changed here, and a harness switch refuses a place whose file sets launch options
(`split`, `skills`, `args`...), since it would rebuild them: both say so in a line at the top
until the next key, and `o` opens the file. In Codex, focus the panel first (click the gutter
or Shift-F12); these keys have no prefix commands.

**Switching projects.** With more than one project the hub's name row reads `name ▾ i/n`
and `[` and `]` step through the panel's own project and the existing roots in
`$HUD_HOME/projects.json` (deduplicated, at most 16). Enter or a click on the name row
opens the **Projects list** (`‹ Projects` replaces the tabs; Esc or a click on the crumb
returns to the hub). `2` opens the project shown last (at the page it had open, else its hub), never the list.
On a page `[`/`]` work too and its crumb shows the project's name; its cursor, scroll and
folds start fresh. The choice belongs to the panel and survives its reload, not
Settings. Home always stays on the panel's own project, and opening Home's progress block
returns to it. The panel keeps one collector per visited project (at most four, the
panel's own never dropped, the oldest other one first) and collects only the shown one.
With one project there is no `▾ i/n` and no list.

**Projects list.** Two rows per project: its name, current milestone, `?` the count of
STATE's waiting items and `◉` the count of unsettled HUD jobs under its root; then its
stacked bar, one key count (landed to try, else open tickets) and the time since it was
last touched (STATE.md or a ticket file, whichever is newer; a ledger commit date would
need Git). A project without STATE.md shows `no STATE.md` where the bar would be. Order:
the panel's own project, then projects with waiting items, then with running jobs, then
the rest, each group newest first. Enter or one click opens that project's hub (Esc on
that hub goes back to the list; on a hub not reached from the list Esc does what it
always did, so keys can still be handed back to Codex). The cursor marks both rows of an
entry. The list is read only while it is visible: for each listed project STATE and
tickets as Home reads them (cached by file signature) and, in one pass over the newest
64 job directories, the unsettled jobs per root, at most once every five seconds while
the list stays open (opening it again reads at once). No Git, no roles, no full collection;
the shown project's own full collection pauses while the list is open. The last-touched
time reads `12m`, `3h`, `4d` (`12分钟`, `3小时`, `4天` in Chinese).
A project without STATE.md says `no STATE.md` on Progress; its other pages work.

On a page Enter folds a header, shows a ticket's detail or opens a row's file, and `o`
opens it in `$EDITOR` (default vim), in a herdr tab that closes with the editor; failed workspace lookup falls back to a
split. Home and Project retain separate cursor/scroll state. Full Project collection
runs while the hub or a page is visible, not behind modals; Home reuses only cached
STATE/ticket reads.
Git is gated to at most once per five seconds. Reads do not start a browser or MCP.

## The panel

### Frame and reload

Home and Project are the two tabs. Inspector, Changes, Settings and Help share
one title band, exact-width rows and whole footer hints (rightmost hints drop when
narrow). There is no Agents pane, stacked/compact layout, Timeline, activity hub,
agent log, Summary or diagnostics page. Each page retains its scroll/selection.
Icons are `unicode` or `text`; old nerd/emoji values load as unicode.

After a new installed entry is stable for two seconds, a bounded child import
validates it before the panel restarts in the same pane. Selection, scroll, folds,
show-all, modal, Settings cursor, opening time and width override survive. Unsaved
Settings delay reload; a bad build leaves the old panel and a dim notice. Bars are
separate and need restarting for new code. Quiet, positively idle observations can
back off to five-second collection; input/redraw remain independent.

### Keys

In Codex, press the prefix (default `Ctrl+\`) then the key; ordinary input outside
Settings/Help forwards to Codex. Standalone panels consume their own keys.

| Key | Action |
|---|---|
| `1`, `2`, `3` | Home, Project, Changes summary |
| Tab/Shift-Tab, Left/Right | Home ⇄ Project |
| `[`, `]` | Project: previous/next project (not on the Projects list); in Codex the prefix then `[` or `]`, ignored while the panel is closed |
| `p` `m` `e` (capitals back), `+` `-` `K` `J`, `x` | Control plane: harness / model / thinking of the place under the cursor; add / remove / move up / move down a place; clear its exhausted mark. Panel focused (in Codex), no prefix commands |
| Up/Down (`j`/`k`), PgUp/PgDn, Home/End (`g`/`G`) | Move/page/first/last |
| Enter | Expand/collapse card, question, decision or lane; in Project open a page, then fold, show a ticket or open a row's file |
| `o` | Open question + answer, else report, else brief; native transcript; in Project the row's file |
| `v`, Space, `4` | Inspector |
| `a` | Show/hide older jobs and decisions |
| `n`/`N` | Next/previous trouble |
| `b` | Model text master on/off (also the top-row models word) |
| `,`, `?` | Settings, Help |
| Esc | Back (a Project page returns to the hub, the Projects list to the hub, a hub opened from the list to the list); dirty Settings ask save/discard/continue; standalone main-page Esc exits |
| `q` | Close panel |
| Prefix twice | Send the prefix itself to the focused pane |

Codex repeat movement keeps the prefix active for half a second. Settings chooses
`Ctrl+\` or `Ctrl+]`; older settings without an explicit prefix retain `Ctrl+]`.
F12 closes/reopens the Codex panel; Shift-F12 opens with focus. Mouse click selects,
a second click expands, wheel scrolls without moving selection. Clicking the blank
gutter keeps keys in the panel until Esc. Help lists current shortcuts.

### Inspector

The selected card/question/decision expands above facts: role/harness, model/effort,
package, state/phase and observed local times. Files lists brief, QA, reviews and
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
| Panel | Home mode, Width, Stall threshold, Fold after, Hide after, Notifications, Refresh, Mouse |
| Models | Model text, Model, Decision API, Call cap, Decision cap, Summary interval, separate hourly counters, Test API |
| Codex | Prefix key, Bar on launch |

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
| Native sentence/name/result/cause | Name/role (80 chars each), public task/charge (400), report (600), action (200), result (8000 head/tail), error (2000); settled Codex may use a safe 32 KiB tail, Claude reuses collected text |
| Decision title/localized detail | Question and answer, 4096 bytes each; ≤8-word title plus faithful question/answer/instead/why |
| Outcome label | Final state + first 12 report lines (4096-byte head), once per settlement |
| Kind label | First two brief paragraphs (1500-byte head), once per running/job settled within one day |
| Looping label | Last 12 public tool/result pairs (600 chars each part) from the same safe tail; after 3 quiet minutes, at most once per 5 minutes, unchanged input never repeats |
| Question category | 4096-byte question head; ≤100 questions per observed job |
| Review severity | ≤24 list items (400 chars each) from newest 32 KiB review head or settled reviewer report |
| Home ranking/brief | ≤200 cards' ids, lanes, state, role (80), title (160), age, sentence/reason (240), question flag, outcome; no bodies |
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
model effort │ context %/window │ repo branch(dirty) │ quota │ notices ··· MCP n  skills n
```

Context is ten cells, green below 70%, yellow from 70%, red from 85%, measured
against the client's compaction window when known. Claude/Codex show only their
own tightest quota window, blue then magenta from 75%, red from 90%; pi has session
cost instead (in its top-right editor ribbon, not duplicated below). Missing facts
are absent. Agent/job start/done/failure and Claude skill-load notices stay three
minutes. Open approvals/questions are pinned. No clock, rate, task count, hooks count, tool-at-work or idle fallback.

Settings Bar style: `line`, `p10k`, `gauge` (Gauge Plates), `tide`, `micro`, `stacked`,
`headline`, `triptych`. Stacked is two rows in Claude/pi; Codex falls back to line.
Tide tints need truecolor. Text icons/none keep meanings without colour. `barFields`
selects from `model,context,project,quota,notice,loaded` without reordering them.
When narrow, optional loaded text/meters/reset/project detail give way before model;
notices cut at words, and the model is never dropped. pi's ribbon follows the look;
other extensions' statuses remain visible. The bars stay English-only.

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
| `CODEX_HUD_TREE_WIDTH` | Initial tmux panel width when no saved settings |
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
