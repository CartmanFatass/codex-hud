# 03: A running HUD MCP server and watcher pick up a rebuilt HUD

**Status:** done
**Blocked by:** none

**What to build:** Found 2026-11-22: the main session's hud MCP server and the watcher ran yesterday's code all day; every landed MCP/watcher change stayed inactive until a manual /mcp reconnect, and killing the server loses in-flight MCP task notices. Make the server and watcher notice a newer build (e.g. dist build stamp) and switch to it at a safe point without the client reconnecting and without losing MCP tasks (tasks are recoverable from job files) — e.g. a stable stdio front that restarts its worker half between calls, and a watcher that re-execs when idle. Design note first in the report if the approach changes the spec.

- [x] After npm run build in the HUD checkout, the next tool call is served by the new code with no client action
- [x] An MCP task started before the switch still completes with one notice
- [x] The watcher runs the new code within a minute of a build
- [x] npm test and check:fixtures pass

## Comments

- 2026-11-22: landed d8b1f67b via sonic gate (same gate; needs one /mcp reconnect to move off the pre-fix launcher).
