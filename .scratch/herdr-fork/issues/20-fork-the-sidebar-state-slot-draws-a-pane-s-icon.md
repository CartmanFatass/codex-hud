# 20: Fork: the sidebar state slot draws a pane's icon token in the state colour

**Status:** done
**Owner try:** yes
**Blocked by:** none
**Objective:** herdr-fork

**What to build:** Owner 2026-11-26: worker rows in herdr's left sidebar should show an icon for the worker's kind (HUD role) instead of the state dot. When a pane's metadata tokens contain `hud_icon` (reported by HUD via `pane.report_metadata`, herdr-fork/19), the agent row's `state_icon` token draws that glyph (first grapheme, width 1; fall back to the dot if wider or empty) with exactly the style the dot would have for the current state (colours, blink/attention). Panes without the token are unchanged. Document in HUD-FORK.md. Fork worktree on its own branch from `hud`; do not merge; never push or install.

- [ ] Tests: a pane with hud_icon draws the glyph in each state's style; a wide or empty glyph falls back to the dot; panes without the token unchanged; render width unchanged
- [ ] Live try: with herdr-fork/19 landed and this installed, workers show their role icon coloured by state in the sidebar

## Comments
