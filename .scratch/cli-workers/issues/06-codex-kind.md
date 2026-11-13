# 06: A Codex role works, and the Codex bar never adopts a worker's rollout

**What to build:** `agent: "codex"` roles run like grok roles. Codex shows a spinner for up to ~30 s at startup
(phantom working → done): the launch waits for startup to settle before prompting (start timeout 90 s) and the
startup turn is never taken for a finished one. No trust dialog appears with the bypass flag. Which Codex account
runs is whatever the owner's shell gives `codex` (the HUD sets no CODEX_HOME). The Codex bar's fallback that adopts
the newest rollout in the same directory must skip rollouts that belong to HUD CLI jobs (their `agent_session_id`),
so a worker in the same repo never shows up as the main session.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] codex row in the per-kind table; startup spinner handled (test with fake herdr event sequence)
- [ ] Bar fallback skips worker rollouts (unit test with synthetic rollouts)
- [ ] One real Codex job by hand (gpt-6-luna, low), recorded in the comments

## Comments

- 2026-11-13 orchestrator: implemented by imp on grok-4.7 high. Real run through the new MCP (isolated HUD_HOME,
  gpt-6-luna, low, 60 s grace): startup spinner waited out before the prompt; the worker asked a question with
  `hud-ask` (QUESTION line reached the orchestrator pane, answer file read back), wrote the report in 31 s →
  idle_grace → `/quit` → closed (settled) → reaped, tab closed; `agent_session_id` recorded; the rollout stayed under
  the account home the owner's shell `codex()` function picked (`$CODEX_HOME/sessions/…`), nothing in the job dir.
