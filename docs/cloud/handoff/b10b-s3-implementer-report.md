# B10B-s3 implementer report

Saved by the orchestrator from the frontend implementer's text report (Sonnet xhigh).

- **Branch:** `cloud/b10b-s3`, from `cloud/b10b-s2` (92e638d).
- **Brief:** `docs/cloud/B10B-s3.md`, on `cloud/briefs-2`.
- **Rulings:** [`../rulings/b10b-s3.md`](../rulings/b10b-s3.md), batch 1. The implementer stopped once with seven questions; the rulings answer them and record the orchestrator's Q5 decision to widen file ownership.

**Status:** complete as ruled. No new design question. Section 4 lists the implementer's judgement calls.

## 1. Files

**Q5 plumbing (ownership widened by the orchestrator)**
- `src/utils/workbench-input.ts`: `n N L R` map to `next-trouble`, `previous-trouble`, `log`, `resume-reconcile`.
- `src/utils/panel-command.ts`: the four keys added to `PANEL_COMMANDS`, `MONITOR_KEYS` and `needsOpenPanel`.
- `bin/codex-hud-keys`: four `bind_command 0` lines (no `-r`).
- `bin/codex-hud-command`: the closed-panel `case` list.
- `docs/reference.md`, `docs/reference.zh.md`: three Keys rows.

**Render**
- New: `src/render/delegation/selection.ts` (destinations, `resolveSelection`, the stops for `n`/`N`).
- New: `src/render/delegation/actions.ts` (buttons per row, the typed actions).
- `rows.ts`: `parentKey` on rows, a plan index, `⊕N` keys, a plan memo with several entries.
- `cards.ts`: collapsed card head, sub-row items, the fold exemption, `overflowKeys`.
- `panel.ts`: `delegationView`, `delegationPutAway`.
- `facts.ts`: the comparator guard.
- Also edited: `monitor.ts`, `monitor-input.ts`, `control-bar.ts`, `agents-view.ts`, `i18n.ts`.

**Tests and fixtures**
- New suites: `tests/unit/b10b-s3-{facts,width,collapse,selection,keys,actions,bar,rich,input-keys,perf}.test.ts`.
- New fixtures: `tests/fixtures/b10b-s3.ts`, `tests/fixtures/b10b-big.ts`.
- Additive edits: `tests/fixtures/b10b-delegation.ts`, `tests/fixtures/visual-baselines.{ts,json}`.

Not touched: `src/tree-page.ts`, `src/core`, `src/collectors`, `packages`, contracts, the design doc.

## 2. Exported API and action types

**`MonitorOutcome.action`**
- `{type:'delegation-open', key}`
- `{type:'delegation-log', key}`
- `{type:'delegation-copy', key, descriptor}`: the view model's `ActionDescriptor` object as held. The panel builds no command.
- `{type:'delegation-diagnostic', key, text}`: the §5.5 sentence, in EN or ZH.
- The existing `{type:'switch', id}` is reused, with `id` = `identity.ref.sessionId` of a Codex native in the root's own native subtree (Q4).

**New exports**
- `selection.ts`: `destinationsOf`, `resolveSelection`, `stopsOf`, `stepStop`.
- `actions.ts`: `rowActions`, `selectedActions`, `openButtonAction`, `openKeyAction`, `logKeyAction`, `recoverAction`, `RESUME_DIAGNOSTIC`.
- `rows.ts`: `putKey`, `parsePutKey`, `foldKey`, `PlannedRow.parentKey`, `RowPlan.{index, away, putRows}`.
- `panel.ts`: `DelegationView`, `delegationView`, `delegationPutAway`.
- `cards.ts`: `overflowKeys`.
- `facts.ts`: `comparatorFor<T>`.
- `monitor.ts`: `MonitorState.delegating?: true`, `MonitorFrame.delegation`, `MonitorControl.kind += 'delegation-open' | 'delegation-recover'`, `MonitorControl.disabled`, `MonitorRow.of`, `reconcileMonitor(..., delegation?)`, `rowButtons`.
- `control-bar.ts`: `BarInput.buttons`, `RowButtons`.

**Keys**
- `o` → Open or Switch only.
- `L` → Log only.
- `R` → Reconcile or Resume.
- Enter, Space and `v` stay the Inspector's keys and emit nothing.
- A key acts exactly when its button is drawn, and does what a click on that button does.

## 3. Rulings used

All of Q1–Q7, Enter, and defaults 1, 2, 4, 5, 6, 8 and 9, as written in the rulings file.

`⊕N` rows are keyed `put:<place>:<parentKey>`. They are identified by their parent and rewritten when they move.

## 4. Implementation decisions, for review

1. **Button words.** Words are kept at every level except `none`, not only through `named`/`all`.
   - Through `all`, the stacked bar never shows a word at 48 columns. That contradicts §4.9's `⇢ Log` sample and ruling default 3's note that §4.13's bare `⇢` is a sample amendment.
   - Result: words at 80, 56 and 48 columns; a bare `⇢` at 40 and 32. At 48, with both buttons and a long older word, the words go too (`e-reconcile/48x12`).
   - One predicate in `hasWord` (`control-bar.ts`) reverts it.
2. **`f` (filter)** is a no-op in the delegation view.
3. **Reconcile** shows for any row with a descriptor, the root included (the root has no `⇢`).
4. **`o`, `L`, `R`** act under the bar's condition: focus on Agents, or the Inspector on the agent.
5. **Missing conflict rows.** A conflict claim with no row (`omittedConflicts`) is represented by its parent as a stop.
6. **Performance gates.** The gates measure segment 2's painter plus the selection. Whole-`renderMonitor` ticks are printed, not gated.

## 5. `src/tree-page.ts` dispatcher the owner must add

| Action | Status | What the dispatcher must do |
|---|---|---|
| `switch` | exists: today's `switchSession(id)` | gap: `uniquePickerLabel(tree, id)` (line 1201) reads the empty legacy tree, so natives get no narrow-pane label |
| `delegation-open` | missing | focus `host.currentState` via Herdr or tmux; re-check the gate on the current view model at dispatch; refuse rather than pick another node |
| `delegation-log` | missing | tail `~/.hud/runs/<runId>/…` in a pane when the host is controllable; otherwise show the path |
| `delegation-copy` | missing | copy `descriptor.displayCommand` verbatim; show `✓ Copied` for two seconds |
| `delegation-diagnostic` | missing | `navigationMessage = text` until the Inspector exists |

Also for the owner:
- **Optional:** pass the view model to the three `reconcileMonitor` calls (lines 1016, 1105, 1134). The `delegating` flag can then go.
- **Activity hub:** its `target` action walks the legacy tree (~1350–1370).
- **New key bindings:** a running tmux session picks them up when `bin/codex-hud-keys` runs at panel start. A pane started before the build needs a restart.

## 6. Frames

`test:visual`: 331 tests over 321 frames.

Against segment 2: 309 → 321 frames. 12 added, 6 changed, 0 removed. The 282 legacy frames and the 21 unchanged segment-2 frames are byte-identical.

**Changed**

| Frames | Change |
|---|---|
| `delegation/rows/en/h/32x5`, `delegation/rows/zh/h/32x5`, `delegation/view/en/h-compact/32x8` | F7: `review-te… ⊟` → `review-tests` |
| `delegation/panel/en/c-rich/48x32` | `› ▸ ✳ main` (the selection now falls back to the first row) |
| `delegation/panel/en/d-rich-accordion/48x24` | `›` on the root; the bar gains `⊕9` |
| `delegation/panel/en/parent-compact/48x24` | `›` on `impl-parser` |

**Added**
- `delegation/panel/en/h-open/{48x9,80x9,32x9}`
- `delegation/panel/en/h-log/48x9`
- `delegation/panel/en/c-switch/48x12`
- `delegation/panel/en/e-reconcile/48x12`
- `delegation/panel/en/e-reconcile-log/80x12`
- `delegation/panel/en/g-resume/{48x14,80x14}`
- `delegation/panel/en/c-rich-folded/48x24`
- `delegation/panel/zh/h-open/48x9`
- `delegation/panel/zh/e-reconcile/48x12`

## 7. Check output

Node 22.23.4, temporary HOME, `HUD_HOME` unset.

| Check | Result |
|---|---|
| build, build:test, build:hud-mcp | clean |
| `npm test` (twice) | 2436 tests: 2405 pass, 7 fail, 7 cancelled, 17 skipped. Only the three base failures: `b45-launch`, `hud-link-export`, `run-control`. HYG1 fixes the first two on its own branch. |
| `test:mjs` (run alone) | 47/47 |
| `test:core` | 209 pass, 1 skipped |
| `test:visual` | 331/331 |
| `test:hud-mcp` | 83 pass, 1 skipped |
| `node --test dist-test/tests/unit/b10b-*.test.js` | 361/361 |
| format / fixtures / diff-check | clean / OK / clean |

## 8. Performance

Command: `B10B_PERF=1 node --test dist-test/tests/unit/b10b-s3-perf.test.js`.

- n = 1000 after 200 warm-up, nearest-rank, 200 nodes, 56 columns.
- Shared host at load 1–2.
- Each tick runs: `reconcileMonitor` with the view model, a ↓/↑ key press, the agents rows, the painted row text, and the frame-diff.
- The changed tick is production-shaped: a fresh `structuredClone` of the view model, 1 of 200 nodes differing, and moving clocks.

| Gate | Limit | p99, three strict runs |
|---|---|---|
| compact no-change (60 rows in view) | 2 | 1.19, 1.48, 1.42 |
| rich no-change (60 rows in view) | 2 | 0.85, 1.03, 0.95 |
| compact changed (every row read) | 10 | 8.26, 9.03, 7.84 |
| rich changed (every row read) | 15 | 8.53, 10.18, 9.84 |

All times are in ms. One rich-changed sample had a 363 ms max outlier; p99 did not move.

**Segment 2's own bench on this branch** (three runs, p99 ms): compact changed 9.18, 8.01, 9.40; rich changed 10.05, 9.94, 10.81. All pass.

**Paired regression run** (1500 samples, alternating builds, p99 ms):

| Case | Segment-2 build | This branch | This branch + selection |
|---|---|---|---|
| compact changed | 9.45 | 9.66 | 9.19 |
| rich changed | 11.13 | 10.92 | 10.69 |

**Cost of the new parts, per tick:** reconcile 0.003–0.005 ms, key press 0.007–0.009 ms, control bar 0.10–0.11 ms.

**Printed, not gated** (whole `renderMonitor` tick, load 2, p99 ms):
- compact no-change 2.73;
- rich no-change 4.0;
- compact changed 10.25;
- rich changed 12.1;
- reconcile plus render from a selection that is not a destination: 2.4 compact, 4.6 rich;
- cold tick: 14.2 compact, 13.7 rich.

The whole-panel no-change ticks are above 2 ms. The segment-2 gate never covered that path.

## 9. Failure-mode tests

Each behaviour below has a test that fails without it. The implementer mutated the compiled copy for each of 22 behaviours, and every mutant was killed.

**`b10b-s3-selection`**
- A destination stays across a tick.
- `selectionMap` (chain and loop).
- A node that is gone → the first row.
- A row that is put away → its `⊕N`.
- A row under a collapsed ancestor → that ancestor.
- The sixth rich sub-row → its card.
- A `⊕N` stays selected when a row is inserted above it.
- `a` → the old place.
- Parent put away → the grandparent's `⊕N`.
- The `tree-page` call order (fails without the flag).
- The flag is written only by a view-model reconcile.
- A null view model leaves no mark.
- A stale press resolves against the frame the user saw.

**`b10b-s3-keys`**
- ↑/↓, Home, End, Page keys.
- The summary row and the parent row are not selectable.
- `h`/`l`, including `h` on the root; `+N` on a rich card head.
- `a` and `s`.
- Every kind of stop, with the root excluded.
- `n`/`N` wrap; no stop → no action.
- A collapsed row over a `⚑` stays collapsed.
- A rich card stands for its sixth sub-row.
- Enter, Space and `v` emit no action.
- A click only selects.
- Legacy `o`.

**`b10b-s3-actions`**
- Log on every headless state, and nowhere else.
- Switch scope.
- Open greyed for each gate reason.
- Reconcile: `strictEqual` on the descriptor.
- Resume: greyed and diagnostic-only, in EN and ZH, for four statuses.
- No Resume without a report, or while the run is alive.
- Reconcile wins over Resume.
- ZH words.
- Live paint differs from greyed paint.
- No action from painting.

**`b10b-s3-bar`**
- `older` counts with history hidden.
- Building the second plan does not evict the drawn one.
- Button condition and order.
- Widths 32–80 × 5 looks × 4 icon sets.
- ZH at 48.

**`b10b-s3-rich`**
- Sub-row items.
- A click does not scroll; key moves reveal.
- Never-fold.
- Rows past the fifth are not destinations.

**`b10b-s3-input-keys`**
- All of ASCII in both decoder profiles, with only the four letters changed.
- The command map and `needsOpenPanel`.
- Bindings without `-r`.
- With the panel closed, the four do nothing.
- Help lists the keys only when a view model is present.
- The docs rows.

**`b10b-s3-facts`, `-width`, `-collapse`**
- Fact names with digits, underscores and `$`.
- F7 at 32, 34 and 39 columns, and at the floor.
- F6: the card head and its cache invalidation.

## 10. Open items

**Segment 4: the Inspector**
- Inspector content for delegation keys.
- The reasons for a greyed Open.
- The Resume diagnostic.
- Whether a compact click opens the Inspector.
- Coverage with `omittedConflictRows`.

**Data layer**
- A reconcile descriptor per conflict relation.
- The real resume gate and its descriptor (after B14).
- Picker-label inputs for natives.
- The `SurfaceLocator` check for plain sessions.

**`tree-page.ts` owner (B10D)**
- The dispatcher in §5.
- The view model on the three reconcile calls.
- The activity hub's `target` action.

**Design doc (owner, non-blocking)**
- §3.7 Log row.
- §2 "trouble".
- "⇢ 只有 Reconcile" in §3.3 and §4.8.
- §4.13's bar sample.
- `f` is inactive in the delegation view.

## Orchestrator verification

- **Changed files:** the listed files only. `src/tree-page.ts`, `src/core`, `src/collectors`, `packages`, `docs/contracts` and `docs/design` have no diff against `cloud/b10b-s2`.
- **Visual baselines:** checked by key against `cloud/b10b-s2`. 309 → 321 frames, 0 removed. The changed frames are exactly the six listed above.
- **Re-run after a rebuild:**
  - `node --test dist-test/tests/unit/b10b-*.test.js`: 361/361.
  - `npm run test:visual`: 331/331.
  - `format:check`, `check:fixtures` and `git diff --check`: clean.
