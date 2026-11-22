# 04: hud-statusline renders agy's payload, fast enough for 3 Hz

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Proposal 25 §2.4.
- `hud-statusline` recognises `product: "antigravity"` and shows model, context % and tokens.
- It renders the `quota` buckets as quota watermarks, the same form as Codex's "5h 80% left".
- It skips transcript parsing for agy.
- It never shows or stores `email`.
- agy calls the command about every 300 ms while the screen changes. Measure the per-call cost and bring p50 to ≤ 30 ms, using the forward worker or a cache keyed on the input signature.
- A failure prints a short degraded line and exits 0, so agy does not disable the statusline.
- Use synthetic payload fixtures only. Shape: proposal 25 §1, re-probed with a session-only `--settings` statusLine if the quota bucket shape is needed.

- [ ] Synthetic agy payloads (fresh session, mid-turn, quota present) render the expected lines in EN/ZH
- [ ] Timing reported before/after; npm test and check:fixtures pass

## Comments
