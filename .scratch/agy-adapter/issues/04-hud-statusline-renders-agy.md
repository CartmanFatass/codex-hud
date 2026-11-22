# 04: hud-statusline renders agy's payload, fast enough for 3 Hz

**Status:** ready-for-human
**Blocked by:** none

**What to build:** Proposal 25 §2.4.
- `hud-statusline` recognises `product: "antigravity"` and shows model, context % and tokens.
- It renders the `quota` buckets as quota watermarks, the same form as Codex's "5h 80% left".
- It skips transcript parsing for agy.
- It never shows or stores `email`.
- agy calls the command about every 300 ms while the screen changes. Measure the per-call cost and bring p50 to ≤ 30 ms, using the forward worker or a cache keyed on the input signature.
- A failure prints a short degraded line and exits 0, so agy does not disable the statusline.
- Use synthetic payload fixtures only. Shape: proposal 25 §1, re-probed with a session-only `--settings` statusLine if the quota bucket shape is needed.

- [x] Synthetic agy payloads (fresh session, mid-turn, quota present) render the expected lines in EN/ZH
- [x] Timing reported before/after; npm test and check:fixtures pass

## Comments

- 2026-11-22 main: landed 6833f789 4ef12ad3 . Stale-while-revalidate shell fast path: p50 ~17 ms (was ~88), ~0.75 node renders/s while streaming, cold ~105 ms. Quota uses the real 1.5.14 shape probed by main (gemini-*/3p-* buckets, remaining_fraction, reset_time); family follows the model. Suite 962/962. reference.zh.md not yet updated for the statusline.
