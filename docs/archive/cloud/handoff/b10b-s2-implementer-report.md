# B10B-s2 implementer report (round 0)

Saved by the orchestrator from the implementer's text report. Branch `cloud/b10b-s2` from `universal-hud` 6fcf08a. The implementer first stopped with ten design questions; the rulings are in [`../rulings/b10b-s2.md`](../rulings/b10b-s2.md) (Q1–Q10), and this report covers the implementation that followed.

## Changed files

New:
- `src/render/delegation/panel.ts`: delegation agents view, summary row, compact view and micro card, 30 s ledger stamp.
- `src/render/delegation/lines.ts`: delegation line (Q3), focus line (Q2), parent row (Q9).
- `src/render/delegation/cards.ts`: rich cards, sub-rows, accordion, card caches, lazy line rows.
- Tests: `tests/unit/b10b-s2-{panel,lines,summary,native,selection,cards,perf}.test.ts`.

Modified, segment-1 delegation modules:
- `facts.ts`: new facts `nativeTitle`, `nativeKind`, `costValue`, `costQuality`, `worktreeRoot`, `worktreeName`, `workspaceCwd`, `runSeq`, `reconciliationMissing`, `terminalNote`, `linkBoundAt`.
- `projection.ts`: native name from `native.title`; `NodeProjection.kind` and `.detail`; `DelegationProjection.kindIcons` and `.reviews`.
- `glyphs.ts`: `GlyphSet.kind` (blank in ASCII), `GlyphSet.review` (`◈` / `r`).
- `rows.ts`: `slotText` and the icon-slot rule (Q7); `◈N` chip at ≥ 56 (Q8); selected `⊕N` row with band ink; `RenderContext.cardModel`; exported helpers; plan memo kept until the next put-away boundary instead of one second (decision 1).

Modified, panel hooks:
- `src/render/monitor-panes.ts`: `agentsView` delegates to `delegationAgentsRows` when `input.hud?.delegation` is non-null; new `viewport?` parameter.
- `src/render/monitor.ts`: `MonitorData.hud` widened to `HudData & HudDelegationData`; `MonitorRow.lead?`; a rich re-render with the pane height for the accordion, mirroring the existing DENSE_BELOW second pass.
- `src/render/agents-view.ts`: a leading `lead` row pinned above the heading (`pinned = 2`).
- `src/render/colors.ts`: `theme.onSelectedBand` getter alias.
- `src/render/i18n.ts`: new EN/ZH words, including the Q2 cause words.

Modified, tests and fixtures:
- `tests/fixtures/b10b-delegation.ts` (additive): NodeSpec `workspace`, `boundAt`, `runSeq`, `nativeMeta`, `missing`, `terminalNote`; `DEFAULT_WORKSPACE`; `situationC({ nativeMeta })`; `situationA`, `situationB`, `situationParent(form)`.
- `tests/fixtures/visual-baselines.ts` and `.json`: new kinds `delegation-view` and `delegation-panel`; JSON diff +496 / −0.
- `tests/unit/b10b-cache.test.ts`: table entries for the 11 new facts.
- `tests/unit/b10b-rows.test.ts`: "plan memoised per second" rewritten to the new rule (decision 1).

## Exported API

- `panel.ts`: `delegationAgentsRows(vm, DelegationPanelOptions): MonitorRow[]`, `DelegationPanelOptions`, `summaryCounts`, `coverageChip`, `listedWorkers`, `microCard`, `LEDGER_WARN_MS`, `resetLedgerStamp`.
- `lines.ts`: `delegationElements`, `delegationLine`, `delegationLinePlain`, `focusLine`, `focusText`, `FocusLine`, `parentRow`, `asChildRelation`, `dirText`, `rootOf`, `isIntentRoot`, `hasDelegationLine`, `paneText`, `ageOf`, `Segment`.
- `cards.ts`: `richRows`, `cardHeight`, `isCardHolder`, `MAX_SUB_ROWS`, `SIBLING_FOLD`, `CARD_CACHE_LIMIT`, `cardCacheStats`.
- `rows.ts` (new exports): `slotText`, `CHIP_MIN_WIDTH`, `CLOCK_COLS`, `NAME_MIN`, `clockOf`, `foldTexts`, `tierOf`, `clip`, `padStart`, `prefixText`, `newEpisode`, `fadedRole`, `nameMuted`, `exact`, `isHistoryStyle`, `Ink`, `PLAIN_INK`, `SELECTED_INK`, `Tier`.
- `projection.ts`: `NodeDetail`, `ReviewCount`.
- The three new modules are not re-exported from `delegation/index.ts`, so the bar process does not load panel code.

## `tree-page.ts` hook

None (Q1). `tree-page.ts` is unchanged; the data arrives as `renderMonitor`'s `input.hud.delegation`.

## Implementation decisions within the rulings

1. Plan memo window (`rows.ts`): the plan is kept until a subtree crosses its put-away time instead of being rebuilt every second (design §6 #3: sort only when a node changes bucket). Needed for the 2 ms no-change tick. The segment-1 per-second test was updated with boundary checks before and after.
2. Lazy row text (§6 #5): rows are built when the pane reads them; rich card heights computed without drawing; a rich view is reused across ticks on its plan; card head/body cached separately from the foot (500 entries, oldest evicted, plus last inputs per card).
3. Card frames (`┌ │ └ ─`) stay box-drawing under ASCII, as legacy cards do; markers, harness marks, tree, meter and contract dash switch.
4. Micro-card lead: `│` (accent), the row's tree columns, two spaces (`││   …` under a `├` row).
5. Sub-row width tier: a card's sub-row uses the card's inner width for its tier (at 48 columns, depth-1 sub-rows are medium tier, 6-column badge).

## Frames added (27)

- `delegation/view/en/`: `a-rich/48x3`, `b-rich/48x10`, `b-compact/48x6`, `b-compact-ascii/48x6`, `c-rich/48x19`, `c-rich-selected/80x19`, `c-compact-selected/48x10`, `c-compact-selected/32x10`, `c-compact-chip/56x8`, `c-compact-ascii/48x10`, `d-compact/48x11`, `d-rich-accordion/48x16`, `e-compact/48x10`, `e-rich/48x25`, `g-compact/48x4`, `g-history/48x11`, `h-rich/48x19`, `h-compact/48x8`, `h-compact/32x8`, `parent-offline/48x4`, `parent-unconfirmed/32x4`, `parent-cancel/48x6`.
- `delegation/view/zh/`: `c-rich/48x19`, `h-compact/48x8`.
- `delegation/panel/en/` (through `renderMonitor`): `c-rich/48x32`, `d-rich-accordion/48x24`, `parent-compact/48x24`.
- The existing 282 frames are byte-identical (0 changed, 0 removed).

## Check output (README set)

| Command | Result |
|---|---|
| build, build:test, build:hud-mcp | clean |
| `env -u NO_COLOR -u FORCE_COLOR -u HUD_HOME HOME=$(mktemp -d) npm test` | tests 2333, pass 2302, fail 7, cancelled 7, skipped 17 |
| `npm run test:core` | 210, pass 209, skipped 1 |
| `npm run test:visual` | 319/319 |
| `npm run test:hud-mcp` | 84, pass 83, skipped 1 |
| `format:check` / `check:fixtures` / `git diff --check` | clean / OK / clean |
| `node --test dist-test/tests/unit/b10b-*.test.js` | 270/270 |

The `npm test` failures are `b45-launch` (7 cancelled), `hud-link-export` (6, SQLite ExperimentalWarning on stderr), `run-control` (1); none imports `src/render`. The orchestrator verified that these fail identically on unmodified 6fcf08a (`# tests 46 # pass 31 # fail 7 # cancelled 7`).

## Performance

Command: `B10B_PERF=1 node --test dist-test/tests/unit/b10b-s2-perf.test.js`. n = 1000 after 200 warm-up, nearest-rank, 200 nodes, 56 columns; 4-core VM, load ≈ 1.5–2 from parallel agents. ms.

| Case | p50 | p95 | p99 | max | Gate |
|---|---|---|---|---|---|
| compact no-change tick, 60 rows in view | 0.155 | 0.351 | 0.646 | 1.159 | ≤ 2, pass |
| rich no-change tick, 60 rows in view | 0.062 | 0.142 | 0.211 | 2.175 | ≤ 2, pass |
| compact changed tick, all 200 rows + micro card + frame-diff | 0.576 | 1.223 | 2.249 | 3.420 | ≤ 10, pass |
| rich changed tick, 500-card cache, accordion to 60 rows | 0.446 | 0.805 | 1.387 | 1.565 | ≤ 15, pass |
| compact no-change, every row read | 0.509 | 1.083 | 1.332 | 2.839 | printed |
| rich no-change, every row read | 0.412 | 0.719 | 1.407 | 3.659 | printed |
| compact cold, every node differs, every row read | 7.230 | 11.305 | 17.039 | 26.857 | printed, over 10 |
| compact cold, 60 rows in view | 3.394 | 8.666 | 12.746 | 23.314 | printed |
| rich cold, every row read | 8.231 | 12.286 | 14.621 | 28.054 | printed |
| rich cold, 60 rows in view | 3.756 | 9.494 | 11.625 | 16.985 | printed |

The gates assert the changed tick (design §6 #6: "only the rows that changed"); cold is printed only and is mostly segment-1 row building. Segment 1's own bench on pristine `origin/universal-hud` on this host: rows200 cold p99 12.6–12.8 ms, no-change p99 2.2–2.5 ms (over budget there too). Segment 1's bench on this branch (`B10B_PERF=1 node --test dist-test/tests/unit/b10b-perf.test.js`): rows200 cold 9.876 pass; no-change 1.263 pass; projection changed 1.927 pass; statusline 1.972 pass; conflict-heavy 15.304 fail against 15 (13.5 earlier in the session; passes the non-strict bound in `npm test`).

## Rulings used

All ten (Q1–Q10) from `docs/cloud/rulings/b10b-s2.md`.

## Failure-mode tests

- `b10b-s2-panel`: null/absent VM draws the legacy panel byte for byte; non-null VM is the agents view, natives only included; parent row pinned above the heading; no viewpoint root; scenarios (a)(b)(c)(d)(e)(g)(h); every row exactly the panel width (all scenarios, both layouts, 32–80, EN/ZH/ASCII, every selection); CJK widths; ASCII switches the whole glyph table.
- `b10b-s2-lines`: delegation line elements, handshake/reported, run/heartbeat/cost/slot/close, `in <dir>`, shedding at 120/80/70/56/48/40/32/24/18, extra intent root, focus line kinds, parent row forms and shedding, gone parent.
- `b10b-s2-summary`: sampled strings, shedding order, worker counting, chip precedence incl. omitted conflict rows, 30 s flip, summary row never selectable.
- `b10b-s2-native`: title and null fallback, kind and null/other fallbacks, no slot without kind icons, `KIND_GLYPHS` parity, ASCII slot rules, `◈N` at 56 vs 55 / rich head / `rN` / red when a review failed.
- `b10b-s2-selection`: `⊕N` on mocha/latte/titanium (band + family ink), none/terminal (`›` + bold), rich card head on the band, a selection that is no planned row selects nothing.
- `b10b-s2-cards`: root card always, 5 sub-rows + `+2 (2▸)`, `children unknown` and `+N?`, root natives as cards with deeper ones as sub-rows, sub-row badge vs card model, accordion fold order, > 5 siblings, card cache reuses bodies and redraws only feet, card height equals its drawing.

## Open items

- Data layer (B9/B16): no `action`, `brief`, output rate or native digest on the VM; no `reconciliation.missing` vocabulary; `node.parent` not filled for the viewpoint root.
- Segment 3: `reconcileMonitor` accepting delegation keys (nothing is selected in production yet; `put:` key is positional; `selectionMap`); keys and clicks over `plan.rows`; the `older` button from `plan.putAway`; Inspector Coverage with `omittedConflictRows`; actions.
- Design-doc amendments for the owner (from the rulings): Q3 sample strings; Q4 drop order and §4.4 summary string; Q10 root card / root natives / no count line; absent brief/action/rate lines in the samples.
- Brief wording: "conflict-overflow summary row" read as Q5; `tree-page.ts` hook is "none".
- Performance: cold tick over 10/15 ms p99 on this host, mostly segment-1 row building; printed, not asserted.
- Scope: segment-1 source under `src/render/delegation/` and two segment-1 test files were edited (all inside `src/render/**` / tests).

## Orchestrator verification

- `git status` matches the listed files; `git diff universal-hud` is empty for `src/tree-page.ts`, `src/core`, `src/collectors`, `packages`, `docs/contracts`, `docs/design`; the baselines JSON diff removes no line.
- Rebuilt; `node --test dist-test/tests/unit/b10b-*.test.js` 270/270; `npm run test:visual` 319/319; `format:check`, `check:fixtures`, `git diff --check` clean.
