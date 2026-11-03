# B10B-s2 re-check (Oracle, Fable max, fresh agent), after fix round 1

Saved by the orchestrator from the reviewer's text. Read-only; benches, mutations and probes ran on compiled copies outside the worktree.

**Verdict: accept.** No P0–P2; three P3s, none a behaviour regression.

## Per finding

| # | Status | Evidence |
|---|---|---|
| F1 (P2) | fixed | `b10b-s2-perf.test.ts:177-187` `changedTicks`: fresh `structuredClone` per sample, two trees differing in `n004` only, clock moves 1 s per tick. Instrumented: 1 projection miss per tick; rich logs 1 card miss per tick. Gates (lines 207, 248, 290): compact every row + frame-diff ≤ 10 ms p99, rich ≤ 15, no-change ≤ 2; n = 1000 after 200 warm-up, nearest-rank — matches acceptance #4. Memoised case p50 0.88 ms vs fresh-VM changed tick 3.4 ms, so the shape really changed. The comparator is covered: dropping one key from the generated comparator fails `factsEqual compares every fact` and a projection-cache test. |
| F2 | fixed | `cards.ts:219,231-232` monotonic `nextLookId++`; reverting fails the `(F2)` test. |
| F3 | fixed | `rows.ts:231` `tierWidth` (cache key `:491`, `tierOf` `:518`, `◈N` gate `:556`); `cards.ts:153,429`. Removing it fails the `(F3)` test and exactly the two named frames, which now read `6.1sol·xhigh` as in §4.7. |
| F4 | fixed | `lines.ts:24-39` shed ranks; `focusText` `:345-355`. Disabling shedding fails the `(F4)` test and only `g-history/48x11`. A same-rank tie drops the leftmost segment; unreachable today (Q2). |
| F5 | fixed (test) | `b10b-s2-selection.test.ts:130-156`; painting the micro card with `SELECTED_INK` fails it. |
| F6, F7 | not fixed, by design | segment-3 / segment-1 open items |

## The changed-tick bench (idle 4-core host)

Full run, p50 / p99 ms: compact no-change 0.245 / 1.037; rich no-change 0.079 / 0.352; **compact changed 3.370 / 10.503 (fail ≤ 10)**, max 14.5; rich changed 3.038 / 10.624; cold every row compact 7.985 / 18.313, rich 9.094 / 21.092. Compact test alone, three times: p99 8.559 / 8.308 / 8.317 (pass). Scratch driver, three reps: compact 9.685 / 9.087 / 9.800, rich 9.494 / 9.530 / 9.712. With a full GC between samples: compact p99 5.3–6.1, rich 6.3–6.9; p50 ≈ 1.1 ms projection + 1.0–1.2 ms plan + rows + diff. The renderer's own cost is well inside budget; about 4 ms of the p99 tail is GC of per-tick garbage (production-shaped). **The compact gate is marginal on this host: 1 fail in 7 idle runs (8.3–10.5 ms p99).**

Segment-1 strict bench: rows200 cold 13.593 fail (pre-existing: base 12.5–12.8); projection200 changed 1.630, no-change 1.972, statusline 2.714, alerts 0.056, conflict-heavy 14.745 all pass (conflict-heavy noisy: 16.5 / 17.9 fails earlier).

## `factsEqual` with `new Function` (`facts.ts:230-246`)

Correct (`===` over every own key of a `nodeFacts()` product) and safe: the only production caller is `projection.ts:407` with cached facts; keys are the module's own 66 identifiers, all passing the `[A-Za-z]+` guard; no CSP and no `--disallow-code-generation-from-strings` in `bin/*`. Edge cases match the old loop (extra key on `b` ignored; missing key → unequal → cache miss). Microbench per 200-node tick: generated comparator 61–62 µs; hand-unrolled static function 57–73 µs; old keyed loop 736–772 µs; `for…of` over a key array 855–883 µs. The win (~0.7 ms per changed tick) needs an unrolled form; a loop is 12× slower. Acceptable; it is the repo's only dynamic code generation.

## Frames

282 base frames byte-identical (0 changed, 0 removed), 27 added, `version` unchanged, key order preserved; mutations flip exactly the three named new frames.

## New findings (P3)

1. `src/render/delegation/facts.ts:240` — the guard `/^[A-Za-z]+$/` rejects legal identifiers (digits, `_`, `$`); a future fact like `exitCode2` would throw `fact names are identifiers` on first comparison in the render path (CI's `b10b-cache` would catch it). — `/^[A-Za-z_$][\w$]*$/` or a compile-time key list.
2. `src/render/delegation/facts.ts:241` — `// eslint-disable-next-line @typescript-eslint/no-implied-eval` names a linter the repo does not have. — drop it or make it a plain comment.
3. `tests/unit/b10b-s2-perf.test.ts:248` — the compact gate straddles 10 ms on this host (see above). — report the range and GC share; no code change.

## Checks (temp HOME, HUD_HOME unset, rebuilt)

`npm test` 2337 / 2306 pass / 7 fail / 7 cancelled / 17 skipped (only `b45-launch`, `hud-link-export`, `run-control`); `test:core` 209 + 1 skipped; `test:visual` 319/319; `test:hud-mcp` 83 + 1 skipped, 0 fail; b10b-* 274/274; format, fixtures, diff-check clean. §8 sweep of the touched modules: no `Date.now`, no raw escapes, new words in `i18n.ts` with ZH.
