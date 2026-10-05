# Codex HUD reference

The details behind the [README](../README.md): the panel part by part, every key, the settings and the model features, the machine-readable state, and the configuration. [中文](./reference.zh.md)

- [The panel](#the-panel): [Panes](#panes) · [Layouts](#layouts) · [The control bar](#the-control-bar) · [Looks and icons](#looks-and-icons) · [The status card](#the-status-card) · [Scrolling and selection](#scrolling-and-selection) · [Keys](#keys) · [Switching sessions](#switching-sessions) · [Agents in the list](#agents-in-the-list) · [Timeline](#timeline) · [Agent log](#agent-log) · [Inspector and Changes](#inspector-and-changes) · [Settings](#settings) · [LLM](#llm) · [Picture](#picture)
- [Output throughput](#output-throughput)
- [Machine-readable state](#machine-readable-state)
- [Configuration](#configuration): [Environment Variables](#environment-variables) · [Notifications](#notifications) · [config.toml](#configtoml)

## The panel

### Panes

There are four panes: **1 Agents** (the cards in rich, the tree in compact), **2 Timeline**, **3 Changes** (the worktrees over the changed files) and **4 Inspector**; Agents is open by default, the others open from the bar or with `Ctrl+]` `2`–`4`. Panes stack vertically. Each has a **title row** naming it, drawn as the panel's look draws it (below), with which rows are in view at its right end when it scrolls (`7–14/46`), or else how many it holds (`4 files`, `9 events`); then its rows behind a gutter `│` on the left only (in the accent for the focused pane, dim for the rest): no right border and no bottom rule. In a panel 30 rows or taller a blank row parts the sections: under the bar, between two panes and above the status card; never at a pane's expense, and not in the frame look, whose edges part them already. A pane is **open or closed**; a closed one takes no row at all. A click on a pane's title zooms it to the room between the bar and the status card, and a second click restores it, as `Ctrl+]` `z` does. A pane takes no more rows than it has to show; spare height goes to Agents, or to the Inspector while it has the focus. The agents area works the same way: its title row carries the counts, a click on it zooms the cards, and it can be closed from the bar, the other panes then sharing its room.

### Layouts

**Two layouts** (Settings → Panel → Layout, applied at once):

- **rich** (the default): the agents as cards. One line at the top counts the agents the main session started by how they stand (`!1 failed  ✓3 done  ▸3 run`, each count with its word; one counts as running while a subtask of it runs), with `◈N` for the session's guardian reviews (in the error colour when one failed) and, where it fits, how many subtasks the L1s started and how many of them failed (`· 17 subtasks, 1 failed`), which outlasts the counts' words and the view's `4–19/46` on a narrow panel (`!1 ✓3 ▸3  · 17 subtasks, 1 failed`); under it, in one scrolling view, an entry for each agent the main session started (an **L1** agent), in the list's order, under the same filter and linger window. The agents those started (**L2**: implementers, reviewers, scouts and the like) have no entry of their own: they are on their lead's card. An L1 that is running, has failed, finished in the last minute or needs a look gets a **card**, open on the right. Its top rule has the status icon, a glyph for the kind of work (when Labels and title gave one), the agent's name in its direction's colour (the colour the timeline gives the same agents; middle-cut when long, underlined because a click on it switches to the agent), `◈N` for its guardian reviews and the model/effort badge; the bottom rule has the turn clock counting seconds while it runs (`◷4m07s`, in the warning colour when quiet) or how long ago it finished or failed (`12d`), then the agent's context meter filling the rest of the rule as a thin line with its percentage at the end of the fill (`────57%──────`), and `▾`. Inside, a line each, and each only when there is something to say: what it is for (its task, strong, or, where the rollout keeps the task sealed, what it said it would do); who it works with (on a lead, `⇄` and the agents without subtasks it exchanged three or more messages with; on one of those, `→` and the lead it works for, in that lead's colour); what it is doing this moment (`▸ npm run bench`, its open tool call); its newest model note (`~`) and its newest update; the subtasks that matter, three at most and failures first, each with its status, its name, what it returned or, failed, why (marked `~`, from Failure cause), and its clock or age at the right; and the rest of its subtasks counted by role (`3 implementer · 2 reviewer · 1 critic +1`, a prefix every role shares left out). A subtask matters when it failed, a note flagged it, or its role is named in `importantRoles` (see [Settings](#settings)); Settings → Agents → Role counts hides the count line. Cards take their state's colour: running info, quiet warning, failed error, just finished success; the selected card's top rule sits on a lighter band. Settings → Agents → Card corners draws them square (`┌`, the default) or round (`╭`). Every other finished L1 is **two lines**: `✓ audit_deps   ☽◐ ───57%──── 12d`, its meter and age in columns down the list, and under it, indented and dim, how far it got: its newest model note, else its newest update, else its task. Names come first: where the meters would cut most of the names, the list draws none, and a run of rows of the same age says it once, at the top of the run. `j`/`k` move over the cards and the two-line rows, a two-line row only marked (its first line on the lighter band), and `e`, Space or a click opens it into its card. An opened card (`e`, Space, or a click on its top rule or `▾`) adds the name Codex prints when a label stands in for it and names every subtask that matters, then the agent's whole log newest first, about twenty lines, the rest left to the Inspector (or, with no log, its last report), then the task in full. A click on a subtask's line selects that subtask, for the Inspector. Agent text loses its chat markdown in cards and the Inspector: links keep their text, bold, code and heading marks go, a full commit hash shows seven characters. Guardian review threads get no card: they are the `◈N` chip, and a failed one shows as a card. The main session's brief is not in this view: it is in the status card at the foot (below).
- **compact**: the Agents pane (the tree, one row per agent and subtask, by Codex's own name, under the same title row as rich) with the brief, the recap and the agent log under it, as before.

Every view counts alike: an **agent** is one the main session started, a **subtask** an agent under one, at any depth, and a **review** a guardian approval review, wherever it sits. The Agents pane's title row, the status card's alert, which says the failures as one phrase (`! 1 agent · 1 subtask · 1 review failed`), the bar's Agents field and alert, notifications and `codex-hud --json` all count the three apart, and an agent counts as running while a subtask of it runs.

### The control bar

**The control bar** is the panel's first row (two in the frame look), and every control the panel has is on it; cards, the status card and the panes' titles draw none. Each control is a **button**: its icon, and its word where it fits. No key is written on it; the keys are in the help.

```
120 columns   ⌂ Main   ▦ Agents   ≣ Timeline  ± Changes  ◫ Inspect                       ǁ Pause brief  ⊕1 older  ⚙ Settings  ? Help
 56 columns   ⌂  ▦ Agents    ≣ Timeline   ±   ◫             ǁ ⊕1 ⚙ ?
 40 columns   ⌂  ▦ Agents    ≣   ±   ◫      ǁ ⊕1 ⚙ ?
 32 columns   ⌂  ▦ Agents  ≣ ± ◫    ǁ ⊕1 ⚙ ?
```

- `⌂` returns Codex to the main session. Its word (Main) shows where every button has room for its own, and in the frame look's title wherever it fits.
- The tabs are the panes, in their order: `▦` Agents, `≣` Timeline, `±` Changes, `◫` Inspect, each the icon its pane's title carries. The focused tab is drawn as the look draws it (a filled tab in the tab look); an open one is in the text colour, a closed one dim. In the stacked layout one click opens a closed pane and focuses it, and closes an open one, the cards included; in the tabs layout it shows that pane, and the pane's title leaves its name to the tab: it is the pane's counts and where its rows are (`✓38 done  · 101 subtasks    23–44/103`), or in the frame look the frame's edge alone.
- `ǁ` / `▶` (Pause brief / Resume brief) pauses or resumes the brief, shown only while one is configured; `⊕1` (older) shows the finished agents the linger window put away and `⊖1` (Hide) hides them again, shown only when there are some (in rich, the agents, the list's rows: their subtasks are on the cards either way; in compact, every row the tree put away); `⚙` opens settings; `?` the help.
- The bar follows the width. Words go before buttons: first the actions' words (they show only when every button has its word), then the closed tabs', then the open tabs' but the focused one's, then that one's, the columns between the tabs narrowing from three to one on the way. Then buttons go: the closed panes' tabs, the older agents' button, the brief's, the other tabs, the focused tab. The main session's button, settings and help never go. A click anywhere between the midpoints of the gaps either side of a button is that button. Without colour (`theme: none`) the focused tab is in brackets, and a closed pane has no tab.

### Looks and icons

**Look** (Settings → Panel → Look, or `CODEX_HUD_LOOK`) draws the bar and the panes' titles in one of five ways. Picking a look in Settings sets Icons to the set it was drawn with (`CODEX_HUD_LOOK` alone leaves them as they are); Icons can change them after.

```
tab     ⌂  ▦ Agents    ≣   ±   ◫      ǁ ⊕1 ⚙ ?
band    ⌂ ▦ Agents   ≣   ±   ◫ ────── ǁ ⊕1 ⚙ ?
tile    ⌂  🤖 Agents  🕘 📝 🔍        ǁ ⊕1 ⚙ ?
frame  ╭─ ⌂ Main ────────────────── ǁ ⊕1 ⚙ ? ─╮
       │  ▦ Agents    ≣ Timeline   ±   ◫      │
pill    ⌂ ▦ Agents   ≣   ±   ◫      ǁ ⊕1 ⚙ ?
```

- **tab** (Tab row, the default; Unicode icons): the focused tab is filled, a column of its colour either side of its face. A pane's title is its icon and name, the accent where the focus is, on no surface of its own.
- **band** (Status band; Unicode icons): the bar is a band on its own background, as the status card's is, its spare columns an accent rule between the tabs and the actions; the focused tab is in the accent. The panes' titles are bands too, a zoomed one filled as the focused tab is.
- **tile** (Emoji tiles; emoji icons): every open tab sits on a chip of its own, the focused one filled; a pane's title runs on into a rule, the accent where the focus is.
- **frame** (Frame; Unicode icons): a rounded frame round the whole panel. The main session is the title on its top edge, with the actions at that edge's right end; the tabs are the row under it; each pane's title is an edge across the frame (`├─ ± Changes ──────────── 4 files ─┤`), its rows between the frame's sides (the left one in the accent beside the focused pane), and the status card's corner closes it (`╰─ … ─╯`). Under 20 columns it is drawn as tab.
- **pill** (Pills; Nerd Font icons): the focused tab is a pill with rounded ends; the panes' titles are pills, the focused pane's in the tab colour, the rest on a chip.

**Icons** (Settings → Panel → Icons, or `CODEX_HUD_ICONS`) picks the set: `unicode` (the glyphs above), `nerd` ([Nerd Font](https://www.nerdfonts.com/) icons: a home `U+F015`, a robot `U+F06A9`, a history clock `U+F1DA`, a diff `U+F440`, an info circle `U+F05A`, pause / play `U+F04C` / `U+F04B`, an eye and a struck eye `U+F06E` / `U+F070`, a cog `U+F013`, a question circle `U+F059`), `emoji` (the panes as 🤖 🕘 📝 🔍, two columns each, the actions keeping their Unicode glyphs), or `text`: the buttons are words alone (`← Main`, `Agents Timeline Changes Inspect`, `Pause brief`, `+1 older`, `Settings Help`), shortened where narrow (`Ag Tl Ch In`, `Pause`). `glyphs: text` does the same. The Unicode and Nerd Font icons and the pills' rounded ends are drawn by MesloLGS NF (see [Font](../README.md#font)).

### The status card

**The status card** at the foot is a band and a corner, as omp draws its status line, and its meters are thin lines with the reading where the fill ends:

```
 ✓ Idle ★◆ 5d ──────────────────────56%──────────────────272K ~3m
│ ◎ Make the tokenizer twice as fast without breaking CJK text
│ ▸ Waiting on the CJK fix and the cache review
│ ✓ Dependency audit clean
│   Add the streaming tokenizer API +2
╰─ parser-kit · main * ↑2 7d ───────────────────────────99% ↺4d18h
```

- **The band**, on its own background across the width: the session's state (while it works, the running tool and its target, the turn's clock and `~N tok/s`), the model badge and the session's age; the context meter, the percentage where the fill ends and the window size at the tail (a `┃` tick marks the auto-compact point when `config.toml` sets `model_auto_compact_token_limit`); then, wherever a brief is configured, its state (`~3m` for the recap's age, then in words: writing…, failed, paused). A click anywhere on the band steps the level, as `r`.
- **The body** hangs off a left gutter (`│`) in the main session's state colour: dim idle, info working, error failed, warning stale or needing you (an approval, a failed tool or agent, a recap that needs you).
- **The corner** (`╰─`): where the session works (the project in bold, `› repo` when it differs, `· branch`); the quota meter for the tightest window, labelled `7d` and read `99%`; the reset countdown; and the prompt-cache reminder, only in the five minutes before the cache lapses, in the warning colour.
- Meters fill in the info colour, warning past 70 %, error past 85 %, over a dim track.
- Short of room, the band drops the rate, the tasks, the age, the window size, the model and the brief's state, then the meter shrinks to its percentage; the corner drops other windows, the branch, the window, the repo and the forecast, then its meter and the reset. The state and the percentages go last. Under 24 columns there is no card.

It has three levels (Settings → Panel → Status card, saved like the other panel preferences); `Ctrl+]` `r` or a click on its band steps through them:

- **min**: the band alone, with the brief's state and the quota's reading at its right end, marked `!` when a tool or agent failed or the recap says it needs you.
- **status**: the band, the alerts when there are any, and the corner.
- **full** (the default): those, then the main session's brief: the pending approval in the model's words first (`⚑ ~ …`), then the recap with its labels inline in one column, needs (`!`, in the warning colour) first, then goal (`◎`), now (`▸`) and the newest two done items (`✓`, a dim `+N` for the rest), each value at most two lines; the whole-picture sentence stands in for Now only when there is no recap; then a failed call or a reply in another shape than asked for. Paused, the brief steps back to dim. With glyphs set to text, the labels are words (Needs, Goal, Now, Done) padded to one column. The card takes at most a third of the panel and leaves the agents at least ten rows when the panel is tall enough; rows the panes above leave unused are its too, as far as the brief fills them, and then it shows every done item and up to four lines a value. A brief taller than its room keeps needs, now and goal in view and the rest a scroll away (the wheel over the card), with a line saying what is out of view.

Compact keeps its layout: the brief and recap stay in the area under the tree, in the same inline fields, so its card has only min and status (full there is status) and `Ctrl+]` `r` switches between the two.

### Scrolling and selection

The view under the agents' title row scrolls when it does not fit: the wheel over it, `PgUp`/`PgDn`, and moving the selection, which brings the selected agent into view. The title row says at its right end which rows are in view (`6–17/40`). Where it is scrolled to holds across repaints and new content, and is clamped when content shrinks. A view under 12 rows drops its blank lines before it hides content. The status card and the open panes 2–4 keep their place.
At 16–20 columns, margins shrink. Use `Ctrl+]` `z` to give the focused pane the full height.
Selection follows agent IDs and file paths across refreshes, and every pane retains its scroll position.

### Keys

Every key below follows the prefix: `Ctrl+]`, then the key (or the prefix chosen in Settings). Typed without it, a key goes to Codex.

| `Ctrl+]`, then | Action |
|-----|--------|
| `,` / `?` | Open settings / the help (also the `⚙` and `?` buttons); arrows, Enter and click change values, Save applies them |
| `Tab` / `Shift+Tab` | Cycle pane focus (in the tabs layout, show the next or the previous pane) |
| `1`–`4` | Open and focus a pane, or close it if it is open: `1` Agents (the cards in rich), `2` Timeline, `3` Changes, `4` Inspector; in the tabs layout, show it; so does a click on its tab |
| `x` | Close the focused pane (stacked layout) |
| `j` / `k`, `↑` / `↓` | Move the selection or scroll; repeats without the prefix for half a second (`Ctrl+]` `j` `j` `j`) |
| `PgUp` / `PgDn`, `g` / `G` | Page (the agents view scrolls a page; repeats), first/last item |
| `e` or Space (rich) | Open or close the selected card (opened, it names every subtask that matters and gives the agent's log), or open a two-line finished agent into its card |
| `Enter` / `v` | Open Inspector; inside Inspector, expand/collapse timestamps, IDs and full paths (`▾ More`); in the Timeline, bring back twenty earlier entries |
| `h` / `l` (compact) | Fold/unfold or navigate parent/child agents |
| `s` | Active-first / creation order |
| `a` | Show or hide the finished agents the tree has put away (the `⊕N` button) |
| `f` or `/` | Filter all, running, failed, unknown |
| `o` | Switch the actual Codex conversation to the selected agent (a click on an agent in compact, on a card's name in rich) |
| `m` | Return the Codex conversation to the root session (the `⌂` button) |
| `z` | Zoom/restore focused pane, a click on its title too (stacked layout) |
| `b` | Pause / resume the brief and recap model calls (the `ǁ` button) |
| `r` | Status card level: min → status → full (compact: min ↔ status); a click on the card's band too |
| `Esc` | Dismiss help, unzoom, return to list; close from Agents |
| `q` | Close the panel |
| `Ctrl+]` | Send `Ctrl+]` itself to the pane with the cursor |

| Mouse | Action |
|-----|--------|
| Click / wheel | Select or scroll; the wheel scrolls the agents view without moving the selection, and over the status card (rich, full) its brief |
| Click a card (rich) | Body or bottom rule: select it; top rule or `▾`: select and open/close it; its underlined name: switch to that agent; a one-line row: open it |
| Click an agent (compact) | Switch to it |

### Switching sessions

Session switching drives Codex's own `/subagents` picker (verified against Codex 0.154 and 0.157) and selects the row showing the agent's exact UUID; it never submits guessed `/agent <id>` commands. It requires an empty composer (including the read-only composer of a sub-agent view) or the recognized picker. Drafts, copy mode and unsupported views produce a visible message instead of forced input. Keyboard selection alone previews the agent; `o` switches. Visible targets are reached in one movement batch, long lists a page at a time, and the row is rechecked before Enter. The picker is not reopened afterward, avoiding a second popup and transcript redraw. A delivered request does not independently confirm the final Codex view.

Below about 63 columns Codex stops printing UUIDs in the picker. The agent is then matched by the name the picker prints (its task path, or `Main [default]`), and only when no other agent of the session prints the same name; otherwise the switch is refused with a request to widen the Codex pane. While agents are running, Codex adds a "Sub-agents running" note to the conversation each time the picker opens; that note is Codex's own.

### Agents in the list

Active sorting only rearranges siblings. A running descendant brings its entire branch forward;
latest turn starts determine order, while ordinary token and log updates do not reshuffle the tree.
Parent links support both metadata locations. Missing status evidence stays unknown.

Each agent's rollout is read once, each read going on from where the last one stopped. How far each was read and what it held (status, stages, open calls) is kept in `$CODEX_HOME/hud/scan/`, one file for each rollout of more than 256 KB (mode 0600, removed after a week unwritten), so a panel or bar started again reads only what was written since. A saved read is used only while the file still matches it (the same file and thread, the bytes it ended on unchanged); otherwise the rollout is read again from its start.

Agents are named by the last segment of their task path, the name Codex's `/subagents` picker shows: `/root/essays_2020_2021` reads `essays_2020_2021`. That name heads the tree row, the card and the agent's log block until a label arrives. With Labels and title on (the default, once a backend is set), the model's short name then stands in for it in cards, rows, the compact tree, the timeline and the Inspector's heading (Settings → Agents → Label as name; off, the label is the line under the name instead); an opened card and the Inspector still show the name Codex prints, and switching to an agent always goes by that name. The random nickname Codex also assigns (Copernicus, Meitner…) and the role move to the Inspector. Guardian review threads (Codex 0.155+ opens one beside a session to review its approvals) get no row or card of their own: their parent carries `◈N`, in the info colour while one runs, and a failed one still shows.

Finished agents leave the list 3 minutes after they finish (Settings → Hide finished: 1m, 3m, 10m, 30m or never). Running and failed agents never leave, and a finished agent whose child is still shown stays as a dimmed row. Each finished row says how long ago it finished; the control bar counts what was put away (`⊕12`), and clicking that or `Ctrl+]` `a` shows everything again.

### Timeline

Pane 2, closed by default, lays the session out on the main session's axis, newest first, each entry with its age, said once at the top of a run of entries of one age. The main session's own events are at the left: a turn that finished, with the head of what it told you (`⏎`), approvals asked for and answered, compaction, a quota window crossing 80 % and 95 %, turns interrupted or failed, and failed tool calls, each by the command it ran (an `exec` script's first command, `✗ rg -n …`), else the tool's name; the same one in a row is one line with `×N`. The agents the main session started are a level in, a line for each of their stages: one that ended sits at its end, with how long it took, the subtasks the agent saw finish in that time (`✓2 ✗1`) and, for the agent's newest, the first lines of what it returned; one still running sits at its start, with its clock and what the agent said it would do. A helper's stage names the lead it was for (`Performance advice → Tokenizer speed`). Of the subtasks, only those that matter (as on the cards) get a line, a level further in, at their end. Each agent is in its direction's colour, the one its card's name has: an L1 and the agents under it share a colour, a helper takes its lead's, and directions at work side by side get colours apart. A failure's cause, when Failure cause wrote one, is under it, marked `~`. Facts the rollouts recorded only: a quiet stretch is not an entry. Guardian reviews' comings and goings are left out, their failures kept. A pending approval also says how long it has waited, on the bar's alert (widest form) and in the panel's status card.

Settings → Panel → Timeline style draws the levels three ways:

```
rail      28m ⏎ CJK stage 1 is merged; vertical punct…
          30m ├─▸ Performance advice                 ◵
              │    Checking whether the lookup table
          40m │ ╰✗ b03_review_harness              15m
          50m ├─▸ CJK correctness                    ◴

indent    28m ⏎ CJK stage 1 is merged; vertical punct…
          30m   ▸ Performance advice                 ◵
                  Checking whether the lookup table
          40m     ✗ b03_review_harness             15m
          50m   ▸ CJK correctness                    ◴

lanes     28m ⏎ │ │ CJK stage 1 is merged; vertical p…
          30m │ ▸ │ Performance advice               ◵
              │ │ │   Checking whether the lookup
          40m │ ✗ │   b03_review_harness           15m
          50m │ │ ▸ CJK correctness                  ◴
```

- **rail** (the default): the main session's entries on a rail down the left, the agents' off it, a subtask's a step further.
- **indent**: the same levels as indents alone.
- **lanes**: a lane beside the main session's for each direction that has subtasks or is at work, three of them, four from 48 columns wide; a direction's entries sit on its lane, and a lane runs from the top while its direction is at work.

Settings → Panel → Timeline span is the window: the last 1, 3 (the default), 6, 12 or 24 hours, and at least the newest eight entries whatever their age; a stage still running shows wherever it started. What is earlier is counted on a last row, `▸ 40 earlier`: a click on it, or Enter while the Timeline has the focus, brings back twenty more at a time.

### Agent log

Under the tree (in its card, in rich), each subagent has a log, newest first: its starts, finishes and failures and its latest updates as observed, written on the same read that updates the tree, and the brief's notes about it, marked `~` as model-written. The log only grows; a new brief adds to it rather than replacing the last. It follows the tree: an agent the tree hides (put away, filtered out, under a collapsed parent) is not shown, and a collapsed parent says how many logs are folded under it; showing the agent again shows its whole log. In compact each block is headed by the agent's status, kind glyph and Codex name, with its model name or task on the line under it; each agent shows its latest two entries, the selected one six and leads the list, and the Inspector shows all of them but the update it shows above, and none while the log holds only starts and finishes. Each entry's age is a column of its own, its text hanging beside it, without chat markdown. Clicking a log line selects its agent. The log is kept per session in `$CODEX_HOME/hud/agent-log/` (mode 0600, removed after 30 days). It shows whenever a model backend is chosen; Agents → Agent log shows it with observed entries only when the backend is off.

### Inspector and Changes

Inspector starts with name, model and effort (the glyphs, then both in words: `☀◆ gpt-6-astra · max`), status, turn age and last activity. Press `v` for full timestamps and UUIDs. Session-switch notices stay in the footer. Clicking Agents summary or blank rows does not navigate; only actual agent rows switch sessions.

Changes lists the worktrees over the files, where there is more than one: a row each, the one whose files are listed marked `●` and in bold, how far its branch is from upstream (`↑2`, `↓1`) and its state on the right (`4 mod`, `clean`, `locked`); then a rule naming it again with its counts (`─ main · 2 unstaged ───`), and its files. One cursor runs through the worktrees and the files: on a worktree's row it lists that worktree's files, and Enter shows its details in the Inspector (its HEAD commit's subject, branch, state and counts, the full path under More; no hash). A settings file from before, with a Worktrees pane saved open, opens Changes. The files belong to the listed worktree; no file ownership is inferred from agent activity.
Each file is one letter for what happened to it, in its colour: `M` modified (yellow), `A` added (green), `D` deleted (red), `R` or `C` renamed or copied (blue), `!` a conflict (red); the lines it adds and removes are at the right end where they fit (`+12 −3`), and the counts above the list say how many are staged and unstaged. Untracked files fold into one last row, `▸ 12 untracked`: Enter or a click lists them under it, and again folds them. Compact summaries use Δ for changed files, S for staged and U for unstaged.
Select a file and press Enter for staged/unstaged patches (their hunks; the git header, which repeats the path and names blobs by hash, is left out) or bounded untracked-file content; an untracked directory lists how many files it holds and their paths. The heading names the file, with the lines it adds and removes (`+12 −3`) and, dim under it, its folder; each section is headed Staged, Unstaged or Untracked in the panel's language. A long line wraps where a word ends, its later rows two columns in so the `+`/`-` column starts only its first; a tab is spaces to the next fourth column. Inspector zooms automatically; Esc restores the panes.
Long preview lines wrap; additions are green, deletions red and hunk markers cyan, retaining +/- markers without color. Git reads disable external diffs,
content filters and partial-clone lazy fetching. The panel provides no staging, commit or checkout actions.

### Settings

Settings → Panel → Width offers the widths the panel is laid out for: 32 columns (the default), 40, 48 and 56, each a step in what fits (the row meters, the model badge's words, the timeline's fourth lane); ←/→ step between them and come round past either end. Another width, from the settings file or a dragged border, still draws, and ←/→ step on from where it falls. Save applies it at once, and Codex keeps at least 41 columns, so in a narrow window the panel gets less than it asks for. A 0 from an older settings file reads auto, the default width. The width is applied again whenever the tmux window changes size, as when a session started detached is attached from a wider terminal; dragging the border by hand is left alone. `CODEX_HUD_TREE_WIDTH` remains an initial override when no saved settings exist.

Settings is grouped into Status bar (density, theme, model label, motion, context, bar on launch, notifications), Agents (order, hide finished, agent log, label as name, role counts, card corners, key roles), LLM (every feature that sends material to a model, below) and Panel (layout, panes, look, icons, status card, language, the panes 2–4 with the timeline's style and span, width, picture, mouse, prefix key, refresh). Values sit in one column beside the labels, a value that is not the default in the accent, and from 70 columns each row has a short dim hint after it (on a narrow panel the values line up at the right edge instead); the selected one reads `‹ value ›`, and ←/→, Enter or a click change it (a click on `‹` steps back). The line under the list says what the selected setting does. While Theme, Model label, Panes, Look or Icons is selected, a Preview above that line draws the panel's bar and a pane's title as the unsaved value would, so a look can be seen before it is saved. Unsaved fields show `*` and the Save button lights up; Bar on launch applies from the next launch. Save persists to `$CODEX_HOME/hud-settings.json` (or `CODEX_HUD_SETTINGS_PATH`) and updates the compact HUD on its next refresh. Saved preferences override environment defaults; `NO_COLOR` still wins. Back discards unsaved edits; Reset prepares defaults for Save. The page is a modal: while it is open its keys are its own (arrows, Enter, `s` saves, `r` resets, `Esc` goes back), and the footer names only the moves the buttons do not cover. Rows that wait on another (every model feature on a backend, desktop notices on notifications, Routine every on the items it paces: the agents brief, the main recap and the change summary) are dim while it is off, with "takes effect with a backend" under Backend; they stay selectable, to set up in advance. Narrow views retain complete Back/Save buttons and use short labels. Above the help line, one row says when the panel last read the session (`HUD read the session 2s ago`) and, if a read has failed, where, when and why; a failure newer than the last good read is shown as a warning. That is how a quiet session and a HUD that cannot read stop looking alike, since a failed read otherwise leaves the last good values on screen.

Agents → Key roles (`importantRoles` in the settings file) names the roles whose subtasks matter. The page offers none, the default, each role the session's subtasks have, as the cards say it, and what is set; several at once are a comma list in the settings file (`"importantRoles": "critic, oracle"`), which the page keeps among its values. A subtask in one of them is named on its lead's card, gets a line in the Timeline and is named in the Agents brief's report, as a failed one or one a note flagged is. A name matches the role or the role's end after a dash, so `critic` names `team-platform-critic`. With none, only failed and flagged subtasks matter.

### LLM

Everything the panel asks a model to write is in the LLM settings group, each item with its own switch, and every item is written in the panel's language and shown under the Brief rule as model-written text, not as observed fact. LLM → Backend picks who writes: `omp`, `agy`, or any OpenAI-compatible chat completions endpoint (`api`); off turns every item off. All items share one queue (one call at a time), one cache and one hourly cap (Call cap, 60 calls an hour by default, counted across panels of the same `CODEX_HOME`); a request past the cap is refused and the reason is shown where its text would be. Two settings pace them: Brief every, how often news that matters (a stage, status or failure changing, a prompt, a final reply) may run an item, and Routine every (15 minutes by default), how often routine news may (an agent's new update or command, a turn that runs long, a diff that changed). Settings shows the calls made today under the list. The cache and the call log (timestamps only) are kept in `$CODEX_HOME/hud/model-cache/`, mode 0600. What each item sends:

- **Agents brief** (on by default once a backend is chosen): a sentence on the subagents as a whole at the top of the area, and a note per agent that goes into its log. It sends a report with an entry for each agent the main session started (guardian reviews left out), one that works for another right after it: its name and role; its stage and how long it has run, or when it finished or failed; who assigned it, and its task (300 characters) or else the words it took the task on with, its first update of the stage; its latest public update (600 characters) and the command it is running now (200); what its last stage returned and, shorter (300), the two before; its subtasks counted by role, with up to four that matter (failed, flagged by a note, or of a role named in `importantRoles`) named with their state and their answer or cause; failed approval reviews; and who wrote to it during the stage. An answer of up to 1,500 characters is sent as it is; a longer one as its Result digest when that is on, otherwise as its head and tail. The report starts with the agents that need attention (they or a subtask failed in the last hour, or a note says so), then the running ones, then those finished in the last half hour; one finished longer ago gives only its last result. With it go what happened since the previous brief (stages begun and ended, failures; 20 events at most) and the previous brief itself, its sentence and the newest notes, so the model writes notes only for the agents the news is about, eight at most, and every other agent keeps its note. The request is held to 16 KB: past that, lines give way in a fixed order, each from the bottom of the report and only as far as needed (earlier stages' answers; all but the first line of an agent with no subtasks; agents finished over half an hour ago; latest updates; the subtasks that matter; the answers of agents finished in the last half hour, then those agents; all but each agent's first line; then whole agents), and an agent that needs attention is never cut. It runs at most once per Brief every, when an agent's stage, status or failures change; a new update, the command it runs or its routine subtasks moving on are sent at most once per Routine every. A reply that is not the JSON asked for is sent back once to be put right; if that fails too, the last brief stays, and the area says so.
- **Main recap** (off by default): a rolling recap of the main session, shown in the status card (rich) or at the top of the brief area (compact): the goal, what is done (at most four items), where it stands, and, painted as a warning, what it needs from you. It sends your prompts and the assistant's public replies and commentary (each cut to about 600 characters, about 4,000 characters in all, never its reasoning), the plan steps, a pending approval's summary, the compaction count, the goal set with Codex's `/goal` and its status (read from `$CODEX_HOME/goals_1.sqlite`, read only, when it can be), and the name, status and turn time of each subagent; subagents' tasks and updates are sent only when Agents brief is on as well. A prompt that starts with a tag in square brackets (`[watcher] …`) or with a peer's header, who to whom and that it is a peer's (`Docs lead → Root (peer, no reply owed).`), is sent marked as possibly automatic, since tools that write into the session tend to start that way, and does not count as you sending a prompt. Each run is given the previous recap and only what was said since, so it stays cheap and survives Codex compacting the conversation. It runs as soon as Brief every allows when you send a prompt, a final reply lands, a turn ends, a plan step completes or an approval is asked for; while a turn runs long (waiting on subagents, say) it is refreshed at most once per Routine every (15 minutes by default, never more often than Brief every) if anything at all changed, commentary or a subagent moving on included. Nothing changed, nothing is sent. The recap is saved per session in `$CODEX_HOME/hud/recaps/` (mode 0600, removed after 30 days), so reopening the panel or `codex resume` shows the last one at once with its age; a recap in the other language is asked for again. In rich it is shown in the status card at level full; in compact, at the top of the brief area.
- **Result digest** (off by default): when a subagent finishes, its whole final answer (the public final reply only; when it is longer than about 8,000 characters, its head and its tail) is sent once, and comes back as three short lines: the conclusion, what it rests on, and the caveats the agent itself gave. An agent the main session started has each stage's answer longer than 1,500 characters digested as well, when the stage ends. The digest goes into the agent's log, is shown in the Inspector under "~ Result digest", and stands in for the answer in the Agents brief's material. Agents that finished more than an hour before the panel saw them are digested only when you inspect them.
- **Labels and title** (on by default; nothing is sent until a backend is set): each subagent's task text (400 characters) is sent once, several in one request, nothing else; the reply gives each task a kind of work (research, experiment, fix, review, writing, summary or other) and a short name of about 10 Chinese characters or 4 English words. The kind is drawn as a fixed glyph the HUD picks, dim beside the agent's name: ⌕ research, ⚗ experiment, ⚒ fix, ◈ review, ✎ writing, ∑ summary, none for other (the legend is in `?`). The short name stands in for the agent's name wherever the panel shows it (Label as name, on by default; off, it is the line under the name in the card and the log block); the opened card and the Inspector keep Codex's name, the one `/subagents` prints, and switching goes by it. Until a reply arrives, with the feature off, or when the call fails, a card shows the task text instead and no glyph. Labels are kept by a hash of the task text in `$CODEX_HOME/hud/model-cache/labels.json` (0600), so an agent is labelled once ever; entries written before labels had a kind still read, as kind other. The session also gets a title: the recap's goal when Main recap has written one (no call), otherwise one call with your **first prompt** (1,500 characters). The title is saved as `<session>.title.json` beside the recaps and shown in the bar's session field at its widest reading, with the session id beside it.
- **Failure cause** (off by default): when a main-session tool call fails, the command and the last 2,000 characters of its output are sent; when a subagent ends in error, the error events from the end of its rollout (or the last failed command's output) are. One line naming the cause comes back, shown under the event in the Timeline and, for an agent, in its log and the Inspector. A failure whose rollout recorded no error output sends nothing.
- **Change summary** (off by default): while the Changes pane is open, when the diff's files or line counts change, at most once per Routine every, the per-file stat (40 files at most) and up to 6,000 characters of the staged and unstaged hunks are sent; untracked files are sent by name only. One or two lines on what the diff does come back at the head of the pane, marked `~`; once the diff has moved on, the old summary says so until the next one.
- **Approval words** (off by default): when a command waits for approval, the whole command (2,000 characters at most) is sent, and one sentence describing what it does is shown at the top of the brief area as "~ Approval, in the model's words:". It describes only: a reply that judges whether the command is safe is dropped rather than shown. It does not replace reading the command; Codex's approval prompt is still where you answer.

Every item's answer is cached by its input, so the same answer, digest or diff is never sent twice, also across panels. A request that fails is not repeated for 10 minutes.

`codex-hud brief --dry-run` prints the brief the panel would send now for the current directory's session, the instructions and the material with their sizes, from the saved settings, the agent log and the last recap; no model is called and nothing is written, and it works while the backend is off. `codex-hud brief --dry-run FILE` writes it to FILE (mode 0600) instead.

`Ctrl+]` `b`, or a click on the bar's pause button (Pause brief), pauses and resumes every item above (it is offered while Agents brief or Main recap is on). For `api`, set these in `hud-settings.json`:

```json
{ "briefing": "api",
  "briefingApiBase": "http://localhost:11434/v1",
  "briefingApiModel": "qwen3:8b",
  "briefingApiKey": "" }
```

An empty base is OpenAI's. An empty key falls back to `CODEX_HUD_BRIEF_API_KEY`, then `OPENAI_API_KEY`; with none the request is sent without one, for a local server. The file is written with mode 0600. `CODEX_HUD_BRIEF_MODEL` overrides the model for every brief command. Requests are sent at a low thinking level: `omp --thinking low`, and `agy`'s default `gemini-3.8-flash-low` model. Only the fields every compatible server accepts are sent to an `api` endpoint; set `"briefingApiReasoning": true` if yours takes `reasoning_effort` and it will be sent too.

### Picture

Panel → Picture draws a picture in the panel's empty space: braille dots, dots in the picture's own colours, or ASCII. It only takes lines nothing else is using, and gives them back as the agents and the brief need them. `bin/codex-hud-art <image> [dots|color|ascii]` copies a picture next to the settings and switches it on; `bin/codex-hud-art off` switches it off. ffmpeg reads the picture, so any format it knows works.

## Output throughput

The default bar shows `Out ~42.1 tok/s` when enough output-token samples exist.
Selected-agent details show that agent's estimate; expand with `v` to see the sample interval.
The estimate is the change in cumulative **output** tokens divided by rollout timestamp elapsed time
in a roughly 30-second window. It can include tool/service waits and is not pure model decoding speed.
A new turn excludes the preceding idle gap. After 10 seconds without a new sample, `last ~42.1 tok/s`
retains the previous reading. Context usage and compaction counts stay in the bar; the workbench has no Ctx trend.

## Machine-readable state

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

`agents` counts as the panel does (see [Layouts](#layouts)): `active`,
`completed`, `failed` and `unknown` are the agents the main session started,
one active while a subtask of it is; `agents.subtasks` and `agents.reviews`
give the same four for their subtasks and for the guardian reviews; and
`agents.nodes` lists every thread with its `kind` (`agent`, `subtask` or
`review`). This is `version` 2; version 1 counted every thread together.

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
| `CODEX_HUD_THEME` | `terminal` | Palette (`terminal` / `titanium` / `mocha` / `latte` / `none`) |
| `CODEX_HUD_LOOK` | `tab` | How the panel's bar and pane titles are drawn (`tab` / `band` / `tile` / `frame` / `pill`) |
| `CODEX_HUD_ICONS` | `unicode` | The panel's icons (`unicode` / `nerd` / `emoji` / `text`) |
| `CODEX_HUD_GLYPHS` | `both` | Model badge style (`glyph` / `text` / `both`) |
| `CODEX_HUD_STATUSLINE` | `1` | Bottom bar enabled by default; `0` disables for new HUD sessions, overriding Settings → Bar on launch |
| `CODEX_HUD_CONTEXT` | `used` | Context percentage: `used` or `remaining`; also available in Settings |
| `CODEX_HUD_POSITION` | `bottom` | HUD pane position (`top` / `bottom`) |
| `CODEX_HUD_HEIGHT` | `1` | HUD height in lines |
| `CODEX_HUD_MOUSE` | `1` | Enable mouse/trackpad scrolling |
| `CODEX_HUD_SKIP_FONTS` | unset | `1`: the installers leave the MesloLGS NF font out |

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
