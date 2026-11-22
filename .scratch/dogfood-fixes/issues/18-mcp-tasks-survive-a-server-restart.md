# 18: MCP tasks survive a server restart

**Status:** done
**Blocked by:** none
**Owner try:** no

**What to build:** 2026-11-22: after the owner ran `/mcp` to reconnect hud (needed to load the landed dogfood-fixes/16), Claude Code polled every outstanding task (about ten: lands, creates, sends) and each came back `Unknown or expired task`. The jobs and flows kept running, but the main session lost every completion notice and had to poll by hand. Task state lives only in the hud-mcp process (`tasks`, `activeTasks`, `landTasks` in src/mcp/thin-main.ts). Persist enough per task under `$HUD_HOME` (private files with a TTL bound): task id, job or flow id, fence, createdAt, report/attention baselines and caller. A new server process then answers `tasks/get` and `tasks/result` for tasks it did not create, by re-reading the job or flow, and delivers the same single terminal notice. Expired TTL keeps today's reply. Land tasks (flow ids) are re-read from the flow file.

- [x] Start a create task and a land task, restart the server process, poll both by task id: working, then completed once the job reports or the flow ends, each with the same text a never-restarted server would give
- [x] A task past its TTL still returns the expired reply; persisted task files are bounded and private
- [x] Targeted thin-mcp task tests pass

## Comments

- Landed dc12a5dc20fad81069ae4fb8d5d11db686b57f6f; gate 5/5 passed.
