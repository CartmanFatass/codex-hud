# 20: Batch creates in a task session use MCP tasks

**Status:** ready-for-agent
**Blocked by:** role-overrides/01 (same `hud_create` code)
**Owner try:** no

**What to build:** Owner 2026-11-22: a worker question from a batch-created job arrived in the main session's prompt as typed text, so it looked like the owner had pasted it ("这不是我贴的 不知道为什么没走mcp"). Cause: `hud_create({jobs:[...]})` returns plain JSON, and in a task-capable session its items' notices are pushed into the caller pane with `notify` (`pushBatchNotices` in src/mcp/thin-main.ts). One tool call can carry only one MCP task.

In a session whose client supports MCP tasks, `hud_create` with `jobs` returns an error before creating anything: "In a task session, send one hud_create per job as parallel calls; each gets its own MCP task." Sessions without task support keep batch create and its pane delivery as today. Say this positively in the `jobs` field description ("batch create for sessions without MCP tasks; task sessions send parallel single creates"). Remove the batch pane-push path only if nothing else uses it.

- [ ] Task client: batch create errors and creates no job; single creates in parallel each return a task
- [ ] Non-task client: batch create unchanged
- [ ] Targeted MCP task tests pass

## Comments
