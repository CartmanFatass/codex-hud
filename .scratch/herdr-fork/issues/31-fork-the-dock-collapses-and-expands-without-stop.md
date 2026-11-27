# 31: fork: the dock collapses and expands without stopping its process

**Status:** done
**Owner try:** no
**Live try:** After install, open /hud, scroll or select something in the panel, collapse it with the keybinding and with the frame button, then expand it: the panel reappears instantly with the same state, and the main pane uses the full width while collapsed.
**Blocked by:** none

**What to build:** Repo: ~/projects/herdr-hud (dispatch with cwd there; land via its own land block). D-2026-11-27-01. Today `dock.toggle`/`dock.close` shut the dock terminal down (src/app/dock.rs close_dock → shutdown_terminal_runtime), so reopening is a cold start. Add a hidden state: `dock.hide` / `dock.show` and `dock.toggle` switching between shown and hidden while a dock exists (open it if none); `dock.close` still stops it. Hidden: the runtime keeps running and keeps its size, nothing is drawn, the tab area is full width in both overlay and push mode, mouse and keys never route to it. `dock.status` / the response report `shown`, `hidden` and the existing fields; live-handoff carries hidden. Add a clickable collapse mark on the dock frame and a default keybinding (prefix-based, configurable like other herdr bindings) that toggles hidden/shown. Wire protocol stays additive (old clients ignore the new fields). Never touch ~/.local/bin/herdr or the running server; main installs.

- [x] Fork test: toggle on an open dock hides it with the same terminal id and runtime alive; toggle again shows it; close stops it
- [x] Fork test: hidden dock gets no mouse/key routing and the tab area is full width in overlay and push
- [x] Fork test: keybinding and frame mark toggle hidden; handoff preserves hidden
- [x] Fork gate passes; report names the built binary

## Comments
