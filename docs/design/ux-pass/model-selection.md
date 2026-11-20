# UX-PASS: model selection and pi footer quota — design to build from

Checkout `ef97a505` (universal-hud). Read-only; nothing in the repository was changed.
"Before" frames are fixtures. Control and picker "before" frames come from the in-flight
NO-DEFAULT-LABELS worktree (`../MyHUD-wt/no-default-labels`, uncommitted), as the brief says to treat it as done;
they may still shift slightly when it lands.

## 1. Direct answer

Build five slices. Four are needed, one is optional.

| # | Slice | What the owner gets | Pain |
|---|---|---|---|
| S1 | FOOTER-QUOTA | pi's quota drawn as Claude's: bar, threshold colour, reset; `≈` marks an estimate | 4 |
| S2 | QUICK-MODEL | `m` on a role row, pick, Enter: saved. 2 keys instead of 7 | 1 |
| S3 | PICKER-PANE | no pane zoom; the picker fills the panel body; one click sets; the cursor never leaves the screen | 3 |
| S4 | PICKER-ORDER | likely models on the first screen; typing gives one ranked flat list | 2 |
| S5 | PICKER-FLAT (optional) | CLI and AI Studio places use the same picker | 1 |

- **Order.** S1 runs in parallel with the rest. S2 → S3 → S4 → S5 are serial: they share files. S2–S5 start after NO-DEFAULT-LABELS lands (same files).
- **No file-format change.** The short path writes through the existing `preset-edit` `op: 'run'` writer.
- **No new data source, timer, poll or subprocess.** Everything comes from the Control snapshot and the EXP files the footer already reads.
- **Four owner decisions** (§5): drop the zoom, one click sets, footer percent means used, filtered results are flat.
- **Two spec sentences change** if decisions 1 and 2 are accepted (§5, wording proposed; not edited).

## 2. Diagnosis

### 2.1 The path is 7 keys or 7 clicks, and `m` does nothing where the owner stands

The owner lands on the role list. This is what it shows (fixture `preset-row-40-split-en`):

```
  ◉ imp [daily] → pi/xai
  ◉ reviewer → pi/mistral
...
imp ──────────────────────────── [daily]
next job  pi/xai
                                        
Chain ─────────────────────────────── 3
  1 ◉ pi/xai  [grok-4.7 ▾]         high
  2 ○ agy [gemini-4-hydrogen-high ▾]
  3 ○ claude  [claude-opus-5-5 ▾]  high
                                        
  click ▾ or press m to choose a model
model     xai/grok-4.7
thinking  high
source    yours · imp.json
 ↑↓ move  ⏎ chain  c C preset  p presets
```

- The role row does not name the model (`pi/xai`), so the list does not show what is to be changed.
- The preview says "press m", but `m` on a role row is not handled: the role-row branch of `src/render/workboard-input.ts:256-291` knows Enter, the preset keys and clicks only. `m` works only inside chain focus (`src/render/chain-input.ts:198-206`).
- The preview repeats one fact four times: `next job pi/xai`, chain row 1, `model xai/grok-4.7`, `thinking high`.

The keyboard path today, for the first place of the selected role:

| Key | What happens | Source |
|---|---|---|
| Enter | chain focus | `workboard-input.ts:278` |
| `m` | Edit-place sheet opens with its Model field, then the picker (and the zoom) | `chain-input.ts:198-206`, `136-141` |
| pick, Enter | the model fills the sheet; the sheet stays open on `model` | `chain-input.ts:115-121` |
| ↓ ↓ | to `done` | fields are target, model, thinking, done: `chain-input.ts:28-34` |
| Enter | the place goes into a "Not saved" draft | `chain-input.ts:124-134` |
| `s` | one write | `chain-input.ts:208-212` |

That is 7 keys plus the picking. `docs/reference.md:522-524` documents the same route.

The mouse path is also 7 clicks: role, `[model ▾]`, model, the same model again (`src/render/model-input.ts:125`), `done` twice (the first click only selects the field, `chain-input.ts:182-186`), `s save`.

### 2.2 The picker opens on a wall of folded headers, in alphabetical order

Fixture `pick-grouped-40-en` (40×24):

```
 Home ?1  Project ?2  Control  models on
demo-project ───────────────────────────
 Roles  Harnesses
Healthy ────────────────────────────── 5
  ◉ imp [daily] → pi/openai
  ◉ reviewer → pi/mistral
imp ───────────────── [daily] · place #1
Model ───────────────── pi · list 2h old
/ ▌                                   31
Pinned ─────────────────────────────── 1
› ◉ pi's model (gpt-6.1-sol)
      from pi settings
▸ anthropic ────────────────────────── 7
▸ arena ────────────────────────────── 9
▸ google ───────────────────────────── 1
▸ mistral ──────────────────────────── 3
▸ new-provider ─────────────────────── 1
▸ openai ───────────────────────────── 7
▸ xai ──────────────────────────────── 3
Selected ───────────────────────────────
  openai/gpt-6.1-sol
  272K ctx  128K out  think ✓  img ✓
  ◉ current · imp [daily] place #1
  ↑↓ pick  ⏎ set  esc cancel  ^R refresh
```

- **Nothing to pick on the first screen.** At 40 columns every group starts folded (`model-input.ts:75`: open only when wide or filtering). One row is selectable.
- **The keyboard cannot open a group.** Headers are off the cursor path and fold only on a click (`model-input.ts:130-137`). A keyboard user must type.
- **Providers are alphabetical** (`model-input.ts:81`), so `anthropic` and the 38-model `arena` (settled sample, frame 2a) sit above the providers the roles use. Zoomed, all groups start open: about 88 rows in that order.
- **The filter is one substring** over `provider/model` (`model-input.ts:68`). `gpt mini` matches nothing. Results keep provider headers in alphabetical order, so `grok` lists arena's copies above xai's (fixture `pick-filter-40-en`).
- **14 of 24 rows are not the list:** three frame rows, three role rows, two rules, the query, a four-row strip and the hints. The strip's `◉ current · imp [daily] place #1` repeats the rule above it; `Enter sets it · not the current model` (fixture `pick-filter-40-en`) repeats the footer.

### 2.3 Zoom and mouse

- **The picker draws twice on open.** `open()` asks herdr asynchronously with a 1000 ms budget (`src/cli/model-picker-zoom.ts:12,20-33`). The wide layout is painted only once the reply sets the flag (`src/render/work-view.ts:147`). So: narrow picker, then the pane resizes, then the two-column picker. Closing resizes again (`src/tree-page.ts:1306-1307`). The zoom also covers the main session pane.
- **Two clicks to set** (`model-input.ts:125-127`).
- **The wheel moves the window but not the cursor** (`model-input.ts:112-116`). Enter then sets a row that may be off-screen (`model-input.ts:149`). The next arrow key drops the scroll and re-centres (`model-input.ts:148`).
- **Every ↑↓ re-centres the window on the cursor** (`src/render/control-view.ts:86-91`), so all rows move on every key once past the middle.
- PgUp/PgDn move 5 rows whatever the height (`model-input.ts:145`).

I did not watch the zoom live; the two redraws are read from the code, not observed.

### 2.4 The pi footer quota is a text field

`src/harness/pi/subscription.ts:176-186` returns strings (`5h left 89%`, `7d ≈57%`). `src/harness/pi/p10k-footer.ts:612-617` passes them as the bar's text form, which has no bar, no level colour and no reset (`src/render/layout/bar-fields.ts:246-251`). Claude's windows form has all three (`bar-fields.ts:252-270`).

Rendered with the built renderer, same facts, `line` style:

```
120  ◎ gpt-6.1-sol high │ ███████░░░ 72%/200K │ example synthetic-main +1 *1 ?1 │ 5h left 89% · 7d ≈57%       MCP 2  skills 3
 80  ◎ gpt-6.1-sol high │ 72%/200K │ example synthetic-main +1 *1 ?1 │ 5h left 89%
 36  ◎ gpt-6.1-sol │ 72% │ 5h left 89%
```

Claude's statusline, fixture `bar-widths.json` (120, quiet):

```
✻ opus-5.5 high │ ████░░░░░░ 41%/1M │ example wt/BAR-NARROW*↑2 │ 5h ██████░░░░ 62% (1h19m) │ ~42.7 t/s
```

Three further differences:

- **Opposite meaning.** Claude's number is percent used (`src/statusline-parity/render.ts:38-42`); pi's is percent left.
- **The narrow form keeps the wrong window.** `shortText` is the first window, the shortest (`p10k-footer.ts:616`), not the tightest. Above, it keeps 5h (89% left) and drops 7d (57% left).
- **States are words:** `refresh pending`, ` · stale` (`subscription.ts:181-184`).

## 3. Principles

1. **Change it where you see it.** A row that shows a model changes that model with `m`. Nothing has to be entered first.
2. **A single choice saves at once; a structure is a draft.** Picking a model is one decision. Adding, moving and removing places stay a draft that `s` saves.
3. **Likely first, the rest by typing.** The first screen holds the current model, this role's preset models and the providers the roles use. Everything else is one row or a few letters away.
4. **The picker is a menu.** It opens in place at once, one click or Enter chooses, Esc leaves, and the cursor is always on screen.
5. **One quota grammar on every bar.** Label, bar, number in the level colour, reset. A mark carries certainty; no word does.
6. **Rows are for content.** A heading, sentence or count that repeats what the frame already shows is removed.

## 4. Slices

Checks for every slice run from the slice's worktree through `tmp/env.sh` (temp HOME, HUD_HOME, CODEX_HOME): `npm run build && npm run build:test`, the named tests, `npm run snapshots:update` for intended changes only, `npm run check:fixtures`. Data is synthetic. Reference EN and ZH and Help are updated where they quote changed rows or keys.

### S1 · FOOTER-QUOTA

**Goal.** pi's subscription windows and API grant use Claude's quota segment: same cells, same thresholds, same place in the line.

**Grammar.**

- Window: `label bar number (reset)`. The number is percent used.
- The tightest window comes first and owns the bar and the reset. The other window follows after two spaces as label and number only.
- API grant: `API bar ≈$left (days)`. The bar is the share of the grant spent; the number stays dollars left, as today.
- Cells and colours are Claude's: ten cells `█`/`░`, blue below 75, magenta from 75, red from 90 (`bar-fields.ts:24,166,169-176`).

**Marks, no words.**

| Reading | Shown | Today |
|---|---|---|
| measured on this session's own responses | `11%` | `left 89%` |
| proxy or ledger estimate | `≈43%`, `≈$12.34` | `≈57%`, `≈$12.34` |
| stale (older than twice the refresh interval, `src/exp-proxy.ts:63`) | `≈43%?`, dim, no level colour | `≈57% · stale` |
| reset time passed, no new reading yet | `↻` in place of the number, dim, no bar cells | `refresh pending` |
| grant not calibrated | `API uncalibrated` (unchanged) | same |

**Exact strings.** Rendered by a scratch copy of the built `bar-fields.js` with the change below, `line` style. Facts: 5h measured 11% used, resets in 3h12m; 7d proxy 43% used, resets in 2d4h.

```
before 120  ◎ gpt-6.1-sol high │ ███████░░░ 72%/200K │ example synthetic-main +1 *1 ?1 │ 5h left 89% · 7d ≈57%       MCP 2  skills 3
after  120  ◎ gpt-6.1-sol high │ ███████░░░ 72%/200K │ example synthetic-main +1 *1 ?1 │ 7d ████░░░░░░ ≈43% (2d4h)  5h 11%

before  80  ◎ gpt-6.1-sol high │ 72%/200K │ example synthetic-main +1 *1 ?1 │ 5h left 89%
after   80  ◎ gpt-6.1-sol high │ 72%/200K │ example synthetic-main +1 *1 ?1 │ 7d ≈43%

before  36  ◎ gpt-6.1-sol │ 72% │ 5h left 89%
after   36  ◎ gpt-6.1-sol │ 72%/200K │ 7d ≈43%
```

5h at 92% (red), 41 minutes to reset:

```
after  120  ◎ gpt-6.1-sol high │ ███████░░░ 72%/200K │ example synthetic-main +1 *1 ?1 │ 5h █████████░ 92% (41m)  7d ≈43%
after   80  ◎ gpt-6.1-sol high │ 72%/200K │ example synthetic-main +1 *1 ?1 │ 5h 92%
after   36  ◎ gpt-6.1-sol │ 72%/200K │ 5h 92%
```

Stale, and 5h reset pending:

```
after  120  … │ 7d ████░░░░░░ ≈43%?  5h ≈11%?
after  120  … │ 7d ████░░░░░░ ≈43% (2d4h)  5h ↻
after   36  ◎ gpt-6.1-sol │ 72%/200K │ 7d ≈43%?
```

API grant, 75% spent, 12 days to renewal; then 96% spent:

```
before 120  ◎ gpt-6.1-sol high │ ███████░░░ 72%/200K │ example synthetic-main +1 *1 ?1 │ API ≈$12.34         lens ✓  MCP 2  skills 3
after  120  ◎ gpt-6.1-sol high │ ███████░░░ 72%/200K │ example synthetic-main +1 *1 ?1 │ API ████████░░ ≈$12.34 (12d)
after   80  ◎ gpt-6.1-sol high │ 72%/200K │ example synthetic-main +1 *1 ?1 │ API ≈$12.34
after   36  ◎ gpt-6.1-sol │ 72% │ API ≈$12.34
after  120  … │ API ██████████ ≈$2.05 (3d)
```

The other looks follow with no extra work, because they already draw the windows form. From the same prototype at 120:

```
p10k      ◎ gpt-6.1-sol high  72%/200K  example synthetic-main +1 *1 ?1  7d ≈43% (2d4h)  5h 11%     lens ✓  MCP 2  skills 3
micro    ◎ gpt-6.1-sol high  ⋔ example synthetic-main +1 *1 ?1  ███████▎░░ 72%/200K  7d ████▎░░░░░ ≈43% ↻2d4h  5h 11%
stacked  ◎ gpt-6.1-sol   ctx 72%           example                   7d ≈43%  5h 11%                             lens ✓  MCP 2
           high          ━━━━━━━─── 200K   synthetic-main +1 *1 ?1   ━━━━╸───── (2d4h)                                   skills 3
```

A pending window has no reading, so it draws no bar and is never the leading window while the other one has a reading (`docs/ARCHITECTURE.md` §8: no fabricated zero).

**How it narrows.** The existing ladder is not changed (`bar-fields.ts:891-907`). The segment keeps three forms:

1. bar, reset, and the other window;
2. reset and the other window (the bars of context and quota go together);
3. the tightest window's number.

Then the footer's own rule still drops the project, then the context, before the quota (`p10k-footer.ts:622-631`).

**Build notes.**

- `bar-fields.ts:246-270`: a window may carry `shown` (text in place of `N%`) and `quiet` (dim, no level colour); the quota may ask for the other windows as trailing numbers in forms 1 and 2. About 15 lines. Claude and Codex pass none of these.
- `subscription.ts:155-187`: `draw()` returns windows (label, used percent, reset from `resetsAt`, measured or estimate, stale, pending) instead of strings.
- `p10k-footer.ts:537-553,611-617`: pass windows. For the API grant, the spent share needs the grant amount, which `readExpGrantBalance` has in hand (`src/collectors/exp-store.ts:158-163`); the cycle end is `ExpBalance.endDate` (`src/exp-config.ts:15-23`).
- The reset text changes only when the footer redraws anyway. No timer.

**Visible changes and removals.**

- The number flips from percent left to percent used (decision 3). The word `left` goes.
- The ` · ` between windows goes; the tightest window leads instead of the 5h window.
- `refresh pending` becomes `↻`; ` · stale` becomes `?` and dim ink.
- At narrow widths the kept window is the tightest, not the shortest.
- The API reading gains a bar and the days to renewal.
- The segment is wider, so the loaded counts (`lens ✓  MCP 2  skills 3`) give way earlier: at 120 with a long branch they are gone (rows above).

**Acceptance.**

- `bar-widths.json` and `bar-themes.json`: every claude and codex row is byte-identical.
- `pi-footer.test.ts`, `exp-proxy.test.mjs`: measured without `≈`; proxy with `≈`; stale; pending; the narrow form keeps the tightest; API with bar; uncalibrated stays text.
- New pi rows in the bar fixtures at 144, 120, 80 and 36 match the strings above.
- Theme `none`: no ANSI, and `≈`, `?`, `↻` still tell the states.
- No `setInterval` or `setTimeout` added; `draw()` still only enqueues I/O.

**Size.** About 120–170 source lines plus fixtures. Files: `bar-fields.ts`, `subscription.ts`, `p10k-footer.ts`, `exp-store.ts`. Shares no file with S2–S5 except the reference docs.

### S2 · QUICK-MODEL

**Goal.** Change a role's model from the role row in 2 keys, with no chain focus, sheet, draft or `s`.

**Rules.**

1. `m` works on a role row (Roles list, Split and Classic), on a place in chain focus and on a draft place. A click on `[model ▾]` is `m` on that place.
2. On a role row, `m` targets the place the row shows: the `◉` place, or place 1 when none can run. A Flow place takes no model: no hint, no action.
3. **No draft open: the pick is saved at once.** One `preset-edit` with `op: 'run'`, the chain in force with only that place's `model` changed, and the role's `revision`. This is the write `s` does today (`chain-input.ts:208-212`, `src/tree-page.ts:1404-1418`, `src/roles/roster.ts:735-788`), so validation, the owner-layer rule and the atomic 0600 write are unchanged. The change lands in the chain in force: the selected named preset, else the file chain.
4. **Draft open: the pick fills the draft place.** `s` still saves the whole draft.
5. `m` never opens the Edit-place sheet. A pi place opens the picker. A CLI or AI Studio place opens the existing inline model list directly, and its Enter follows rule 3 or 4.
6. The sheet opened with Enter on a place is unchanged, its Model field included.
7. After a save the cursor stays where `m` was pressed: the role row, or the same place in chain focus. Today a save always leaves the chain (`tree-page.ts:1408`).
8. A refused write (role changed on disk, validation) writes nothing and shows the existing notice.
9. Project-pinned roles are unchanged: no `m`.

**Role row.** The destination names the model when it fits whole, else it stays as today:

- pi: `provider/model`, else `pi/provider`;
- CLI: `agent model`, else `agent`;
- browser: unchanged.

The model is dropped before anything is cut (`docs/ARCHITECTURE.md` §8). An unset model follows NO-DEFAULT-LABELS (the effective model, muted, when known).

**Preview** (Split, and Classic's expansion; `src/render/control-page.ts:79-114`). It opens on the chain. Four rows go: `next job`, the sentence `click ▾ or press m to choose a model`, `model`, `thinking`. The `◉` row already says all four.

**Before → after, 40 columns EN.** Rows that change, in frame order. `reviewer`'s model is illustrative; the fixture frame does not show it.

```
before                                    after
  ◉ imp [daily] → pi/xai                    ◉ imp [daily] → xai/grok-4.7
  ◉ reviewer → pi/mistral                   ◉ reviewer → mistral/mistral-small-4
imp ──────────────────────────── [daily]  imp ──────────────────────────── [daily]
next job  pi/xai                          Chain ──────────────────────────────── 3
                                            1 ◉ pi/xai  [grok-4.7 ▾]          high
Chain ─────────────────────────────── 3     2 ○ agy [gemini-4-hydrogen-high ▾]
  1 ◉ pi/xai  [grok-4.7 ▾]         high     3 ○ claude  [claude-opus-5-5 ▾]   high
  2 ○ agy [gemini-4-hydrogen-high ▾]      source    yours · imp.json
  3 ○ claude  [claude-opus-5-5 ▾]  high
                                        
  click ▾ or press m to choose a model
model     xai/grok-4.7
thinking  high
source    yours · imp.json
 ↑↓ move  ⏎ chain  c C preset  p presets     m model  ↑↓ move  ⏎ chain  c C preset
```

**40 columns ZH, after.**

```
  ◉ imp [daily] → xai/grok-4.7
  ◉ reviewer → mistral/mistral-small-4
imp ──────────────────────────── [daily]
备选链 ─────────────────────────────── 3
  1 ◉ pi/xai  [grok-4.7 ▾]          high
  2 ○ agy [gemini-4-hydrogen-high ▾]
  3 ○ claude  [claude-opus-5-5 ▾]   high
来源      用户 · imp.json
     m 模型  ↑↓ 移动  ⏎ 备选链  c C 预设
```

**After a pick.** The notice slot (`control-page.ts:43-45`) and the row:

```
EN  ✓ imp #1 → xai/grok-4.7-fast
      ◉ imp [daily] → xai/grok-4.7-fast
ZH  ✓ imp 第 1 位 → xai/grok-4.7-fast
      ◉ imp [daily] → xai/grok-4.7-fast
```

**120 columns.** Same rows; the model always fits whole, so no role row falls back to `pi/provider`.

**Keys and mouse.**

| Act | Today | After S2 | After S3 |
|---|---|---|---|
| keyboard, first place | Enter, `m`, pick, Enter, ↓, ↓, Enter, `s` | `m`, pick, Enter | same |
| keyboard, place 2 | the same after one ↓ | Enter, ↓, `m`, pick, Enter | same |
| mouse (Split) | 7 clicks | role, `[model ▾]`, model, model | role, `[model ▾]`, model |

**Visible changes and removals.**

- A model change no longer passes through Edit place, Done and `s`.
- A model change alone never shows "Not saved", so Esc can no longer discard it: it is already saved.
- The role row names the model.
- The preview loses the four rows above.
- Role-row hints start with `m model`; at 40 columns `p presets` no longer fits in the Split footer (`p` still works; Classic's action row still lists Presets).

**Acceptance.**

- Role row, `m`, type, Enter: the role file's chain in force has the new model on that place; every other place, preset and unknown field is preserved; `hud_roster` reports it. No draft appears, and Esc afterwards changes nothing.
- First place exhausted, `◉` on place 2: `m` on the role row changes place 2, and the notice says `#2`.
- With a draft open (after `i` or `K`): `m`, pick. The file is unchanged until `s`.
- A CLI place: `m` opens its inline list; Enter saves; the sheet never shows.
- Stale `revision`: no write, the existing notice.
- Project-pinned role: `m` does nothing.
- Frames exact at 40 columns EN and ZH, Split and Classic; 120 columns.
- Tests: role-control, role-presets, role-writes, model-picker, control-tab, split-layout, kept-pages, panel-keys.

**Size.** About 150–220 source lines. Files: `workboard-input.ts`, `chain-input.ts`, `control-page.ts`, `control-view.ts`, `model-input.ts` (`pickOf`), `work-view.ts` (it closes a picker that has no chain sheet, lines 144-146), `tree-page.ts`, the i18n tables, fixtures.

### S3 · PICKER-PANE

**Goal.** The picker opens at once in the panel's own pane and takes the whole panel body. One click sets. The cursor is always visible.

**Layout.**

- Never ask herdr for a zoom. `src/cli/model-picker-zoom.ts` and its call sites go (`tree-page.ts:672,720,751,888,1159,1306-1307,1479`).
- While the picker is open it owns every row below the tab line, in Split and Classic. Its title rule carries role, place, preset and harness.
- The two-column layout stays, chosen by width alone: 100 columns or more (`work-view.ts:147` loses the zoom flag). The owner's own herdr zoom therefore still gives it.

**Before → after, 40×24 EN.** Before is the frame in §2.2. After (list content is still today's; S4 changes it):

```
 Home ?1  Project ?2  Control  models on
imp #1 ──────────────────── [daily] · pi
/ ▌                                   31
Pinned ─────────────────────────────── 1
› ◉ pi's model (gpt-6.1-sol)
      from pi settings
▸ anthropic ────────────────────────── 7
▸ arena ────────────────────────────── 9
▸ google ───────────────────────────── 1
▸ mistral ──────────────────────────── 3
▸ new-provider ─────────────────────── 1
▸ openai ───────────────────────────── 7
▸ xai ──────────────────────────────── 3
                                        
                                        
                                        
                                        
                                        
                                        
Selected ───────────────────────────────
  openai/gpt-6.1-sol
  272K ctx  128K out  think ✓  img ✓
  ◉ current · imp [daily] place #1
  ↑↓ pick  ⏎ set  esc cancel  ^R refresh
```

The list gets 16 rows instead of 10.

**ZH, the rows that differ from today's ZH frame.**

```
 首页 ?1  项目 ?2  控制          模型 开
imp 第 1 位 ─────────────── [daily] · pi
/ ▌                                   31
```

**120 columns** (two-column layout, first and last row):

```
before   Model · imp [daily] place #1 · pi                                                     88 models · list 2h old · zoomed
after    Model · imp [daily] place #1 · pi                                                              88 models · list 2h old
before  … type to filter  ↑↓ pick  ⏎ set  click a header: fold  ^R refresh  esc close and restore
after   … type to filter  ↑↓ pick  ⏎ set  click a header: fold  ^R refresh  esc cancel
```

**Keys and mouse.**

| Input | Today | After |
|---|---|---|
| open | herdr zoom, two redraws | no herdr call, one frame |
| click a model | selects; a second click sets | sets (decision 2) |
| click a provider header | folds or unfolds | unchanged (S4 removes it) |
| click `esc cancel` in the footer | nothing | closes without setting |
| wheel | moves the window; the cursor can go off-screen | moves the window 3 rows; the cursor is kept inside it |
| ↑ ↓ | the window re-centres on every key | the window moves only when the cursor reaches its edge, keeping one row of context |
| PgUp PgDn | 5 rows | one window less one row |
| Enter, typing, Backspace, Esc (clear, then close), Ctrl+R, Ctrl+C | — | unchanged |

**Visible changes and removals.**

- The automatic zoom and its restore.
- The word `zoomed` in the wide title and the hint `esc close and restore`.
- While the picker is open in Split: the role list above it, the project rule and the Roles / Harnesses row.
- The rule `Model ── pi · list 2h old` at 40 columns. The harness moves to the title rule. The list's age is not shown while fresh; `List is stale` and `Refresh failed` stay (`control-view.ts:114-116`). The wide title keeps the age.
- Select with one click and set with a second.

**Acceptance.**

- Opening the picker runs no herdr command; the first painted frame is the final layout.
- The 40×24 frame above, exact, EN and ZH, Split and Classic.
- One click on a model row produces one `model-picked`; a click on an empty row or outside the list does nothing.
- Wheel down twice, then Enter: the row set is visible.
- ↓ repeated: the window's first row changes only when the cursor passes the last visible row.
- At 100 columns or more, outside herdr: the two-column layout paints.
- The panel's reload no longer waits on a zoom restore (`tree-page.ts:888`).
- Tests: model-picker, panel-keys, control-tab, split-layout; the zoom cases of `model-picker-zoom.test.mjs` go, its wide-layout cases stay.

**Size.** About 100 lines added, 90 removed. Files: `tree-page.ts`, `work-view.ts`, `model-input.ts`, `control-view.ts`, `control-page.ts`, `model-picker-view.ts`, `monitor.ts`. Same files as S2: run after it.

### S4 · PICKER-ORDER

**Goal.** The model wanted is on the first screen without a key, or is the first row after a few letters.

**Browse view (empty query), top to bottom.**

1. **Top block, no heading:**
   - the current model, `◉`;
   - the models this role's other presets use, tagged `[preset]` (today's rule, `model-input.ts:54-66`);
   - the model this place had before the last change in this panel session, tagged `was` / `原`. Memory only, no file: it is the way back after an immediate save;
   - the row that clears the model, when it is not the current one.
2. **Providers in use,** as open groups. A provider is in use when any pi place of any role or preset in the snapshot names it, or pi's own default does. The current model's provider comes first, then the others by number of uses, ties alphabetical. Headers are plain rules with a count: not selectable, not foldable. Models stay alphabetical.
3. **One selectable row for every other provider:** `▸ anthropic · arena · google ── 59`. Enter or a click opens them below as alphabetical groups (`▾`); again closes them. Names that do not fit end in `+N`. The row has no word, so EN and ZH are the same.
4. **Providers that are off:** `⊘ off: deepseek` / `⊘ 已停用：deepseek`. The word stays: a glyph needs its text (`docs/ARCHITECTURE.md` §8).

With no provider in use, every group is shown and row 3 is absent.

**Filtered view (any query).**

- The query splits at spaces. Every part must occur in `provider/model`, any case.
- Results are one flat list, each row the whole ID, no headers.
- Order: providers in use first; then parts that match at the start of a provider or model name, then after `/ - . _ :`, then inside a word; then alphabetical.
- The cursor starts on the first row. The count is the number of matches.

**Rows.**

- 40 columns: `› ◉ name`, the state (`✗ 42m`, `⊘`, `?`) and tags at the right, as today.
- The strip is one row of facts for the cursor row, with no heading. The whole ID wraps above it only when the row's ID was shortened.
- 100 columns or more: the left list takes the same order; its columns and the right pane are unchanged.

**Duplicate providers (arena).** Not collapsed: `docs/design/control-tab/design.md` §4 settled that the same model under two providers stays two rows. They stop being in the way instead. A provider no role uses sits behind row 3 and ranks last when filtering. One the owner never wants is one toggle in Harnesses, which already removes its rows.

**Before → after, 40×24 EN.** Synthetic set: 88 models; in use xai (imp), mistral (reviewer), openai (imp's `sol` preset and pi's default); not in use anthropic 9, arena 38, google 12; deepseek off. Before is the layout of §2.2 with these counts.

```
 Home ?1  Project ?2  Control  EXP
imp #1 ──────────────────── [daily] · pi
/ ▌                                   88
› ◉ xai/grok-4.7
    openai/gpt-6.1-sol       ✗ 42m [sol]
    xai/grok-4.6                     was
xai ────────────────────────────────── 6
    grok-4.5
    grok-4.6
  ◉ grok-4.7
    grok-4.7-code
    grok-4.7-fast
    grok-4.7-mini
mistral ────────────────────────────── 8
    codestral-3
    magistral-2
    mistral-large-4
    mistral-medium-4
    mistral-nemo-2
    mistral-small-4
    pixtral-3
    voxtral-2
256K ctx  64K out  think ✓  img ✓
  ↑↓ pick  ⏎ set  esc cancel  ^R refresh
```

The end of the same list, after scrolling:

```
openai ────────────────────────────── 15
    gpt-5.5
    …
    o5-pro
▸ anthropic · arena · google ──────── 59
⊘ off: deepseek
```

**ZH, the rows that differ.**

```
 首页 ?1  项目 ?2  控制  EXP     模型 开
imp 第 1 位 ─────────────── [daily] · pi
    openai/gpt-6.1-sol    ✗ 42分钟 [sol]
    xai/grok-4.6                      原
256K 上下文  64K 输出  思考 ✓  图片 ✓
      ↑↓ 选择  ⏎ 设为  esc 取消  ^R 刷新
```

**Filtered, before → after, EN.** Before is fixture `pick-filter-40-en` (`5 matches`, arena's group above xai's, a four-row strip).

```
before                                    after
/ grok▌                        5 matches  / grok▌                                8
▾ arena ────────────────────────────── 2  ›   xai/grok-4.5
    grok-4.6                                  xai/grok-4.6
    grok-4.7                                ◉ xai/grok-4.7
▾ xai ──────────────────────────────── 3      xai/grok-4.7-code
  ◉ grok-4.7                                  xai/grok-4.7-fast
›   grok-4.7-fast                             xai/grok-4.7-mini
    grok-4.7-mini                             arena/grok-4.6
                                              arena/grok-4.7
Selected ───────────────────────────────
  xai/grok-4.7-fast                       256K ctx  64K out  think ✓  img ✓
  2M ctx  32K out  think ✓  img ✓            ↑↓ pick  ⏎ set  esc clear  ^R refresh
  Enter sets it · not the current model
   ↑↓ pick  ⏎ set  esc clear  ^R refresh
```

Two parts:

```
/ gpt mini▌                            4
›   openai/gpt-5.5-mini
    openai/gpt-6-mini
    openai/gpt-6.1-mini
    openai/gpt-6.1-sol-mini
```

ZH filtered rows are the same; the strip and hints read `256K 上下文  64K 输出  思考 ✓  图片 ✓` and `↑↓ 选择  ⏎ 设为  esc 清除  ^R 刷新`.

**120 columns.** The left list in the order above, with today's columns; the last row is the hints:

```
before  … type to filter  ↑↓ pick  ⏎ set  click a header: fold  ^R refresh  esc cancel
after   … type to filter  ↑↓ pick  ⏎ set  ^R refresh  esc cancel
```

**Keys and mouse.** ↑↓ skip headers and visit the `▸` row; Enter or a click on it opens or closes the rest. A click on a header does nothing. Everything else is as S3 leaves it.

**Visible changes and removals.**

- Folding one provider by clicking its header, and every group folded on opening at 40 columns.
- Every group open on opening at 100 columns or more: providers not in use start behind the `▸` row there too.
- The `Pinned` heading and its count; the `Selected` heading.
- The strip lines `◉ current · imp [daily] place #1`, `Enter sets it · not the current model` and `✗ exhausted · resets in 42m` (the row's `✗ 42m` says it).
- The words `matches` / `个匹配`, and `, not listed` / `，不在列表` on the off line.
- Provider headers inside filtered results.
- Alphabetical provider order.

**Acceptance.**

- With the synthetic set, the 40×24 frame above, exact, EN and ZH: the current model, the preset models and the current provider's models are visible with no key pressed.
- anthropic, arena and google rows appear only after Enter on the `▸` row or by typing.
- `grok`: 8 rows, xai's six above arena's two. `GROK`: the same. `gpt mini`: the 4 rows above.
- A model of a provider not in use is found by typing, without opening anything.
- No match: `No matching models`; Enter writes nothing.
- A long ID: shortened in its row, whole in the strip.
- No provider in use: every group is listed and there is no `▸` row.
- `pickView` stays pure; typing runs no subprocess; discovery is unchanged.
- Tests: model-picker, control-tab, split-layout, kept-pages.

**Size.** About 200–260 source lines. Files: `model-input.ts`, `control-view.ts`, `model-picker-view.ts`, the i18n tables, fixtures. Same files as S3: run after it.

### S5 · PICKER-FLAT (optional)

**Goal.** One chooser for every place that takes a model.

- A CLI or AI Studio place opens the same picker as a flat list: no groups, no facts strip, the same keys, the same save rule.
- It replaces the inline list that `m` opens after S2. The Edit-place sheet keeps its own Model field.
- Before → after: the inline list under the sheet's Model row becomes the S4 frame without groups and strip.
- Removes: the inline list as the result of `m`.
- Acceptance: `m` on `oracle → claude` opens the picker; Enter saves; the catalog and discovered models are all listed.
- Size: about 60–90 lines. Files: `model-input.ts`, `chain-input.ts`.

Skip it if the short CLI lists feel fine in the inline list after S2.

## 5. Owner decisions

1. **Drop the automatic zoom.** Recommended: yes. The picker opens in place in one frame; the two-column layout remains for a pane that is 100 columns wide on its own or zoomed by hand. Keeping the zoom keeps both redraws.
   Spec sentence that changes (`docs/spec.md:13`): "the picker zooms the panel's herdr pane while open (narrow below about 100 columns or outside herdr)" → "the picker opens in the panel's own pane (two columns from about 100 columns wide)".
2. **One click on a model sets it.** Recommended: yes, the picker is a menu. The session-only `was` row and the notice are the way back. This departs from "a click selects …, a second click acts as Enter" (`docs/spec.md:28-29`) for picker rows only; that sentence would gain "; a click on a picker row sets it".
3. **The footer percent means used, as on Claude's statusline.** Recommended: yes. The bar then fills and reddens in the same direction on both bars. The alternative keeps percent left and makes the pi bar read opposite to Claude's.
4. **Filtered results are one flat ranked list.** Recommended: yes. The alternative keeps provider headers and orders the groups by the same ranking; the best row is then not always first. The browse view stays grouped either way, which I read as satisfying "grouped by provider in one list and filtered by typing" (`docs/spec.md:13`).

Also for the spec, if S2 is built: "a model change on one place saves at once; other chain edits stay a draft until saved".

## 6. Assumptions, guesses and open points

**Assumptions.**

- A quick model change edits the chain in force, so on `imp [daily]` it changes the preset `daily`. That is what `s` does today. The alternative, detaching to the file chain, would make the preset tag vanish after every change.
- The second quota window stays in the footer where it fits. Claude shows only the tightest (`bar-fields.ts:252-253`, owner 2026-11-11). Dropping pi's second window would be the simpler build (no renderer change beyond `shown` and `quiet`) but removes something EXP-03 shows today.
- S2's preview trim and role-row text touch the Control tab, which UX-PASS-OVERALL is also designing. Reconcile before dispatching S2.

**Guesses, not verified.**

- Real provider and model counts: I ran no discovery and read no real `~/.hud` data. S4's frames use a synthetic set.
- The two zoom redraws are read from the code, not seen.
- The mouse count of 7 is read from the handlers, not clicked through.
- `reviewer`'s model in S2's rows and all S4 model names are invented.
- `was` / `原` is a proposed word.
- S1's strings come from a scratch copy of the built renderer with the described change; the real change may differ by a column in edge cases.

**Hardening not asked for, with cost.**

- An undo key on the notice (`u` restores the previous model): about 40 lines and one more state field. The `was` row already covers it.
- Fuzzy (subsequence) matching: about 30 lines; short IDs then match surprising rows.
- A persisted recent-models file: one new file under `$HUD_HOME`; the owner settled against it (`.scratch/model-picker/spec.md:12`).
- Newest-version-first order inside a group: a name heuristic that breaks on IDs such as `gpt-oss-240b`.
- Tab inside the picker to step through the chain's places: about 30 lines; Enter, ↓, `m` already reaches place 2.

## 7. Files read and commands run

**Read.**

- `packages/hud-mcp/instructions/oracle.md`, the brief, `CLAUDE.md`.
- `docs/spec.md` (all), `docs/reference.md` (470–570, 900–990), `docs/handoff/STATE.md` (head, Next, working slices).
- `.scratch/model-picker/spec.md`, `docs/design/model-picker/index.html` (text of every frame and the To settle list), `docs/design/control-tab/design.md`.
- `src/render/model-input.ts`, `control-view.ts`, `model-picker-view.ts`, `chain-input.ts`, `control-page.ts`, `workboard-input.ts` (225–300), `work-view.ts` (135–150, 245–262), `monitor.ts` (types), `monitor-text.ts` (`squeeze`), `workboard-rows.ts` (`section`, `footHints`).
- `src/cli/model-picker-zoom.ts`, `src/tree-page.ts` (zoom sites, 1340–1470), `src/utils/workbench-input.ts` (key table).
- `src/roles/model-discovery.ts`, `role-control.ts` (285–410), `roster.ts` (`savePreset`).
- `src/harness/pi/subscription.ts`, `p10k-footer.ts` (460–650), `src/render/layout/bar-fields.ts` (all), `bar-modules.ts`, `src/statusline-parity/render.ts` (quota lines), `src/exp-proxy.ts` and `src/exp-config.ts` (helpers), `src/collectors/exp-store.ts` (balance).
- Fixtures: `bar-widths.json`, `bar-themes.json`, `project-frames.json` (Control, chain, picker, preset frames), `pi-footer.ts` (head), `claude-hud-parity/README.md`.
- In flight, read only: the NO-DEFAULT-LABELS brief and that worktree's `project-frames.json`.
- `docs/ARCHITECTURE.md` §8 (rules), section list only for the rest.
- Not read: `split-frames.json`.

**Commands, all read-only.** `wc`, `ls`, `grep`, `sed -n`, `git log`, `git status`, CodeGraph explore, and Python and Node scripts in the session scratchpad:

- fixture frames printed with ANSI stripped;
- `tmp/env.sh node` on the built `dist/render/layout/bar-fields.js` (temp homes) to render today's pi rows;
- the same on a scratchpad copy of that file with S1's change, for the "after" strings in every look;
- a width checker for the proposed 40- and 120-column frames (CJK counted as two cells).

No build, no test run, no model discovery, no write outside the report and the scratchpad.
