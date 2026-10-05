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

![Codex HUD — Single Session](./docs/fig/2a00eaf0-496a-4039-a0ce-87a9453df30d.png)

## Why Codex HUD?

**Q: Codex CLI already works. Why do I need a HUD?**

Because you're flying blind without one. Codex HUD gives you a persistent dashboard at the bottom of your terminal:

- **Branch, model, permissions** — at a glance, no guessing
- **Token usage (including cache)** — know exactly how much context you've burned
- **Context window fill bar** — see when you're about to hit the wall
- **MCP server status & tool calls** — watch what Codex is actually doing
- **Reasoning effort level** — see the current thinking depth

**Q: My session spawns subagents. Can I see what they are doing?**

Yes. Press `F12` to open the **subagent tree** in a side panel: every agent the session spawned, its model and reasoning effort, whether it is running, finished, or failed, and which agent spawned it. Press `F12` again to close it. The panel takes the status bar's place while it is open: the bar's fields move to the panel's foot, so Codex keeps the whole height and nothing is shown twice.

`Ctrl+T` is left alone on purpose — that is Codex's own transcript overlay.

![Codex HUD — Subagent Tree](./docs/fig/6d0edbdd-19b5-4038-b9a3-ca5341fd39d1.png)

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

![Windows WSL self-check](./docs/fig/wsl-self-check.png)

3. Run Codex HUD:

```powershell
codex
```

![Windows WSL launch](./docs/fig/windows-wsl.png)

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
▸ Edit: src/types.ts · 1m20s  ☀● Astra  codex-hud git:(main * ↑2) │ Agents 1 run · 1 ok  Ctx ████▎░░░░░ 42% (114.2K/272K)  ◷~00m │ 2/5  Q61%            30m
```

When something needs you, it takes the front of the line:

```
! 1 tool failed · 1 agent failed │ ▸ Edit: src/types.ts · 1m20s  ☀  main* │ 1▸1✗  Ctx 42%  ◷~00m │ 2/5  Q61%    30m
```

| Field | Means |
|-------|-------|
| `!` | Something the HUD actually observed went wrong: a tool that reported failure, an agent that ended in error, a usage window that reported itself full |
| `▸ Edit: src/types.ts · 1m20s` | What this turn is doing: the running tool, what it is working on, and how long the turn has taken. A narrow pane keeps the mark and the elapsed time, then the mark alone |
| `☀● Astra` | Model family and reasoning effort: `○` low, `◐` medium, `◕` high, `●` xhigh, `◆` max, `✦` ultra |
| `codex-hud git:(main * ↑2)` | Project, branch, uncommitted changes, ahead/behind. Started in a folder that holds the repository rather than inside it, the bar names the repository the session works in: `shenlun › Learn-to-Write git:(main *)` |
| `Agents 1 run · 1 ok · 1 fail` | Subagents by outcome. Finished and failed are separate numbers, and an agent with no observed state is counted as `?`, never as running |
| `Ctx 42% (114.2K/272K)` | How full the context window is, to an eighth of a column. `↻2` counts compactions |
| `◷~00m` | Minutes since the last model usage, as a prompt-cache reminder. It warns at 25 minutes and stops counting at `30m+` |
| `2/5` | Steps completed in the current plan |
| `Q61%` | Share of the account's usage window spent. This is quota, not task progress; `↺1h23m` is the wait for the next reset. At its widest the field adds `out in ~40m`: a straight-line projection of when the window runs out at its recent rate, shown only when readings span five minutes or more, use is rising, and the projection falls before the reset |
| `84K` | Tokens spent this session |

A field appears only when there is real data behind it. A missing quota
snapshot means no quota field, not a bar reading zero.

Clicking the bar acts on the field under the cursor: the alert and the agent
counts open the panel and hand it the keyboard, the meters
open it and leave the cursor in Codex, and anywhere else toggles the panel as
the whole bar used to.

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

**The panel takes no keys of its own.** Every panel command is the **prefix key, `Ctrl+]`, then one key**: `Ctrl+]` `,` opens settings, `Ctrl+]` `?` the help, `Ctrl+]` `b` pauses the brief (the full list is the table below, and the help's Shortcuts section). The prefix works wherever the cursor is, in Codex's pane or in the panel; `Ctrl+]` `j` `j` `j` moves three rows, since the moves repeat for half a second without the prefix. A command that needs the panel opens it first. Anything typed without the prefix goes to Codex: with the cursor in the panel (after `Shift+F12`, or a click), keys and pastes are passed to Codex's pane exactly as typed, a paste stays one bracketed paste, and the cursor moves back to Codex with them. The settings page and the help are the exception: while one is open it takes the keys it needs (arrows, Enter, `Esc`), until `Esc` or its `[Back]` button closes it. The mouse works as before.

`Ctrl+]` twice sends `Ctrl+]` itself to the pane with the cursor. Codex 0.160 binds `Ctrl+]` to *Skip Question*; that is `Ctrl+]` `Ctrl+]` now. To keep `Ctrl+]` for Codex, choose `Ctrl+\` in Settings → Panel → Prefix key (no Codex 0.160 binding uses it; `Ctrl+G`, its external editor, and `Alt+]`, which a terminal sends as the start of an escape sequence, are not offered). The prefix is a key table in the HUD's own tmux session: the server's root and `Ctrl+B` tables are untouched. A changed prefix is installed at once for the panel that saved it; a session started before this version keeps its old keys until it is launched again.
Agents and Worktrees open by default; Changes and Inspector open on demand. The focused heading and selected row are highlighted; status colors are concentrated on the icons:

| Pane | Content |
|------|---------|
| **1 Agents** | Nested agents, state and model/effort badges; badges survive long-name truncation |
| **2 Worktrees** | Each worktree by name (its branch; detached, the nearest directory that is not an id, such as `atlas-launch-sources`), its changed/conflicted state and `locked` in words, and under it its HEAD commit's subject. No hash is shown, here or in the Inspector |
| **3 Changes** | Files in the selected worktree, index/worktree status and conflicts, under their counts in words (`5 unstaged · 2924 untracked`, zeros left out); a path too long to fit shows the shortest ending that tells it apart (`.agents/…/SKILL.md`); selectable even at narrow widths |
| **4 Inspector** | Agent status and activity times, worktree details, or colored file diffs |

Panes stack vertically, each drawn as the status card is: a **band** with its icon and name on the left and, on the right, which rows are in view when it scrolls (`7–14/46`) or else how many it holds (`3 worktrees`, `12 files`, `9 events`), then its rows behind a gutter `│` on the left only (in the accent for the focused pane, dim for the rest): no right border and no bottom rule. A pane is **open or closed**; a closed one takes no row at all. A click on a pane's band zooms it to the room between the bar and the status card, and a second click restores it, as `Ctrl+]` `z` does. Worktrees shrinks to its content; spare height goes to Agents or the focused Inspector. The agents area works the same way: its summary line is its band, a click on it zooms the cards, and it can be closed from the bar, the other panes then sharing its room.

**Two layouts** (Settings → Panel → Layout, applied at once):

- **rich** (the default): no Agents pane. One line at the top counts what is failed, running and done (`!1 failed  ▸2 run  ✓5 done`, each count with its word; guardian reviews left out), with `◈N` for the guardian reviews under the main session; under it, in one scrolling view, an entry per subagent in the tree's order, under the same filter and linger window. A running agent, a failed one, one that finished in the last minute and one that needs a look get a **card**, open on the right. Its top rule has the status icon, a glyph for the kind of work (when Labels and title gave one), the agent's name (middle-cut when long, underlined because a click on it switches to the agent), `◈N` for its guardian reviews and the model/effort badge; the bottom rule has the turn clock counting seconds while it runs (`◷4m07s`, in the warning colour when quiet) or how long ago it finished or failed (`12d`), a collapsed parent's count (`+3 folded`), then the agent's context meter filling the rest of the rule as a thin line with its percentage at the end of the fill (`────57%──────`), and `▾`. Inside, one line each: its task (strong), its newest model note (`~`) and its newest update. Cards take their state's colour: running info, quiet warning, failed error, just finished success; the selected card's top rule sits on a lighter band. Every other finished agent is **two lines**: `✓ audit_code_paths   ☽◐ ───57%──── 12d`, its meter and age in columns down the list, and under it, indented and dim, how far it got: its newest model note, else its newest update, else its task. `j`/`k` only marks it (its first line on the lighter band), and `e`, Space or a click opens it into its card. Child entries are indented a column a level, at most two. An opened card (`e`, Space, or a click on its top rule or `▾`) adds the name Codex prints when a label stands in for it, the agent's whole log newest first, about twenty lines, the rest left to the Inspector (or, with no log, its last report), then the task in full. Agent text loses its chat markdown in cards and the Inspector: links keep their text, bold, code and heading marks go, a full commit hash shows seven characters. Guardian review threads get no card: they are the `◈N` chip, and a failed one shows as a card. The main session's brief is not in this view: it is in the status card at the foot (below).
- **compact**: the Agents pane (the tree, one row per agent, by Codex's own name) with the brief, the recap and the agent log under it, as before.

**The control bar** is the panel's first row, on its own background, and every control the panel has is on it; cards, the status card and the panes' bands draw none. Each control is a **button**, a chip with its icon in the text colour and bold, never dimmed, and its word where it fits. No key is written on it; the keys are in the help.

```
90 columns   ← 主会话   ▦   ⎇   ±   ⌖   ⋮                   ‖ 暂停简报   +31 已收起   ☰ 设置   ? 帮助
56 columns    ←   ▦   ⎇   ±   ⌖   ⋮        ‖   +31   ☰ 设置   ? 帮助
44 columns    ←   ▦   ⎇   ±   ⌖   ⋮      ‖   +31   ☰   ?
36 columns    ←   ▦  ⎇  ±  ⌖  ⋮     ‖  +31  ☰  ?
32 columns   ←  ▦ ⎇ ± ⌖ ⋮          ‖ +31 ☰ ?
```

- `←`, with the main session's name where it fits, returns Codex to the main session.
- The tabs are the panes, with the icon their pane's band carries: ▦ 卡片 / Agents, ⎇ 工作树 / Trees, ± 改动 / Changes, ⌖ 详情 / Inspect, ⋮ 时间线 / Timeline. A tab says its pane's state by its chip: the focused one sits on the accent, an open one on a chip a step lighter than the bar, a closed one on the bar itself, its icon as bright as the rest. One click opens a closed pane and focuses it, and closes an open one, the cards included.
- `‖` / `▸` (暂停简报 / 继续简报) pauses or resumes the brief, shown only while one is configured; `+31` (已收起) shows the finished agents the linger window put away and `−31` (收起) hides them again, shown only when there are some; `☰` (设置) opens settings; `?` (帮助) the help.
- The chips follow the width. From 56 columns a chip is a space, its icon, its word and a space, a column apart; the tabs' words go first, then the other buttons', so at 56 settings and help keep theirs. From 44 the chips are their icon with a space either side, a column apart; from 36 the same with no column between; under 36 a chip is its icon and one space, and short of room the closed panes' tabs go, then the older agents' button, then the brief's. Back, settings and help never go. A click anywhere on a chip, its spaces included, is its button. Without colour (`theme: none`) there are no chips: the focused tab is in brackets, and a closed pane has no tab.
- **Icons** in settings picks the set: `unicode` (the default, the glyphs above), `nerd` ([Nerd Font](https://www.nerdfonts.com/) icons: a home `U+F015`, a robot `U+F06A9`, a branch `U+E725`, a diff `U+F440`, an info circle `U+F05A`, a history clock `U+F1DA`, pause / play `U+F04C` / `U+F04B`, an eye `U+F06E` / `U+F070`, a cog `U+F013`, a question circle `U+F059`; it needs that font in the terminal, MesloLGS NF for one), or `text`.
- With **Icons** set to `text` (`glyphs: text` does the same) the buttons are words alone (`← 主会话`, `卡片 工作树 …`, `暂停简报`, `设置 帮助`), shortened where narrow (`← 主`, `工作…`, `Ag Wt Ch In Tl`, `暂停`).

**The status card** at the foot is a band and a corner, as omp draws its status line, and its meters are thin lines with the reading where the fill ends:

```
 ✓ ☀◆ 5d ────────────────────56%──────────────────────────246K ~3m
│ ◎ 整理测试数据补全文档，并在版本冻结前合并本轮改动
│ ▸ 本轮改动已合并并发布，无待办任务，等待新的需求
│ ✓ 整理两个 CI 失败与下一步排查记录
│ ✓ 提交 release 说明并推送到 main 分支 +2
╰─ atlas-wsl · main * 7d ─────────────────────────────────99% ↺114h
```

- **The band**, on its own background across the width: the session's state (while it works, the running tool and its target, the turn's clock and `~N tok/s`), the model badge and the session's age; the context meter, the percentage where the fill ends and the window size at the tail (a `┃` tick marks the auto-compact point when `config.toml` sets `model_auto_compact_token_limit`); then, wherever a brief is configured, its state (`~3m` for the recap's age, then in words: writing…, failed, paused). A click anywhere on the band steps the level, as `r`.
- **The body** hangs off a left gutter (`│`) in the main session's state colour: dim idle, info working, error failed, warning stale or needing you (an approval, a failed tool or agent, a recap that needs you). With glyphs on, the state's word goes and its glyph stays (`✓`, `✗`, `?`, `!`).
- **The corner** (`╰─`): where the session works (the project in bold, `› repo` when it differs, `· branch`); the quota meter for the tightest window, labelled `7d` and read `99%`; the reset countdown; and the prompt-cache reminder, only in the five minutes before the cache lapses, in the warning colour.
- Meters fill in the info colour, warning past 70 %, error past 85 %, over a dim track.
- Short of room, the band drops the rate, the tasks, the age, the window size, the model and the brief's state, then the meter shrinks to its percentage; the corner drops other windows, the branch, the window, the repo and the forecast, then its meter and the reset. The state and the percentages go last. Under 24 columns there is no card.

It has three levels (Settings → Panel → Status card, saved like the other panel preferences); `Ctrl+]` `r` or a click on its band steps through them:

- **min**: the band alone, with the brief's state and the quota's reading at its right end, marked `!` when a tool or agent failed or the recap says it needs you.
- **status**: the band, the alerts when there are any, and the corner.
- **full** (the default): those, then the main session's brief: the pending approval in the model's words first (`⚑ ~ …`), then the recap with its labels inline in one column, needs (`!`, in the warning colour) first, then goal (`◎`), now (`▸`) and the newest two done items (`✓`, a dim `+N` for the rest), each value at most two lines; the whole-picture sentence stands in for Now only when there is no recap; then a failed call or a reply in another shape than asked for. Paused, the brief steps back to dim. With glyphs set to text, the labels are words (Needs, Goal, Now, Done) padded to one column. The card takes at most a third of the panel and leaves the agents at least ten rows when the panel is tall enough; a brief taller than its room keeps needs, now and goal in view and the rest a scroll away (the wheel over the card), with a line saying what is out of view.

Compact keeps its layout: the brief and recap stay in the area under the tree, in the same inline fields, so its card has only min and status (full there is status) and `Ctrl+]` `r` switches between the two.

The view under the summary line scrolls when it does not fit: the wheel over it, `PgUp`/`PgDn`, and moving the selection, which brings the selected agent into view. Its band, the summary line, says at its right end which rows are in view (`6–17/40`). Where it is scrolled to holds across repaints and new content, and is clamped when content shrinks. A view under 12 rows drops its blank lines before it hides content. The status card and the open panes 2–5 keep their place.
At 16–20 columns, margins shrink. Use `Ctrl+]` `z` to give the focused pane the full height.
Selection follows agent IDs and file paths across refreshes, and every pane retains its scroll position.

Every key below follows the prefix: `Ctrl+]`, then the key (or the prefix chosen in Settings). Typed without it, a key goes to Codex.

| `Ctrl+]`, then | Action |
|-----|--------|
| `,` / `?` | Open settings / the help (also the `设置` and `帮助` buttons); arrows, Enter and click change values, Save applies them |
| `Tab` / `Shift+Tab` | Cycle pane focus |
| `1`–`5` | Open and focus a pane, or close it if it is open (`1` is the cards in rich); so does a click on its tab |
| `x` | Close the focused pane |
| `j` / `k`, `↑` / `↓` | Move the selection or scroll; repeats without the prefix for half a second (`Ctrl+]` `j` `j` `j`) |
| `PgUp` / `PgDn`, `g` / `G` | Page (the agents view scrolls a page; repeats), first/last item |
| `e` or Space (rich) | Open or close the selected card's timeline, or open a one-line finished agent into its card |
| `Enter` / `v` | Open Inspector; inside Inspector, expand/collapse timestamps, IDs and full paths (`▾ More`) |
| `h` / `l` | Fold/unfold or navigate parent/child agents |
| `s` | Active-first / creation order |
| `a` | Show or hide the finished agents the tree has put away (the `+N` button) |
| `f` or `/` | Filter all, running, failed, unknown |
| `o` | Switch the actual Codex conversation to the selected agent (a click on an agent in compact, on a card's name in rich) |
| `m` | Return the Codex conversation to the root session (the `←` button) |
| `z` | Zoom/restore focused pane; a click on its band too |
| `b` | Pause / resume the brief and recap model calls (the pause button, 暂停简报) |
| `r` | Status card level: min → status → full (compact: min ↔ status); a click on the card's band too |
| `Esc` | Dismiss help, unzoom, return to list; close from Agents |
| `q` | Close the panel |
| `Ctrl+]` | Send `Ctrl+]` itself to the pane with the cursor |

| Mouse | Action |
|-----|--------|
| Click / wheel | Select or scroll; the wheel scrolls the agents view without moving the selection, and over the status card (rich, full) its brief |
| Click a card (rich) | Body or bottom rule: select it; top rule or `▾`: select and open/close it; its underlined name: switch to that agent; a one-line row: open it |
| Click an agent (compact) | Switch to it |

Session switching drives Codex's own `/subagents` picker (verified against Codex 0.154 and 0.157) and selects the row showing the agent's exact UUID; it never submits guessed `/agent <id>` commands. It requires an empty composer (including the read-only composer of a sub-agent view) or the recognized picker. Drafts, copy mode and unsupported views produce a visible message instead of forced input. Keyboard selection alone previews the agent; `o` switches. Visible targets are reached in one movement batch, long lists a page at a time, and the row is rechecked before Enter. The picker is not reopened afterward, avoiding a second popup and transcript redraw. A delivered request does not independently confirm the final Codex view.

Below about 63 columns Codex stops printing UUIDs in the picker. The agent is then matched by the name the picker prints (its task path, or `Main [default]`), and only when no other agent of the session prints the same name; otherwise the switch is refused with a request to widen the Codex pane. While agents are running, Codex adds a "Sub-agents running" note to the conversation each time the picker opens; that note is Codex's own.

Active sorting only rearranges siblings. A running descendant brings its entire branch forward;
latest turn starts determine order, while ordinary token and log updates do not reshuffle the tree.
Parent links support both metadata locations. Missing status evidence stays unknown.

Agents are named by the last segment of their task path, the name Codex's `/subagents` picker shows: `/root/essays_2020_2021` reads `essays_2020_2021`. That name heads the tree row, the card and the agent's log block until a label arrives. With Labels and title on (the default, once a backend is set), the model's short name then stands in for it in cards, rows, the compact tree, the timeline and the Inspector's heading (Settings → Agents → Label as name; off, the label is the line under the name instead); an opened card and the Inspector still show the name Codex prints, and switching to an agent always goes by that name. The random nickname Codex also assigns (Copernicus, Meitner…) and the role move to the Inspector. Guardian review threads (Codex 0.155+ opens one beside a session to review its approvals) get no row or card of their own: their parent carries `◈N`, in the info colour while one runs, and a failed one still shows.

Finished agents leave the list 3 minutes after they finish (Settings → Hide finished: 1m, 3m, 10m, 30m or never). Running and failed agents never leave, and a finished agent whose child is still shown stays as a dimmed row. Each finished row says how long ago it finished; the control bar counts what was put away (`+12 older`), and clicking that or `Ctrl+]` `a` shows everything again.

**Timeline.** Pane 5, closed by default, lists the session's events newest first with their age: approvals asked for and answered, compaction, a quota window crossing 80 % and 95 %, turns finished, interrupted or failed, failed tool calls, and each subagent starting, finishing or failing. They are facts the rollout recorded; a quiet stretch is not an event. The same event in a row is one line with `×N` (`12d ⏎ Turn finished ×7`: every line carries a word beside its icon); an agent that started and finished in the list is one line at the finish (`▸ bench_tokenizer 7m ✓`, or `bench_tokenizer ran 7m ✓` with glyphs set to text), and one still running is `▸ bench_tokenizer`; guardian reviews' comings and goings are left out, their failures kept. Each agent's name has its own colour, here and in the Inspector's heading, so one agent can be followed down the list. A pending approval also says how long it has waited, on the bar's alert (widest form) and in the panel's status card.

**Agent log.** Under the tree (in its card, in rich), each subagent has a log, newest first: its starts, finishes and failures and its latest updates as observed, written on the same read that updates the tree, and the brief's notes about it, marked `~` as model-written. The log only grows; a new brief adds to it rather than replacing the last. It follows the tree: an agent the tree hides (put away, filtered out, under a collapsed parent) is not shown, and a collapsed parent says how many logs are folded under it; showing the agent again shows its whole log. In compact each block is headed by the agent's status, kind glyph and Codex name, with its model name or task on the line under it; each agent shows its latest two entries, the selected one six and leads the list, and the Inspector shows all of them. Clicking a log line selects its agent. The log is kept per session in `$CODEX_HOME/hud/agent-log/` (mode 0600, removed after 30 days). It shows whenever a model backend is chosen; Agents → Agent log shows it with observed entries only when the backend is off.

Inspector starts with name, model/effort, status, turn age and last activity. Press `v` for full timestamps and UUIDs. Session-switch notices stay in the footer. Clicking Agents summary or blank rows does not navigate; only actual agent rows switch sessions.

Changes belong to the selected worktree; no file ownership is inferred from agent activity.
Status columns show index then worktree. Compact summaries use Δ for changed files, S for staged and U for unstaged.
Select a file and press Enter for staged/unstaged patches or bounded untracked-file content. Inspector zooms automatically; Esc restores the panes.
Long preview lines wrap; additions are green, deletions red and hunk markers cyan, retaining +/- markers without color. Git reads disable external diffs,
content filters and partial-clone lazy fetching. The panel provides no staging, commit or checkout actions.

Settings offers four panel widths: narrow (16), auto (the original 20–30 column policy), wide (45), and wider (70). Width changes apply immediately and preserve space for the main conversation. The width is applied again whenever the tmux window changes size, as when a session started detached is attached from a wider terminal; dragging the border by hand is left alone. `CODEX_HUD_TREE_WIDTH` remains an initial override when no saved settings exist.

Settings is grouped into Status bar (density, theme, model label, motion, context, bar on launch), Agents (order, hide finished), LLM (every feature that sends material to a model, below) and Panel (layout, status card, language, the four panes, width, picture, mouse, prefix key, refresh). Values sit in one column beside the labels, a value that is not the default in the accent, and from 70 columns each row has a short dim hint after it (on a narrow panel the values line up at the right edge instead); the selected one reads `‹ value ›`, and ←/→, Enter or a click change it (a click on `‹` steps back). The line under the list says what the selected setting does. Unsaved fields show `*` and the Save button lights up; Bar on launch applies from the next launch. Save persists to `$CODEX_HOME/hud-settings.json` (or `CODEX_HUD_SETTINGS_PATH`) and updates the compact HUD on its next refresh. Saved preferences override environment defaults; `NO_COLOR` still wins. Back discards unsaved edits; Reset prepares defaults for Save. The page is a modal: while it is open its keys are its own (arrows, Enter, `s` saves, `r` resets, `Esc` goes back), and the footer names only the moves the buttons do not cover. Rows that wait on another (every model feature on a backend, desktop notices on notifications, the recap floor on the main recap) are dim while it is off, with "takes effect with a backend" under Backend; they stay selectable, to set up in advance. Narrow views retain complete Back/Save buttons and use short labels. Above the help line, one row says when the panel last read the session (`HUD read the session 2s ago`) and, if a read has failed, where, when and why; a failure newer than the last good read is shown as a warning. That is how a quiet session and a HUD that cannot read stop looking alike, since a failed read otherwise leaves the last good values on screen.

**LLM.** Everything the panel asks a model to write is in the LLM settings group, each item with its own switch, and every item is written in the panel's language and shown under the Brief rule as model-written text, not as observed fact. LLM → Backend picks who writes: `omp`, `agy`, or any OpenAI-compatible chat completions endpoint (`api`); off turns every item off. All items share one queue (one call at a time), one cache and one hourly cap (Call cap, 60 calls an hour by default, counted across panels of the same `CODEX_HOME`); a request past the cap is refused and the reason is shown where its text would be. Settings shows the calls made today under the list. The cache and the call log (timestamps only) are kept in `$CODEX_HOME/hud/model-cache/`, mode 0600. What each item sends:

- **Agents brief** (on by default once a backend is chosen): a sentence on the subagents as a whole at the top of the area, and a note per agent that goes into its log. It sends each listed agent's name, status, task text (300 characters) and latest public update (600 characters). The whole picture runs at most once per Brief every, and only when an agent's status or latest update changed; between briefs, agents with news since their last note get new notes, all of them in one request at most once a minute.
- **Main recap** (off by default): a rolling recap of the main session, shown in the status card (rich) or at the top of the brief area (compact): the goal, what is done (at most four items), where it stands, and, painted as a warning, what it needs from you. It sends your prompts and the assistant's public replies and commentary (each cut to about 600 characters, about 4,000 characters in all, never its reasoning), the plan steps, a pending approval's summary, the compaction count, and the name, status and turn time of each subagent; subagents' tasks and updates are sent only when Agents brief is on as well. Each run is given the previous recap and only what was said since, so it stays cheap and survives Codex compacting the conversation. It runs as soon as Brief every allows when you send a prompt, a final reply lands, a turn ends, a plan step completes or an approval is asked for; while a turn runs long (waiting on subagents, say) it is refreshed at most once per Recap floor (15 minutes by default, never more often than Brief every) if anything at all changed, commentary or a subagent moving on included. Nothing changed, nothing is sent. The recap is saved per session in `$CODEX_HOME/hud/recaps/` (mode 0600, removed after 30 days), so reopening the panel or `codex resume` shows the last one at once with its age; a recap in the other language is asked for again. In rich it is shown in the status card at level full; in compact, at the top of the brief area.
- **Result digest** (off by default): when a subagent finishes, its whole final answer (the public final reply only; when it is longer than about 8,000 characters, its head and its tail) is read from the agent's rollout and sent once, and comes back as three short lines: the conclusion, what it rests on, and the caveats the agent itself gave. The digest goes into the agent's log, is shown in the Inspector under "~ Result digest", and stands in for the 600-character excerpt in the Agents brief's material. Agents that finished more than an hour before the panel saw them are digested only when you inspect them.
- **Labels and title** (on by default; nothing is sent until a backend is set): each subagent's task text (400 characters) is sent once, several in one request, nothing else; the reply gives each task a kind of work (research, experiment, fix, review, writing, summary or other) and a short name of about 10 Chinese characters or 4 English words. The kind is drawn as a fixed glyph the HUD picks, dim beside the agent's name: ⌕ research, ⚗ experiment, ⚒ fix, ◈ review, ✎ writing, ∑ summary, none for other (the legend is in `?`). The short name stands in for the agent's name wherever the panel shows it (Label as name, on by default; off, it is the line under the name in the card and the log block); the opened card and the Inspector keep Codex's name, the one `/subagents` prints, and switching goes by it. Until a reply arrives, with the feature off, or when the call fails, a card shows the task text instead and no glyph. Labels are kept by a hash of the task text in `$CODEX_HOME/hud/model-cache/labels.json` (0600), so an agent is labelled once ever; entries written before labels had a kind still read, as kind other. The session also gets a title: the recap's goal when Main recap has written one (no call), otherwise one call with your **first prompt** (1,500 characters). The title is saved as `<session>.title.json` beside the recaps and shown in the bar's session field at its widest reading, with the session id beside it.
- **Failure cause** (off by default): when a main-session tool call fails, the command and the last 2,000 characters of its output are sent; when a subagent ends in error, the error events from the end of its rollout (or the last failed command's output) are. One line naming the cause comes back, shown under the event in the Timeline and, for an agent, in its log and the Inspector. A failure whose rollout recorded no error output sends nothing.
- **Change summary** (off by default): while the Changes pane is open, when the diff's files or line counts change, at most once per Recap floor, the per-file stat (40 files at most) and up to 6,000 characters of the staged and unstaged hunks are sent; untracked files are sent by name only. One or two lines on what the diff does come back at the head of the pane, marked `~`; once the diff has moved on, the old summary says so until the next one.
- **Approval words** (off by default): when a command waits for approval, the whole command (2,000 characters at most) is sent, and one sentence describing what it does is shown at the top of the brief area as "~ Approval, in the model's words:". It describes only: a reply that judges whether the command is safe is dropped rather than shown. It does not replace reading the command; Codex's approval prompt is still where you answer.

Every item's answer is cached by its input, so the same answer, digest or diff is never sent twice, also across panels. A request that fails is not repeated for 10 minutes.

`Ctrl+]` `b`, or a click on the bar's pause button (Pause brief), pauses and resumes every item above (it is offered while Agents brief or Main recap is on). For `api`, set these in `hud-settings.json`:

```json
{ "briefing": "api",
  "briefingApiBase": "http://localhost:11434/v1",
  "briefingApiModel": "qwen3:8b",
  "briefingApiKey": "" }
```

An empty base is OpenAI's. An empty key falls back to `CODEX_HUD_BRIEF_API_KEY`, then `OPENAI_API_KEY`; with none the request is sent without one, for a local server. The file is written with mode 0600. `CODEX_HUD_BRIEF_MODEL` overrides the model for every brief command. Requests are sent at a low thinking level: `omp --thinking low`, and `agy`'s default `gemini-3.8-flash-low` model. Only the fields every compatible server accepts are sent to an `api` endpoint; set `"briefingApiReasoning": true` if yours takes `reasoning_effort` and it will be sent too.

**Picture.** Panel → Picture draws a picture in the panel's empty space: braille dots, dots in the picture's own colours, or ASCII. It only takes lines nothing else is using, and gives them back as the agents and the brief need them. `bin/codex-hud-art <image> [dots|color|ascii]` copies a picture next to the settings and switches it on; `bin/codex-hud-art off` switches it off. ffmpeg reads the picture, so any format it knows works.

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
attention items, `approvalSince` while an approval is pending, `quotaForecast`
when a projection holds (an estimate, not a reading), plus `bar.segments`: which field ended up in which columns of
the line that was actually drawn. That is what turns a click at a column into
the field under it.

The same rules as the display apply. Every value is something that was
observed, and a field with no data is absent rather than zero, so `no quota
snapshot` and `quota at 0%` do not look alike. The file is written atomically
with mode `0600`, only when something other than the clock changed, at most
once a second, and it is deleted when the HUD stops: a state file for a HUD
that is no longer running would read as live.

`health` says whether the bar's own reads go through: `lastReadAt`, when the
session lookup and rollout read last succeeded, and `lastError` (`source`,
`message`, `at`), the most recent failed collection. Each is absent until it
happens. Another successful read alone does not rewrite the file, so
`lastReadAt`, like `updatedAt`, is as of the last write.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_HUD_DENSITY` | `balanced` | How much the bar shows (`focus` / `balanced` / `full`) |
| `CODEX_HUD_THEME` | `terminal` | Palette (`terminal` / `mocha` / `latte` / `none`) |
| `CODEX_HUD_GLYPHS` | `both` | Model badge style (`glyph` / `text` / `both`) |
| `CODEX_HUD_STATUSLINE` | `1` | Bottom bar enabled by default; `0` disables for new HUD sessions, overriding Settings → Bar on launch |
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

Saved display preferences override environment defaults; change Context, Theme and Model label in Settings when preferences already exist. Wheel events go to mouse-aware applications or fall back to tmux history scrolling. HUD bindings use a separate key table, and right-clicking the side panel no longer pastes clipboard text or moves keyboard focus.

Settings → **Bar on launch** saves the bottom bar preference for the next new HUD session. An explicit `CODEX_HUD_STATUSLINE` takes precedence over that saved value.

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
| `CODEX_HUD_PROFILE` | `0` | `1` times each stage of the bar's and the panel's ticks and appends a summary per stage every 10 s to `$CODEX_HOME/hud/profile.log` |
| `CODEX_HOME` | `~/.codex` | Codex home directory |
| `CODEX_SESSIONS_PATH` | (unset) | Override sessions directory |

</details>

### Notifications

Off by default, because Codex has its own notifier and two pop-ups for one
event is worse than none. Settings → Status bar → Notifications, or
`CODEX_HUD_NOTIFY=1`, turns them on; Desktop notices is the second switch for
`CODEX_HUD_NOTIFY_DESKTOP`. A variable that is set wins over the setting.

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

To see where a tick's time goes, start a session with `CODEX_HUD_PROFILE=1`.
Both processes time their stages (`session.find`, `rollout.parse`,
`tree.build`, `status.build`, `git`, `render`, `write`, and the whole `tick` or
`collect`) and every 10 s append one line per stage that ran to
`$CODEX_HOME/hud/profile.log`:

```
2026-10-04T15:27:35.725Z bar pid=144913 tick n=10 avg=2.79ms p95=5.35ms max=5.35ms
```

Nothing goes to the terminal, and with the variable unset the timers cost a
null check. The log starts over past 4 MiB, keeping one `.old` copy.

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
