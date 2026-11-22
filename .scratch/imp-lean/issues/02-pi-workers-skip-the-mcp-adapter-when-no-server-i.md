# 02: pi workers skip the MCP adapter when no server is configured; short briefs inline

**Status:** claimed
**Blocked by:** none

**What to build:** Ranks 3 and 6 (launcher part). In the pi dispatch path (src/mcp/thin-main.ts dispatchPi and the pi-role launch args), when the job does not set `mcp` and pi's MCP config lists no servers, start without the MCP adapter. When the brief is under 16 KB, put its text in the first user message so turn 1 is not a read of brief.md (the brief file stays on disk). Spec §2.1.4 switches line unchanged unless the default changes visibly; if it does, one sentence, told to the owner.

- [ ] With an empty pi MCP config a pi worker launches without the adapter; `mcp: true` still enables it
- [ ] A short brief arrives inline and the worker does not read brief.md first
- [ ] npm test and check:fixtures pass

## Comments
