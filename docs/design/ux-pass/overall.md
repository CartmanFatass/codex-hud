# UX-PASS: design for an overall UI/UX pass on the HUD

Oracle job je49848d19971c0d8, 2026-11-20, checkout f02c8a6b (branch universal-hud). Read-only: nothing in the repository was changed.

## 0. Direct answer

The panel's data and layouts are sound. What the owner feels at 40 columns is mostly wording and placement: footers that drop the useful hint, the same fact said two or three times, and two pages (Help, EXP) that do not follow the form of the others. I recommend six slices, built in this order, one implementer at a time:

| # | Slice | What the owner sees | Size |
|---|---|---|---|
| 1 | FOOTER | One footer rule everywhere; `? help` always visible; row actions first | M |
| 2 | SAY-ONCE | Project hub, Progress and question slabs stop repeating facts and key hints | M |
| 3 | HELP | Help grouped by tab, opens at the tab you came from, complete marks, no prose | M |
| 4 | EXP-FORM | EXP looks like the other pages; its option sheet lists every option | S |
| 5 | HARNESS-ROWS | Harnesses shows only exceptions; a cut Chinese control label fixed | S |
| 6 | TOP-ROW | Top row and words: no `models on`, no `EXP exp`, Esc the same on every tab, short Chinese minutes | S |

All six are render and input changes. None adds a read, a timer, a model call or a setting. Four owner decisions are in section 4; each has a recommendation, and every slice names the decision it waits on.

Model selection (the Control path to change a model, the picker, zoom and mouse) and the pi footer's quota visuals belong to the parallel oracle job. Section 5 gives them one line each and no slice here touches them.

Simplest option that still satisfies the brief: slices 1 and 2 alone. They remove most of what the owner sees every minute. Slices 3 to 6 are each independent of one another in function.

## 1. Findings, ranked by how much the owner feels them

Frame sources: `tests/fixtures/*-frames.json` (named `file :: key`), or "rendered" for frames I drew from the same test fixtures through `tmp/env.sh` (temp homes) at 40 columns, because the fixture set has no 40-column Home (Classic), Help, EXP or Harnesses frame.

**F1. Footers are about 30 hand-written strings, each in its own order, and at 40 columns the wrong hints survive.** A footer keeps hints from the left until the row is full (`footHints`, `src/render/workboard-rows.ts:64-68`), so the order decides what a 40-column panel shows. The order is written per scene (`src/render/job-actions.ts:45`, `src/render/split-project.ts:84-91,152-153,191,208,240`, `src/render/inbox-project.ts:209-237,368`, `src/render/work-view.ts:386-400`, `src/render/harness-page.ts:93-96`, `src/render/settings-page.ts:324-325`).

- `↑↓ move` leads most footers and always survives, and it tells the owner nothing. `? help` is cut on the Split hub, the Classic Progress page, both Control footers, Harnesses, the Inspector, Settings and EXP.
- On Home the count `✓ 1 done today` takes 14 of 40 cells, so a running job's row shows `⏎ open  g job tab` and neither `X stop` nor `? help` (`split-frames.json :: home-busy-40-en`, row 40). The Chinese row has room for `X 停止` (`home-busy-40-zh`), so the two languages show different keys.
- The same action has two words: Enter on a Control role says `⏎ chain` in Split and `⏎ open` in Classic (`split-frames.json :: control-40-en` row 40, `project-frames.json :: control-rich-40-en` row 48). Two keys share one word: `⏎ open` and `o open` (`split-frames.json :: home-busy-120-en` row 40).
- Key names differ: `esc` in footers, `Esc` in Help and prompts; `Space 勾选` on the hub and `空格 开关` in Harnesses (`src/render/split-i18n.ts:23`, `src/render/workboard-i18n.ts:241`).

```
split-frames.json :: home-busy-40-en      ✓ 1 done today         ⏎ open  g job tab
split-frames.json :: hub-40-en               ↑↓ move  Space mark  y accept  n flag
project-frames.json :: progress-rich-40-en      ↑↓ move  ⏎ open  t to try  esc back
split-frames.json :: control-40-en         ↑↓ move  ⏎ chain  c C preset  p presets
```

**F2. The same fact is said two or three times on one screen, and key hints sit in the body as well as in the footer.** On the Split hub (`split-frames.json :: hub-40-en`, rows 3 to 37): the milestone is on the name row and on the Progress row; `5 to try` is on the Waiting row and the Progress row; every row under the heading `To try` says `to try`, every row under `Latest accepted` says `accepted`; `y accept  n flag` is in the body and in the footer; `⏎ open page` is on the preview's rule. The Progress row then has no room for the two facts nothing else shows (blocked, working: `pageSummary` drops the last facts first).

```
demo-project ───────────────────── 0.1.3
? Waiting for you           2 · 5 to try
◐ Progress      0.1.3 · 5 to try
Progress ─────────────────── ⏎ open page
To try   y accept  n flag
  ◇ DATA-ONE                   to try 1d
Latest accepted
  ✓ REVIEW-ONE               accepted 8d
```

Also: each question slab ends with a row of hints, `┃ qa/q1.md  ⏎ expand  o open` (`src/render/home-view.ts`, `askSlabRows`), one row per question for words the footer already has. In Split the slab's title repeats its lane's name right under the rule that names the lane (`home-busy-40-en` rows 15-16). The Progress preview ends with a row that only repeats the milestone on its rule (`progress-40-en` rows 17-19).

**F3. On the Split Progress page a slice's row says its state twice and never what the slice is.** Mark and word say the same thing; the text is only in the preview, one slice at a time (`split-frames.json :: progress-40-en`, rows 5 to 12). With the model on, to-try rows with a brief already show a sentence (`docs/design/panel-ux/screens.txt`, Progress page); every other row stays like this.

```
◐ PAGE-ONE     working
◇ DATA-ONE     to try                 1d
◇ NATIVE-ROWS  to try                19d
○ LATER-ONE    todo
```

**F4. Help is 118 rows at 40 columns and is not organised by where a key works** (rendered, `kept-pages.mjs` fixture, `help` at 40 columns; builder `src/render/work-view.ts:31-90`). One flat list of 34 key rows mixes tabs (Control keys sit between Project keys and job keys). After it come 22 rows of prose that mostly repeat the table, then the skills list. It always opens at the top, whatever tab the owner came from (`src/render/monitor-input.ts:72-74`).

- One English row reads as a cut sentence: `dim rows are older ones, shown with a` (the last word is the key; Chinese says 按 a 显示).
- Keys that work are not listed: `t` (to-try view), `q`, `j`/`k`, PgUp/PgDn (outside Split), Home/End.
- The legend explains job and decision marks only. `◐ ◆ ◇ ○` on slices and `◉ ○ ✗ ⊘ −` on places are not explained, and three marks mean different things on different pages (`◉` running job, healthy role, next place, switch on; `◆` a departing answer and a blocked slice; `◇` an answer as proposed and a slice to try).

**F5. EXP does not look like the other pages, and its option sheet hides the options** (rendered, `exp-page.test.mjs` setup, 40 columns; `src/render/exp-view.ts`). No blank row between sections, rows not indented, a bare `.codex` row with no label next to a reading row that belongs to it, and no `? help` in the footer. Choosing a Codex profile shows one option at a time with `1/2`: the owner cannot see what the other option is without pressing ↓. The tab label says its name twice: `EXP exp`, `EXP 实验` (`src/render/work-view.ts:199`). The header says `Local · all projects` where Harnesses says `This machine · all projects` for the same thing (Chinese uses one phrase for both).

```
Codex native status line ───────────────        Codex profile
Track native status line             off
.codex                                          1/2
Last native bar seen                   —        Unbound
Codex setup / restore
pi subscription proxy ──────────────────
```

**F6. Words for the normal state.** Every enabled Harnesses row says `installed` or `listed` (rendered; `src/render/harness-page.ts`), the top row says `models on`, and switch states are capitalised in the middle of a row (`pi:xai Switched off`, `state  Switched on · installed`; `src/render/control-page.ts:27,73`, `src/render/harness-page.ts:20`). This is the same class as the `default` labels the owner just had removed.

**F7. Chinese rows pay more cells than English ones.** Minutes are `分钟` (four cells against one), so the same row cuts a title in Chinese that English shows whole (rendered Classic Home at 40: `? imp  Dedupe the sync queue   asking 4m` against `? imp  Dedupe the sync qu…  提问中 4分钟`). The compound form already says `分` (`1小时5分`, `src/render/workboard-i18n.ts:30,75`). One control label is cut in Chinese: Classic role actions at 40 columns read `预设  复制预设  空白预设  重命名  删…` (rendered; `roleActions`, `src/render/control-page.ts:195-212`), against the rule that controls stay whole (`docs/ARCHITECTURE.md:416-417`).

**F8. Esc does different things at the root of each tab.** On Control and EXP it jumps to Home (`src/render/workboard-input.ts:212,375`); on Home and the Project hub it does nothing (checked with `handleMonitorInput`). In Split, Esc is the key the owner presses most (back from the preview), so one press too many on Control leaves the tab. `docs/reference.md:718` says a standalone main-page Esc exits the panel; I did not find that path and my check returned `close: false`, so the document and the code disagree here.

**F9. Small ones.** The hub's Working tree and Docs rows wear `○`, which means todo or standby everywhere else. A Split Harnesses cursor on the Off fold shows an empty preview under a rule (rendered). `Latest ── newest first` and `History ── newest first` spend the rule's right side on a phrase that never changes.

**Not a finding: speed.** Pure rendering of the busiest pages takes 0.4 to 1.6 ms a frame at 40x50 on the synthetic fixtures (300 runs each, this WSL2 host: Home 0.4-0.6, hub 0.6, Progress 0.7, Control 0.8, Help 1.6). I did not measure collection or key-to-paint time in a live herdr pane, so I propose no performance slice; no slice below adds work to a paint.

## 2. Design principles

1. **Say a fact once per screen.** The nearest heading wins: a row under a heading that names its state does not repeat the state.
2. **The normal state is silent.** Words are for exceptions (`not installed`, `models off`, `off`), never for on, installed or default.
3. **Keys live in the footer and in Help, not in the body.** The one exception is `1-2 answer  d default`, which stays beside the numbered options it refers to.
4. **One footer rule.** The row's own actions, then Enter with the verb for this row, then Esc, then page actions; `? help` is last and is never dropped; movement keys are not listed.
5. **One key, one word, one spelling**, in both languages and both layouts (`Esc`, `Space`, `⏎`; the same action has the same word in Classic and Split).
6. **At 40 columns drop words before cutting names.** A control label is never cut. Chinese gets the same room as English.
7. **Every page has one skeleton:** tab row or crumb, a blank row, section rules with a count, rows indented two cells, the footer.
8. **Nothing new to compute.** Every change is in pure render or input code: no new read, timer, model call or setting.

## 3. Slices

Order: 1, 2, 3, 4, 5, 6. No slice needs a later one. Every slice changes frame snapshots (`npm run snapshots:update`, diff inspected) and both references (`docs/reference.md` and its Chinese counterpart), so they are best run one at a time; two slices in parallel both rewrite `tests/fixtures/*-frames.json` and the later one must regenerate after the merge.

Files in common (run these in sequence):

| File | Slices |
|---|---|
| `src/render/split-project.ts`, `board-project.ts`, `inbox-project.ts`, `split-home.ts` | 1, 2 (6 also touches `split-home.ts`) |
| `src/render/work-view.ts` | 1 (hint choice), 3 (Help), 6 (top row) |
| `src/render/exp-view.ts` | 1 (its hints), 4 |
| `src/render/harness-page.ts`, `control-page.ts` | 1 (hints), 5; `control-page.ts` is also in NO-DEFAULT-LABELS (in flight) and in the parallel model-selection design |
| `src/render/workboard-i18n.ts`, `split-i18n.ts`, `i18n.ts` | all (new entries; small merges) |
| `src/render/workboard-input.ts` | 6 only |

Slice 4 can run beside 2 or 3 if a second implementer is free (EXP has inline test frames, no snapshot file). Slice 5 starts after NO-DEFAULT-LABELS has landed.

### Slice 1. FOOTER: one footer rule

**Goal.** Every footer is built by one function from an ordered list of hints, so a 40-column panel always shows the row's own actions and `? help`.

**Rule.**
1. Order: the row's own actions, most specific first; `⏎` with the verb for this row; `Esc back` where Esc leaves something; page actions (`/ filter`, `a all`, `t to try`, `[ ] project`, `h`, `r refresh`); `? help` last.
2. `? help` is pinned: when the row is short, hints are dropped from the end of the list, never `? help`. Pages where typing owns the keyboard (the `/` filter while typing, the preset list, Add back, the picker) keep their own footers without `? help`.
3. Never listed: `↑↓` in any form (move, select, pick, place, field, scroll), `←→ tab`, `, settings`. Help lists them.
4. One word per key: `o file` (not `o open`); Enter on a Control role is `⏎ chain` in both layouts. Key names: `Esc` and `Space` in both languages.
5. Home's left count is `✓ N done today` from 56 columns and `✓ N` below (decision D1).

**Before → after, 40 columns.**

```
Home (Split), cursor on a running HUD job
before EN  |✓ 1 done today         ⏎ open  g job tab|
after  EN  |✓ 1    g job tab  X stop  ⏎ open  ? help|
before ZH  |✓ 1 今日完成    ⏎ 打开  g 任务页  X 停止|
after  ZH  |✓ 1     g 任务页  X 停止  ⏎ 打开  ? 帮助|
Home (Split), cursor on a block row (Waiting, Decided, Progress)
before EN  |✓ 5 done today  ⏎ open  ? help  / filter|
after  EN  |✓ 5      ⏎ open  / filter  a all  ? help|
before ZH  |✓ 5 今日完成      ⏎ 打开  ? 帮助  / 筛选|
after  ZH  |✓ 5       ⏎ 打开  / 筛选  a 全部  ? 帮助|
Home (Classic), cursor on a card
before EN  |✓ 3 done today          ⏎ expand  ? help|
after  EN  |✓ 3  ⏎ expand  o file  v inspect  ? help|
before ZH  |✓ 3 今日完成      ⏎ 展开  ? 帮助  / 筛选|
after  ZH  |✓ 3       ⏎ 展开  o 文件  v 详情  ? 帮助|
Project hub (Split), Progress row with slices to try
before EN  |   ↑↓ move  Space mark  y accept  n flag|
after  EN  |    Space mark  y accept  n flag  ? help|
before ZH  |     ↑↓ 移动  Space 勾选  y 验收  n 标记|
after  ZH  |      Space 勾选  y 验收  n 标记  ? 帮助|
Project hub (Classic), one project / several projects
before EN  |         ↑↓ move  ⏎ open  ←→ tab  ? help|
after  EN  |                          ⏎ open  ? help|
before EN  |    ↑↓ move  ⏎ open  ←→ tab  [ ] project|
after  EN  |             ⏎ open  [ ] project  ? help|
before ZH  |        ↑↓ 移动  ⏎ 打开  ←→ 切页  ? 帮助|
after  ZH  |                          ⏎ 打开  ? 帮助|
Progress page (Classic)
before EN  |     ↑↓ move  ⏎ open  t to try  esc back|
after  EN  |      t to try  ⏎ open  Esc back  ? help|
before ZH  |     ↑↓ 移动  ⏎ 打开  t 待试用  esc 返回|
after  ZH  |      t 待试用  ⏎ 打开  Esc 返回  ? 帮助|
Progress page (Split), a working slice
before EN  |  ↑↓ move  ⏎ open file  ? help  / filter|
after  EN  | ⏎ open file  Esc back  / filter  ? help|
before ZH  |     ↑↓ 移动  ⏎ 打开文件  ? 帮助  / 筛选|
after  ZH  |    ⏎ 打开文件  Esc 返回  / 筛选  ? 帮助|
Control, a role row (before: Split, then Classic; after: both layouts)
before EN  | ↑↓ move  ⏎ chain  c C preset  p presets|
before EN  |  ↑↓ move  ⏎ open  c C preset  p presets|
after  EN  |  c C preset  p presets  ⏎ chain  ? help|
before ZH  |   ↑↓ 移动  ⏎ 备选链  c C 预设  p 选预设|
after  ZH  |    c C 预设  p 选预设  ⏎ 备选链  ? 帮助|
Control, Harnesses, a switch row
before EN  |       ↑↓ move  Space on/off  i add back|
after  EN  |        Space on/off  i add back  ? help|
before ZH  |    ↑↓ 移动  空格 开关  i 添加  Del 删除|
after  ZH  |    Space 开关  i 添加回  h 角色  ? 帮助|
Inspector
before EN  |               ↑↓ move  ⏎ open  esc back|
after  EN  |                ⏎ open  Esc back  ? help|
before ZH  |               ↑↓ 移动  ⏎ 打开  esc 返回|
after  ZH  |                ⏎ 打开  Esc 返回  ? 帮助|
Settings
before EN  |  ↑↓ select  ←→ change  s save  esc back|
after  EN  |     ←→ change  s save  Esc back  ? help|
before ZH  |      ↑↓ 选择  ←→ 修改  s 保存  esc 返回|
after  ZH  |       ←→ 修改  s 保存  Esc 返回  ? 帮助|
EXP
before EN  |               ↑↓ select  ⏎ edit  ←→ tab|
after  EN  |                          ⏎ edit  ? help|
before ZH  |                ↑↓ 选择  ⏎ 编辑  ←→ 切页|
after  ZH  |                          ⏎ 编辑  ? 帮助|
Help
before EN  |                     ↑↓ scroll  esc back|
after  EN  |                                Esc back|
```

At 120 columns every hint fits; only the order and the three dropped hints change:

```
Home (Split), cursor on a running HUD job, 120 columns
before EN  |✓ 1 done today        ⏎ open  g job tab  X stop  ? help  / filter  o open  v inspect  ↑↓ move  a all  , settings  ←→ tab|
after  EN  |✓ 1 done today                                     g job tab  X stop  ⏎ open  o file  v inspect  / filter  a all  ? help|
```

**Keys and mouse.** No key changes. Footer hints that are click targets today (Harnesses, `harnessFooterControls`) stay click targets.

**Visible features removed or changed.**
- Footers no longer show `↑↓ move/select/pick/place/field/scroll`, `←→ tab` or `, settings`.
- `✓ N done today` reads `✓ N` under 56 columns.
- `o open` becomes `o file`; `esc` becomes `Esc`; Chinese `空格` becomes `Space`; Classic Control's `⏎ open` on a role becomes `⏎ chain`.
- `? help` appears on every footer except text-entry ones and Help itself.

**Acceptance.**
- A unit test draws each scene (Home, hub, Progress, Tickets, Working tree, Docs, Control roles, chain focus, Harnesses, Inspector, Settings, EXP; Classic and Split) at 40, 56, 80 and 120 columns in English and Chinese, and checks: the footer is exactly the width; `? help` is its last hint; no hint starts with `↑↓`.
- A table test checks one word per key across all scenes and that no hint string is built outside the one builder (`rg "'↑↓ "` in `src/render` finds nothing).
- The 40-column rows above match in both languages.
- The owner reads Home, the hub and Control at 40 columns and finds `? help` on each.

**Size.** M: one builder in `workboard-rows.ts`, about 30 call sites reduced to hint lists, i18n entries, snapshots. No behaviour change.

### Slice 2. SAY-ONCE: Project hub, Progress and question slabs

**Goal.** Each fact appears once on the hub and the Progress page; key hints leave the body; a slice's row says what the slice is.

**Changes.**
1. Hub Progress row: the milestone leaves the row when the name row above shows it, so `blocked` and `working` get the room.
2. A row under a heading that names its state drops the state word and keeps its age: Split hub `To try` and `Latest accepted`, Classic `Only to try`, the Inbox layout's `To try` group. Mixed lists (`Now`, `Latest`, `History`) keep the word.
3. Body hints go: `⏎ open page` on a preview's rule, `y accept  n flag` beside `To try`, and the slab's last row (`qa/qN.md  ⏎ expand  o open`). The expanded slab keeps `1-2 answer  d default`.
4. Split Progress list: the state word gives way to the slice's ledger text, cut at a word (decision D2). The mark carries the state; the preview's rule still says the word and the preview still shows the whole text. Rows with a model brief are unchanged. The preview's last row is left out when it has only the milestone.
5. Split Home preview: a slab's title drops the lane name under the rule that names the lane.
6. Hub rows with nothing to flag (Working tree, Docs) have no mark instead of `○`. `newest first` leaves the `Latest` and `History` rules.

**Before → after, hub (Split), 40 columns, English.**

Before (`split-frames.json :: hub-40-en`):

```
demo-project ───────────────────── 0.1.3

? Waiting for you           2 · 5 to try
◐ Progress      0.1.3 · 5 to try
? Tickets       3/14 done · 2 working
○ Working tree  synthetic-project
○ Docs          M3b · AI-THIN

Progress ─────────────────── ⏎ open page
  Synthetic hub work in two worktrees
  ████████████▒▒▒▒▒▒░░░░░░ 0/4 accepted

To try   y accept  n flag
  ◇ DATA-ONE                   to try 1d
    ledger history, live jobs and ticket
    detail
  ◇ WATCH-LINK                 to try 5d
    the watcher survives a link loop
  …
Latest accepted
  ✓ REVIEW-ONE               accepted 8d
  ✓ ONE-PAGE                accepted 20d
  ✓ SKILL-MOVE              accepted 28d
```

After:

```
demo-project ───────────────────── 0.1.3

? Waiting for you           2 · 5 to try
◐ Progress      5 to try · 1 blocked
? Tickets       3/14 done · 2 working
  Working tree  synthetic-project
  Docs          M3b · AI-THIN

Progress ───────────────────────────────
  Synthetic hub work in two worktrees
  ████████████▒▒▒▒▒▒░░░░░░ 0/4 accepted

To try
  ◇ DATA-ONE                          1d
    ledger history, live jobs and ticket
    detail
  ◇ WATCH-LINK                        5d
    the watcher survives a link loop
  …
Latest accepted
  ✓ REVIEW-ONE                        8d
  ✓ ONE-PAGE                         20d
  ✓ SKILL-MOVE                       28d
```

Chinese, before (`hub-40-zh`) and after:

```
demo-project ───────────────────── 0.1.3

? 等你处理                  2 · 5 待试用
◐ 进度          0.1.3 · 5 待试用
? 工单          3/14 完成 · 2 工作中
○ 工作区        synthetic-project
○ 文档          M3b · AI-THIN

进度 ──────────────────────── ⏎ 打开页面
  Synthetic hub work in two worktrees
  ████████████▒▒▒▒▒▒░░░░░░ 0/4 已验收

待试用   y 验收  n 标记
  ◇ DATA-ONE                  待试用 1天
    ledger history, live jobs and ticket
    detail
  ◇ WATCH-LINK                待试用 5天
    the watcher survives a link loop
  …
最近验收
  ✓ REVIEW-ONE                已验收 8天
  ✓ ONE-PAGE                 已验收 20天
  ✓ SKILL-MOVE               已验收 28天
```

```
demo-project ───────────────────── 0.1.3

? 等你处理                  2 · 5 待试用
◐ 进度          5 待试用 · 1 受阻
? 工单          3/14 完成 · 2 工作中
  工作区        synthetic-project
  文档          M3b · AI-THIN

进度 ───────────────────────────────────
  Synthetic hub work in two worktrees
  ████████████▒▒▒▒▒▒░░░░░░ 0/4 已验收

待试用
  ◇ DATA-ONE                         1天
    ledger history, live jobs and ticket
    detail
  ◇ WATCH-LINK                       5天
    the watcher survives a link loop
  …
最近验收
  ✓ REVIEW-ONE                       8天
  ✓ ONE-PAGE                        20天
  ✓ SKILL-MOVE                      28天
```

**Before → after, Progress page (Split), 40 columns.** Before (`split-frames.json :: progress-40-en`), after:

```
◐ PAGE-ONE     working
◆ PAGE-TWO     blocked
◇ DATA-ONE     to try                 1d
◇ NATIVE-ROWS  to try                19d
◇ SENTENCE-CUT to try                 7d
◇ WATCH-LINK   to try                 5d
◇ NO-HASH      to try
○ LATER-ONE    todo
◉ imp Tidy the synthetic docs in the… 5m
→ Next                                 4
▸ History   3 landed in 7 days · 7 older

PAGE-ONE ─────────────── working · 0.1.3
  the hub and one page per section
  0.1.3
```

```
◐ PAGE-ONE     the hub and one page per…
◆ PAGE-TWO     waits for page one
◇ DATA-ONE     ledger history, live…  1d
◇ NATIVE-ROWS  native rows keep one… 19d
◇ SENTENCE-CUT job sentences are cut… 7d
◇ WATCH-LINK   the watcher survives…  5d
◇ NO-HASH      landed with no commit in…
○ LATER-ONE    a later slice
◉ imp Tidy the synthetic docs in the… 5m
→ Next                                 4
▸ History   3 landed in 7 days · 7 older

PAGE-ONE ─────────────── working · 0.1.3
  the hub and one page per section
```

Chinese (`progress-40-zh`), before and after:

```
◐ PAGE-ONE     工作中
◆ PAGE-TWO     受阻
◇ DATA-ONE     待试用                1天
◇ NATIVE-ROWS  待试用               19天
◇ SENTENCE-CUT 待试用                7天
◇ WATCH-LINK   待试用                5天
◇ NO-HASH      待试用
○ LATER-ONE    待办
◉ imp Tidy the synthetic docs in … 5分钟
→ 下一步                               4
▸ 历史        7 天内落地 3 个 · 7 已收起

PAGE-ONE ──────────────── 工作中 · 0.1.3
  the hub and one page per section
  0.1.3
```

```
◐ PAGE-ONE     the hub and one page per…
◆ PAGE-TWO     waits for page one
◇ DATA-ONE     ledger history, live… 1天
◇ NATIVE-ROWS  native rows keep…    19天
◇ SENTENCE-CUT job sentences are…    7天
◇ WATCH-LINK   the watcher survives… 5天
◇ NO-HASH      landed with no commit in…
○ LATER-ONE    a later slice
◉ imp Tidy the synthetic docs in … 5分钟
→ 下一步                               4
▸ 历史        7 天内落地 3 个 · 7 已收起

PAGE-ONE ──────────────── 工作中 · 0.1.3
  the hub and one page per section
```

**Before → after, question slabs, 40 columns** (`split-frames.json :: home-busy-40-en/zh`; Classic rendered):

```
Split preview, EN
NATIVE-TREE ─────────────── imp · 2 jobs
? imp · NATIVE-TREE            asking 0m
┃ Question: Which synthetic option?
┃ qa/q1.md              ⏎ expand  o open

Split preview, ZH
NATIVE-TREE ───────────── imp · 2 个任务
? imp · NATIVE-TREE         提问中 0分钟
┃ Question: Which synthetic option?
┃ qa/q1.md                ⏎ 展开  o 打开

Classic slab, EN
? imp · R5-UX                  asking 4m
┃ Keep the v1 shim for one more
┃ release?
┃ 2 options · default: a: keep it for …
┃ qa/q3.md              ⏎ expand  o open

Classic slab, ZH
? imp · R5-UX               提问中 4分钟
┃ Keep the v1 shim for one more
┃ release?
┃ 2 个选项 · 默认: a: keep it for one …
┃ qa/q3.md                ⏎ 展开  o 打开
```

```
Split preview, EN
NATIVE-TREE ─────────────── imp · 2 jobs
? imp                          asking 0m
┃ Question: Which synthetic option?

Split preview, ZH
NATIVE-TREE ───────────── imp · 2 个任务
? imp                       提问中 0分钟
┃ Question: Which synthetic option?

Classic slab, EN
? imp · R5-UX                  asking 4m
┃ Keep the v1 shim for one more
┃ release?
┃ 2 options · default: a: keep it for …

Classic slab, ZH
? imp · R5-UX               提问中 4分钟
┃ Keep the v1 shim for one more
┃ release?
┃ 2 个选项 · 默认: a: keep it for one …
```

At 120 columns the same words go; rows there already put a slice's text beside its id (`project-frames.json :: hub-rich-120-40-en`), so only the state words under `To try` and `Latest accepted`, the rule hints and the slab row change.

**Keys and mouse.** None. If the slab's `⏎ expand` and `o open` words are click targets today (I did not check), a click on the slab already selects it and a second click is Enter (`docs/reference.md:721`).

**Visible features removed or changed.**
- The slab's file row (`qa/qN.md  ⏎ expand  o open`) is gone; the file still opens with `o`.
- `⏎ open page` and `y accept  n flag` no longer appear in the preview body.
- The Progress row no longer shows the milestone when the name row does.
- State words under `To try` / `Latest accepted` headings are gone; ages stay.
- Split Progress rows show the slice's text in place of the state word.
- `○` on Working tree and Docs rows, and `newest first`, are gone.

**Acceptance.**
- The four frames above match at 40 columns in both languages; every row is exactly the width.
- On the hub, `to try` appears as a count on the Waiting row and at most once more (Progress row); the milestone appears once.
- With the model on, a briefed to-try row is unchanged; with it off, the list row is the cut ledger text and the preview shows the whole text.
- Counts still agree between Home, the hub, Progress and the Projects list (existing tests).
- No Classic Home frame changes except the slab's last row.

**Size.** M: about six small edits in `split-project.ts`, `project-view.ts`, `board-project.ts`, `inbox-project.ts`, `split-home.ts`, `home-view.ts`; snapshots.

### Slice 3. HELP: by tab, at the right place, complete

**Goal.** Help answers "what can I press here": keys grouped by where they work, opened at the group of the tab the owner came from, with a legend for every mark and no prose.

**Changes.**
1. Sections in this order: Everywhere, Home, Project, Control, Split (only in the Split layout), Marks, Backup skills.
2. `?` opens Help scrolled so that the section of the current tab is the first row under the crumb (Home opens at the top; EXP opens at Everywhere). The crumb row is unchanged.
3. A key is listed once per section; `Space` and `i Del` appear in two sections because they do two things in two places.
4. The nine prose paragraphs go. What they said that the table did not is now a key row (click, Harnesses' Del) or the three-line note under Control.
5. The legend covers jobs, slices, answers and places. The cut English sentence is rewritten.
6. Keys missing today are added: `t`, `q`, `j k`, PgUp/PgDn.

The `m` row and any picker wording follow whatever the model-selection design settles.

**Before, 40 columns, English** (rendered; excerpts of 118 rows):

```
‹ Help

Keys ───────────────────────────────────
← → Tab switch tab (a click too)
f       Changes
↑ ↓     move
/       filter rows live
⏎       expand / fold, edit a place, or
        toggle switch
  … 30 more key rows, one flat list …
Esc     back; confirm discarding a
        draft; picker: clear then exit

Marks ──────────────────────────────────
✓ done      ◉ running   ? asking you
✗ failed    − stopped   ◷ stalled
◆ answer differs from the default
◇ answer as proposed
┃ body of a card
dim rows are older ones, shown with a
lavender words are marked by the model

In Project ⏎ opens a page, then a row or
fold; o opens its file; Esc goes back
In a Control chain, Enter edits a place.
Choose Target, Model or Flow kind,
Thinking where offered, then Done.
Nothing changes on disk until Save.
  … 16 more rows of prose …

Backup skills ─────────────────────── 17
```

**After, 40 columns, English** (the Split section shows only in Split):

```
‹ Help

Everywhere ─────────────────────────────
← → Tab switch tab (a click too)
↑ ↓ j k move; PgUp PgDn page
⏎       act on the row; the footer says
        what it does there
o       open the row's file in $EDITOR
/       filter rows live
Esc     back; clear a filter first
,       Settings
?       this page
b       model text on / off
w       write the review board (HTML)
f       Changes
q       close the panel
click   select; again = ⏎; wheel scrolls

Home ───────────────────────────────────
g       job: go to its herdr tab
1-4 d   job: answer its open question
X       job: stop it (y confirms)
v       inspect: details and files
a       show / hide older cards
> <     next / previous card that needs
        you

Project ────────────────────────────────
[ ]     previous / next project
Space   mark a to-try row
y n     accept / flag the marked rows,
        or the current one
t       Progress: only what is to try

Control ────────────────────────────────
c C     role: next / previous preset
p       role: choose a preset by name
N I     role: new draft, copied or empty
R D     role: rename / delete the preset
i Del   place: add / remove; harness:
        add back / off
K J     place: move up / down
m       place: choose its model
x       place: clear its exhausted mark
s       draft: save and select it
h       Roles / Harnesses
Space   harness: on / off
r       refresh the model lists
        Saved to $HUD_HOME/roles; the
        next job uses it. Project role
        files are read-only here.

Split ──────────────────────────────────
⏎ Esc   into the preview / back
PgUp Dn scroll the preview
= + -   list bigger / smaller

Marks ──────────────────────────────────
jobs    ◉ running  ? asking  ◷ stalled
        ✓ done  ✗ failed  − stopped
slices  ◐ working  ◆ blocked  ◇ to try
        ✓ accepted  ○ todo
answers ◆ differs from the default
        ◇ as proposed
places  ◉ next  ○ standby  ✗ exhausted
        ⊘ off  − not installed
dim     older rows; a shows them
lavender words are marked by the model

Backup skills ─────────────────────── 17
  (unchanged below)
```

**After, 40 columns, Chinese:**

```
‹ 帮助

通用 ───────────────────────────────────
← → Tab 切换页面（也可点击）
↑ ↓ j k 移动；PgUp PgDn 翻页
⏎       对当前行操作；底栏写明具体作用
o       在 $EDITOR 打开该行的文件
/       实时筛选行
Esc     返回；有筛选时先清空
,       设置
?       本页
b       模型文字 开 / 关
w       导出审阅看板（HTML）
f       改动
q       关闭面板
点击    选中；再点即 ⏎；滚轮滚动

首页 ───────────────────────────────────
g       任务：切到它的 herdr 标签页
1-4 d   任务：回答它的提问
X       任务：停止它（y 确认）
v       查看详情和文件
a       显示 / 收起较早的卡片
> <     下一个 / 上一个需要你的卡片

项目 ───────────────────────────────────
[ ]     上一个 / 下一个项目
Space   勾选待试用行
y n     验收 / 标记已勾选的行；没勾选
        则当前行
t       进度：只看待试用

控制 ───────────────────────────────────
c C     角色：下一个 / 上一个预设
p       角色：按名称选择预设
N I     角色：新草稿，复制当前链或空白
R D     角色：重命名 / 删除预设
i Del   位置：添加 / 移除；宿主：添加回
        / 停用
K J     位置：上移 / 下移
m       位置：选择模型
x       位置：清除耗尽标记
s       草稿：保存并选中
h       角色 / 宿主
Space   宿主：开 / 关
r       刷新模型列表
        写入 $HUD_HOME/roles，下一个任务
        即用；项目角色文件在此只读。

分栏 ───────────────────────────────────
⏎ Esc   进入预览 / 返回
PgUp Dn 滚动预览
= + -   列表变大 / 变小

图例 ───────────────────────────────────
任务    ◉ 运行中  ? 提问中  ◷ 停滞
        ✓ 完成  ✗ 失败  − 已停止
切片    ◐ 工作中  ◆ 受阻  ◇ 待试用
        ✓ 已验收  ○ 待办
答复    ◆ 与默认不同  ◇ 与建议一致
位置    ◉ 下一个  ○ 备用  ✗ 已耗尽
        ⊘ 已停用  − 未安装
暗色    较早的行，按 a 显示
紫色字是模型标出的关键词

备用技能 ──────────────────────────── 17
  （以下不变）
```

Backup skills starts at row 65 in English (today 76) and row 61 in Chinese (today 66) in Classic; the Split section adds five rows in Split.

At 80 columns and wider the two-column form stays: key sections on the left, Marks on the right, as today.

**Keys and mouse.** `?` opens at the current tab's section. Scrolling, Esc, `?` and Enter to close are unchanged.

**Visible features removed or changed.**
- The prose notes under the key table are gone (the facts are listed above).
- Help no longer always opens at its first row.
- The single mixed key list becomes sections; `┃ body of a card` leaves the legend (it marks nothing the owner must decode).

**Acceptance.**
- `tests/unit/panel-keys-rows.test.mjs` is changed to "each key once per section" and still fails when a key is listed twice in one section.
- Every key the decoder names appears in Help (a test walks the decoder's key names).
- From Control, `?` shows `Control ───` as the first section row; from Project, `Project ───`; from Home, `Everywhere ───`.
- Every row is at most the width at 40 columns in both languages; no description is cut.
- The skills list is byte-for-byte what it is today.

**Size.** M: `helpRows` rewritten as data (`work-view.ts`), one scroll anchor (`monitor-input.ts`), i18n entries, the keys test.

### Slice 4. EXP-FORM: EXP in the panel's form

**Goal.** EXP reads like Settings and Control, and choosing a value shows the choices.

**Changes.**
1. A blank row before each section rule (dropped first on a short panel, as elsewhere); rows indented two cells.
2. The profile row carries its own reading on the right; the separate `Last native bar seen` row goes. With a reading it says the time (`seen 11-20 10:12`), without one `bar not seen yet`.
3. A choice opens as a list of all options under a rule with the count; `›` is the cursor and `◉` the current value, as in the preset list.
4. The header says `This machine · all projects`, the phrase Harnesses uses.

**Before → after, 40 columns, English** (rendered):

```
 Home  Project  Control  EXP  models off
Local · all projects
Codex native status line ───────────────
Track native status line             off
.codex
Last native bar seen                   —
Codex setup / restore
pi subscription proxy ──────────────────
Codex profile                    Unbound
Auto-refresh                         off
Interval                          15 min
Proxy readings                       off
API grants ─────────────────────────────
anthropic-api         off · uncalibrated
openai-api            off · uncalibrated
```

```
 Home  Project  Control  EXP  models off
This machine · all projects

Codex native status line ───────────────
  Track native status line           off
  .codex                bar not seen yet
  Codex setup / restore

pi subscription proxy ──────────────────
  Codex profile                  Unbound
  Auto-refresh                       off
  Interval                        15 min
  Proxy readings                     off

API grants ─────────────────────────────
  anthropic-api       off · uncalibrated
  openai-api          off · uncalibrated
```

**Chinese, before and after** (the tab label loses `实验` in slice 6; shown here as it will be):

```
 首页  项目  控制  EXP 实验      模型 关
本机 · 所有项目
Codex 原生栏 ───────────────────────────
记录原生状态栏                        关
.codex
最近观察到原生栏                       —
Codex 接入／恢复
pi 订阅代理 ────────────────────────────
Codex 配置                        未绑定
自动刷新                              关
刷新间隔                         15 分钟
代理读数                              关
API 赠额 ───────────────────────────────
anthropic-api                关 · 未校准
openai-api                   关 · 未校准
```

```
 首页  项目  控制  EXP           模型 关
本机 · 所有项目

Codex 原生栏 ───────────────────────────
  记录原生状态栏                      关
  .codex                  尚未见到原生栏
  Codex 接入／恢复

pi 订阅代理 ────────────────────────────
  Codex 配置                      未绑定
  自动刷新                            关
  刷新间隔                       15 分钟
  代理读数                            关

API 赠额 ───────────────────────────────
  anthropic-api              关 · 未校准
  openai-api                 关 · 未校准
```

**The option sheet:**

```
before EN (one option shown at a time)
 Home  Project  Control  EXP  models off
Codex profile

1/2
Unbound

             ↑↓ pick  ⏎ save  esc cancel

after EN
 Home  Project  Control  EXP  models off
Codex profile ──────────────────────── 2
› ◉ Unbound
    .codex

                      ⏎ save  Esc cancel

after ZH
 首页  项目  控制  EXP           模型 关
Codex 配置 ─────────────────────────── 2
› ◉ 未绑定
    .codex

                        ⏎ 保存  Esc 取消
```

At 120 columns the rows are the same with the values at the right edge.

**Keys and mouse.** None changed. A click on an option selects it and a second click saves it, as rows do elsewhere.

**Visible features removed or changed.**
- The `Last native bar seen` row is merged into the profile row.
- The `1/2` position counter is replaced by the visible list.
- English header wording.

**Acceptance.**
- `tests/unit/exp-page.test.mjs` flows still pass (same keys, same saves).
- The option sheet shows every profile at once at 40 columns; long profile names are cut in the middle, never the mark.
- A 16-row panel still shows all three sections (blank rows give way first).

**Size.** S: `exp-view.ts` only, plus entries in `i18n.ts`.

### Slice 5. HARNESS-ROWS: exceptions only, whole controls

**Goal.** Harnesses shows what is wrong, not what is normal; no control label is cut. Starts after NO-DEFAULT-LABELS lands (same file).

**Changes.**
1. An enabled switch row shows its name; `not installed` and `not seen` stay, `installed` and `listed` go (decision D4). The selected row's Split preview still says `on · installed`.
2. Switch words are lower-case and short in English: `off`, `on`.
3. Classic role actions wrap before a label would be cut.
4. In Split, the Off fold's preview lists the off entries.

**Before → after, 40 columns, English** (rendered):

```
This machine · all projects
Runner ─────────────────────────────── 1
  ◉ pi                         installed

CLI agents ─────────────────────────── 3
  ◉ agy                        installed
  ◉ claude                     installed
  ◉ codex                  not installed

Browser tools ──────────────────────── 3
  ◉ jev-ask  chatgpt gemini    installed
  ◉ jev-aistudio  argon    not installed
  ◉ jev-flow  flow         not installed

Pi providers ───────────────────────── 3
  ◉ anthropic                     listed
  ◉ openai                        listed
  ◉ synthetic                   not seen

▸ Off ──────────────────────────────── 2
```

```
This machine · all projects
Runner ─────────────────────────────── 1
  ◉ pi

CLI agents ─────────────────────────── 3
  ◉ agy
  ◉ claude
  ◉ codex                  not installed

Browser tools ──────────────────────── 3
  ◉ jev-ask  chatgpt gemini
  ◉ jev-aistudio  argon    not installed
  ◉ jev-flow  flow         not installed

Pi providers ───────────────────────── 3
  ◉ anthropic
  ◉ openai
  ◉ synthetic                   not seen

▸ Off ──────────────────────────────── 2
```

**Chinese:**

```
本机 · 所有项目
运行器 ─────────────────────────────── 1
  ◉ pi                            已安装

CLI 代理 ───────────────────────────── 3
  ◉ agy                           已安装
  ◉ claude                        已安装
  ◉ codex                         未安装

浏览器工具 ─────────────────────────── 3
  ◉ jev-ask  chatgpt gemini       已安装
  ◉ jev-aistudio  argon           未安装
  ◉ jev-flow  flow                未安装

pi 提供方 ──────────────────────────── 3
  ◉ anthropic                     已列出
  ◉ openai                        已列出
  ◉ synthetic                       未见

▸ 已停用 ───────────────────────────── 2
```

```
本机 · 所有项目
运行器 ─────────────────────────────── 1
  ◉ pi

CLI 代理 ───────────────────────────── 3
  ◉ agy
  ◉ claude
  ◉ codex                         未安装

浏览器工具 ─────────────────────────── 3
  ◉ jev-ask  chatgpt gemini
  ◉ jev-aistudio  argon           未安装
  ◉ jev-flow  flow                未安装

pi 提供方 ──────────────────────────── 3
  ◉ anthropic
  ◉ openai
  ◉ synthetic                       未见

▸ 已停用 ───────────────────────────── 2
```

**Smaller rows:**

```
Classic role actions, ZH (a control label is cut today)
before  |  预设  复制预设  空白预设  重命名  删…|
after   |  预设  复制预设  空白预设  重命名      |
        |  删除                                  |

Switch words, EN (ZH already says 已停用 / 已启用)
before  |      pi:xai Switched off               |
after   |      pi:xai off                        |
before  |      Switched off · pi:xai             |
after   |      off · pi:xai                      |
before  |state     Switched on · installed       |
after   |state     on · installed                |

Split, cursor on the Off fold (empty preview today)
before  |Off ────────────────────────────────────|
after   |Off ────────────────────────────────── 2|
        |  ⊘ cli:grok               not installed|
        |  ⊘ pi:xai                              |
```

**Keys and mouse.** None.

**Visible features removed or changed.**
- `installed` and `listed` no longer appear on enabled rows in the list.
- `Switched off` / `Switched on` read `off` / `on` in English.

**Acceptance.**
- At 40 columns in Chinese no action label ends in `…` (Classic, cursor on a role with a named preset).
- A missing executable and an unseen provider still say so on the row.
- `tests/unit/control-tab.test.mjs` passes with the new words.

**Size.** S: `harness-page.ts`, three strings and `roleActions` in `control-page.ts`.

### Slice 6. TOP-ROW: top row, Esc and words

**Goal.** The last words that say nothing, and one Esc.

**Changes.**
1. The top row shows `models off` only when model text is off (decision D4). `b` and Settings → Models still switch it; the word is still a click target while it shows.
2. The EXP tab is `EXP`, without `exp` / `实验`.
3. Esc at the root of a main tab does nothing on every tab (today Control and EXP jump to Home). `q` closes. `docs/reference.md:718` is corrected to match.
4. Home's native lane says `subagents` / `子代理` in place of `native` / `原生会话`.
5. Chinese minutes are `分` (decision D3).

**Before → after, 40 columns.**

```
Top row, model text on (the word stays when it is off)
before EN  | Home ?1  Project ?2  Control  models on|
after  EN  | Home ?1  Project ?2  Control           |
before ZH  | 首页 ?1  项目 ?2  控制          模型 开|
after  ZH  | 首页 ?1  项目 ?2  控制                 |
Top row with EXP
before ZH  | 首页 ?1  项目  控制  EXP 实验   模型 开|
after  ZH  | 首页 ?1  项目  控制  EXP               |
Home (Split), the native lane
before EN  |◉ this session native          1 running|
after  EN  |◉ this session subagents       1 running|
before ZH  |◉ 本次会话     原生会话         1 运行中|
after  ZH  |◉ 本次会话     子代理           1 运行中|
Chinese minutes (decision D3)
before ZH  |? NATIVE-TREE  imp          提问中 0分钟|
after  ZH  |? NATIVE-TREE  imp            提问中 0分|
before ZH  |✗ EXPORT-CSV   sonic          失败 9分钟|
after  ZH  |✗ EXPORT-CSV   sonic            失败 9分|
before ZH  |◉ M4-PROJECT   实现           imp 20分钟|
after  ZH  |◉ M4-PROJECT   实现             imp 20分|
before ZH  |      pi/openai 已耗尽 42分钟           |
after  ZH  |      pi/openai 已耗尽 42分             |
```

```
Top row with EXP, 120 columns
before EN  | Home  Project  Control  EXP exp                                                                              models off|
after  EN  | Home  Project  Control  EXP                                                                                  models off|
```

**Keys and mouse.** Esc on the Control and EXP roots no longer switches to Home. Clicking `models on` to turn model text off is gone, because the word is gone; clicking `models off` to turn it on stays.

**Visible features removed or changed.**
- `models on` in the top row.
- The `exp` / `实验` tag after EXP.
- Esc as a way from Control or EXP to Home.
- `分钟` becomes `分` wherever an age or a duration is shown in Chinese (Settings values included; sentences such as help text keep `分钟`).

**Acceptance.**
- With model text on, the top row has no models word at 40, 80 and 120 columns; with it off, `models off` shows wherever it fits today.
- Esc on each of the four tab roots leaves the tab and the cursor where they were.
- A Chinese Home row that cut its title only for the unit shows two more cells of title.

**Size.** S: `work-view.ts` (top row), `workboard-input.ts` (two lines), `split-home.ts`, `work-lanes.ts`, i18n entries.

## 4. Owner decisions

Only these four change what the owner sees in a way taste decides.

**D1. Footers stop listing movement and global keys, and Home's count shortens under 56 columns** (slice 1). Recommended: yes. At 40 columns a footer holds three or four hints; today one of them is `↑↓ move`. Alternative: keep `✓ N done today` whole and accept one hint fewer on Home.

**D2. Split Progress rows show the slice's text, cut, in place of the state word** (slice 2, change 4). Recommended: yes. `docs/spec.md` §2.2 says what the owner tries is never cut to a name; the whole text stays in the preview directly below, which is how briefed rows already work, so I read this as inside the spec. If the owner reads the sentence more strictly, drop change 4 and keep the rest of the slice.

**D3. Chinese minutes: `分` in place of `分钟`** (slice 6). Recommended: yes. It matches the compound form the panel already uses (`1小时5分`) and gives Chinese rows two cells back.

**D4. The normal state is silent: no `models on` in the top row, no `installed` / `listed` on enabled harness rows** (slices 5 and 6). Recommended: yes, as the same taste as dropping `default`. The cost is one click target (turning model text off by mouse).

## 5. Notes for the parallel job (one line each, no slice here)

- Control role detail: the next place is said three times (`→ target` on the role row, `next job`, the `◉` chain row, then `model` and `thinking` rows) and a hint row repeats the footer (`src/render/control-page.ts:104-110`).
- At 40 columns a place with a long model name shows no thinking at all (`split-frames.json :: control-40-en` row 26: the fixture's `xhigh` is not on the row).
- Picker: `1 matches` (no singular), `Enter sets it` beside `⏎ set`; its footer should follow slice 1's order without `? help`, since typing owns `?`.
- Bars: Claude and Codex show a quota window as percent used with no word (`5h 62%`), the pi proxy as percent left (`≈72%`, `left 72%`; `src/harness/pi/subscription.ts:184`): one direction or a word.

## 6. Considered, not proposed

- **The bars.** Three accepted passes (BAR-NARROW, BAR-FIDELITY, BAR-NOTICE) cover width fitting and notices; apart from the quota note above I found nothing clearly worth changing in `tests/fixtures/bar-widths.json`. I did not look at the Codex native row in a live Codex.
- **Changes (`f`) and Project › Working tree** both show git state. Merging them deletes a visible page for a small gain; not worth a slice now.
- **Settings.** Folding rarely used rows is already an M5 candidate (`docs/spec.md` §5). For that slice: `Calls this hour`, `Decision calls this hour` and `Test API  press t` are readings and an action among settings.
- **Re-drawing marks** so that `◉ ◆ ◇` mean one thing each would touch every page and the settled samples. The legend in slice 3 is the cheap answer.
- **Split Home's middle column** (role, phase or job count by row) is a deliberate PANEL-UX-02 choice; left alone.

Optional hardening, not part of the recommendation:
- With theme `none` or `NO_COLOR`, the active tab and the cursor row on Home, Split lists and EXP have no mark (rendered rows carry no escape and no glyph; Settings uses `*`). A `›` cursor and a bracketed active tab in that theme only would fix it. Cost: S, plus the no-colour snapshots.

## 7. Open questions and assumptions

- Assumed the owner's panel is 40 columns wide and in the Split layout (spec §2.2 and STATE say he kept Split; the default is Classic). Slices 1, 3, 4, 5 and 6 apply to both layouts; slice 2 is mostly Split.
- Assumed NO-DEFAULT-LABELS lands as its worktree shows (`../MyHUD-wt/no-default-labels`: no `[Custom]` tag, muted effective values). My frames were rendered from the main checkout, so role rows in them still show `[Custom]`; no slice here depends on it.
- The "after" rows were built by a script that checks cell widths (CJK as two cells); cut points of free text follow "cut at a word, then `…`" and the implementer's `cutWords` may differ by a word.
- Not verified: whether the slab's hint words are click targets (slice 2), and where, if anywhere, Esc closes a standalone panel (F8).

## 8. Files read and commands run

Read: `packages/hud-mcp/instructions/oracle.md`, the job brief, `docs/spec.md`, `docs/ARCHITECTURE.md` §6-§11, `docs/reference.md` (Home to Configuration), `docs/handoff/STATE.md`, `docs/design/control-tab/design.md`, `docs/design/panel-ux/screens.txt`; `tests/fixtures/{split,project,kept-pages}-frames.json`, `bar-widths.json`, `bar-widths.ts`, `kept-pages.mjs`, `project-page.mjs`; `src/render/{work-view,workboard-rows,job-actions,split-home,control-page,exp-view,harness-page,main-tabs,monitor-input,workboard-input}.ts` (the parts cited), `src/render/layout/bar-fields.ts:245-275`. Not read in full: `docs/design/hud-information-design.md`, `docs/design/model-picker/` (left to the parallel job).

Commands (all read-only; renders ran through `tmp/env.sh` with temporary HOME, HUD_HOME and CODEX_HOME, scripts kept in the session scratchpad): `rg`, `sed -n`, `wc`, `ls`, `git log`, `git diff --stat` on the NO-DEFAULT-LABELS worktree; `node` scripts that dump fixture frames as text, render Classic Home, Inspector, Help, Changes, EXP, Harnesses, the chain focus and the place sheet at 40 columns from the existing fixtures and `dist/`, print raw escapes for theme `none`, send one Esc through `handleMonitorInput`, and time 300 renders per page. No build, no test run, no model call, no write outside the job directory and the scratchpad.
