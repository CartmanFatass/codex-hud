# Panel redesign, round 2: omp band, agent briefs, label names, control bar, resume binding

Date: 2026-10-04 · Branch: `hud-enhancements` (on top of `5605738`)

This builds on `2026-10-04-panel-redesign.md`, parts A–G, which are already
implemented. The user reviewed the result and asked for the five changes
below. They approved a rendered preview. Do all of it in one run, commit
each part on its own, and finish with the live check in part 6. Do not
stop to ask questions. Where a detail is open, choose and say which in the
final report.

**The preview is the target.**
- `$S/prev/mock2.py` writes `$S/prev/preview2.ansi`, rendered as
  `$S/prev/preview2.png`. Read the script: it is the exact spec for the
  colours, glyphs and order.
- `$S` = `/tmp/claude-1000/-home-fires-codex-codex-hud/c4a91d06-e869-4633-8cf6-9b018adb87bc/scratchpad`.
- An older 90-column variant is `$S/prev/mock.py`.

**Real panel widths are 32–56 columns, about 44 rows high.**
- The user's live panel is 32–56 columns wide (`CODEX_HUD_TREE_WIDTH`
  policy). Design for 40 and 56 first, keep 32 legible, and treat 90 as the
  wide case.
- Earlier captures were 90 wide, and that hid crowding.

## 1. The status card in omp's band style

The user's omp setup is `composer.shape: band`, theme titanium,
`statusLine.separator: none`, `transparent: false`. They like its frame:
- a dark background band carrying coloured segments with no separators;
- a thin-line context meter in the band's gap;
- a `╰─` corner below.

Redraw the status card (`src/render/status-foot.ts`, `status-block.ts`)
like this:

```
[band ] ✓ ★◕ 41s ──────────56%──────────────246K ~3m      ← one row, band background
│ ◎ 整理测试数据补全文档，并在版本冻结前合并本轮改动        ← brief rows, left gutter only
│ ▸ 本轮改动已合并并发布，无待办任务，等待新的需求
│ ✓ 整理两个 CI 失败与下一步排查记录
│   提交 release 说明并推送到 main 分支 +2
╰─ atlas-wsl · main * 7d ──────────99% ↺113h
```

**The band row (top).**
- Draw the background across the full width.
- Left: the state glyph, model badge and session age, as part G set them
  up. While working, add the tool, elapsed time and tok/s, as today.
- Middle: the context meter (see "Meter" below), with tail `246K` when it
  fits.
- Right: **data only.** That is the brief's state (`~3m`, `~…`, `✗`, `‖`).
- No hints and no switches on the card. They move to the control bar
  (part 4).

**Body.** The brief rows from part A3, which wrap each field to 2 lines.
`mock2.py` clips each row to one line; that was a shortcut in the mock, and
A3's 2-line wrap wins. The frame is a **left gutter `│`
only**: no right border and no `╮ ╯` corners. The gutter and the corner
take the state colour from part G1 (idle dim, working info, needs warning,
failed error, stale warning).

**Bottom.** `╰─`, then project · branch, the quota window label, the quota
meter with no tail, and the reset `↺…` in the tick colour.
- At 40 columns the branch drops first, then the window label.
- Keep the cache reminder `◷…` only while it is urgent, as today's rule
  has it.

**Levels.**
- min: the band row alone.
- status: band plus `╰─` row (2 rows).
- full: band, brief and `╰─` row.
- `r` and a click on the band still step the level. That click is not a
  drawn button.
- The height cap and the brief priority from part A4 are unchanged.

**The meter** is one helper, used everywhere: the status card, the agent
cards' bottom rules and the one-line agent rows. Replace the heavy `━`
meter from part A1 with omp's **thin line**:
- The fill is `─` in the zone colour: info (blue) under 70%, warning 70–85%,
  danger at 85% and above. Reuse the existing threshold functions.
- The percentage sits at the fill's head, in **bold**, in the zone colour,
  and moves with the fill.
- The track is `─` in a dedicated **track** colour that is clearly darker
  than the frame rule.
- `─` plus the tail (`246K`) in a **tick** colour, the steel blue `67` in
  the preview.
- Keep the `┃` tick rule from part A1: only for a threshold the HUD knows.
- On a band row, the meter keeps the band background.
- Old (finished) agent rows keep the zone colour: do not dim the meter to
  grey. That was the "区分度很差" (poor contrast) complaint. Dim only the
  name.

**Palette** (`src/render/palette.ts`). Add these meanings: `band`, `bar`
(control bar background), `selectedBand` (selected row background), `track`
and `tick`.
- `terminal`: the 256 colours in the preview (band 235, bar 236, selected
  237, track 239, tick 67).
- `mocha` and `latte`: Catppuccin equivalents. Latte is light, so its band
  is a light surface, not dark grey.
- `none`: no background, no colour. The meter falls back to `━` fill and `─`
  track so it stays readable without colour.

## 2. The agent brief on every agent (the user's main ask)

The user's main reason for the panel is the per-agent brief: "how far has
each subagent got". Round 1 folded finished agents into one line and so hid
the `~` note. Restore it.

**Finished agents (the B1 condition) take two lines.**
- Line 1: the row as now. Status, name, badge, the thin meter (12 cells at
  40 wide, 16 at 56 or more) and the age.
- Line 2: indented 3 columns, dim, one line clipped with `…`, showing
  whichever exists first:
  1. the newest model note (`~ …`, model kinds);
  2. the newest agent update (its own words, run through `plainText`);
  3. the task text.
  With none of these, there is no line 2.

**Running, quiet, failed and opened agents keep the full card.** Its body
is:
1. the task line, bold when the label replaced the name (part 3);
2. the `~` model note;
3. the newest update.

Each is at most one line, in that order. Never more than 3 body lines when
closed. The opened card keeps its longer timeline.

**The selected row is marked with the `selectedBand` background** across
its first line, in addition to `›`.

**The compact (tree) layout** gets the second line **for the selected row
only**, so compact stays compact. The rich layout gives it to every
finished row.

## 3. Label replaces name (new setting, default on)

- **New setting `labelAsName`** (Settings → Agents, "Label as name",
  zh 标签替换名字), boolean, **default `true`**.
- **`agentLabels` default becomes `true`.** It does nothing until a backend
  is on, and the backend still defaults to off. Mention this in the
  settings help.
- **When both are on and a label exists for the agent**
  (`node.label !== node.name`, see `agent-title.ts`), show the label
  wherever the agent's name is shown:
  - cards and one-line rows;
  - the compact tree;
  - timeline lines;
  - the inspector heading.
- **Before a label arrives, show the original name.**
- **The original name is never lost:**
  - The inspector shows it under the heading, as `原名 cache_cleanup_reviewer`
    / `name …`.
  - An opened card shows it, dim, in its task block.
  - Click-to-switch and `o` still navigate by the real picker label
    (`uniquePickerLabel` in `tree-page.ts`). Add a test proving that the
    label is not used for navigation.
- **The task line in the body:** when the label is the name, the body's
  first line shows the task text, not the label again.
- The filter (`f`, `/`) matches both the label and the original name.

## 4. One control bar at the top

Today the controls are scattered:
- `b‖` and `, ?` on the status card;
- `m` on the title line;
- `hide old` / `+31` on the summary row;
- `[-][x]` / `[+][x]` on each pane's title rule (`monitor.ts` around lines
  1020 and 1038).

Gather them into **one control bar**: the panel's first row, today's
"← 主会话 … m" line, drawn on the `bar` background.

```
 ← 主会话  1 2 3 4 5        b‖  a+31  ,设置  ?
```

**Left.**
- `←` and the main session's name. Click it, or press `m`, to return to the
  main session.
- The pane tabs `1 2 3 4 5`:
  - an **open** pane is in the text colour;
  - a **closed** pane is dim;
  - the **focused** pane has a lighter background, as in the preview;
  - a **folded** pane is dim and underlined, or uses a variant you choose,
    as long as it can be told apart.

Tab clicks:
- clicking a closed tab opens and focuses it;
- clicking an open, unfocused tab focuses it;
- clicking the focused tab folds or closes it, in the same cycle as today's
  `[-]` and `[x]`. Pick a cycle and document it in `?`.

The keys `1`–`5`, `x` and `-` keep working as today.

**Right.** Each item is a click target, with its key in dim and a short
label:
- `b‖` / `b▸` pauses or resumes the brief; only shown while a brief is
  configured;
- `a+N` shows or hides the older agents; only shown when some are hidden or
  shown;
- `,设置` opens settings;
- `?` opens help.

**Narrow widths.** Drop the labels first (`,设置` becomes `,`), then the
tabs of closed panes, then `a+N`. `←`, `?` and `,` stay.

**What remains elsewhere.**
- **Summary row:** counts only, `✓5 ▸1 ◈3`. No toggle text.
- **Pane title rules:** the name only, for example `─ 5 Timeline ─────`. No
  buttons.
- **Status card:** no hints (part 1).
- Update `click-map`/controls, the `?` legend and the tests.
- In the same commit as this part, update `README.md` and `README.zh.md`
  where round 1 (`dc2a612`) described the status card's rows, the `, ?`
  hints and the panes' `[+][x]`.

## 5. Bind the HUD to a resumed conversation

**Bug, seen live 2026-10-04 at 21:19.**
1. The user started `codexH` in `/home/fires/atlas-wsl`; the panel started
   at 21:16:58.
2. In that TUI they ran `/resume` on the old conversation
   `01a0ef2b-a391-7693-a748-60e24be246ae` (rollout from 2026-09-29, also
   open in another TUI).
3. The panel showed "还没有 subagent", no context and no quota: it never
   bound.

**Cause.** In `SessionFinder.findFallbackSession`
(`src/collectors/session-finder.ts` lines 779–785), a rollout is only
accepted if it started, or was modified, after `targetStartTime − 15s`. A
resumed rollout is not written until the next turn. Pane binding through
shell snapshots does not work under the Codex 0.159+ daemon either: see the
memory note in `findThreadIdForPane`.

**Evidence: the daemon logs which thread each connection opens.**

The daemon writes these logs to `$CODEX_HOME/logs_2.sqlite`, table `logs`,
with columns
`ts, level, target, thread_id, process_uuid, feedback_log_body`.

At startup:
- The TUI process logs rows of its own, with
  `process_uuid = 'pid:<tui pid>:<uuid>'`. Example:
  `codex_tui::app::startup … connected app-server` at ts 1791173833, from
  TUI pid 562894.
- Within about 1 s, the daemon (`pid:196900:…`) logs
  `app-server request: thread/start connection_id=ConnectionId(21) request_id=String("startup-thread-start-…")`.
  Then a `codex_core::shell_snapshot` row carries
  `thread_id='01a10a47-b559-7ba2-a18c-ec3c852cd73c'`: the fresh thread.

On `/resume`, at ts 1791173951:
- `app-server request: thread/resume connection_id=ConnectionId(21) request_id=Integer(8)`;
- then a `codex_app_server::request_processors::thread_lifecycle` row
  with `thread_id='01a0ef2b-…'` and the body
  `composing running thread resume response thread_id=01a0ef2b-… request_id=ConnectionRequestId { connection_id: ConnectionId(21), … }`.

**Approach.** Best effort, read only, cheap.
0. **First look for a direct mapping.** Check whether the daemon logs
   something per connection that names the client: an `initialize` request,
   `clientInfo`, or a client pid or name. If it does, use that, and keep the
   timing correlation below only as a fallback.
1. Find the TUI's pid. The HUD knows `CODEX_HUD_MAIN_PANE`; take the
   pane's `pane_pid` and its `codex` child, the same way the code already
   finds the pane process.
2. Find the TUI's daemon connection id: the `startup-thread-start`
   connection whose request follows the TUI's first `pid:<tui>` log row
   most closely, within a few seconds. Several TUIs can start inside one
   window: the real logs hold two `startup-thread-start-*` ids, `d7780f42`
   at 21:17:14 and `137b5e` at 21:17:54, and a third thread, `01a109fa`,
   was shut down. Pick by the timing of the TUI pid's own row, never just
   by "the newest".
3. Follow that connection's latest `thread/start` or `thread/resume` to its
   thread id (the `thread_id` column of the response row, or the id in its
   body).
4. Bind with `findSessionByThreadId`. This takes priority over the
   start-time fallback. Re-check only when `logs_2.sqlite`'s mtime or size
   changes, and at most every 2 s.

Constraints:
- Use `node:sqlite` (`DatabaseSync`, `readOnly: true`), which is present
  in Node 24.
- Fall back silently to today's behaviour when:
  - the Node version has no `node:sqlite`;
  - the database is locked or missing, or has another schema;
  - the TRACE/DEBUG rows that link a connection to its thread are absent
    because of the log level. The
  package says `engines >=18`, so it must not crash there.
- Keep queries bounded: rows with `ts >= tui start − 5`, with an index-free
  `LIMIT`.
- Never write to the database.

**Tests.** A unit test with fixture rows built from the shapes above,
using a temporary sqlite file:
- fresh start binds to the started thread;
- `/resume` switches to the resumed one;
- two TUIs on separate connections don't cross;
- several startups inside the window still resolve to the right one;
- a missing database or schema falls back.

**Live verification, read-only, against today's real
`~/.codex/logs_2.sqlite`.** With TUI pid 562894 and the 21:16:58 start, the
resolver must return `01a10a47-…` before ts 1791173951 and `01a0ef2b-…` after
it. Check that the user's live panel `%18` in tmux session
`codex-hud-f06eb2b7-20261004211658-562126` would now bind by running the
resolver as a script. It is fine to tell the user to reopen the panel.

**What you may do on the user's default tmux server:**
- **Allowed:** read-only `tmux display -p` and `tmux list-panes` (for
  example to get `pane_pid`).
- **Never:** `send-keys`, `resize`, `kill` or `respawn`, or anything else
  that changes a pane.

`%16` may already be closed by the time you run this. The check against the
database is historical and does not need the TUI alive: use pid 562894
directly.

The statusline (`src/index.ts`) uses the same finder, so it is fixed too.

## Ground rules (as before)

- **Commits.**
  - First commit this plan file. Then commit 1, 2, 3, 4 and 5 separately,
    plus a fix commit after the live check if needed.
  - Subjects are imperative sentences in the repo's style.
  - End every message with
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Do not push.
- **Checks.** `npm test` must pass at every commit. `format:check` was
  already failing before this work (about 128 warnings): do not make it
  worse, and do not reformat.
- **i18n.** English is the key, with a zh entry for every new string. Keep
  the rendering pure.
- **Respect the existing modes:**
  - `glyphs: text` keeps its words;
  - `theme: none` emits no escapes;
  - no animation, 1 Hz repaint.
- **Safety.**
  - Never change anything on the user's default tmux server. Their live
    Codex panes are `%0` and `%16`, and the HUD panes are `%8` and `%18`.
    Only the read-only queries named in part 5 are allowed there.
  - Never write into `~/.codex` or `~/.codex-account2`. Reading `logs_2.sqlite`
    read-only is fine.
  - Every harness launch puts `$S/fakebin` first on `PATH`, so no real model
    is called.
  - Set Backend only to `off` or `omp`.
  - Afterwards: `tmux -L hudui kill-server`, and no stray `sleep 900`.
- **Harness:** `$S/launch.sh`, `$S/ch`, `$S/ch2`, `$S/mkrun.py` (the running,
  needs, error and stale homes) and `$S/tmuxw`, from round 1.

## 6. Live check (required)

Capture into `$S/captures/r2/`, as `.txt` and `.ansi`, using `ch2`, `ch`
and the `mkrun.py` homes. Also render **PNGs**:
- `python3 $S/prev/ansi2html.py <title> "<name>=<file.ansi>" > x.html`;
- then
  `~/.omp/puppeteer/chrome/linux-150.0.7871.24/chrome-linux64/chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars --window-size=W,H --screenshot=x.png file://…/x.html`.

The browser's CJK widths are slightly off. Judge alignment from the `.txt`
captures, colour from the PNG.

Captures:
1. `ch2` at 40×44, 56×44 and 90×42, at status levels full, status and min.
2. Agents at 40 and 56 columns (`ch` after `a`, and the running home):
   - the two-line rows;
   - a running card;
   - the selected row's band;
   - the compact layout.
3. The label-as-name state. Make labels exist in a copied home: the model
   cache or the agent-log label entries. Read
   `src/collectors/model-jobs.ts` for where labels are stored, and seed
   them from fixture data. Then capture with the setting on, and with it
   off.
4. The control bar at 32, 40 and 56 columns, with:
   - each pane focused once;
   - a folded pane;
   - brief paused;
   - older agents hidden or shown.
5. The status card in each state (idle, working, needs, error, stale) at 56
   columns.
6. `glyphs: text` at 56, and `theme: none` at 56.
7. The resolver output for part 5 against the real logs database.

**Acceptance.**
- At 56×44 with the brief, the panel shows at least 5 agents, each with its
  brief line, plus the status card, without scrolling.
- No line exceeds the width.
- No control remains on a card or a pane border.
- Every meter's fill is distinguishable from its track and from the frame
  in the PNG.

**Compare with `$S/prev/preview2.png`** and fix the differences that are
not deliberate.

## Final report

1. The commits.
2. The test counts.
3. The capture paths: the PNGs first, then the key `.txt` captures pasted
   inline at 40 and 56 columns.
4. The resolver's output.
5. The decisions made, and anything not done, with the reason.

Also copy the three most telling PNGs to `/mnt/c/Users/fires/OneDrive/图片/`
as `hud-r2-*.png`, so the user can open them.
