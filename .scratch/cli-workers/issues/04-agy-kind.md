# 04: An agy role works

**What to build:** `agent: "agy"` roles run like grok roles: Antigravity's flags, its trust dialog (herdr `blocked`,
`agent start` exits 1; declined with down + enter, launch fails with the reason), and its startup `done` before any
prompt is never taken for a finished turn. Ships an `agy-imp` role (model left to the owner's choice of a strong
Gemini; document how to pick one with `agy models`).

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] agy row in the per-kind table; startup done ignored (test)
- [ ] Trust dialog path fails cleanly (test with fake herdr)
- [ ] One real agy job by hand, recorded in the comments

## Comments

- 2026-11-13 orchestrator: implemented by imp on grok-4.7 high. Real runs through the new MCP (isolated HUD_HOME,
  gemini-3.8-flash-low, 60 s grace): untrusted dir → launch failed "agy has not trusted …", and agy's
  trustedWorkspaces did not gain the dir; trusted dir → report in 20 s → idle_grace → `/quit` → closed (settled) →
  reaped, tab closed, no session files in the job dir. Gap: `agent_session_id` stayed null (agy publishes it after the
  first prompt, the supervisor reads it once at start); fixed in 06.
