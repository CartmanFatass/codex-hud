# 01: Rarely changed Settings rows fold under "Advanced"

**Status:** ready-for-agent
**Blocked by:** monitor-state/04; land after primitives/04 or rebase on it (both edit src/render/settings-page.ts)

**What to build:** Proposal docs/neon-proposal/10-settings-advanced-fold.md with its §6 defaults (owner, 2026-11-22: "do as your recommendation"): the 10 rows in §3.1 fold under one global "Advanced" row (Call cap and Sonic auto-thinking stay visible); the fold is not remembered between opens; no tree-page.ts change. Update docs/reference.md and reference.zh.md ("All groups are open …" sentence). This is the spec's M5 candidate "rarely changed Settings rows fold under Advanced".

- [ ] Settings opens with Advanced folded; Enter on it shows the 10 rows; EN/ZH frames updated
- [ ] npm test and check:fixtures pass

## Comments
