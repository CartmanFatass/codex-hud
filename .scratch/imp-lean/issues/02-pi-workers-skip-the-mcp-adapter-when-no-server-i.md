# 02: pi workers skip the MCP adapter when no server is configured; short briefs inline

**Status:** done
**Blocked by:** none

**What to build:** Ranks 3 and 6 (launcher part). In the pi dispatch path (src/mcp/thin-main.ts dispatchPi and the pi-role launch args), when the job does not set `mcp` and pi's MCP config lists no servers, start without the MCP adapter. When the brief is under 16 KB, put its text in the first user message so turn 1 is not a read of brief.md (the brief file stays on disk). Spec §2.1.4 switches line unchanged unless the default changes visibly; if it does, one sentence, told to the owner.

- [x] With an empty pi MCP config a pi worker launches without the adapter; `mcp: true` still enables it
- [x] A short brief arrives inline and the worker does not read brief.md first
- [x] npm test and check:fixtures pass

## Comments

- 2026-11-22: landed 6fc6d5a3 via sonic gate (test:mjs 1027/1027 on run 2 (run 1: one unrelated CLI timing flake), unit 92/92, fixtures OK; live: briefs arrive inline, MCP adapter off once ~/.config/mcp/mcp.json was emptied).
