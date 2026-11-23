# 02: Claude CLI workers get the HUD worker tools loaded up front

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Scans and fable's review: Claude Code workers see hud_report/hud_progress/hud_sonic/hud_ask/hud_lease as deferred tools; ToolSearch for them returned empty 19/19 times, workers then guessed arguments (invalid_arguments) and started ~0 sonic children vs 1.6-2.8 for pi. Find how the Claude worker launch (src/mcp/cli-worker-startup.ts, harness-cli) can make these tools always loaded (Claude settings/env for tool search, or MCP server config), apply it to Claude worker launches only, and verify with a real headless claude worker that the first turn lists the five tools.

- [ ] Report names the mechanism and its source (Claude docs/flags/env) and the change made
- [ ] Live: a claude worker job's transcript shows the HUD worker tools available without a ToolSearch call
- [ ] Owner's own Claude settings untouched

## Comments
