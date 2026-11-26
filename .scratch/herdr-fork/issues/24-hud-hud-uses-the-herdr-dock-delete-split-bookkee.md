# 24: HUD: /hud uses the herdr dock; delete split bookkeeping; overlay/push setting

**Status:** ready-for-human
**Owner try:** yes
**Live try:** toggle /hud ten times fast in Claude Code, Codex, pi and a shell pane: one panel, no orphan pane, main pane text does not reflow in overlay mode; switch Settings -> Panel -> Dock mode to push and back and see the main pane shrink and restore
**Blocked by:** 23
**Objective:** herdr-fork

**What to build:** D-2026-11-26-01 Step 2a, HUD side (oracle job jf92ac005aa757331 section Q4 and Ticket 22 of its report). With capability `dock` on the running fork, `hud panel` (without --here), the Claude mod /hud, the Claude/Codex /hud command and skill, and pi /hud call dock.toggle / open / close / status over src/runtime/herdr-socket.ts; every client toggles the same right-edge panel. Refuse `hud panel` when HUD_JOB_DIR is set (panel_worker_forbidden). Add `dockMode: overlay | push` (default overlay) under Settings -> Panel, applied live with dock.configure on save together with the width. openCommandPane opens editor / git show tabs from inside the dock (HERDR_DOCK=1, no HERDR_PANE_ID). Delete the split bookkeeping: src/integrations/panel/README.md and receipt.ts (move displayTarget to src/cli/panel.ts), openPanelPane / closePanelPane / panelPaneExists / watchPanelCaller, TreeWidthKeeper / herdrWidthKeeper, pi per-session split tracking, and the split-only fakes and tests. Keep: who may open the panel (explicit /hud or hud panel only, worker exclusion, session binding), `hud panel --here` and the outside-herdr fallback, panel reload, job tab actions (focus, pin, hide, stop). Update docs/reference.md, install.d/README.md and the skill/command messages (report opened/closed, not a pane id). Removes: the panel as a tiled split pane (replaced by the dock; owner approved 2026-11-26).

- [x] hud panel and pi /hud send dock.* requests with the configured dockMode and width; HUD_JOB_DIR refuses; --here still runs in the foreground (tests)
- [x] Saving dockMode or width in Settings calls dock.configure live; editor and git show tabs open from inside the dock (tests)
- [x] No split_reply_lost, PanelStore, TreeWidthKeeper, watchPanelCaller or openPanelPane left in src/
- [x] docs and client messages updated

## Comments

- Landed in this commit (replay base 4fd1123616402c37078816ef1e9b101df63d540a); gate 5/5 passed.
