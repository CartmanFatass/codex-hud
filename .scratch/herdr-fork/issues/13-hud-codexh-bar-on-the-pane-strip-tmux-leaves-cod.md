# 13: HUD: codexH bar on the pane strip; tmux leaves Codex panes

**Status:** ready-for-agent
**Owner try:** yes
**Blocked by:** herdr-fork/10
**Objective:** herdr-fork

**What to build:** D-2026-11-26-01 step 1b, HUD side. With the pane-strip capability, `codexH` (bin/codex-hud) starts Codex directly in the pane with a bottom strip and pushes its bar there at the exact width from the fork's width event, renewing the lease. Owner-approved removal: the tmux session inside Codex panes, its prefix keys and copy mode, `codex-hud-paste`, `codex-hud-resize`, tmux height and scrollback settings, and the bridge-health probe. The bar's content and look stay identical. Update docs (reference, install.d/README).

- [ ] Tests: the bar line pushed to the strip equals today's codexH bar at 40/80/120 columns; a resize pushes at the new width
- [ ] git grep finds no tmux invocation in the codexH path
- [ ] Owner try: open Codex with codexH: same bar as today; mouse selection and scrollback behave as in any herdr pane; a bar code change shows after npm run build without restarting the session

## Comments
