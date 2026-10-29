# Codex HUD reference

Native historical usage and the new Quiet overview appearance are described in
[Native usage and Quiet overview](./native-usage.md#english). Open Usage with
the HUD prefix then `w`; activate the appearance in Settings → Display → Look.

The details behind the [README](../README.md): the panel part by part, every key, the settings and the model features, the machine-readable state, and the configuration. [中文](./reference.zh.md)

- [The panel](#the-panel): [Panes](#panes) · [Layouts](#layouts) · [The control bar](#the-control-bar) · [Looks and icons](#looks-and-icons) · [The status card](#the-status-card) · [Scrolling and selection](#scrolling-and-selection) · [Keys](#keys) · [Switching sessions](#switching-sessions) · [Agents in the list](#agents-in-the-list) · [Timeline](#timeline) · [Agent log](#agent-log) · [Inspector and Changes](#inspector-and-changes) · [Settings](#settings) · [Card settings](#card-settings) · [LLM](#llm) · [Picture](#picture)
- [Output throughput](#output-throughput)
- [Machine-readable state](#machine-readable-state)
- [Configuration](#configuration): [Environment Variables](#environment-variables) · [Notifications](#notifications) · [config.toml](#configtoml)

## The panel

### Panes

There are four panes: **1 Agents** (the cards in rich, the tree in compact), **2 Timeline**, **3 Changes** (the worktrees over the changed files) and **4 Inspector**; Agents is open by default, the others open from the bar or with `Ctrl+\` `2`–`4`. Panes stack vertically. Each has a **title row** naming it, drawn as the panel's look draws it (below), with which rows are in view at its right end when it scrolls (`7–14/46`), or else how many it holds (`4 files`, `9 events`); then its rows behind a gutter `│` on the left only (in the accent for the focused pane, dim for the rest): no right border and no bottom rule. In a panel 30 rows or taller a blank row parts the sections: under the bar, between two panes and above the status card; never at a pane's expense, and not in the frame look, whose edges part them already. A pane is **open or closed**; a closed one takes no row at all. A click on a pane's title zooms it to the room between the bar and the status card, and a second click restores it, as `Ctrl+\` `z` does. A pane takes no more rows than it has to show; spare height goes to Agents, or to the Inspector while it has the focus. The agents area works the same way: its title row carries the counts, a click on it zooms the cards, and it can be closed from the bar, the other panes then sharing its room.

### Layouts

**Two layouts** (Settings → Panel → Layout, applied at once):

- **rich** (the default): one configurable card for every visible agent the main session started (an **L1**), active or idle, in one scrolling list under the same order, filter and finished-agent linger window. There is **no card expand/collapse state**, no expansion arrow and no two-line resting layout. Descendants at any depth are listed inside their L1's card, not given separate cards. The fixed summary row counts L1s by status (`!1 failed  ✓3 done  ▸3 run`), counts an L1 as running while a subtask runs, and includes guardian reviews (`◈N`, error colour if one failed). Where room permits it adds the subtasks and their failures (`· 17 subtasks, 1 failed`) and the combined output rate of every running thread, subtasks and reviews included (`· ~186 tok/s`; the main session's rate is in the status band). On narrow panels the count words and view range give way before the subtasks figure.
  - **Identity and selection:** the top rule has status, the name in its direction's timeline colour (middle-cut when long), and the optional work-kind glyph, review chip and model/effort badge. A click on the card selects it; a child line selects that child. The name is underlined when the Codex pane is at least 63 columns or its width is not yet known; a second click on the name within 400 ms switches the Codex conversation. `Ctrl+\` `Enter`, Space or `v`, or the Inspector button, opens details on the selection. These never expand a card; the old prefix `e` command is removed. The selected top rule is on a lighter band. State colours are info for running, warning for quiet, error for failed, success for just finished, and dim for older settled work.
  - **Independent contents:** Settings → Cards controls each field separately (see the [card settings table](#card-settings)). Name and status always remain. The body may show the model's task label under the name, Codex's original name when a label replaces it, relations (`⇄` for collaborators that exchanged at least three messages; `→` for the lead a helper serves), the latest stored model summary, the current tool/action (`▸ npm run bench`), children and role counts (`3 implementer · 2 reviewer · 1 critic +1`, omitting a shared role prefix). The L1's latest model note wraps in full; older notes, raw tasks, pre-create charge, stage intent, reports and log history stay in the Inspector, never as card text. Hiding a field removes its space, not its stored data.
  - **Children:** Child scope defaults to **live + important** (`important`), meaning live children plus failed, flagged and key-role descendants (and eligible guardian reviews); it can be **live** or **all** instead. A child always keeps its name and status. With Child summaries on, an active child uses its latest model progress note, not a stale digest; a failed child prefers its model failure cause; a completed child prefers its result digest, falling back to a note. Only the **first sentence / first digest line**, at most **160 Unicode code points**, is shown, wrapping beside or under the name rather than being cut to a single display row. The digest's evidence and caveats remain in the Inspector. Child summaries off keeps the child names and statuses. Child clocks follow the same Turn clock switch as the L1.
  - **Footer and models:** the optional clock counts seconds during the turn (`◷4m07s`, warning when quiet), or shows the age since finish/failure (`12d`); the optional rate (`· ~42 tok/s`) follows, then the optional context meter (`────57%──────`). The rate uses a turn-level wallclock estimate (including initial latency and generation stalls, excluding identifiable tool waits), resets at a turn start, and disappears when the newest report is three minutes old, rounds to zero or would leave the meter under twelve columns. Card corners are square (`┌`, default) or round (`╭`), in Settings → Cards. The Card progress generator requests only the live subjects whose summaries these settings allow in the currently shown Agents list, while Agents is shown and no modal is open; pending/error text accompanies the corresponding enabled summary and retains its old words. Guardian reviews have no separate card: their parent carries `◈N`, with failed reviews still visible as rows. Agent text loses chat markdown in cards and the Inspector: links keep their text, bold/code/heading marks go, and a full commit hash shows seven characters. The main session's brief stays in the status card at the foot.

- **compact**: the Agents pane (the tree, one row per agent and subtask, by Codex's own name, under the same title row as rich) with the brief, the recap and the agent log under it, as before.

Every view counts alike: an **agent** is one the main session started, a **subtask** an agent under one, at any depth, and a **review** a guardian approval review, wherever it sits. The Agents pane's title row and cards, the status card's alert and notifications, which say the failures as one phrase (`! 1 agent · 1 subtask · 1 review failed`), the bar's Agents field and alert, the Agents brief and `codex-hud --json` all count the three apart, and an agent counts as running while a subtask of it runs. A card counts its subtasks at every depth and shows its reviews as its `◈N`, red when one failed.

### The control bar

**The control bar** is the panel's first row (two in the frame look), and every control the panel has is on it; cards, the status card and the panes' titles draw none. Each control is a **button**: its icon, and its word where it fits. No key is written on it; the keys are in the help.

```
120 columns   ⌂ Main   ▦ Agents   ≣ Timeline  ± Changes  ◫ Inspect  ⚙ Settings                  ǁ Pause models  ⊕ 1 finished  ? Help
 56 columns   ⌂  ▦ Agents   ≣ Timeline  ±  ◫  ⚙ Settings      ǁ ⊕1 ?
 40 columns   ⌂  ▦ Agents  ≣ ± ◫ Settings     ǁ ⊕1 ?
 32 columns   ⌂  ▦  ≣ ± ◫ Settings    ǁ ⊕1 ?
```

- `⌂` returns Codex to the main session. Its word (Main) shows where every button has room for its own, and in the frame look's title wherever it fits.
- The tabs are the panes, in their order: `▦` Agents, `≣` Timeline, `±` Changes, `◫` Inspect, each the icon its pane's title carries. The focused tab is drawn as the look draws it (a filled tab in the tab look); an open one is in the text colour, a closed one dim. In the stacked layout one click opens a closed pane and focuses it, and closes an open one, the cards included; in the tabs layout it shows that pane, and the pane's title leaves its name to the tab: it is the pane's counts and where its rows are (`✓38 done  · 101 subtasks    23–44/103`), or in the frame look the frame's edge alone.
- `⌨` (Keys here) appears while the panel keeps the keys (after a click on a blank row or a gutter): nothing typed reaches Codex until Esc or a click on it hands them back. It is in the accent, its word where the row has room, and it is never given up for room before the help button.
- `⇢` (Switch) appears while an agent is selected in the Agents pane, or open in the Inspector: a click switches the actual Codex conversation to it, as `o` does. It gives way for room together with the models' button.
- `ǁ` / `▶` (Pause models / Resume models) pauses or resumes all model generation, shown while a model backend is configured; `⊕N` shows the finished agents the linger window put away and `⊖` hides them again, shown only when there are some (in rich, the agents, the list's rows: their descendants belong to their cards rather than adding entries to this button's count; in compact, every row the tree put away). Where the row fits the words it reads `⊕ N finished`, or `⊖ Hide` while they are shown; otherwise it stays `⊕N` / `⊖N`. With icons set to text it stays `+N older`. The labelled **Settings** navigation tab opens settings; `?` opens the help. Settings stays on the navigation row, including the frame look's second row, not among the right-side actions. Its word survives at 24 columns and above; below that it uses a short word, not a gear alone.
- The bar follows the width. The older agents' button takes its words whenever that row fits them, and the icon alone when it does not, before a button or another word is dropped. The other actions' words show only when every button has its word; then the closed tabs' words, then the open tabs' but the focused one's, then that one's, the columns between the tabs narrowing from three to one on the way. Then buttons go: the closed panes' tabs, the older agents' button, the models' pause button, the other tabs, the focused tab. The main session's button, settings and help never go. A click anywhere between the midpoints of the gaps either side of a button is that button. Without colour (`theme: none`) the focused tab is in brackets, and a closed pane has no tab.

### Looks and icons

**Look** (Settings → Display → Look, or `CODEX_HUD_LOOK`) draws the bar and the panes' titles in one of five ways. Picking a look in Settings sets Icons to the set it was drawn with (`CODEX_HUD_LOOK` alone leaves them as they are); Icons can change them after.

```
tab     ⌂  ▦ Agents   ≣ Timeline  ±  ◫  ⚙ Settings      ǁ ⊕1 ?
band    ⌂ ▦ Agents   ≣ Timeline   ±   ◫   ⚙ Settings ── ǁ ⊕1 ?
tile    ⌂  🤖 Agents    🕘    📝    🔍    Settings      ǁ ⊕1 ?
frame  ╭─ ⌂ Main ────────────────────────── ǁ ⊕ 1 finished ? ─╮
       │  ▦ Agents    ≣ Timeline   ±   ◫   ⚙ Settings         │
pill    ⌂ ▦ Agents  ≣ Timeline  ±  ◫  ⚙ Settings      ǁ ⊕1 ?
```

- **tab** (Tab row, the default; Unicode icons): the focused tab is filled, a column of its colour either side of its face. A pane's title is its icon and name, the accent where the focus is, on no surface of its own.
- **band** (Status band; Unicode icons): the bar is a band on its own background, as the status card's is, its spare columns an accent rule between the tabs and the actions; the focused tab is in the accent. The panes' titles are bands too, a zoomed one filled as the focused tab is.
- **tile** (Emoji tiles; emoji icons): every open tab sits on a chip of its own, the focused one filled; a pane's title runs on into a rule, the accent where the focus is.
- **frame** (Frame; Unicode icons): a rounded frame round the whole panel. The main session is the title on its top edge, with the actions at that edge's right end; the tabs are the row under it; each pane's title is an edge across the frame (`├─ ± Changes ──────────── 4 files ─┤`), its rows between the frame's sides (the left one in the accent beside the focused pane), and the status card's corner closes it (`╰─ … ─╯`). Under 20 columns it is drawn as tab.
- **pill** (Pills; Nerd Font icons): the focused tab is a pill with rounded ends; the panes' titles are pills, the focused pane's in the tab colour, the rest on a chip.

**Icons** (Settings → Display → Icons, or `CODEX_HUD_ICONS`) picks the set: `unicode` (the glyphs above), `nerd` ([Nerd Font](https://www.nerdfonts.com/) icons: a home `U+F015`, a robot `U+F06A9`, a history clock `U+F1DA`, a diff `U+F440`, an info circle `U+F05A`, pause / play `U+F04C` / `U+F04B`, an eye and a struck eye `U+F06E` / `U+F070`, a cog `U+F013`, a question circle `U+F059`), `emoji` (the panes as 🤖 🕘 📝 🔍, two columns each, the actions keeping their Unicode glyphs), or `text`: the buttons are words alone (`← Main`, `Agents Timeline Changes Inspect`, `Pause models`, `+1 older`, `Settings Help`), shortened where narrow (`Ag Tl Ch In`, `Pause`); set to text, the panel's other marks are words too (the status card's Needs, Goal, Now, Done, `12d ago`, the bar's `Cache`). Model label (`glyphs`) is the model badge's alone: its text value writes the model and effort as words and leaves the icons as they are. The Unicode and Nerd Font icons and the pills' rounded ends are drawn by MesloLGS NF (see [Font](../README.md#font)).

### The status card

**The status card** at the foot is a band and a corner, as omp draws its status line, and its meters are thin lines with the reading where the fill ends:

```
 ✓ Idle ★◆ 5d ──────────────────────56%──────────────────272K ~3m
│ ◎ Make the tokenizer twice as fast without breaking CJK text
│ ▸ Waiting on the CJK fix and the cache review
│ ✓ Streaming API merged
│   Benchmarks set up on the 50 MB corpus
│   Dependency audit clean
│   Add the streaming tokenizer API
╰─ parser-kit · main * ↑2 7d ───────────────────────────99% ↺4d18h
```

- **The band**, on its own background across the width: the session's state (while it works, the running tool and its target, the turn's clock and `~N tok/s`; idle, how long it has waited on you since the turn finished, from a minute on: `✓ Idle 12m`, as the bottom bar's activity says `✓ idle 12m`), the model badge and the session's age; the context meter, the percentage where the fill ends and the window size at the tail (a `┃` tick marks the auto-compact point when `config.toml` sets `model_auto_compact_token_limit`); then, wherever a brief is configured, its state (`~3m` for the recap's age, then in words: writing…, failed, paused). A click anywhere on the band steps the level, as `r`.
- **The body** hangs off a left gutter (`│`) in the main session's state colour: dim idle, info working, error failed, warning stale or needing you (an approval, a failed tool, agent, subtask or review, a recap that needs you).
- **The corner** (`╰─`): where the session works (the project in bold, `› repo` when it differs, `· branch`); the quota meter for the tightest window, labelled `7d` and read `99%` (a full window with credits behind it reads the balance instead, `credits 31.8K`, and is not marked `!`: Codex goes on, on credits); the reset countdown; and the prompt-cache reminder, only in the five minutes before the cache lapses, in the warning colour.
- Meters fill in the info colour, warning past 70 %, error past 85 %, over a dim track.
- Short of room, the band drops the rate, the tasks, the age, the window size, the model and the brief's state, then the meter shrinks to its percentage; the corner drops other windows, the branch, the window, the repo and the forecast, then its meter and the reset. The state and the percentages go last. Under 24 columns there is no card. At 32 columns or fewer the card draws as min, and the saved level comes back when the panel is wider. A saved full stays full in shorter windows too, as far as the height permits; changing agent card contents does not change its level.

It has three levels (Settings → Panel → Status card, saved like the other panel preferences); `Ctrl+\` `r` or a click on its band steps through them:

- **min**: the band alone, with the brief's state and the quota's reading at its right end, marked `!` when a tool, agent, subtask or review failed or the recap says it needs you. Its context meter is named `Ctx` (as the quota's reading is named by its window, `5h 61%`), so the two percentages do not read alike; the name outlasts the meter's bar, the window size and the brief's state.
- **status**: the band, the alerts when there are any, and the corner.
- **full** (the default): those, then the main session's brief: the pending approval in the model's words first (`⚑ ~ …`), then the recap with its labels inline in one column, needs (`!`, in the warning colour) first, then goal (`◎`), now (`▸`) and the newest two done items (`✓`, a dim `+N` for the rest), each value at most two lines; the whole-picture sentence stands in for Now only when there is no recap; then a failed call or a reply in another shape than asked for. Paused, the brief steps back to dim. With Icons set to text, the labels are words (Needs, Goal, Now, Done) padded to one column. The card takes at most a third of the panel and leaves the agents at least ten rows when the panel is tall enough; in rich mode its height is reserved independently of card content settings, so longer agent cards scroll instead of taking room away from the recap. A brief taller than its room keeps needs, now and goal in view and the rest a scroll away (the wheel over the card), with a line saying what is out of view.

Compact keeps its layout: the brief and recap stay in the area under the tree, in the same inline fields, so its card has only min and status (full there is status) and `Ctrl+\` `r` switches between the two.

### Scrolling and selection

The view under the agents' title row scrolls when it does not fit: the wheel over it, `PgUp`/`PgDn`, and moving the selection, which brings the selected agent into view. The title row says at its right end which rows are in view (`6–17/40`). Where it is scrolled to holds across repaints and new content, and is clamped when content shrinks. A view under 12 rows drops its blank lines before it hides content. The status card and the open panes 2–4 keep their place.
At 16–20 columns, margins shrink. Use `Ctrl+\` `z` to give the focused pane the full height.
Selection follows agent IDs and file paths across refreshes, and every pane retains its scroll position.

### Keys

Every key below follows the prefix: `Ctrl+\`, then the key (or the prefix chosen in Settings; a settings file saved before `Ctrl+\` became the default, with no prefix of its own, keeps `Ctrl+]`, which Codex 0.160 also binds to Skip Question). Outside settings, help, activity and evidence modals, a key typed without it goes to Codex.

| `Ctrl+\`, then | Action |
|-----|--------|
| `u` | Activity hub: inbox, since viewed, find, history |
| `p` | Find agents by name, role or path; pin selected agents |
| `c` | Evidence sources, model-call dashboard, diagnostic preview/export |
| `,` / `?` | Open settings / the help (also the Settings tab and `?` button); in settings, arrows, Enter and click change values, Save applies them. The help has three pages, a tab each beside its title: Keys, Mouse (the buttons and the mouse) and Legend; a click on a tab, Tab/Shift+Tab or ←/→ turn them, ↑/↓ and PgUp/PgDn scroll one. Too narrow for the three tabs, it shows `‹ page ›`, each arrow a click to the page before or after |
| `Tab` / `Shift+Tab` | Cycle pane focus (in the tabs layout, show the next or the previous pane) |
| `1`–`4` | Open and focus a pane, or close it if it is open: `1` Agents (the cards in rich), `2` Timeline, `3` Changes, `4` Inspector; in the tabs layout, show it; so does a click on its tab |
| `x` | Close the focused pane (stacked layout) |
| `j` / `k`, `↑` / `↓` | Move the selection or scroll; repeats without the prefix for half a second (`Ctrl+\` `j` `j` `j`) |
| `PgUp` / `PgDn`, `g` / `G` | Page (the agents view scrolls a page; repeats), first/last item |
| `Enter` / Space / `v` | Open Inspector on the selection (no card expansion); inside Inspector, expand/collapse timestamps, IDs and full paths (`▾ More`); in the Timeline, open the agent of the entry under the cursor (↑/↓ step through the agents' entries), else bring back twenty earlier entries |
| `h` / `l` (compact) | Fold/unfold or navigate parent/child agents |
| `s` | Active-first / creation order |
| `a` | Show or hide the finished agents the tree has put away (the `⊕N` button) |
| `f` or `/` | Filter all, running, failed, unknown |
| `o` | Switch the actual Codex conversation to the selected agent at once (`⌂` does the same for the main session; the bar's `⇢` Switch does the same as `o`). A click selects; a second click on the name within 400 ms switches |
| `m` | Return the Codex conversation to the root session (the `⌂` button) |
| `z` | Zoom/restore focused pane, a click on its title too (stacked layout) |
| `b` | Pause / resume all model calls (the `ǁ` button) |
| `r` | Status card level: min → status → full (compact: min ↔ status); a click on the card's band too |
| `Esc` | While keys are kept in the panel, hand them back to Codex; then dismiss help, unzoom, or step back to the Agents list, and stop there. Esc never closes the panel: `q` or F12 does |
| `q` | Close the panel |
| `Ctrl+\` | Send `Ctrl+\` itself to the pane with the cursor |

| Mouse | Action |
|-----|--------|
| Click / wheel | Select or scroll; the wheel scrolls the agents view without moving the selection, and over the status card (rich, full) its brief |
| Click a card (rich) | Select it, without expanding or collapsing. A second click on the name within 400 ms switches (underlined when the Codex pane is at least 63 columns). A child line selects that child. Enter, Space, `v` or `◫` opens the Inspector |
| Click an agent (compact) | Open the Inspector; a second click within 400 ms switches |
| Click a blank row, or the gutter | Keep the next keys in the panel until Esc. While they are held the bar shows `⌨ Keys here` (the glyph alone where narrow, `Keys` with icons set to text); a click on it hands them back too |

### Local activity and evidence

`Ctrl+\ u` opens a modal with five tabs. Tab/left/right change tabs, arrows/wheel select rows, Enter inspects a current agent, and Escape returns. Historical agents absent from the current tree are not used as live navigation targets.

- **Inbox:** observed approvals, failures and readback/collection problems. Mark read (`r`), snooze ten minutes (`s`), pin (`p`), or use the named buttons. Read is not resolved: recovery requires successful evidence from the corresponding source. This does not add another desktop notification channel.
- **Since viewed:** unacknowledged completion/failure, observed Git-state changes and stored model-summary changes. `v` / Mark viewed acknowledges only the visible events; opening or closing the modal does not discard unseen events. Git file state is collected on demand while this tab or Changes is open; unavailable/stale state is labelled. This is not a complete between-times Git diff.
- **Find:** filter name, role or agent path, including Unicode and pasted text. Ordinary letters are query text while editing; Ctrl+P or the Pin button pins the selection, Ctrl+F returns to query editing. Pins are scoped to the root session. Normal input forwarding resumes when the modal closes.
- **History:** bounded observed state snapshots and their retained events, explicitly labelled historical. It does not record the conversation, restore the terminal or rerun tasks.
- **Sessions:** the root sessions started in this session's directory over the last 7 days (at most eight, the most recently written first): when, how long ago, the title a model wrote earlier where there is one (else the id's head), and `this session` on the current one. The selected one's resume command is under the list, whole (the id on lines of its own where the line cannot hold it): `$ codex resume <id>`. The HUD never runs it, and nothing here calls a model; the list is read from the rollouts' first lines only while the tab is open, at most every ten seconds.

The private atomic journal under `$CODEX_HOME/hud/activity/` is scoped by root session and bounded to 500 events, 48 snapshots, 200 agents/pins, 30 days and 4 MiB serialized. It retains only necessary status, bounded paths and already generated model summaries, not raw tasks, conversation, commands or reasoning. Bar and panel both observe; concurrent panels merge changes. A contended/unwritable store remains visibly pending for a later flush. Time without a running HUD is not reconstructed.

`Ctrl+\ c` explains main/selected-agent evidence, timestamps, estimated TPS and Herdr readback/conflicts. The status-band TPS is clickable; `Ctrl+\ d` retains the Inspector diagnostics with a Sources/Calls/Export entry. Unknown data remains unknown, and lifecycle completion does not verify work quality.

The Calls tab groups locally observed requests, cache hits, successes, failures, cancellations, limits and mean dispatch-to-settlement duration by feature, including connection probes. Retention is 24 hours / 1000 records. Requests include cached consumers and refusals, not just provider calls; durations exclude queue time. Other panels' pending work and older/pre-instrumentation calls are unavailable. Unknown tokens and dollar cost are not estimated as billing.

Export shows a fixed full JSON preview first. Save report / `s` writes those exact bytes to a new 0600 file under `$CODEX_HOME/hud/diagnostics/`. It excludes credentials, endpoints, identifiers, file paths and source/summary text. Versions, platform and a startup entry-file hash identify only the entry observed at process start, not the whole build or current Git checkout.

Repeated positively idle, unchanged observations gradually reduce collection to at most five seconds (an already slower configured cadence is preserved). Activity, uncertainty, failure, input or source change restores normal polling. Redraw/input remain independent. Large scans yield between chunks; individual JSON parsing remains synchronous. Poll cadence is not a model or notification delivery guarantee.

### Switching sessions

Session switching drives Codex's own `/subagents` picker (verified against Codex 0.154 and 0.157) and selects the row showing the agent's exact UUID; it never submits guessed `/agent <id>` commands. It requires an empty composer (including the read-only composer of a sub-agent view) or the recognized picker. Drafts, copy mode and unsupported views produce a visible message instead of forced input. Keyboard selection alone previews the agent; `o` switches. Visible targets are reached in one movement batch, long lists a page at a time, and the row is rechecked before Enter. The picker is not reopened afterward, avoiding a second popup and transcript redraw. A delivered request does not independently confirm the final Codex view.

Below about 63 columns Codex stops printing UUIDs in the picker. The agent is then matched by the name the picker prints (its task path, or `Main [default]`), and only when no other agent of the session prints the same name; otherwise the switch is refused with a request to widen the Codex pane. While agents are running, Codex adds a "Sub-agents running" note to the conversation each time the picker opens; that note is Codex's own.

### Agents in the list

Active sorting only rearranges siblings. A running descendant brings its entire branch forward;
latest turn starts determine order, while ordinary token and log updates do not reshuffle the tree.
Parent links support both metadata locations. Missing status evidence stays unknown.

Each agent's rollout is read once, each read going on from where the last one stopped. How far each was read and what it held (status, stages, open calls) is kept in `$CODEX_HOME/hud/scan/`, one file for each rollout of more than 256 KB (mode 0600, removed after a week neither used nor written), so a panel or bar started again reads only what was written since. A saved read is used only while the file still matches it (the same file and thread, the bytes it ended on unchanged); otherwise the rollout is read again from its start.

Agents are named by the last segment of their task path, the name Codex's `/subagents` picker shows: `/root/essays_2020_2021` reads `essays_2020_2021`. That name heads the tree row, the card and the agent's log block until a label arrives. With Agent names on (as name, the default, once a backend is set), the model's short name for what the agent is on now then stands in for it in cards, rows, the compact tree, the timeline and the Inspector's heading, and changes as its work moves on (Settings → LLM → Agent names: under name puts it on the line under the name instead; off keeps Codex's names); the card can show the name Codex prints with Cards → Original name, and the Inspector always keeps it, and switching to an agent always goes by that name. Cards → Task label controls labels only on cards: off keeps their Codex names without changing the naming policy in other views or generating a new label. The random nickname Codex also assigns (Copernicus, Meitner…) and the role move to the Inspector. Guardian review threads (Codex 0.155+ opens one beside a session to review its approvals) get no row or card of their own: their parent carries `◈N`, in the info colour while one runs, and a failed one still shows.

With the session read and its tree built, a session that has started no agent, subtask or review says so in one dim line under the title (`No agents started in this session yet`), with where the help is; until then, or with no session bound, the view stays blank rather than guess. With no model backend set and Agent summary shown, one dim line after the last card says no new summaries are written (`~ No model backend, so no new summaries: Settings → LLM`); stored ones stay on their cards.

Finished agents leave the list 3 minutes after they finish (Settings → Hide finished: 1m, 3m, 10m, 30m or never). Running and failed agents never leave, and a finished agent whose child is still shown stays dimmed (still a card in rich). The optional card clock, or the compact row, says how long ago it finished; the control bar counts what was put away (`⊕12`), and clicking that or `Ctrl+\` `a` shows everything again.

### Timeline

Pane 2, closed by default, lays the session out on the main session's axis, newest first, each entry with its age, said once at the top of a run of entries of one age.

| Level | What gets a line |
|-------|------------------|
| The main session (left) | A turn that finished, with the head of what it told you (`⏎`), approvals asked for and answered, compaction, a quota window crossing 80 % and 95 %, turns interrupted or failed, and failed tool calls, each by the command it ran (an `exec` script's first command, `✗ rg -n …`), else the tool's name; the same one in a row is one line with `×N`. |
| An agent the main session started (a level in) | A line for each of its stages: one that ended sits at its end, with how long it took, the subtasks under it, at any depth, that finished in that time (`✓2 ✗1`) and, for the agent's newest, the first lines of what it returned; one still running sits at its start, with its clock and what the agent said it would do. A helper's stage names the lead it was for (`Performance advice → Tokenizer speed`). |
| A subtask (a level further in) | Only those that matter (failed, flagged or in Key roles, independent of the card Child scope), at their end |

- Each agent is in its direction's colour, the one its card's name has: an L1 and the agents under it share a colour, a helper takes its lead's, and directions at work side by side get colours apart.
- **Agent colours** (Settings → Display, `agentColors`) says where that colour shows: on names and marks (`name`, the default), on the marks alone (`mark`: the timeline's rails and lanes, and the work kind's glyph on a card, the names in the text colour), or nowhere (`off`). The Inspector's heading follows it too.
- A failure's cause, when Failure cause wrote one, is under it, marked `~`.
- Facts the rollouts recorded only: a quiet stretch is not an entry. Guardian reviews' comings and goings are left out, their failures kept.
- A pending approval also says how long it has waited, on the bar's alert (widest form) and in the panel's status card.

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

Settings → Panel → Timeline span is the window: the last 1, 3 (the default), 6, 12 or 24 hours, and at least the newest eight entries whatever their age; a stage still running shows wherever it started. What is earlier is counted on a last row, `▸ 40 earlier`: a click on it, or Enter while the Timeline has the focus, brings back twenty more at a time. An agent's entry opens that agent in the Inspector: a click on any of its lines, or ↑/↓ to put the cursor on it (the cursor stops only on agents' entries and the earlier row; down starts at the top of the view) and Enter. Esc from that Inspector comes back to the Timeline, its cursor where it was. PgUp/PgDn, `g`/`G` and the wheel still scroll the view, and let the cursor go.

### Agent log

Each subagent has a log, newest first: its starts, finishes and failures and its latest updates as observed, written on the same read that updates the tree, and model-written brief/progress notes, digests and causes, marked `~` as model-written in compact and the Inspector. A rich card does not list that log (see the cards above); the Inspector does.

- **Language:** What a model wrote shows in the language it was written in: switch Language and the other language's notes step aside until a generator writes them again, while the observed entries stay.
- **It only grows:** a new brief adds to it rather than replacing the last.
- **It follows the tree:** An agent the tree hides (put away, filtered out, under a collapsed parent) is not shown, and a collapsed parent says how many logs are folded under it; showing the agent again shows its whole log.
- **In compact:** Each block is headed by the agent's status, kind glyph and Codex name, with its model name or task on the line under it; each agent shows its latest two entries, the selected one six and leads the list, and the Inspector shows all of them but the update it shows above, and none while the log holds only starts and finishes. Each entry's age is a column of its own, its text hanging beside it, without chat markdown. Clicking a log line opens the Inspector on that agent.
- **Storage and switches:** The log is kept per session in `$CODEX_HOME/hud/agent-log/` (mode 0600, removed after 30 days). Stored model notes, digests and causes remain available in the current panel language even with the backend off or models paused. In compact and the Inspector, observed entries are always available with a backend; with the backend off, Agents → Agent log controls those observed entries independently. Neither switch turns the log into card history.

### Inspector and Changes

Inspector shows, in this order:

1. Name, model and effort (the glyphs, then the full slug and effort: `☀◆ gpt-6-astra · max`; the card's badge is the short form, `6astra·max` in text mode)
2. Its task path, when that path has more than one segment
3. Status
4. Its context (`Ctx`) and, while it writes, its output rate (`Out ~42 tok/s`)
5. What it has spent over its life, once its rollout has reported it (`Tokens 1.2M in (cache 84%) · 32.1K out`, the cumulative `total_token_usage` of its newest report; narrow, the cache share goes, then the output)
6. Where the parent rollout still has plaintext from before this agent was created, that text under What it was given
7. Where the rollout keeps the task sealed, what it said it would do as it opened its newest stage (`Took on`, its own words, whole)
8. Its latest update, its task (always) and its log, turn age and last activity

Press `v` for full timestamps and UUIDs. Session-switch notices stay in the footer. A click on a blank row, or on the gutter left of a pane, keeps the next keys in the panel until Esc, or a click on the bar's `⌨ Keys here` chip, hands them back to Codex. Each long part sits under a dim rule (`── What it was given ──`), two columns in. A click on a card only selects it; a second click on its name within 400 ms switches the session. Enter, Space, `v` or `◫` opens the Inspector on the selection. `o` and `⌂` switch at once. In narrow Codex panes, session switching uses the unique-name fallback or asks for more width, as described in [Switching sessions](#switching-sessions).

The Inspector's **~ Model summary** section shows the newest stored model note in the panel language, separately from the agent's own Latest update. **Coverage** (`coverageAt`) identifies the public snapshot covered; **Generated** (`generatedAt`) is when the result was produced. Each appears only when that metadata is explicitly known. Older or periodic notes without coverage metadata say **Recorded** (their log timestamp), never an invented coverage boundary; no generated time is inferred. The section also explains progress context: backend off, models paused, live progress disabled, summary hidden, agent not live, no public progress evidence, refresh cooldown, retry wait (and remaining retry delay when known), progress concurrency cap or hourly model call cap. Queued and writing are distinct states. These diagnostics read existing state and do not broaden progress targets; rendering them makes no model call.

Changes lists the worktrees over the files, where there is more than one: a row each, the one whose files are listed marked `●` and in bold, how far its branch is from upstream (`↑2`, `↓1`) and its state on the right (`4 mod`, `clean`, `locked`); then a rule naming it again with its counts (`─ main · 2 unstaged ───`), and its files. One cursor runs through the worktrees and the files: on a worktree's row it lists that worktree's files, and Enter shows its details in the Inspector (its HEAD commit's subject, branch, state and counts, the full path under More; no hash). A settings file from before, with a Worktrees pane saved open, opens Changes. The files belong to the listed worktree; no file ownership is inferred from agent activity.
Each file is one letter for what happened to it, in its colour: `M` modified (yellow), `A` added (green), `D` deleted (red), `R` or `C` renamed or copied (blue), `!` a conflict (red); the lines it adds and removes are at the right end where they fit (`+12 −3`), and the counts above the list say how many are staged and unstaged. Untracked files fold into one last row, `▸ 12 untracked`: Enter or a click lists them under it, and again folds them. Compact summaries use Δ for changed files, S for staged and U for unstaged.
Select a file and press Enter for staged/unstaged patches (their hunks; the git header, which repeats the path and names blobs by hash, is left out) or bounded untracked-file content; an untracked directory lists how many files it holds and their paths. The heading names the file, with the lines it adds and removes (`+12 −3`) and, dim under it, its folder; each section is headed Staged, Unstaged or Untracked in the panel's language. A long line wraps where a word ends, its later rows two columns in so the `+`/`-` column starts only its first; a tab is spaces to the next fourth column. Inspector zooms automatically; Esc restores the panes.
Long preview lines wrap; additions are green, deletions red and hunk markers cyan, retaining +/- markers without color. Git reads disable external diffs,
content filters and partial-clone lazy fetching. The panel provides no staging, commit or checkout actions.

### Settings

The main Settings tab remains above the page and is highlighted while settings is open. Back, Save and Reset group are on the row beneath it; Reset all appears when there is room. Clicking the active Settings tab preserves the draft and cursor. Back, Esc, another navigation tab or a prefix command that leaves settings checks for unsaved changes. A dirty draft opens a confirmation: **Save and leave**, **Discard changes**, or **Continue editing** (the default; Esc also continues editing). Saving successfully applies the draft before continuing to the requested destination; a save failure keeps both the draft and the prompt, showing the error so you can retry or keep editing. With no changes, leaving is immediate. Navigation selects/opens its target rather than toggling an already-open view closed. This protection covers in-panel navigation, not F12 pane replacement, process termination or a killed tmux session.

**Reset group** (or plain `r` while settings is open) changes only the selected row's section in the draft; **Reset all** resets the known preferences owned by the settings page, not the entire settings file. Both require Save to apply. Neither resets the model backend, API credentials/base, model tiers or model override, reasoning option, hourly call cap, or picture asset path/file. Resetting LLM, or resetting all preferences, conservatively turns off every generation feature and sets Pause models on; it does not restore enabled generation defaults or grant permission to send material. Other section resets leave model permissions alone.

Settings → Panel → Width offers the widths the panel is laid out for: 32, 40, 48 columns (the default) and 56, each a step in what fits (the row meters, the model badge's words, the timeline's fourth lane); ←/→ step between them and come round past either end. Another width, from the settings file or a dragged border, still draws, and ←/→ step on from where it falls. Save applies it at once, and Codex keeps at least 41 columns, so in a narrow window the panel gets less than it asks for. A 0 from an older settings file reads as the default width, 48. The width is applied again whenever the tmux window changes size, as when a session started detached is attached from a wider terminal; dragging the border by hand is left alone. `CODEX_HUD_TREE_WIDTH` remains an initial override when no saved settings exist.

Settings has seven contiguous groups, in this order:

| Group | Rows |
|-------|------|
| Display | Theme, Look, Icons, Model label, Agent colours, Motion |
| Panel | Language, Layout, Panes, Status card, the Timeline's style and span, Width, Picture |
| Agents | Order, Hide finished, Key roles, Agent log |
| Cards | Content presets, every card visibility switch, Child scope and Corners ([Card settings](#card-settings)) |
| LLM | Every feature that sends material to a model ([LLM](#llm)) |
| Status bar | Bar on launch, Density, Context, Notifications |
| Input | Mouse, Prefix key, Refresh |

Settings that only work together are one row: Brief pace (its two intervals as a pair), Agent names (as name, under name or off) and Notifications (off, tmux, or tmux and the desktop). The panes 2–4 have no row: the bar opens and closes them, and remembers them.

**Moving around**

- The page is an accordion: only the selected row's group is open, under its heading (`── ▾ Cards ──`); every other group is folded to one line with its name and the values that say most about it (`▸ Display  terminal · Tab row · Unicode`, a `*` in front when a row in it is unsaved), so all seven fit a 24-row page.
- ↑/↓ walk the rows in order and open each group as they enter it; PgUp/PgDn jump to the first row of the next or previous group; a click on a folded line opens that group at its first row without changing any value.
- The page is a modal: while it is open its keys are its own (arrows, Enter, `s` saves, `r` resets the current group, `Esc` requests leaving), and the footer names only the moves the buttons do not cover. Narrow views retain complete Back/Save buttons and use short labels.

**Rows and values**

- Labels stay left and values align at the actual pane's right edge, a non-default value in the accent; from 70 columns a stable help column occupies the right-hand portion instead.
- Saving a new panel width reflows the settings rows to that real width, not a fixed left-packed column; the selected one reads `‹ value ›`, and ←/→, Enter or a click change it (a click on `‹` steps back).
- The line under the list says what the selected setting does; when it is inactive, an additional selected-row message explains why.
- While Theme, Panes, Look or Icons is selected, a Preview above that line draws the panel's bar and a pane's title as the unsaved value would, so a look can be seen before it is saved.

**Saving**

- Unsaved fields show `*` and the Save button lights up; Bar on launch applies from the next launch.
- Save persists to `$CODEX_HOME/hud-settings.json` (or `CODEX_HUD_SETTINGS_PATH`) and updates the compact HUD on its next refresh. Saved preferences override environment defaults; `NO_COLOR` still wins.

**Rows that depend on others**

- Rows with unavailable dependencies are dim, but remain selectable so preferences can be preconfigured.
- The selected-row reason distinguishes backend off, model generation paused, a non-rich layout, disabled child lines (for child summaries/scope), and unavailable label replacement (for Original name).
- Card progress additionally needs an enabled agent summary or child lines with summaries; Brief pace needs a periodic agent brief, main recap or change summary.
- Backend off is also explained by "takes effect with a backend" beneath it.
- Pause models keeps stored text visible; it does not turn off presentation switches.
- Agent log controls observed entries in compact and the Inspector when the backend is off, never a card history; with a backend, those observed entries are always available.
- Stored model notes remain available in the panel language with the backend off or paused, independently of Agent log.

**When the panel last read the session.** Above the help line, one row says when the panel last read the session (`HUD read the session 2s ago`) and, if a read has failed, where, when and why; a failure newer than the last good read is shown as a warning. That is how a quiet session and a HUD that cannot read stop looking alike, since a failed read otherwise leaves the last good values on screen.

Agents → Key roles (`importantRoles` in the settings file) names the roles whose subtasks matter. The page offers none, the default, each role the session's subtasks have, as the cards say it, and what is set; several at once are a comma list in the settings file (`"importantRoles": "critic, oracle"`), which the page keeps among its values. A subtask in one of them is eligible for its lead's important-scope child list (when Child agents is on), gets a line in the Timeline and is named in the Agents brief's report, as a failed one or one a note flagged is. A name matches the role or the role's end after a dash, so `critic` names `team-platform-critic`. With none, only failed and flagged subtasks matter.

### Card settings

Settings → Cards is presentation, not permission to send material. **Card preset** is a convenience over the thirteen content booleans below:

| Preset | Enabled contents (name and status always remain) |
|---|---|
| `minimal` | Task label and Agent summary only |
| `progress` | Minimal plus Current action, Child agents and Child sentence |
| `monitor` | Progress plus Relations, Child role counts, Agent model, Review count, Turn clock, Output rate and Context meter |
| `custom` | Derived when the individual switches match none of those three; not a fourth configuration to apply |

All three presets keep Original name off. The preset is derived from **all thirteen** booleans, even ones with inactive dependencies; there is no persisted `cardPreset` JSON field. Editing any granular switch recomputes the classification (usually `custom`, or another exact match). Applying a preset preserves Child scope, Card corners, every LLM generation/privacy permission, backend/API configuration and hourly cap. It can change which visible summaries are automatic progress targets **only if** generation is already permitted; it grants no new permission.

The content switches remain independently editable; Child scope and Card corners have their own values. All thirteen booleans default to `true` **except `cardOriginalName`, which defaults to `false`** (the `monitor` combination). They take effect in rich layout; missing data still produces no placeholder.

| Setting | JSON key | Default | Controls |
|---|---|---|---|
| Task label | `cardLabel` | `true` | Model-written label/kind on this card only; no label-generation request |
| Original name | `cardOriginalName` | `false` | Codex name when a model label replaces it |
| Agent summary | `cardSummary` | `true` | Latest stored L1 model note, wrapped in full |
| Relations | `cardRelations` | `true` | Collaborators / lead |
| Current action | `cardAction` | `true` | Current tool or action |
| Child agents | `cardSubagents` | `true` | Child names and statuses |
| Child sentence | `cardSubagentSummary` | `true` | One model sentence per listed child, wrapped; off keeps names/status |
| Child role counts | `cardRoleCounts` | `true` | Footer counts such as `2 scout · 1 implementer`; off hides only the counts, not child rows or summaries |
| Agent model | `cardModel` | `true` | Model/effort badge, in the widest whole form that fits a quarter of the card: in text mode `6.1sol·xhigh`, then `6.1sol`, then none; otherwise words and glyphs, then the glyphs alone. Never cut with `…` |
| Review count | `cardReviews` | `true` | Guardian review chip |
| Turn clock | `cardClock` | `true` | L1 and child turn clocks / settled ages |
| Output rate | `cardRate` | `true` | L1 output tokens per second |
| Context meter | `cardContext` | `true` | L1 context fill |
| Child scope | `cardSubagentScope` | `important` | `live`: live only; `important`: live + failed, flagged, key-role; `all`: every child |
| Card corners | `cardCorners` | `square` | `square` or `round` |

Turning off Agent summary removes that L1 from automatic progress targets. Turning off Child agents or Child summaries removes the corresponding child requests, and Child scope, the list filter and linger window determine which children qualify. These switches do **not** change periodic briefing, result digest, failure cause, label generation or other generators. Those have their own LLM/privacy switches below; disabling a presentation field neither deletes stored material nor revokes another generator's permission.

### LLM

Everything the panel asks a model to write is in the LLM settings group, each item with its own switch, and every item is written in the panel's language and displayed as model-written text, not as observed fact (card summary text is model-written; compact and Inspector mark model text with `~`).

- **Backend:** LLM → Backend picks who writes, `agy` or any OpenAI-compatible chat completions endpoint (`api`); off makes no model calls and sends nothing. Generation/privacy settings are separate from the Cards presentation switches. OMP is removed; saved `omp` settings migrate to `api`.
- **One queue, one cache, one cap:** All items share one queue (one call at a time), one cache and one hourly cap (Call cap, 60 calls an hour by default, counted across panels of the same `CODEX_HOME`); a request past the cap is refused and the reason is shown where its text would be. Settings shows the calls made today under the list.
- **Brief pace** controls the periodic agent brief, main recap and change summary, not on-demand Card progress, with two figures; it offers 1m · 5m, 2m · 10m, 5m · 15m and 10m · 30m:

  | Figure | Default | How often it may run an item |
  |--------|---------|------------------------------|
  | **Interval** | 5 minutes | News that matters: a stage, status or failure changing, a prompt, a final reply |
  | **Floor** | 15 minutes | Routine news: an agent's new update or command, a turn that runs long, a diff that changed |

- **Language:** Settings → Panel → Language is the language of everything a model writes too: switching it asks again at once, what a model wrote in the other language is neither shown nor sent back as the previous brief or recap, and what the next run keeps from them it translates. A reply plainly in another language than asked (Japanese or English for Chinese, Chinese or Japanese for English) is refused as an invalid response, never cached, and shown as a failure where its text would be; a name or a short quote in another language passes.
- **Storage:** The cache and the call log (timestamps only) are kept in `$CODEX_HOME/hud/model-cache/`, mode 0600.

What each item sends:

- **Periodic agent brief** (`briefAgents: true` by default; requires a backend): a sentence on the subagents as a whole at the top of the area, and a note per agent that goes into its log. It sends a report with an entry for each agent the main session started (guardian reviews left out), one that works for another right after it: its name and role; its stage and how long it has run, or when it finished or failed; who assigned it, and its task (300 characters) or else the words it took the task on with, its first update of the stage; its latest public update (600 characters) and the command it is running now (200); what its last stage returned and, shorter (300), the two before; its subtasks counted by role, with up to four that matter (failed, flagged by a note, or of a role named in `importantRoles`) named with their state and their answer or cause; failed approval reviews; and who wrote to it during the stage. An answer of up to 1,500 characters is sent as it is; a longer one as its Result digest when that is on, otherwise as its head and tail. The report starts with the agents that need attention (they or a subtask failed in the last hour, or a note says so), then the running ones, then those finished in the last half hour; one finished longer ago gives only its last result. With it go what happened since the previous brief (stages begun and ended, failures; 20 events at most) and the previous brief itself, its sentence and the newest notes, so the model writes notes only for the agents the news is about, eight at most, and every other agent keeps its note. The request is held to 16 KB: past that, lines give way in a fixed order, each from the bottom of the report and only as far as needed (earlier stages' answers; all but the first line of an agent with no subtasks; agents finished over half an hour ago; latest updates; the subtasks that matter; the answers of agents finished in the last half hour, then those agents; all but each agent's first line; then whole agents), and an agent that needs attention is never cut. With Agent names on, each note also names what the agent is on now and its kind of work (below), in the same reply. It runs at most once per interval, when an agent's stage, status or failures change; a new update, the command it runs or its routine subtasks moving on are sent at most once per floor. A reply that is not the JSON asked for is sent back once to be put right; if that fails too, the last brief stays, and the area says so.
- **Main recap** (`briefMain: false` by default): a rolling recap of the main session, shown in the status card (rich) or at the top of the brief area (compact): the goal, what is done (at most four items), where it stands, and, painted as a warning, what it needs from you. It sends your prompts and the assistant's public replies and commentary (each cut to about 600 characters, about 4,000 characters in all, never its reasoning), the plan steps, a pending approval's summary, the compaction count, the goal set with Codex's `/goal` and its status (read from `$CODEX_HOME/goals_1.sqlite`, read only, when it can be), and the name, status and turn time of each subagent; subagents' tasks and updates are sent only when Agents brief is on as well. A prompt that starts with a tag in square brackets (`[watcher] …`) or with a peer's header, who to whom and that it is a peer's (`Docs lead → Root (peer, no reply owed).`), is sent marked as possibly automatic, since tools that write into the session tend to start that way, and does not count as you sending a prompt. Each run is given the previous recap and only what was said since, so it stays cheap and survives Codex compacting the conversation. It runs as soon as the interval allows when you send a prompt, a final reply lands, a turn ends, a plan step completes or an approval is asked for; while a turn runs long (waiting on subagents, say) it is refreshed at most once per floor (15 minutes by default, never more often than the interval) if anything at all changed, commentary or a subagent moving on included. Nothing changed, nothing is sent. The recap is saved per session in `$CODEX_HOME/hud/recaps/` (mode 0600, removed after 30 days), so reopening the panel or `codex resume` shows the last one at once with its age; a recap in the other language is asked for again. In rich it is shown in the status card at level full; in compact, at the top of the brief area.
- **Card progress** (`agentProgress: true` by default, independently of `briefAgents`): generates current notes for **exactly the live subjects whose summaries are enabled in the currently shown rich Agents list**, while Agents is shown and no modal is open. Agent summary off excludes that L1; Child agents or Child summaries off excludes those children. Child scope, list filters and linger rules are used for both display and targets; it does not request every descendant merely because a parent is present. The newest stored note remains visible, with concise queued, writing, failure, concurrency-cap or hourly-cap status beside the enabled summary; raw reports and log history stay in the Inspector. It sends only public current-turn evidence: up to four reports (600 characters each), stage intent (300), open tool/action (200), plaintext task and pre-create charge (300 each), name/role (80 each), stage metadata and descendant status counts. No reasoning or sealed task is sent. With no public report, stage intent or open action, no progress is invented and no request is made. Output is **one sentence of at most 120 characters** in the panel language. The first request does not wait for Brief pace; unchanged input is deduplicated/cached, changed input refreshes at most once per minute, and failures retry after ten minutes. Hiding the relevant summary or Agents pane, opening a modal, backend off, Pause models, or changing session/language/turn cancels obsolete work. Card progress shares the queue and call cap but remains independent of the periodic agent brief and recap.
- **Result digest** (off by default): when a subagent finishes, its whole final answer (the public final reply only; when it is longer than about 8,000 characters, its head and its tail) is sent once, and comes back as three short lines: the conclusion, what it rests on, and the caveats the agent itself gave. An agent the main session started has each stage's answer longer than 1,500 characters digested as well, when the stage ends. The digest goes into the agent's log, is shown in the Inspector under "~ Result digest", and stands in for the answer in the Agents brief's material. Agents that finished more than an hour before the panel saw them are digested only when you inspect them.
- **Agent names** (as name, on by default; nothing is sent until a backend is set): a short name for what each agent is working on now, of about 10 Chinese characters or 4 English words, and a kind of work (research, experiment, fix, review, writing, summary or other). The Agents brief writes them beside its notes, in the same reply and at no extra cost, from what it is sent already; it keeps a name while the work is the same and gives a new one when the work moves on, and the newest in the panel's language is shown. Codex 0.162 and later send a subagent its task encrypted. The labels job sends, once, what the parent wrote in plaintext before that subagent was created (400 characters, with the task path and role), or a plaintext task when there is no such text, several in one request; a Fernet payload is not sent. That name is the one the card uses. The brief's name, from the agent's updates and stages, is the fallback until it arrives, and does not replace it. The kind is drawn as a fixed glyph the HUD picks, dim beside the agent's name: ⌕ research, ⚗ experiment, ⚒ fix, ◈ review, ✎ writing, ∑ summary, none for other (the legend is in `?`). As name, the short name stands in for the agent's name in the panel; under name, it is the line under the name in the card and the log block; off keeps Codex's names and asks for neither. Cards → Task label can suppress the label on cards without changing other views, and Cards → Original name independently shows Codex's name when a label replaces it. The Inspector keeps Codex's name, the one `/subagents` prints, and switching goes by it. Until a name arrives, with the feature off, or when the call fails, a card shows Codex's name and no glyph. The brief's names are kept with its notes in the agent log; names from task texts are kept by a hash of the text in `$CODEX_HOME/hud/model-cache/labels.json` (0600), so a task is named once ever, and entries written before names had a kind still read, as kind other. The session also gets a title: the recap's goal when Main recap has written one (no call), otherwise one call with your **first prompt** (1,500 characters). The title is saved as `<session>.title.json` beside the recaps and shown in the bar's session field at its widest reading, with the session id beside it.
- **Failure cause** (off by default): when a main-session tool call fails, the command and the last 2,000 characters of its output are sent; when a subagent ends in error, the error events from the end of its rollout (or the last failed command's output) are. One line naming the cause comes back, shown under the event in the Timeline and, for an agent, in its log and the Inspector. A failure whose rollout recorded no error output sends nothing.
- **Change summary** (off by default): while the Changes pane is open, when the diff's files or line counts change, at most once per floor, the per-file stat (40 files at most) and up to 6,000 characters of the staged and unstaged hunks are sent; untracked files are sent by name only. One or two lines on what the diff does come back at the head of the pane, marked `~`; once the diff has moved on, the old summary says so until the next one.
- **Approval words** (off by default): when a command waits for approval, the whole command (2,000 characters at most) is sent, and one sentence describing what it does is shown at the top of the brief area as "~ Approval, in the model's words:". It describes only: a reply that judges whether the command is safe is dropped rather than shown. It does not replace reading the command; Codex's approval prompt is still where you answer.

Reasoning and private channels are never read for these model features. Card visibility affects display and automatic progress targets only: periodic briefs and the independently enabled digest, name, cause, change and approval generators keep their own scope. Presets, resets and summary diagnostics add no new model material, network destination or credential storage; the existing LLM permissions and connection settings still govern generation.

Background job answers are cached by their input, backend, endpoint and actual model, also across panels. Briefs and rolling recaps are not cached. A failed background job retries after 10 minutes.

`codex-hud brief --dry-run` prints the brief the panel would send now for the current directory's session, the instructions and the material with their sizes, from the saved settings, the agent log and the last recap; no model is called and nothing is written, and it works while the backend is off. It previews brief/recap material, not Card progress or the other background jobs. `codex-hud brief --dry-run FILE` writes it to FILE (mode 0600) instead.

`Ctrl+\` `b`, or a click on the bar's pause button (Pause models), pauses and resumes every item above (`briefingPaused`, default `false`; offered with a model backend). LLM → Pause models is the same switch; stored model text is kept, including when both periodic brief switches are off. The connection is not typed into the panel: with LLM → Backend selected, Settings names the settings file (`~/.codex/hud-settings.json` or `CODEX_HUD_SETTINGS_PATH`) and its connection keys, says whether a base and a key are set (never showing either value), and for `agy` names `CODEX_HUD_BRIEF_MODEL`. For `api`, set these in `hud-settings.json`:

```json
{ "briefing": "api",
  "briefingApiBase": "http://127.0.0.1:4000/v1",
  "briefingApiModel": "",
  "briefingApiLiteModel": "zai-glm-vibe-none",
  "briefingApiLowModel": "zai-glm-vibe-low",
  "briefingApiMediumModel": "zai-glm-vibe-high",
  "briefingApiKey": "" }
```

An empty base is OpenAI's. An empty key falls back to `CODEX_HUD_BRIEF_API_KEY`; `OPENAI_API_KEY` is used only for the official OpenAI origin, never for a custom endpoint. With none the request is sent without one, for a local server. The file is written with mode 0600. API tasks route by feature: labels, titles and approval descriptions use the lite tier; active progress summaries, agents briefs, result digests and change summaries use low; main recaps and failure causes use medium. A nonempty `briefingApiModel` overrides all API tiers; `CODEX_HUD_BRIEF_MODEL` overrides either backend. In this GLM example the internal lite/low/medium tiers use none/low/high aliases; effort is encoded in the model name, not an extra parameter, and there is no silent fallback to another model on failure. HTTP redirects are refused rather than forwarding credentials or session material. `agy` keeps its default `gemini-3.8-flash-low`. Only the fields every compatible server accepts are sent to an `api` endpoint; set `"briefingApiReasoning": true` if yours takes `reasoning_effort` and it will be sent too.

### Picture

Panel → Picture draws a picture in the panel's empty space: braille dots, dots in the picture's own colours, or ASCII. It only takes lines nothing else is using, and gives them back as the agents and the brief need them. `bin/codex-hud-art <image> [dots|color|ascii]` copies a picture next to the settings and switches it on; `bin/codex-hud-art off` switches it off. ffmpeg reads the picture, so any format it knows works.

## Output throughput

The default bar shows `Out ~42.1 tok/s` when enough output-token samples exist.
Selected-agent details show that agent's estimate; expand with `v` to see the sample interval.
The estimate follows the **wallclock** convention: measured **output** tokens divided by
elapsed time in the current turn, including initial latency (TTFT) and generation stalls,
minus the union of identifiable tool-call/output waits. Parallel waits are deducted only once.
Only fully closed wait unions are deducted; missing results conservatively remain in elapsed time
instead of freezing the denominator while output continues to grow.
There is no 30-second rolling window, smoothing, speed cap or one-second minimum.
Codex rollouts lack exact per-request start/stream-end telemetry, so `~` marks a turn-level
proxy, not an exact reproduction of Pi's request-timed wall TPS or pure decoding speed.
Unidentified waits and logging delays may remain in the denominator.
If the prior counter is missing, the estimate waits for two cumulative reports and covers only
their measured interval. A first report's last-call usage may repeat the previous turn, so it
is never used to invent a turn-start counter.
Repeated unchanged counters do not dilute or refresh a reading.
A new turn excludes the preceding idle gap. After 10 seconds without a new sample, `last ~42.1 tok/s`
retains the previous reading. Context usage and compaction counts stay in the bar; the workbench has no Ctx trend.

## Machine-readable state

The bar fits itself to a pane: it shortens what it says and hides what does not
fit, which is right for a reader and wrong for a script. So each collection
tick, of whichever of the bar or the panel is running, also writes what it knows to
`$CODEX_HOME/hud/state/<tmux-session>.json`, and `codex-hud --json` prints the
file belonging to this directory's session. The panel writes an empty `bar.segments`.

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
once a second, and it is deleted when the process that wrote it stops: a state file for a HUD
that is no longer running would read as live. The owner is the pid in `<file>.owner`. A process that does not own the file leaves it in place, so a panel that is closing does not delete a snapshot the bar has just taken over.

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
| `CODEX_HUD_HERDR_BRIDGE` | `1` | In Herdr, enable native Codex detection with a foreground-process hint and main-pane title relay; read back status for diagnostics. `0` disables this integration. No Herdr configuration changes. [Details](./herdr-context-fix.md) |
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
`CODEX_HUD_NOTIFY=1`, turns them on: `tmux` for tmux messages, `tmux + desktop`
for desktop notices as well (`CODEX_HUD_NOTIFY_DESKTOP`). A variable that is
set wins over the setting. The open panel announces on the same terms, on its collect tick.

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

New sessions start with the compact bottom bar (`CODEX_HUD_TREE=0`); `F12` opens the panel. The main session rate keeps space ahead of optional model/age fields at ordinary panel widths. A sample older than ten seconds, from a previous turn, or shown while idle is labelled `last`, rather than disappearing or implying a live measurement.

### Diagnostics and connection checks

Press the HUD prefix (`Ctrl+\` by default), then `d`, to open HUD diagnostics
in the Inspector, including the main session's TPS sample time, sample duration
and estimation method. In an agent's Inspector, Enter expands those same TPS
details. Current-turn, older/previous-turn and missing measurements are distinct.
The JSON snapshot also includes optional `outputRate` evidence and `health.sessionBound`.

The normal panel shows current faults without opening Settings: no bound Codex
session, failed session reads, Herdr probe/transport failure, uncertain notification
history after reconnection, and classified model failures or queue waiting. The
compact bar shows collection/bridge problems. Diagnostic details retain the last
successful read/acknowledgement; normal operation adds no diagnostic banner.

Settings → LLM offers **Test API** (or `t` in that group), and `t` again cancels.
It checks the lite/low/medium routes from the current draft, with fixed synthetic
messages only, up to 256 output tokens per request and a 15-second request timeout.
The three calls share the normal hourly budget; nothing is saved and no session
text is sent. Backend off or AGY does not issue an API test. Closing Settings or
changing the connection cancels pending checks and prevents late results from
reappearing. Results distinguish authentication, unavailable model, rate limiting,
timeout, connection/service failure, output truncation and invalid responses. The test can run while
ordinary model generation is paused because it is an explicit user action.

Model calls sharing one local CODEX_HOME now atomically reserve a budget slot
before sending. Replies merge into a shared cache under coordination; simultaneous
identical cacheable requests share one result. A crashed/cancelled sender may
conservatively consume its reserved slot. Coordination failure refuses the call
instead of sending without accounting. Approvals and explicit probes precede
queued visible progress, which precedes background summaries; background requests
are protected from starvation. In-flight requests are not preempted. Shared-disk
coordination requires local filesystem atomic rename and coherent directory reads.
