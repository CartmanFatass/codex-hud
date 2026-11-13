# 05: A Claude Code role works

**What to build:** `agent: "claude"` roles run like grok roles, so the owner can, for example, register a front-end
design role on a Claude model. Claude's trust dialog is herdr `blocked` with the cursor on "No, exit": a bare Enter
declines it; launch fails with the reason. The worker's own Claude statusline and the HUD MCP load inside it as in any
Claude session; that is fine. The HUD's Claude caller binding (by the pane's own session id) keeps showing the main
session, not a worker's.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] claude row in the per-kind table; trust path fails cleanly (test)
- [ ] An example role file in the docs (e.g. a design role on an Opus/Sonnet model)
- [ ] One real Claude job by hand (haiku, low effort), recorded in the comments

## Comments

- 2026-11-13 orchestrator: implemented by imp on grok-4.7 high. Real runs through the new MCP (isolated HUD_HOME,
  haiku, effort low, 60 s grace): untrusted dir → launch failed "claude has not trusted …" and `~/.claude.json` did
  not gain the dir; trusted dir → report in 12 s → idle_grace → `/quit` → closed (settled) → reaped, tab closed;
  `agent_session_id` recorded; the transcript stayed in Claude's own project store, no session files in the job dir.
  (The model listed the job dir instead of its cwd for the test prompt "the current directory": a wording issue of
  the test task, not the launch — the process ran in the requested cwd.)
