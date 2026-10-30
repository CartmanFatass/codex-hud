# toktrack reference assets

Port reference: toktrack commit `a6353d3`, MIT (see LICENSE).
The offline price table is copied from `assets/pricing_snapshot.json`.
Runtime prefers the user's toktrack pricing cache and custom pricing file.

Code ports:
- `services/pricing.rs`, `services/normalizer.rs` → `src/collectors/usage-pricing.ts`
- `tui/theme.rs`, `widgets/token_composition.rs` → `src/render/usage-theme.ts`
- `widgets/overview_card.rs`, `rank_table.rs`, `usage_trend.rs`, `layout.rs` → `src/render/usage-page.ts`

Unknown or incomplete native counters retain unknown cost, rather than a zero
charge. Codex reasoning remains inside output for billing, as in toktrack's
Codex parser; the visual composition can additionally show its native subset.
