# B10B-s2 fix round 1 report

Saved by the orchestrator from the implementer's text. Responds to `b10b-s2-review-1.md`.

## Per finding

- **F1 (P2)** — `tests/unit/b10b-s2-perf.test.ts`: new `changedTicks(paint)`; every sample gets a fresh `structuredClone` of the VM, alternating two trees that differ in exactly one node (`n004` working ↔ failed), clocks move. Two gated cases (every row read + frame-diff): compact ≤ 10 ms p99, rich ≤ 15 ms p99; 60-rows-in-view variants printed. The old two-tree case is kept, ungated, renamed "no-change + one cached row (two memoised view models alternated)"; the file header says what each case measures. Cold still printed only.
  - Cheap win: `src/render/delegation/facts.ts` `factsEqual` now builds one straight-line comparator with `new Function`, once, from the constructor's own keys; a guard rejects any key that is not `[A-Za-z]+`. Compact changed tick went from p99 9.6–10.4 to 8.1–9.4 ms. Covered by the segment-1 test `factsEqual compares every fact` and the `b10b-cache` table.
- **F2** — `cards.ts`: monotonic `nextLookId++`; `lookId` exported. Test `lookId is monotonic: a cleared table never hands out an id a cached card still carries (F2)` (200 looks across the 64-entry clear); reverting to `looks.size + 1` fails it.
- **F3** — `rows.ts`: `RenderContext.tierWidth`; tier and `◈N` gate use `ctx.tierWidth ?? width`, part of the row cache key. `cards.ts`: folded cards and sub-rows pass `tierWidth: ctx.width`. Test `a folded card and a sub-row are tiered by the panel width: the badge of a compact row at 48 (F3)`; removing `tierWidth` fails it. Frames: `delegation/view/en/d-rich-accordion/48x16` and `delegation/panel/en/d-rich-accordion/48x24` now read `6.1sol·xhigh` as in §4.7.
- **F4** — `lines.ts`: `Segment.shed` rank (`exit unknown` 1, timing note 2, requested cause 3, known exit 4, missing item 5); `focusText` drops ranked segments before clipping. Test `focus line: short of room it drops exit unknown, then the timing note, then the cause, before it cuts (F4)` at 80/60/50/30/12. Frame `delegation/view/en/g-history/48x11` now reads `ended · no report · runtime limit`.
- **F5** — test only: `micro card under a selected row: no band and the plain ink, never the band family (mocha, latte, titanium)` in `b10b-s2-selection`; fails with the compiled micro card mutated to `SELECTED_INK`.
- **F6, F7** — no change (open items).

## Visual baselines

309 frames: 3 changed (all three are this package's new frames, above), 0 removed, 0 added. The 282 pre-existing frames are byte-identical; `visual-baselines.json` vs base is still +496 / −0.

## Check output

| Check | Result |
|---|---|
| build / build:test / build:hud-mcp | clean |
| `npm test` (temp HOME, HUD_HOME unset) | 2337, pass 2306, fail 7, cancelled 7, skipped 17 (pre-existing `b45-launch`, `hud-link-export`, `run-control`) |
| `test:core` | 210 / 209 pass / 1 skipped |
| `test:visual` | 319/319 |
| `test:hud-mcp` | run 1: 82 pass / 1 fail ("B45 accepted spawn is atomic…", `Ledger busy`, known flake); rerun alone: 83 pass / 0 fail / 1 skipped |
| `node --test dist-test/tests/unit/b10b-*.test.js` | 274/274 |
| format / fixtures / diff-check | clean / OK / clean |

Orchestrator re-ran after rebuilding: b10b-* 274/274, visual 319/319, baselines diff removes no line, format and diff-check clean.

## Performance

`B10B_PERF=1 node --test dist-test/tests/unit/b10b-s2-perf.test.js`; n = 1000 after 200 warm-up, nearest-rank, 200 nodes, 56 columns; load average 1.74. ms.

| Case | p50 | p95 | p99 | max | Gate |
|---|---|---|---|---|---|
| compact changed tick (fresh VM, 1/200 differs, every row + frame-diff) | 2.807 | 7.143 | 9.410 | 10.971 | ≤ 10, pass |
| rich changed tick (fresh VM, every row, 500-card cache) | 2.478 | 7.503 | 10.063 | 14.850 | ≤ 15, pass |
| compact no-change, 60 rows in view | 0.138 | 0.331 | 0.841 | 1.737 | ≤ 2, pass |
| rich no-change, 60 rows in view | 0.069 | 0.176 | 0.333 | 1.753 | ≤ 2, pass |
| compact changed tick, 60 rows in view | 2.651 | 7.809 | 9.036 | 13.735 | printed |
| rich changed tick, 60 rows in view | 1.988 | 7.703 | 9.677 | 21.104 | printed |
| compact no-change + one cached row | 0.569 | 1.286 | 2.592 | 4.157 | printed |
| rich no-change + one cached card | 0.607 | 1.104 | 2.307 | 4.629 | printed |
| compact no-change, every row | 0.582 | 1.148 | 1.946 | 2.250 | printed |
| rich no-change, every row | 0.549 | 1.116 | 2.353 | 4.419 | printed |
| compact cold, every row | 7.118 | 12.094 | 17.700 | 29.677 | printed |
| compact cold, 60 rows | 4.075 | 9.625 | 12.321 | 19.613 | printed |
| rich cold, every row | 8.834 | 13.763 | 21.052 | 31.502 | printed |
| rich cold, 60 rows | 4.269 | 10.386 | 12.239 | 20.471 | printed |

Segment-1 bench (`B10B_PERF=1 node --test dist-test/tests/unit/b10b-perf.test.js`), p99 ms: rows200 cold 11.660 fail (base fails too, 12.5 in the reviewer's run); projection200 cold 2.640 printed; projection200 changed 1.782 pass; no-change 1.800 pass; statusline 2.707 pass; alerts + notice 0.069 pass; conflict-heavy 16.536 fail (noisy: 13.5 earlier here; 17.9 branch vs 12.9 base in the reviewer's run).

## Files changed this round

`src/render/delegation/{facts,cards,rows,lines}.ts`; `tests/unit/b10b-s2-{perf,cards,lines,selection}.test.ts`; `tests/fixtures/visual-baselines.json` (the 3 new frames).
