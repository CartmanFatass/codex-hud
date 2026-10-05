# Panel redesign: status card, agent cards, settings, timeline

Date: 2026-10-04 · Branch: `hud-enhancements` (base `585156f`)

The F12 panel is too crowded and its hierarchy is unclear. With a brief on,
the status card fills the bottom half of the screen (20 of 42 rows) and the
agents above need scrolling. This plan covers the whole redesign. Do all of
it in one run, commit each part on its own (A–E below), and finish with the
live check in part F. That check is required: layout that only passed unit
tests has had to be redone after the user saw it.

The user has approved every decision in this document. Where it leaves a
detail open, pick the option that fits the surrounding code and say what you
picked in the final report.

## Reference: omp's status line

omp (`~/.local/bin/omp`, v18.5.0) draws its status line as the top border of
its input box. The gap between the left and right segments is the context
meter:

```
 π  🖥 Jacob  ◒ GLM-5.3  📁 ~/codex/codex-hud  ⑂ hud-enhancements ─0.7%───────────┃──1M─ ⏱ 20:09
╰─ (input)
```

- The filled part of the rule is coloured and the rest is dim.
- The percentage sits at the head of the bar.
- `┃` is a threshold tick, and the window size closes the bar.
- When space runs short, omp drops right-hand segments first, then shortens
  the path.

We adopt the idea: **a card's border is its meter.**

## Today's numbers (captured live at 90×42, atlas-wsl session, brief on)

- The status card takes 20 rows: 2 edges, 4 status rows, an inner rule, and
  13 brief rows that carry only 4 facts.
- Each finished agent card takes 6–7 rows, so 2.5 cards fit above the status
  card.

---

## A. Status card: border as meter, inline brief

Files: `src/render/status-foot.ts` (`planFoot`),
`src/render/status-block.ts` (`statusCard`), `src/render/cards.ts`
(`recapFields`), `src/render/monitor.ts` (`briefParts`, `cardEdge`,
`briefRows`/`recapRows` for compact).

### A1. Shared edge-meter helper

Add one helper that both the status card and the agent cards use (part B6).
Its input:
- the left text, the right text and the corner characters;
- the percentage and the threshold colour (reuse the existing context/quota
  colour functions);
- an optional head label (for example `56%` or `7d 99%`);
- an optional tail (for example `246K`, the window size);
- an optional tick position.

It fills the gap between left and right with:

```
<label><━ fill, coloured><─ rest, dim>[┃ tick]─<tail>
```

The fill length is proportional to the width of the bar region. Width rules:
- Under about 6 columns of bar, draw the label alone with no bar.
- When even that does not fit, drop the tail, then the label.

Draw the `┃` tick only where the HUD can actually know the auto-compact
point. Check whether the Codex config or rollout exposes
`model_auto_compact_token_limit` or an equivalent. If nothing does, draw no
tick. Do not invent a value.

### A2. New layout

Mockups at 90 columns:

The mockups are approximate and were edited by hand: some lines run past 90
columns. Real widths come from the code. Do not fit the code to the mockups.

```
full (brief on) — about 6 rows instead of 20
╭─ ✓ 空闲 ☀◆ 5d5h 56%━━━━━━━━━━━━━━━━━━━━━━━━━━━━━──────────────────┃─246K  ~3m前 b暂停 , ? ─╮
│ 目标   整理测试数据补全文档，并在版本冻结前合并本轮改动                                    │
│ 现在   本轮改动已合并并发布，无待办任务，等待新的需求                                      │
│ 已完成 ✓ 整理两个 CI 失败与下一步排查记录                                                  │
│        ✓ 提交 release 说明并推送到 main 分支  +2                                           │
╰─ atlas-wsl · main * 7d 99%━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━─ ↺114h ◷~30m+ ─╯

status — 2 rows instead of 6
╭─ ▸ exec: npm test · 2m10s · 36 tok/s 56%━━━━━━━━━━━━━━━━━━━━━━────────────┃─246K  , ? ─╮
╰─ atlas-wsl · main * 7d 99%━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━─ ↺114h ◷~30m+ ─╯

min — 1 row
╶─ ✓ 空闲 ☀◆ 5d5h 56%━━━━━━━━━━━━━━━━━━━━━━━━━━━━━───────────────────┃─246K  7d 99% , ? ─╴
```

#### Top edge

Left side:
- The session state (`SESSION_STATES`).
- While working, also the running tool and its target, the turn's elapsed
  time and the output rate `~N tok/s`. The output rate appears **only** while
  working, and the old `Output` row goes away.
- The model badge, then the session age.

Middle: the context meter (A1), with the percentage as its head label and
the window size as its tail.

Right side, at full level with a brief configured:
- The brief's state:
  - `~<age>` for the recap's age (`~` marks model-written text);
  - `writing…` while a brief is being written;
  - `failed`, in the warning colour;
  - `paused`.
- Then the `b pause` / `b resume` switch. Keep it a `brief` control so it
  stays clickable.
- Then the hints, shortened to `, ?`. Keep the settings control on the `,`.

At other levels, or with no brief, the right side is only `, ?`.

#### Bottom edge

- Left: project › repo · branch, the dirty mark and ahead/behind, as
  `card.bottom` builds them today.
- Middle: the quota meter for the primary window. The head label is the
  window plus percentage, for example `7d 99%`. Keep the meanings of the
  exhausted and forecast colours.
- Right: the reset countdown, then the existing `bottomRight` cache
  reminder `◷~30m+`. That reminder is glyph-only and in red. Either dim it
  unless it is urgent, or give it a short word. Pick one and say which.

#### Body (between the edges)

- Alert rows first, at every level except min. Use the current `alert` row
  text and colour.
- Then, at full level only, the brief.
- The `context`, `quota`, `extras` and `session` rows no longer exist as
  rows. Their data moved onto the edges.

#### min level

One line:
- the state, model and age;
- the context meter;
- the quota percentage as text, for example `7d 99%`, with its colour;
- `, ?`.

Keep the `!` attention mark that min shows today. Use `╶ ╴` ends or keep
`╭ ╮`, whichever reads better live.

#### Narrow widths

Drop parts in this order:
1. hints
2. tok/s
3. session age
4. model badge
5. window-size tail
6. the meter bar, shrinking to its minimum and then to just the label
7. the reset countdown

The state word and the percentages go last. Under 24 columns keep today's
plain hint line.

### A3. Brief body format

- **Labels inline.** Put the label in a fixed column, padded with
  `visualLength` so that `已完成` aligns, with the value after it. This is
  how `statusCard` lays out Context/Quota today. No blank lines between
  fields.
- **Field order on screen:** Needs (warning colour), then Goal, Now, Done.
- **Priority when the card is cut:** Needs, then Now, then Goal, then Done.
  Implement it like `KEEP_ORDER`.
- **Done:** the last two items, each with `✓`. When there are more, add a dim
  `+N` at the end of the last line.
- **Long values:** each value gets at most 2 lines, wrapped with a hanging
  indent under the value column (`balancedLines`), and an ellipsis after
  that.
- **The whole-picture sentence (`brief.overall`):** drop it when a recap is
  present, because it repeats Now. Without a recap, show it as one inline
  field labelled like Now. Choose and translate the label.
- **Approval words** (`notes.approval`) lead the body, inline, in the warning
  colour.
- **A failure and a reply in another shape** stay as body rows, as today.
- **Paused:** the body steps back to dim, as today.
- **Compact layout:** it shows the brief in the area above the card (via
  `recapRows`/`recapFields(…, spaced)`). Give that area the same inline-label
  format.

### A4. Size cap

- In `status-foot.ts:115`, change the cap from `floor(height/2)` to
  `floor(height/3)`.
- Raise `MIN_VIEW` so the agents keep at least about 10 rows when the panel
  is tall enough.
- When the brief is taller than its room, cut it by the A3 priority and keep
  today's scroll and `↓ n more lines` behaviour. The wheel over the card
  still scrolls the brief.
- Update `FootInfo`/`frame.statusCard`.
- The level control still covers the top edge, except the settings and
  brief spans.

**Target:** at 90×42 with the atlas brief, the status card is at most 7 rows.

## B. Agent cards (rich layout)

Files: `src/render/cards.ts` (`agentCard`, `richRows`, `cardEntryLines`,
`cardTime`), `src/render/monitor.ts` (`age`, `monitorText`, summary row),
`src/collectors/subagent-tree.ts` (the guardian nodes:
`thread_source: "guardian_review"`, title `codex-auto-review`).

### B1. Finished agents as one row

A finished agent draws as **one line** when all of these hold:
- it has completed, and finished more than `FRESH_FINISH_MS` ago (the
  existing one-minute "just finished" window). Until then it keeps its full
  card, so its final report shows briefly;
- it is not open, not erroring and not quiet;
- it needs no attention.

The line, in tree-row style:

```
 ✓ audit_code_paths ─────────────────────── ☽◐ Luna  57%━━━──── 12d
```

- Selecting it with j/k only highlights it (`›`), so the height does not
  jump while moving.
- `e`, Space, or a click on the row opens it into a full card. That is the
  existing `state.cards` open set.
- Running, failed, quiet and opened agents keep full cards.

### B2. Guardian review threads

Guardian threads no longer get their own card or row:
- The parent's top rule carries a chip `◈N` (N = the number of guardian
  reviews). Draw the chip in the info colour while one is running.
- A guardian directly under the main session puts its chip on the summary
  row, for example `✓14 完成 · ◈5`.
- A guardian that **failed** still shows as an attention row under its
  parent.
- Never render the guardian prompt boilerplate as body text anywhere.
- The same folding applies to the **compact** tree rows, which nest
  guardians today too.
- The done and running counts on the summary row exclude guardians. They
  are counted in the `◈N` chip instead.

### B3. Dim the body of an old finished card

When the name dims (`old`), dim the body text with it. Today the name is
`2;4m` but the body stays at full brightness, which makes the least useful
text the most prominent.

### B4. An opened finished card shows its last report

When the agent log is empty, an opened card shows nothing today, while the
Inspector's "Latest update" has the text (`node.lastReport`, or whatever
feeds the Inspector). Fall back to it, clipped like the timeline entries.

### B5. One relative-time formatter

- Cards say `308h ago` while the status card says `12d`.
- Make `age()` switch to days past 48h, for example `12d`, and use one
  formatter everywhere: cards, timeline, inspector and status card.

### B6. The bottom rule is the agent's context meter

Replace the 3-column `contextLine(…)` plus `NN%` on the right with the A1
helper: `└ <time> 49%━━━━━━━━━━━━━━━━━━─────────────── ▾`.
- Dim the bar when the card is old.
- Keep the `▾`/`▴` control.
- Without context data, draw a plain rule.
- The one-line finished rows (B1) carry the same meter in their gap.

### B7. Fewer lines per card

- **No orphan age line.** `cardEntryLines` puts an entry's age on a line of
  its own when the last line is full. Instead, drop the age when it does not
  fit on the last line, or whenever it equals the card's bottom-rule time
  (as it always does for a finished agent's final report).
- **News in a closed card:** at most 2 lines (`ENTRY_LINES`).
- **Light markdown cleanup** for agent text shown in cards and the
  inspector. Put it in a helper next to `monitorText`, not inside it, if
  other callers need raw text:
  - `[text](url)` becomes `text`;
  - `**x**` and `__x__` become `x`;
  - inline backticks are removed and the content kept;
  - a bare 40-character hex hash becomes its first 7 characters.

## C. Settings page

File: `src/render/settings-page.ts`.

1. **Value next to the label.** Use a label column as wide as the widest
   label on the page plus 2, with the value right after it. Highlight values
   that differ from the default in the accent colour.
2. **Short hint on each row.** When width allows (≥ 70 columns), append a
   dim one-line hint after the value, truncated to fit. Keep the selected
   row's full help at the bottom, as today.
3. **Dependent rows step back.** When `Backend` (briefing) is `off`, dim
   every row that needs a backend, with one dim note under the Backend row:
   "takes effect with a backend". The rows stay selectable, so they can be
   set up in advance. Apply the same rule to any other parent/child pair you
   find.
4. **Clearer labels.** Update the zh translations in `src/render/i18n.ts`
   too.
   - `Log, model off` (无模型时的日志) is an agent log without a backend.
     Name it after what it does, for example "Agent log" with the help
     "Keep a log on each card even with no backend".
   - `Width 0`: show the value `0` as `auto` (自动).
   - `Decoration` → `Picture` (背景图), or similar.
   - The `Last read 0s ago` footer → `HUD read the session 0s ago`
     (HUD 读取会话 0s 前), or similar.

## D. Timeline

File: `src/render/monitor.ts` (`timelineRows`, and the event source if
needed).

1. Fold consecutive identical events into one line with `×N` and the newest
   time, for example `305h Turn finished ×5`.
2. An agent's `started` and `finished` that are both in the list become one
   line: `bench_tokenizer ran 12m ✓` (or `✗` for a failure), at the finish
   time.
3. Guardian started/finished events are hidden, consistent with B2. Keep a
   guardian failure.

## E. Docs

- Update the README files (en/zh/ja/ko) wherever they describe the status
  card's rows or the panel layout.
- Do not regenerate the screenshots. Tell the user which ones are now out of
  date.

## Ground rules

- Match the code style around you: terse identifiers, comments that say
  *why*, and English as the i18n key with a zh entry for every new string.
- Keep the rendering pure, as today.
- Update the tests that move with each part and add tests for the new
  behaviour. The tests likely affected:
  - `status-card`, `status-block`, `recap`, `cards`, `briefing`;
  - `panel`, `panel-repaint`, `timeline`, `settings-page`, `i18n`,
    `click-map`, `monitor`.
- `npm test` and `npm run format:check` must pass at every commit.
- First commit this plan file on its own. Then commit A, B, C, D and E
  separately on `hud-enhancements`.
  - Subjects are imperative sentences in the repo's style, for example
    "Draw the context and quota meters on the status card's edges".
  - Each body explains what changed and why.
  - End every message with
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Do not push.**
- Never touch the user's default tmux server: their live Codex is pane `%0`
  there. Never write into `~/.codex` or `~/.codex-account2`.

## F. Live check (required)

Scratchpad: `/tmp/claude-1000/-home-fires-codex-codex-hud/c4a91d06-e869-4633-8cf6-9b018adb87bc/scratchpad`
(called `$S` below). It already contains these:

- `$S/tmuxw`: a tmux wrapper bound to the `-L hudui` server. Pass it as
  `CODEX_HUD_TMUX_BIN`.
- `$S/ch`: a throwaway `CODEX_HOME` holding the shenlun 2026-09-21 session
  (14 subagents, 5 of them guardians). The session sits under
  `sessions/2026/10/04/`, because the tree only scans 3 days back. Its cwd
  is `/home/fires/shenlun`. Briefing is off. Press `a` to show the older
  agents.
- `$S/ch2`: a throwaway `CODEX_HOME` holding the atlas-wsl session, with 38
  subagents symlinked read-only from `~/.codex/sessions`, the recap,
  agent-log and model-cache copied from `~/.codex/hud`, and `briefing: omp`.
  Its cwd is `/home/fires/atlas-wsl`. The 173 MB main rollout needs about
  30–60 s to load.
- `$S/fakebin/omp` and `$S/fakebin/agy`: each runs `sleep 900`, so that no
  model is ever called. The brief then shows "writing…" over the cached
  recap.
  - **Every** launch, of either home, must put `$S/fakebin` first on
    `PATH`.
  - During captures, set Backend only to `off` or `omp`. Never use `agy` or
    `api`: `api` would make real HTTP calls.
  - Before finishing, kill any `sleep 900` they started.
- `$S/captures/before/`: the baseline captures from `585156f`, already
  taken:
  - `brief42.txt` (ch2, 90×42);
  - `brief1.txt/.ansi` (ch2, 90×60);
  - `cards.txt`, `expanded.*`, `tree.txt` (compact), `settings.*`,
    `timeline.*`, `inspector.*`, `status2/3.*` (all ch, 90×60);
  - `keys.txt`.

Launch:

```bash
tmux -L hudui new-session -d -s p -x 90 -y 42 \
  "cd /home/fires/atlas-wsl && exec env PATH=$S/fakebin:\$PATH CODEX_HOME=$S/ch2 \
   CODEX_HUD_CWD=/home/fires/atlas-wsl CODEX_HUD_TMUX_BIN=$S/tmuxw \
   node /home/fires/codex/codex-hud/dist/tree-page.js"
tmux -L hudui capture-pane -p -t p      # plain text
tmux -L hudui capture-pane -e -p -t p   # with colours, to check the dimming/meter colours
```

Keys:
- `r` steps the status level;
- `,` opens settings;
- `5` opens the timeline;
- `j`/`e` select and open a card;
- `Enter` opens the inspector;
- `tmux -L hudui resize-window -t p -x W -y H` resizes.

**Before:** the baseline above already exists. Before-captures of the
narrow and wide sizes and of the running card are optional. Do not set up a
worktree just for them.

Capture these from your final build into `$S/captures/after/`:

1. `ch2` at 90×42 and 90×60, status level full, then status, then min.
2. `ch2` at 60×30 (narrow) and 120×50.
3. `ch` after `a`:
   - the card list;
   - one finished card opened (B4);
   - guardians folded (B2);
   - the compact layout (Settings → Panel → Layout).
4. A **running** agent. Copy one subagent rollout from `ch`. Cut it before
   its final `task_complete` (or the equivalent event) and before the
   parent's matching completion, and touch its mtime to now, so that it
   reads as running. Capture its full card.
5. The settings page with Backend off and with Backend on, at 90 columns.
6. The timeline pane open on `ch`.

**Acceptance:**
- At 90×42 with the brief, the status card is at most 7 rows, and the
  agents area shows at least 4 agents without scrolling.
- Every state in the list above renders with no broken borders, no
  overflow past the width, and correct CJK alignment.

Afterwards:
- run `tmux -L hudui kill-server`;
- check `pgrep -f "sleep 900"`.

## Final report

1. The commits.
2. The test results.
3. The row counts before and after.
4. The paths to the capture files, plus a few key captures pasted inline:
   the status card at the three levels, the cards, settings and the
   timeline.
5. Any decision this plan left open, and any item you could not do, with
   the reason.
