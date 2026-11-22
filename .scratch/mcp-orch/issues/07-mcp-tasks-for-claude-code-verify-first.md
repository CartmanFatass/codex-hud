# 07: MCP tasks for Claude Code (verify first)

**Status:** done
**Blocked by:** none

**What to build:** Pulled forward from the M5 candidates (spec). First verify, in a real Claude Code session, how MCP tasks wake the session, cancel and show in /tasks; report before building. Then one task per worker turn (hud_create, hud_send, hud_respond) ending at a report or question; the result is state, report path and a one-line summary, not a read; cancel closes the job; such clients do not see hud_wait, hud watch, changes or watcher_alive. Removes the 30-minute Monitor re-arm.

- [x] A written verification of Claude Code's wake, cancel and /tasks behaviour with MCP tasks
- [x] If verified: a Claude main session dispatches and is woken at report or question without hud watch
- [x] Main-path tests pass

## Comments
- 2026-11-21 verify phase (job j70542da6fda0ba80, probe in tmp/tasks/MCPORCH-07/probe/): Claude Code 2.1.330 ignores the
  2025-11-25 `params.task` flow but supports the 2026-07-28 `io.modelcontextprotocol/tasks` extension (`server/discover`,
  flat `resultType:"task"` from `tools/call`, `tasks/get` polled every 5 s). The turn ends at once, `/tasks` lists the
  task, an idle session is woken with a `<task-notification>` carrying the result, a 620 s task worked, cancel from
  `/tasks` sends `tasks/cancel` twice. Unverified: wake across reconnect or process exit, durations beyond 10 minutes.
  Build phase: MCPORCH-07b.
