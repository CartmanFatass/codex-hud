# 01: Model facts and picker keys

**Status:** done (accepted by the owner; see STATE ledger)
**Blocked by:** none

**What to build:** Keep `pi --list-models`'s context, max-out, thinking and images per model in the existing discovery
cache (one added field, same single call; old caches without it still load). The narrow picker shows the bottom strip
(whole ID wrapped, ctx/out/think/img, state) and the per-row HUD state (`✗ 42m` exhausted with reset, `⊘` off, `?`
unknown); providers that are off get one muted non-selectable line. `^R` refreshes inside the picker; the first Esc
clears a typed filter, the next closes. Sample frames 2a–2d (strip, row facts, off line). See spec.md settled 4, 5, 7, 8.

- [ ] parser keeps the four columns from a synthetic table; an old cache without them still opens the picker
- [ ] exhausted / off / unknown facts appear on the row and in the strip
- [ ] Esc clears the filter first, then closes; `^R` refreshes without a subprocess per key
- [ ] 40-col EN/ZH frames match the sample
