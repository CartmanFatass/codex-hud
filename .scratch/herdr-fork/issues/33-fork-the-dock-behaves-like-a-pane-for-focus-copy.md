# 33: fork: the dock behaves like a pane for focus, copy mode and zoom

**Status:** ready-for-agent
**Owner try:** no
**Live try:** After install, move focus into the dock and back with herdr's directional focus keys, enter copy mode in the dock and copy a line, and zoom the dock to full screen and back.
**Blocked by:** 32

**What to build:** Repo: ~/projects/herdr-hud. D-2026-11-27-01: the owner wants the dock usable as an ordinary pane. Directional focus navigation (the same keys that move between panes) moves into the dock from the adjacent edge and back out; copy mode, search and selection work in the dock exactly as in a pane; zoom toggles the dock to the full terminal area and back (hidden state and side unchanged). Keep the existing rule that a server-side dock focus change does not interrupt local copy mode. No new HUD-side code in this ticket.

- [ ] Fork test: directional focus enters and leaves the dock for each side
- [ ] Fork test: copy mode and selection in the dock produce the same clipboard text as in a pane
- [ ] Fork test: zoom fills the terminal area and restores; hidden/side unchanged
- [ ] Fork gate passes; report names the built binary

## Comments
