# 09: Execution map keeps every station reachable and Station Detail scoped and clean

**Status:** done
**Live try:** Open the Execution tab at 40 columns on a run with more stations than fit; walk →/← to the last station and back, open Station Detail on a review and an accept station.
**Blocked by:** none
**Objective:** interaction

**What to build:** Repair from milestone review jc66ed72a3e7bc2c0 (findings 4, 8, 10 and the small deletions). Renderer side only; producer facts are exec-page/08. (4) Width fitting drops reachable stations: src/render/execution-metro.ts:800–815 returns a layout wider than `width` once the allowed folds run out, and :1180 omits off-screen nodes from key and mouse targets (40 columns, 22-step worker/reviewer chain: only s1–s19 reachable, no sign more exist). When the folds cannot fit everything, keep the rest reachable, e.g. a horizontal viewport that follows the cursor station with an edge marker showing more stations off-screen; never fold away review or active stations. Every line stays exactly `width` columns. (8) Station Detail shows the run's current hand-back, choices, hold and reason on any `accept` station (src/render/execution-run-detail.ts:331–342); show them only when they belong to that station's step (Run Detail keeps whole-run context). (10) execution-run-detail.ts:283 passes an already coloured role icon into kvRows, which escapes it (workboard-rows.ts:60), so the terminal theme prints literal escape text; pass plain text through kvRows and apply theme ink after sanitising (ARCHITECTURE §8). Also: a pool with no recorded counts must not print `(○×0)` (render unknown, not zero); remove the unused renderer `lane`/`lanes` hints and the identical arms of `(live.repair ? 'worker' : 'worker')`. Hairline look, keys and golden frames otherwise unchanged.

- [x] At 40 columns a 22-step mixed worker/reviewer chain (and a 32-step graph) keeps every station reachable by ←/→ and by mouse; the frame shows that stations are off-screen; every line is exactly width columns.
- [x] Station Detail on a future accept station during a tickets-step blocker shows no hand-back, choices, hold or reason from that blocker.
- [x] Station Detail in the terminal theme prints no escape text; a test asserts no literal \x1b in the frame.
- [x] A pool without counts renders no zero count.
- [x] Unused lane/lanes hints and the identical ternary arms are removed; existing golden frames still match except frames this ticket changes.

## Comments

- Landed in this commit (replay base 1b6ee5ab6878f2e2590cdc69ec4b6266cf3d48f0); gate 5/5 passed.
