# 06: HUD: direct-exec readiness waits for interactive_ready before the first prompt

**Status:** done
**Owner try:** no
**Blocked by:** herdr-fork/05
**Objective:** herdr-fork

**What to build:** `waitDirectReady` (src/mcp/dispatch/direct-exec.ts:232) treats agent_status idle/done as ready; stock herdr `agent start` (herdr-hud src/cli/agent.rs:414-490) requires interactive_ready=true for idle/done, keeps polling while launch_pending, and accepts codex unknown only with interactive_ready. Mirror that for CLI and Pi direct launches: ready = (idle|done) && interactive_ready, or codex unknown && interactive_ready (keep the screen composer check as fallback); keep polling while launch_pending or not yet interactive; PID/start death stays agent_start_failed; deadline stays agent_not_ready with retained receipt (04 behaviour). Pass the kind's start timeout as `timeout_ms` to direct-exec agent.start. Lands only after the fork from herdr-fork/05 is installed (main installs); tests use the fake herdr.

- [x] Fake herdr reporting idle without interactive_ready: no prompt is sent until interactive_ready=true; then exactly one agent.prompt (CLI and Pi tests)
- [x] Codex unknown with interactive_ready=true is ready; idle with launch_pending=true is not (tests)
- [x] Live on the installed fork: one claude, one agy and one pi job each run their first prompt without manual input, report, and their tab closes on its own

## Comments

- Landed in this commit (replay base dd5e7f7c2991d130ff20e363c1e824cdc13bd986); gate 5/5 passed.
