# 01: Launch facts: valid thinking per model, next place on a failed launch, worker HUD home

**Status:** done
**Blocked by:** none

**What to build:** Starts after WORKER-MCP lands (same launch path). The model facts record which thinking levels each model supports (today only a boolean, src/roles/model-discovery.ts:21); every dispatch maps an unsupported level to the nearest supported one and names it; a place whose launch fails before the worker takes any input is skipped for that dispatch and hud_create tries the next place in the same call, returning the places tried; in worker mode the HUD home comes from the job directory, so worker tools work under Codex without HUD_HOME forwarded. Spec §2.1 (owner 2026-11-21). Proposal: oracle report j61e7649cba37181c A1, A2, A8.

- [x] A sonic or imp dispatch with an unsupported thinking level launches with the nearest supported level and the result names it
- [x] A launch that fails before input falls through to the next available place in one hud_create call; the result lists the places tried and the real cause of each failure
- [x] Worker tools resolve the HUD home from the job directory when HUD_HOME is unset
- [x] Main-path tests for the three behaviours pass

## Comments
