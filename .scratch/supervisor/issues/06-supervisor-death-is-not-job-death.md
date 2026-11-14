# 06: supervisor death is not job death; dispatch stall still supervises

**What:** `hud-watch.mjs`: supervisor gone with the worker pid alive → `waiting_orchestrator` ("supervisor exited;
worker still running"); both gone → failed. A supervisor throw does the same. Dispatch: a stall or timeout after the
prompt was submitted starts the supervisor; only a rejection before any input fails.

**Who:** imp (agy) · **Size:** ~60 lines · **Blocked by:** 05 · **Status:** ready-for-agent

- [ ] Kill the fake supervisor with the worker alive → waiting_orchestrator; both gone → failed
- [ ] `agent_prompt_stalled` after submit → job working under a supervisor
- [ ] A dispatch that fails before input (e.g. trust declined) closes the tab it opened (2026-11-14: an `imp QUIET-DECIDE-check` tab stayed open with agy never started)
