# 02: One role icon table: herdr sidebar uses the bar's icons; sonic ϟ, lead ★

**Status:** ready-for-agent
**Owner try:** no
**Live try:** dispatch a sonic and an imp, then compare the herdr sidebar icon with the statusline worker zone (same glyph per role)
**Blocked by:** none
**Objective:** interaction

**What to build:** Owner 2026-11-26: the herdr sidebar role icons (herdr-fork/19, `hudRoleIcons` in src/mcp/dispatch/direct-exec.ts: imp ◆, reviewer ◎, lead ★, sonic » ...) differ from the statusline's; main's ticket wrongly invented a second table. Owner choice: one table everywhere. (1) Delete `hudRoleIcons`; the `hud_icon` metadata token uses `roleIcon(role)` from src/render/model-glyphs.ts with the owner's `icons` setting (unicode / ascii / nerd), read where the job is dispatched. (2) In ROLE_GLYPHS change sonic's unicode glyph from ⚡ (U+26A1, emoji presentation, two cells, too wide for the one-cell sidebar state slot) to ϟ (U+03DF, one cell); ascii and nerd stay. (3) Add `lead: ['★', 'L', '']` (Font Awesome star, BMP) to ROLE_GLYPHS, placed so the bar order stays sonic last and other before it. (4) Keep the native statusline copy (native/src/render.rs role table) in sync and the parity tests green; update any docs (docs/reference.md icon table, statusline docs) and render tests that name ⚡ or the old sidebar glyphs. Every glyph sent as `hud_icon` in each icon set must be exactly one terminal cell (unicode-width 1, no emoji presentation); add a test over all roles and sets. Removes: the separate sidebar icon table only (no user-visible feature).

- [ ] hud_icon for each role equals roleIcon(role) in the configured icon set; the separate sidebar table is gone
- [ ] sonic shows ϟ and lead shows ★ in the bar, pi footer, Home and sidebar token; ascii and nerd sets have lead entries
- [ ] TS and native statusline tables match (parity tests pass)
- [ ] A test asserts every role glyph in every icon set is one terminal cell wide

## Comments
