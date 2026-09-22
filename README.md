## Modification History

| Date       | Summary of Changes |
|------------|--------------------|
| 2026-05-22 | Documented Windows current-branch download, self-check, and WSL launch flow with screenshots. |
| 2026-05-22 | Switched Windows default launch policy to WSL-only and marked native PowerShell HUD as unsupported. |
| 2026-05-22 | Documented explicit Windows launch-mode flags and Bash installer dependency guidance. |
| 2026-05-21 | Documented completed Windows PowerShell, cmd, and WSL dual-entry behavior. |

<p align="center">
  <a href="./README.md"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
  <a href="./README.zh.md"><img src="https://img.shields.io/badge/lang-中文-red.svg" alt="中文"></a>
  <a href="./README.ja.md"><img src="https://img.shields.io/badge/lang-日本語-green.svg" alt="日本語"></a>
  <a href="./README.ko.md"><img src="https://img.shields.io/badge/lang-한국어-orange.svg" alt="한국어"></a>
</p>

# Codex HUD

Real-time statusline HUD for [OpenAI Codex CLI](https://github.com/openai/codex). Lightweight, zero-config, works inside tmux.

> This branch documents the Windows WSL-first build: Windows `codex` launches the WSL HUD by default, native PowerShell HUD is not a supported user launch mode, and Linux/macOS keep the existing Bash flow.

> Inspired by [claude-hud](https://github.com/jarrodwatts/claude-hud) for Claude Code.

![Codex HUD — Single Session](./doc/fig/2a00eaf0-496a-4039-a0ce-87a9453df30d.png)

## Why Codex HUD?

**Q: Codex CLI already works. Why do I need a HUD?**

Because you're flying blind without one. Codex HUD gives you a persistent dashboard at the bottom of your terminal:

- **Branch, model, permissions** — at a glance, no guessing
- **Token usage (including cache)** — know exactly how much context you've burned
- **Context window fill bar** — see when you're about to hit the wall
- **MCP server status & tool calls** — watch what Codex is actually doing
- **Reasoning effort level** — see the current thinking depth

**Q: My session spawns subagents. Can I see what they are doing?**

Yes. Press `F12` to open the **subagent tree** in a side panel: every agent the session spawned, its model and reasoning effort, whether it is running, finished, or failed, and which agent spawned it. Press `F12` again to close it. The status bar stays up the whole time.

`Ctrl+T` is left alone on purpose — that is Codex's own transcript overlay.

![Codex HUD — Subagent Tree](./doc/fig/6d0edbdd-19b5-4038-b9a3-ca5341fd39d1.png)

**Q: Do I need to set up tmux manually?**

No. Codex HUD auto-activates tmux for you. Just type `codex` and the HUD appears. If tmux isn't installed, the installer handles that too.

## Quick Start

```bash
git clone https://github.com/CartmanFatass/codex-hud.git
cd codex-hud
./bin/codex-hud-install

# Refresh your shell, then just type:
codex
```

### Windows Current Branch (WSL Default)

This branch uses WSL as the supported Windows HUD runtime. PowerShell and cmd are launcher shells; the HUD itself runs in Ubuntu WSL with Bash and tmux.

> **Warning:** Windows installation has not been validated on a native Windows host; back up your existing Codex installation before running it.

1. Download and switch to this branch:

```powershell
git clone https://github.com/CartmanFatass/codex-hud.git
cd codex-hud
git switch feature/windows-support-dual-entry
.\bin\codex-hud-install.ps1
```

2. Open a new PowerShell or cmd window, then check the WSL runtime:

```powershell
codex --self-check
```

![Windows WSL self-check](./doc/fig/wsl-self-check.png)

3. Run Codex HUD:

```powershell
codex
```

![Windows WSL launch](./doc/fig/windows-wsl.png)

Notes:

- `codex` launches the WSL HUD by default on Windows.
- `codex --wsl ...` explicitly requests the same WSL HUD path and strips the wrapper flag before forwarding Codex CLI args.
- Native PowerShell HUD is currently unsupported as a user launch mode; legacy native-mode requests fail fast with an unsupported-mode error.
- `codex-hud-wsl` is the explicit full-HUD command for WSL Ubuntu.
- `cmd.exe` users get managed `.cmd` shims that invoke the same PowerShell entrypoints with `ExecutionPolicy Bypass`.

`codex-hud-install.ps1` automatically:

- install Node.js LTS on Windows if needed
- preserve an existing Windows Codex CLI and install `@openai/codex` only when missing
- ensure Ubuntu WSL is available when possible
- provision WSL with `tmux`, Node.js LTS, `npm`, and `@openai/codex` only when missing
- fail fast with exact manual WSL commands if root or passwordless `sudo` is unavailable

For Linux/macOS/Git Bash installs, `install.sh` now fails fast with exact checks and install guidance when required tools are missing. The main required checks are `command -v node`, `node --version`, `command -v npm`, `npm --version`, `command -v tmux`, and `tmux -V`.

#### Windows Default Path

```powershell
. $PROFILE.CurrentUserAllHosts
codex
codex --wsl
codex --self-check
codex-resume
```

Use `codex` when you want the normal Windows entry. It uses WSL HUD by default. Use `codex --wsl` when you want to be explicit about the WSL path. Legacy native-mode requests are intentionally rejected because native PowerShell HUD is not supported yet.

#### WSL Full HUD Path

```powershell
. $PROFILE.CurrentUserAllHosts
codex-hud-wsl
codex-hud-wsl "help me debug this"
```

Use this when you want the full Bash + tmux HUD inside WSL Ubuntu.

### Management Commands

After the first install, these are available in PowerShell and cmd:

| Command | Description |
|---------|-------------|
| `codex` | Default Windows entry: WSL HUD, then plain Windows codex fallback |
| `codex-resume` | Resume through the same Windows WSL entry |
| `codex-hud-wsl` | Launch full HUD mode via WSL |
| `codex-hud-sync` | Rebuild and refresh aliases for the current checkout |
| `codex-hud-upgrade` | Pull latest changes, then rebuild |
| `codex-hud-uninstall` | Remove aliases and stop HUD sessions |

## What's on the HUD?

One line, pinned to the bottom of the terminal. Related fields sit two
spaces apart, a dimmed `│` divides one group from the next, and the session
timer and the key hint are held against the right edge:

```
▸ Edit: src/types.ts · 1m20s  ☀● Astra  codex-hud git:(main * ↑2) │ Agents 1 run · 1 ok  Ctx ████▎░░░░░ 42% (114.2K/272K)  ◷~00m │ 2/5  Q61%            30m  F12
```

When something needs you, it takes the front of the line:

```
! 1 tool failed · 1 agent failed │ ▸ Edit: src/types.ts · 1m20s  ☀  main* │ 1▸1✗  Ctx 42%  ◷~00m │ 2/5  Q61%    30m  F12
```

| Field | Means |
|-------|-------|
| `!` | Something the HUD actually observed went wrong: a tool that reported failure, an agent that ended in error, a usage window that reported itself full |
| `▸ Edit: src/types.ts · 1m20s` | What this turn is doing: the running tool, what it is working on, and how long the turn has taken. A narrow pane keeps the mark and the elapsed time, then the mark alone |
| `☀● Astra` | Model family and reasoning effort: `○` low, `◐` medium, `◕` high, `●` xhigh, `◆` max, `✦` ultra |
| `codex-hud git:(main * ↑2)` | Project, branch, uncommitted changes, ahead/behind |
| `Agents 1 run · 1 ok · 1 fail` | Subagents by outcome. Finished and failed are separate numbers, and an agent with no observed state is counted as `?`, never as running |
| `Ctx 42% (114.2K/272K)` | How full the context window is, to an eighth of a column. `↻2` counts compactions |
| `◷~00m` | Minutes since the last model usage, as a prompt-cache reminder. It warns at 25 minutes and stops counting at `30m+` |
| `2/5` | Steps completed in the current plan |
| `Q61%` | Share of the account's usage window spent. This is quota, not task progress; `↺1h23m` is the wait for the next reset |
| `84K` | Tokens spent this session |
| `F12` | Opens the subagent tree. Ten minutes into a session with no subagents to open it retires itself |

A field appears only when there is real data behind it. A missing quota
snapshot means no quota field, not a bar reading zero.

### When the pane is narrow

Fields shorten before any of them disappears, the least important one
disappears first, and an alert is never dropped. At 40 columns, with a failure
on screen:

```
!2 │ ▸  ☀  main* │ 1▸1✗  Ctx 42%  ◷~00m
```

### Density presets

| Preset | Shows |
|--------|-------|
| `focus` | Alerts, model, project, agents, context |
| `balanced` (default) | Focus, plus plan progress, quota, output speed and the session timer |
| `full` | Everything, including tokens, approval/sandbox and the session id |

```bash
CODEX_HUD_DENSITY=focus codex
```

## Development workbench

`F12` opens the right panel without taking focus from Codex. `Shift+F12` opens and focuses it.
Agents and Worktrees open by default; Changes and Inspector open on demand. The focused heading and selected row are highlighted; status colors are concentrated on the icons:

| Pane | Content |
|------|---------|
| **1 Agents** | Nested agents, state and model/effort badges; badges survive long-name truncation |
| **2 Worktrees** | Branch, directory and changed/conflicted state for each worktree |
| **3 Changes** | Files in the selected worktree, index/worktree status and conflicts; selectable even at narrow widths |
| **4 Inspector** | Agent status and activity times, worktree details, or colored file diffs |

Panes stack vertically. Worktrees shrinks to its content; spare height goes to Agents or the focused Inspector.
At 16–20 columns, margins shrink. Use `z` to give the focused pane the full height.
Selection follows agent IDs and file paths across refreshes, and every pane retains its scroll position.

| Key | Action |
|-----|--------|
| `Tab` / `Shift+Tab` | Cycle pane focus |
| `1` / `2` / `3` / `4` | Focus a pane directly |
| `j` / `k`, arrows | Move selection or scroll details |
| `PgUp` / `PgDn`, `g` / `G` | Page, first/last item |
| Mouse click / wheel | Select or scroll; click a pane title to fold/unfold it |
| `,` or **Settings** | Open settings; arrows/click change values, `s` or Save applies them |
| `h` / `l`, left/right | Fold/unfold or navigate parent/child agents |
| `s` | Active-first / creation order |
| `f` or `/` | Filter all, running, failed, unknown |
| `Enter` / `v` | Open Inspector; inside Inspector, expand/collapse timestamps, IDs and full paths |
| Click an agent / `o` | Switch the actual Codex conversation to that agent |
| **Main** / `m` | Return the Codex conversation to the root session |
| `x` / `-` | Close / fold the focused pane; `1`–`4` reopens it |
| `z` | Zoom/restore focused pane |
| `?` | Wrapped, scrollable help; arrows, wheel, PgUp/PgDn and g/G navigate |
| `Esc` | Dismiss help, unzoom, return to list; close from Agents |
| `q`, `Ctrl+C` | Close the workbench |

Session switching uses the Codex 0.154 `/subagents` picker and verifies the exact UUID; it never submits guessed `/agent <id>` commands. It requires an empty composer or the recognized picker. Drafts, copy mode, unsupported views and clipped IDs produce a visible message instead of forced input. Keyboard selection alone previews the agent; `o` switches. Visible targets are reached in one movement batch and their UUID is rechecked before Enter. The picker is not reopened afterward, avoiding a second popup and transcript redraw. A delivered request does not independently confirm the final Codex view.

Active sorting only rearranges siblings. A running descendant brings its entire branch forward;
latest turn starts determine order, while ordinary token and log updates do not reshuffle the tree.
Parent links support both metadata locations. Missing status evidence stays unknown.

Inspector starts with name, model/effort, status, turn age and last activity. Press `v` for full timestamps and UUIDs. Session-switch notices stay in the footer. Clicking Agents summary or blank rows does not navigate; only actual agent rows switch sessions.

Changes belong to the selected worktree; no file ownership is inferred from agent activity.
Status columns show index then worktree. Compact summaries use Δ for changed files, S for staged and U for unstaged.
Select a file and press Enter for staged/unstaged patches or bounded untracked-file content. Inspector zooms automatically; Esc restores the panes.
Long preview lines wrap; additions are green, deletions red and hunk markers cyan, retaining +/- markers without color. Git reads disable external diffs,
content filters and partial-clone lazy fetching. The panel provides no staging, commit or checkout actions.

Settings offers four panel widths: narrow (16), default (the original 20–30 column policy), wide (45), and wider (70). Width changes apply immediately and preserve space for the main conversation. `CODEX_HUD_TREE_WIDTH` remains an initial override when no saved settings exist.

Settings controls density, theme, model labels, context mode, the bottom bar, motion, sorting, mouse input, panes, refresh interval and width. Unsaved fields show `*`; the bar switch is marked Next launch. Save persists to `$CODEX_HOME/hud-settings.json` (or `CODEX_HUD_SETTINGS_PATH`) and updates the compact HUD on its next refresh. Saved preferences override environment defaults; `NO_COLOR` still wins. Back discards unsaved edits; Reset or `r` prepares defaults for Save. Narrow views retain complete Back/Save buttons and use short labels.

### Output throughput

The default bar shows `Out ~42.1 tok/s` when enough output-token samples exist.
Selected-agent details show that agent's estimate; expand with `v` to see the sample interval.
The estimate is the change in cumulative **output** tokens divided by rollout timestamp elapsed time
in a roughly 30-second window. It can include tool/service waits and is not pure model decoding speed.
A new turn excludes the preceding idle gap. After 10 seconds without a new sample, `last ~42.1 tok/s`
retains the previous reading. Context usage and compaction counts stay in the bar; the workbench has no Ctx trend.

## Usage

```bash
codex                        # Launch with HUD
codex --model gpt-5          # Pass any Codex CLI args
codex --wsl --model gpt-5    # Explicit WSL HUD mode on Windows
codex "help me debug this"   # With prompt
codex-resume                 # Resume last session
codex-hud-wsl                # Explicit full HUD in WSL (Windows only)
```

<details>
<summary>More commands</summary>

```bash
codex-hud --kill             # Kill session for current directory
codex-hud --list             # List all HUD sessions
codex-hud --json             # Print this directory's HUD state as JSON
codex-hud --attach           # Attach to existing session
codex-hud --new-session      # Force a new session
codex-hud --self-check       # Run diagnostics
```
</details>

### Machine-readable state

The bar fits itself to a pane: it shortens what it says and hides what does not
fit, which is right for a reader and wrong for a script. So each collection
tick also writes what it knows to
`$CODEX_HOME/hud/state/<tmux-session>.json`, and `codex-hud --json` prints the
file belonging to this directory's session.

```bash
codex-hud --json | jq '.context.percent, .agents.active, .attention[].label'
```

It carries the session, project, activity, context, quota, tokens, agents and
attention items, plus `bar.segments`: which field ended up in which columns of
the line that was actually drawn. That is what turns a click at a column into
the field under it.

The same rules as the display apply. Every value is something that was
observed, and a field with no data is absent rather than zero, so `no quota
snapshot` and `quota at 0%` do not look alike. The file is written atomically
with mode `0600`, only when something other than the clock changed, at most
once a second, and it is deleted when the HUD stops: a state file for a HUD
that is no longer running would read as live.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_HUD_DENSITY` | `balanced` | How much the bar shows (`focus` / `balanced` / `full`) |
| `CODEX_HUD_THEME` | `terminal` | Palette (`terminal` / `mocha` / `latte` / `none`) |
| `CODEX_HUD_GLYPHS` | `both` | Model badge style (`glyph` / `text` / `both`) |
| `CODEX_HUD_STATUSLINE` | `1` | Bottom bar enabled by default; `0` disables for new HUD sessions, overriding Settings → Bar next launch |
| `CODEX_HUD_CONTEXT` | `used` | Context percentage: `used` or `remaining`; also available in Settings |
| `CODEX_HUD_POSITION` | `bottom` | HUD pane position (`top` / `bottom`) |
| `CODEX_HUD_HEIGHT` | `1` | HUD height in lines |
| `CODEX_HUD_MOUSE` | `1` | Enable mouse/trackpad scrolling |

Status glyphs use semantic colors: cyan `▸` working, green `✓` turn complete, yellow `■` interrupted, red `✗` failed. Yellow `?` means collection failed; `Ctx~` marks the last context measurement while awaiting a new turn's or compaction's token report. Silence does not turn a working session idle.

The same line includes a cache reminder: `◷~08m` means about eight minutes since the latest model usage report, advancing once per elapsed minute. It turns yellow at 25 minutes and red as `◷~30m+` at 30; a new usage report restarts the clock. This is a 30-minute reminder window, not server-confirmed cache validity or expiry (`~` means estimated). Collection failures use `?`; missing samples hide the field. All density presets include it, with warnings retained at narrow widths. Text mode shows `Cache ~25m`.

Context percentages follow [Codex 0.154's calculation](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/protocol/src/protocol.rs#L2258), subtracting the fixed 12K baseline from both the latest context usage and the window. `Ctx 20%` equals native `80% context left`; the displayed token pair uses the same adjusted window. Custom windows <=12K retain a raw-window fallback. Cumulative session tokens never measure context fill.

```bash
CODEX_HUD_STATUSLINE=0 codex
CODEX_HUD_CONTEXT=remaining codex
CODEX_HUD_GLYPHS=glyph CODEX_HUD_THEME=mocha codex
```

Saved display preferences override environment defaults; change Context percent, Theme and Model labels in Settings when preferences already exist. Wheel events go to mouse-aware applications or fall back to tmux history scrolling. HUD bindings use a separate key table, and right-clicking the side panel no longer pastes clipboard text or moves keyboard focus.

Settings → **Bar next launch** saves the bottom bar preference for the next new HUD session. An explicit `CODEX_HUD_STATUSLINE` takes precedence over that saved value.

<details>
<summary>All environment variables</summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_HUD_NOTIFY` | `0` | Announce failures and finished agents through tmux |
| `CODEX_HUD_NOTIFY_COOLDOWN` | `300` | Seconds before a different alert of the same kind can fire |
| `CODEX_HUD_NOTIFY_DESKTOP` | `0` | Also raise a desktop notification (needs `CODEX_HUD_NOTIFY=1`) |
| `CODEX_HUD_REDUCED_MOTION` | `0` | Stop the traffic marker from animating |
| `NO_COLOR` | (unset) | Any value forces the `none` palette |
| `CODEX_HUD_HEIGHT_AUTO` | `0` | Auto-adjust height based on width |
| `CODEX_HUD_HEIGHT_MIN` | `CODEX_HUD_HEIGHT` | Min height in auto mode |
| `CODEX_HUD_HEIGHT_MAX` | `12` | Max height in auto mode |
| `CODEX_HUD_AUTO_ATTACH` | `0` | Auto-attach to latest session in same dir |
| `CODEX_HUD_ALTERNATE_SCREEN` | `0` | tmux alternate-screen for codex pane |
| `CODEX_HUD_CLEAR_SCROLLBACK` | `0` | Clear scrollback on first render |
| `CODEX_HUD_CWD` | (unset) | Override working directory |
| `CODEX_HOME` | `~/.codex` | Codex home directory |
| `CODEX_SESSIONS_PATH` | (unset) | Override sessions directory |

</details>

### Notifications

Off by default, because Codex has its own notifier and two pop-ups for one
event is worse than none. `CODEX_HUD_NOTIFY=1` turns them on.

```bash
CODEX_HUD_NOTIFY=1 codex
```

It announces failures it observed, approvals Codex is waiting on, and agents
that finished, one message per occurrence, with a cooldown so a flapping
condition cannot become a stream. It never acts on the session: no
auto-approval, no keystrokes, no retries.

`CODEX_HUD_NOTIFY_DESKTOP=1` adds a notification outside the terminal. It is a
second opt-in because leaving the terminal is a bigger ask than a tmux message.

```bash
CODEX_HUD_NOTIFY=1 CODEX_HUD_NOTIFY_DESKTOP=1 codex
```

Two routes, both best-effort and both silent when unsupported: the OSC 9 and
OSC 777 sequences a terminal may raise itself (wrapped in tmux passthrough,
which the wrapper enables), and `notify-send` on Linux or `osascript` on macOS.
Notification text comes from the rollout, so every control character is
stripped before it is written: a message cannot close the sequence and have its
tail run as terminal commands.

### config.toml

The HUD reads from `CODEX_HOME/config.toml`:

```toml
model = "gpt-5.2-codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[mcp_servers.my-server]
command = ["node", "server.js"]
enabled = true
```

## System Support

| Platform | Status |
|----------|--------|
| Linux | Supported |
| macOS (Apple Silicon) | Supported |
| macOS (Intel) | Testing pending |
| Windows PowerShell | Supported as launcher shell; native PowerShell HUD is unsupported |
| Windows cmd | Supported (managed `.cmd` shims) |
| Windows WSL Ubuntu | Supported (default Windows HUD path and `codex-hud-wsl` full HUD entry) |

## Development

```bash
npm install && npm run build   # Build
npm run dev                    # Watch mode
node dist/index.js             # Run HUD directly
npm test                       # Unit tests: parser replay, width safety, render cost
npm run test:integration       # Shell suites: wrapper, tmux toggling, installer
```

`npm test` compiles with `tsconfig.test.json` and runs `tests/unit` against the
recorded rollouts in `tests/fixtures/rollouts`. `docs/BASELINE.md` records the
layout and render-cost baseline those tests defend.

On Windows PowerShell, use `npm.cmd run build` if `npm.ps1` is blocked by ExecutionPolicy.

## Changelog

| Date | Change |
|------|--------|
| 2026-05-22 | Switch Windows default launch policy to WSL HUD only; reject legacy native PowerShell HUD requests as unsupported |
| 2026-05-22 | Add Windows launch-mode parsing experiments, a clear native-to-WSL fallback banner, and precise Bash installer dependency guidance |
| 2026-05-21 | Complete Windows dual-entry hardening: WSL temp wrappers, sudo-based WSL provisioning, cmd shims, first-run session handling, and runtime state precedence |
| 2026-04-20 | Make Windows PowerShell the default entry, add automatic WSL fallback, auto-install native tmux on install, and document Windows dual-mode usage |
| 2026-04-19 | Add Windows dual-entry support (`codex` native fallback + `codex-hud-wsl` full HUD), plus PowerShell installer/sync/upgrade/uninstall |
| 2026-04-09 | Add quick install/sync/upgrade/uninstall commands |
| 2026-04-09 | Bind HUD session to current tmux pane; display reasoning effort |
| 2026-02-09 | Keep Codex pane focused after resize; refine mouse-scroll defaults |
| 2026-02-09 | Update session attach defaults and scrollback config |

## License

MIT

## Credits

Inspired by [claude-hud](https://github.com/jarrodwatts/claude-hud) by Jarrod Watts. Built for [OpenAI Codex CLI](https://github.com/openai/codex).
