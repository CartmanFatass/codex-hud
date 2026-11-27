# 32: fork: the dock resizes by dragging and docks to the right, left or bottom edge

**Status:** ready-for-agent
**Owner try:** no
**Live try:** After install, drag the dock's inner border to resize it, then switch the side to left and to bottom in HUD Settings; the width/height you dragged is kept after hide/show and after reopening.
**Blocked by:** 31

**What to build:** Repo: ~/projects/herdr-hud. D-2026-11-27-01. Width is only settable via `dock.configure` today, and the dock is fixed to the right edge (src/dock.rs inner_rect/tab_area). (a) Dragging the dock's inner border with the mouse resizes it (width for left/right, height for bottom), clamped so the main area keeps its current minimum; the drag emits a `dock.resized` event with the new size so HUD can persist it. (b) `DockOptions.side: right | left | bottom` (default right), applied live by `dock.configure`, in overlay and push; `size` stays meaningful per side (width for left/right, rows for bottom). Additive protocol; handoff carries side and size.

- [ ] Fork test: dragging the border changes the dock size and emits dock.resized with the new size; clamping keeps the main area minimum
- [ ] Fork test: side left/bottom place the dock and the push-mode tab area correctly; configure switches side live
- [ ] Fork gate passes; report names the built binary

## Comments
