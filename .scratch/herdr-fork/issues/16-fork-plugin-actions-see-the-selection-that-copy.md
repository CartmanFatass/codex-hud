# 16: Fork: plugin actions see the selection that copy-on-select just copied

**Status:** done
**Owner try:** yes
**Blocked by:** none
**Objective:** herdr-fork

**What to build:** Owner live try of select-send/01 (2026-11-26): with herdr's default `ui.copy_on_select = true`, mouse-up copies and clears the client selection (src/client/shell/mouse.rs:1759-1768), so a keybound `plugin_action` sends no `selection` (src/client/shell/actions.rs:215-245) and HUD's action sees an empty selection. Owner chose: keep copy-on-select, but remember the selection that was just copied for the pane and hand it to a plugin action invoked on that pane while the pane content revision is unchanged and within a short window (e.g. 30 s), and only until the next click or selection in any pane. Pass it exactly like a live selection (same `PaneSelectionReadParams` with the recorded content revision, so herdr's stale-content check still applies). Nothing else changes: copy behavior, highlight timing, non-plugin commands. Document in HUD-FORK.md. Fork worktree on its own branch from `hud`; do not merge (main merges); never push or install.

- [ ] Tests: with copy_on_select on, select + release + keybound plugin action delivers the selected text; after a click, another selection, a content change or the window expiring it delivers none; copy_on_select off behaves as before
- [ ] HUD-FORK.md documents the recent-selection rule; fmt, clippy -D warnings, schema check, unit tests single-threaded, api_ping, live_handoff, release build
- [ ] Live try: after install, select two lines in a pane with the mouse, release, press Ctrl+b a: the HUD composer opens with those lines

## Comments
