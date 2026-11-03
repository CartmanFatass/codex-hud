# B10B-s2 final review (Oracle, Fable max), round 1

Saved by the orchestrator from the reviewer's text. Read-only; mutations and benches ran on copies outside the worktree.

**Verdict: accept** (no P0/P1). One P2 to fold into the next round that touches the bench; P3s optional.

## Findings

1. `tests/unit/b10b-s2-perf.test.ts:192-227, 229-262` — the gated "changed tick" never exercises a changed tick: it alternates two VMs both memoised by `projectDelegation`'s `WeakMap` on `vm.tree`, so projection, plan window, rich view and summary memo all hit; what is timed is clock-driven re-layout + frame-diff with one pre-cached row swapped. A real changed tick (fresh tree/node objects, as `src/core/link/tick.ts:509-525` produces) rebuilds all of them. Reviewer's production-shaped bench (fresh `structuredClone` per sample, 1 of 200 differs, clocks move; idle host, n=1000 after 200 warm-up, nearest-rank): compact p50 2.99 / p99 9.99 ms (every row) and 9.92 (60 rows in view); rich p50 4.0 / p99 11.8 ms. Budget met, with ~5× less margin than reported. — P2 — add a gated production-shaped case; keep cold printed; correct the report's wording.
2. `src/render/delegation/cards.ts:217-236` (`lookId`) — after `looks.clear()` the next id restarts at 1, reusing ids that up to 500 cached bodies/feet may still carry for a different language/palette/glyph set (> 64 distinct looks in one process). — P3 — monotonic counter.
3. `src/render/delegation/cards.ts:424-431` (`foldedCard`, and `subRowLines` via decision 5) — a folded card is tiered by `ctx.width - indent`, so at 48 columns a depth-1 folded card gets the 6-column badge (`d-rich-accordion/48x16`: `6.1sol`) where §4.7 shows `6.1sol·xhigh` (§3.5: a folded card is the node's compact row; §4.2 budgets by panel width). — P3, cosmetic — a `tierWidth` (panel width) in `RenderContext` for sub-rows/folded cards, or document the deviation.
4. `src/render/delegation/lines.ts:321-332` (`focusText`) — no shedding, only a clip: `g-history/48x11` micro card reads `ended · no report · runtime limit · exit u…` (§0.1 #3 drop a field before cutting text). — P3 — shed trailing segments before clipping.
5. `src/render/delegation/panel.ts:246,250` — micro-card ink (`PLAIN_INK`, correct per §5.2) is asserted nowhere; mutating to `SELECTED_INK` passes all unit and visual tests (baselines are ANSI-stripped). — P3 — cell-level assertion on mocha/latte/titanium.
6. `src/render/delegation/cards.ts:316-347` — a collapsed card draws no `+N (…)` on its head. Unreachable today (Q6). — P3, segment-3 open item.
7. Out of scope (segment 1, `src/render/delegation/rows.ts:631-640`): at ≤ 39 columns a row without a state word cuts the name while keeping `⊟`, contrary to §3.4's ≤ 39 order; present in base frames already. Segment-1 follow-up.

Notes (not defects): the module-level 30 s ledger stamp (`panel.ts:60-86`) is safe for one VM per panel process, idempotent across the two passes per frame, cleared on `available`/`ledger_busy`, resets if the clock goes backwards; the exported `coverageChip` mutates it as a side effect, so tests must `resetLedgerStamp()`. `selectedKey` validation at `panel.ts:289-290` is redundant but harmless.

## Verified

- Builds clean; `npm test` 2333 / 2302 pass / 7 fail / 7 cancelled / 17 skipped (only the pre-existing `b45-launch`, `hud-link-export`, `run-control`); `test:visual` 319/319; `test:core` 209 + 1 skipped; format, fixtures, diff-check clean.
- Byte identity: 282 frames on base, 309 on branch; 0 changed, 0 removed, 27 added. Legacy paths untouched apart from `agents-view.ts` (`lead = 0` → identical arithmetic) and guarded hooks; no new key collides with an existing `t()` call. No diff in `src/tree-page.ts`, `src/core`, `src/collectors`, `packages`, contracts, design doc.
- Rulings Q1–Q10 traced to code and frames.
- §8: no `Date.now` or raw escapes in new modules; widths via `visualLength`/`truncateAnsi`; `monitorText` once per external string; every word through `t()` with ZH entries. `renderMonitor` probe over 624 frames: no throw, every line exact, `pinned = 2` whenever the pane has ≥ 2 rows.
- Failure-mode tests: 25 mutations of the compiled copy; 23 caught by unit tests, one by the visual suite, one uncaught (finding 5).
- Performance (idle host): the gated cases pass twice; cold over budget as reported. The two-pass rich no-change shape `renderMonitor` drives is p99 1.26 ms. Segment-1 strict bench: on pristine base `rows200 cold` 12.5 ms and `no-change` 2.50 ms fail on this host; on the branch `rows200 cold` 11.1 ms fails, `no-change` passes (1.95 ms); `conflict-heavy` 17.9 vs 12.9 on base (high variance; watch).
- Decision 1 (plan memo per put-away boundary): correct and within §6 #3/#16; the brief's "once per second" note is stale wording.
- Ownership: edits only under `src/render/**` and tests; segment-1 edits each required by a ruling or decision 1. Hygiene: synthetic only.
- Report accuracy: files, API, frames, checks, perf, rulings, open items all reproduce.
