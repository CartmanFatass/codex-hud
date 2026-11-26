# 01: MCP hot reload waits for idle instead of holding new calls behind in-flight ones

**Status:** ready-for-agent
**Owner try:** no
**Live try:** during a hud_land of a MyHUD job (which rebuilds dist), call hud_tickets guide and hud_peek from the main session: both return within a second
**Blocked by:** none
**Objective:** unattended

**What to build:** Diagnosis job j728520f939adb5de (read its full report). Today packages/hud-mcp/bin/hud-mcp.mjs:34-40,69-76 starts a reload as soon as the build stamp changes and drains ALL outstanding calls before handing off; new stdin lines wait for the handoff, so a ticket edit waiting minutes on the main-checkout lease holds unrelated calls (guide, peek, even ping) for minutes (reproduced 121 s). Change: defer starting the reload until no call is in flight; keep dispatching new calls to the current generation meanwhile; reload on the next idle moment. Never migrate or replay a mutation. Adapt the existing 'rebuild drains overlapping' test in tests/unit/thin-mcp-reload.test.mjs: a changed stamp with one long call in flight leaves new guide/peek/ping answering in milliseconds, no call is replayed, the reload happens once idle and state is preserved.

- [ ] With a stamp change and a long in-flight call, new unrelated calls answer within 50 ms on the old generation (test)
- [ ] No call is replayed; the reload happens at the first idle moment and preserves state (test)
- [ ] Existing reload tests pass; docs/ARCHITECTURE.md reload note updated

## Comments
