# 02: Even rotation survives quota exhaustion and the bars say which preset left

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 01

**What to build:** Owner 2026-11-24: `even` needs break protection. (1) When a launch on the rotated preset fails with a quota failure (`isQuotaFailure`, today's `markExhausted` path), the place is marked exhausted as now and the same job moves on to the next available preset in the pool (the rotator's order) instead of failing; the job record keeps `route.preset` as the preset that actually ran and lists the skipped one with its reason. (2) An exhausted preset leaves the rotation until its exhaustion mark expires, then rejoins without any action. (3) Notice zone: while any preset of an even pool (imp or sonic) is out of the rotation, the bottom bars (Claude/Antigravity statusline, pi footer, Codex tmux bar; docs/reference.md "The bottom bars") show one notice item after open approvals and before HUD load, e.g. `⚠ imp fast: quota` (several: the first plus `+N`), gone when it rejoins. Text and Nerd icon sets get their own glyph as other items do. This is the only new notice item for now; others come later.

- [ ] A fixture where the rotated preset's launch fails with a quota error starts the same job on the next preset in the pool; the exhausted preset is skipped by later launches until its mark expires, then used again
- [ ] The notice item appears in all bar looks while a pool preset is exhausted and disappears after it rejoins (tests on the TypeScript renderer; the native statusline falls back to TypeScript or renders the same item)
- [ ] docs/reference.md (even paragraph and the notice zone list) updated

## Comments
