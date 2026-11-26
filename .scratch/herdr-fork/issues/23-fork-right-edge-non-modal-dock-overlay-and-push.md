# 23: Fork: right-edge non-modal dock (overlay and push, single-instance server toggle)

**Status:** done
**Owner try:** no
**Live try:** after install, `herdr dock toggle -- /usr/bin/env sh -c cat` opens a right-edge overlay without resizing the focused pane and a second call closes it
**Blocked by:** 21
**Objective:** herdr-fork

**What to build:** D-2026-11-26-01 Step 2a, fork side. Feasibility (oracle job jf92ac005aa757331, read its full report): the modal popup_pane cannot host it; owner 2026-11-26 approved the larger change (~650-850 non-test Rust LOC), sequenced after herdr-fork/21. Build Shape A (server-projected session dock): new fork modules src/dock.rs and src/app/dock.rs plus thin call sites; AppState.dock outside Workspace/Tab layout; one session-wide dock hosting one direct-exec argv command (agent detection disabled, HERDR_DOCK=1, pane identity env stripped); API dock.toggle / open / close / configure / status decided atomically in the server, CLI `herdr dock ...`, capability `dock` on ping. Overlay mode keeps tab pane rects and PTY sizes unchanged and composites the dock with a 1-cell left border over the right edge; push mode shrinks the tab area and emits pane.resized. Project the dock as pane id `dock` at PaneSurfaceFrame.panes[0] (scroll none; omitted from ClientShellSnapshot.panes and pane.list) for click focus, mouse and wheel forwarding, PaneFocus, PaneFocusDirection right into / left out of the dock, PaneClose(dock), PaneDied cleanup. Must coexist with Copy mode, Settings and popup_pane (hud.select-send opens over the dock without ui_busy). Preserve the dock PTY, mode and width across server.live_handoff; cold restore starts closed. Leave endpoint.surface-delta.v1 and the endpoint method-shape fixture unchanged. Document in HUD-FORK.md with the Apache-2.0 4(b) notices; regenerate the schema artifact. Fork worktree on its own branch from `hud` after 21 is merged; do not merge, push or install.

- [ ] Burst of 10 dock.toggle calls leaves at most one dock runtime and no workspace split pane; PaneDied closes the dock (tests)
- [ ] Overlay keeps the underlying pane's PTY size on open/toggle/close; push shrinks the tab by dock width + 1, emits pane.resized and restores on close or configure(overlay) (tests)
- [ ] Opening the dock cancels neither Settings nor Copy mode; a popup opens over the dock without ui_busy; mouse and directional focus route to the clicked or chosen side (tests)
- [ ] Dock survives live handoff; cold snapshot omits it; surface-delta and method-shape tests unchanged; ping advertises dock (tests)
- [ ] Full fork test pass single-threaded (split around the known SIGPIPE case), api_ping, live_handoff, release build

## Comments
