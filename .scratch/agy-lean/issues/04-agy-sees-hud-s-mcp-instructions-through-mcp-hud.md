# 04: agy sees HUD's MCP instructions through mcp/hud/instructions.md

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** agy-lean/03 facts (sonic j1cbc536c208ad272): agy tells its model that ~/.gemini/antigravity-cli/mcp/<server>/ may hold an instructions.md with best practices, but never writes it and does not surface the MCP initialize `instructions` HUD already sends (src/mcp/mcp/server.ts:74-77); agy models tried to read the missing file in 3 of 493 conversations. So an agy main session never sees HUD's server instructions. Have the agy install extension write HUD's main-session instructions (the same text as the initialize default variant, generated from one source) to that file, and remove it on uninstall. Verify agy keeps the file when it rewrites the tool schemas at session start.

- [x] Install writes mcp/hud/instructions.md from the same source as the initialize instructions (test: they match); uninstall removes it; re-install idempotent
- [x] Live check by the main session after install: a new agy session start leaves the file in place (stated in the report as pending if the worker cannot run agy)
- [x] npm test and test:release pass

## Comments

- Landed in this commit (replay base d8597c2a383b46cd55b5a1eecd53a3b1d5b72308); gate 5/5 passed.
