# 25: Fork: the collapsed sidebar draws the HUD role icon too

**Status:** done
**Owner try:** yes
**Live try:** after install, collapse the herdr sidebar with workers running: each worker row shows its role icon in the state colour
**Blocked by:** none
**Objective:** herdr-fork

**What to build:** Owner live try of herdr-fork/20 (2026-11-26): the expanded sidebar shows HUD role icons, the collapsed sidebar still shows only state dots. `render_collapsed_sidebar` (src/client/shell/sidebar.rs:47, agent rows ~:163) calls `status_icon(agent.agent_status, ...)` and never reads the agent's `hud_icon` metadata token. Use the same token helper the expanded row uses (src/ui/sidebar/tokens.rs HUD_ICON_TOKEN, first grapheme, width 1, fallback to the dot) with exactly the state style the dot would have. Workspace rows in the collapsed sidebar keep their dot. Test beside the existing hud_icon tests (each state style, fallback). Fork worktree on its own branch from `hud`; do not merge, push or install. Document in HUD-FORK.md.

- [ ] Collapsed sidebar agent rows draw the hud_icon glyph in the state colour; panes without the token keep the dot (tests)
- [ ] Workspace rows unchanged; layout widths unchanged (tests)
- [ ] Isolated fork tests for the touched module, clippy, fmt, release build pass

## Comments
