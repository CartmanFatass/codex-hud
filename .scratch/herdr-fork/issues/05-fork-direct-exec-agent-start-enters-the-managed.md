# 05: Fork: direct-exec agent.start enters the managed launch lifecycle (launch_pending → interactive_ready)

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** herdr-fork/04
**Objective:** herdr-fork

**What to build:** Live check after herdr-fork/04 (2026-11-25): claude, agy and pi started through direct-exec all lost their first prompt. `start_agent_direct_exec` (src/app/agents.rs ~530-560) pins the declared kind and sets the name but never calls `TerminalState::begin_managed_agent`, so `launch_pending` is never true, `interactive_ready` never becomes true, and `agent.prompt` accepts input while the TUI is still starting (text lands in the editor, the delayed Enter is lost; agy printed it above its banner). The shell path (agents.rs:236-280) uses begin_managed_agent with AGENT_START_SETTLE_DELAY and the request timeout. Make direct-exec starts with a name use the same managed lifecycle (Pending until detection shows the declared kind settled, then Active), so `agent.get` reports launch_pending/interactive_ready and `agent.prompt` refuses with agent_not_ready while pending. Accept `timeout_ms` on direct-exec starts with the shell-path bounds. A managed timeout or kind mismatch must not kill or close the direct-exec process (it only clears pending/name as the shell path does); process exit keeps today's on_exit behaviour. Codex prompt-ready (`observe_codex_prompt_ready`) must work for direct-exec too. Work in ~/projects/herdr-hud on a branch from `hud` (e.g. hud-05), merge into `hud`; never push; do not install or touch ~/.local/bin/herdr or the running server.

- [ ] Direct-exec start with a name: agent.get shows launch_pending=true right after start and interactive_ready=true once the declared agent is detected idle after the settle delay (Rust test with a fake agent)
- [ ] agent.prompt on a pending direct-exec agent returns agent_not_ready and writes nothing to the pane (test)
- [ ] Managed timeout and kind mismatch on a direct-exec start leave the process running and the tab open; clean and nonzero exits keep the 02 on_exit behaviour (tests)
- [ ] Codex prompt-ready detection makes a direct-exec codex interactive_ready (test)
- [ ] cargo build --release and the touched test modules pass; full suite shows no new failures vs 3027f8dd; merged on `hud`; nothing pushed or installed

## Comments
