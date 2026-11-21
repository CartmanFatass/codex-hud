# 07: MCP tasks for Claude Code (verify first)

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Pulled forward from the M5 candidates (spec). First verify, in a real Claude Code session, how MCP tasks wake the session, cancel and show in /tasks; report before building. Then one task per worker turn (hud_create, hud_send, hud_respond) ending at a report or question; the result is state, report path and a one-line summary, not a read; cancel closes the job; such clients do not see hud_wait, hud watch, changes or watcher_alive. Removes the 30-minute Monitor re-arm.

- [ ] A written verification of Claude Code's wake, cancel and /tasks behaviour with MCP tasks
- [ ] If verified: a Claude main session dispatches and is woken at report or question without hud watch
- [ ] Main-path tests pass

## Comments
