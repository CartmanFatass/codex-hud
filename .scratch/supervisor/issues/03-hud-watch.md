# 03: `hud watch`

**What:** `hud watch` prints the `jobChanges` lines for jobs dispatched from the caller's pane (looked up at call time,
never stored), watching the job files the way `hud-watch.mjs` does; no new writes. The HUD convention gets one line
("Claude Code: run `hud watch` under Monitor"), and `hud_create`'s result repeats the hint. pi: its HUD extension
posts the same lines into the session if pi's API allows; else record why. Nothing is typed into a pane.

**Who:** imp (agy) · **Size:** ~100 lines · **Blocked by:** 02 · **Status:** resolved

- [x] Temp HUD_HOME: three transitions and one `qa/q1.md` give four lines
- [ ] Real check by the orchestrator: Claude Code under Monitor, the owner closes a worker tab, the session reacts untold

## Comments
- 2026-11-14 (orchestrator): landed with 01–03 (2c5d7e1d, 52b21b91, 458ef06b; 489/489).
- The orchestrator now runs `hud watch` under Monitor itself (2026-11-14). pi: the HUD package contract has no send-message call, so pi relies on `changes` in MCP responses.
