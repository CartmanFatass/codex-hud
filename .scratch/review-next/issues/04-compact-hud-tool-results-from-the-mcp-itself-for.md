# 04: Compact HUD tool results from the MCP itself for every client

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Reviews (fable §3, carbon #5): the Claude mod's compact `key: value` result (integrations/claude-mod/hooks/compact.ts) only helps Claude. Move the serializer into hud-mcp so Codex, pi and agy main sessions get the same compact results; keep JSON for errors and behind `HUD_MCP_JSON=1` for tests; the mod keeps merging and the report-read guard and stops re-compacting. Worker MCP results unchanged unless trivially shared.

- [ ] All main-session hud_* results are compact text; errors stay JSON
- [ ] Byte saving on the mod's existing sample ≥ same as today
- [ ] Tests that assert JSON use HUD_MCP_JSON=1 or parse the compact form
- [ ] `claude plugin test integrations/claude-mod` passes

## Comments
