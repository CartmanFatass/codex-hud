# 02: HUD MCP tool descriptions say the same in fewer bytes

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Survey 2026-11-22: agy reads HUD's MCP schemas from ~/.gemini/antigravity-cli/mcp/hud/*.json (12 files, ~10.9 KB, hud_create.json 3.3 KB) before its first MCP call in every conversation; Claude and Codex load the same descriptions. Trim tool and parameter descriptions without losing protocol facts the MCP owns (valid values, which parameter applies to which role/harness, defaults, side effects). Measure bytes per tool before and after.

- [ ] Per-tool description bytes before/after in the report; total down ≥ 30%
- [ ] No parameter, enum value, default or side-effect statement lost (a test or a checked list in the report)
- [ ] MCP tool names and schemas' shapes unchanged; thin-mcp tests pass

## Comments
