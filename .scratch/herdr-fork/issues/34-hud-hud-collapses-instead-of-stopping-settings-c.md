# 34: HUD: /hud collapses instead of stopping; Settings choose the dock side and keep the dragged size

**Status:** ready-for-agent
**Owner try:** yes
**Live try:** In Claude Code, Codex, pi and a shell pane: /hud shows and collapses the same panel instantly with its state kept; `hud panel close` stops it; Settings -> Panel -> Side moves it to left/bottom; a dragged size survives hide/show and a new session.
**Blocked by:** 32

**What to build:** MyHUD side of D-2026-11-27-01, after the fork exposes hide/show, side and dock.resized. `hud panel` / every client's /hud (Claude mod, Claude/Codex command and skill, pi /hud) call `dock.toggle` = show/collapse; `hud panel open`, `close` (stops the panel) and `status` (reports shown/hidden/closed); `/hud off` collapses, `/hud close` stops. Bar/band `[Open]` shows a collapsed dock. Settings -> Panel gains Side (right/left/bottom, applied live via dock.configure); the panel persists the size from `dock.resized` into the existing width setting (plus a bottom height setting), so drag and Settings stay one value. A collapsed panel stops its own periodic collection work until shown again (lightweight rule), then refreshes once on show. docs/reference.md updated (zh in the translation pass).

- [ ] Tests: every /hud entry point sends dock.toggle; close stops; status reports shown/hidden/closed
- [ ] Test: Settings Side applies dock.configure live; dock.resized updates the saved size
- [ ] Test: a collapsed panel runs no periodic collection and refreshes once on show
- [ ] npm test, npm run test:mjs and check:fixtures pass

## Comments
