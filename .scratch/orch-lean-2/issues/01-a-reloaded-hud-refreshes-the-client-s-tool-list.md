# 01: A reloaded HUD refreshes the client's tool list

**Status:** done
**Blocked by:** none

**What to build:** docs/llm/post-change-load-2026-11-22.md Rank 3a: when the stdio MCP server hot-swaps to a newer dist build (DOGFOOD-FIXES-03, d8b1f67b) and the tool definitions changed, it sends notifications/tools/list_changed so Claude Code (and other clients that honour it) re-fetch tools without /mcp. Found live: ORCH-LEAN-05's batch forms never reached the main session because its cached hud_create/hud_tickets schemas predate them. The server advertises tools.listChanged in its capabilities.

- [x] After a reload that changes a tool schema, the client receives tools/list_changed once and tools/list returns the new schemas
- [x] No notification when the schemas are unchanged
- [x] npm test and check:fixtures pass

## Comments

- Landed 099df7ed9ad522fad5ac2b5697819f51db0135f2; gate 5/5 passed.
