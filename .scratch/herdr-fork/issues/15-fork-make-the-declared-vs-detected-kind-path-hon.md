# 15: Fork: make the declared-vs-detected kind path honest

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none
**Objective:** herdr-fork

**What to build:** Milestone review 2026-11-26 item 2 (docs/reviews/2026-11-26-worker-stage-milestone.md): herdr-fork/05 made a detected kind win over the declared one, but the detector is pinned to the declaration (`src/pane.rs:3027–3047,3086–3112`, handoff `1016–1052`), so a conflicting root is never observed and the test injects a StateChanged after the suppressing stage. Choose the simpler honest form: either remove the dead detected-wins path and its test (declared kind is authoritative for direct-exec, as HUD always declares correctly), or detect a recognized conflicting ROOT kind during managed startup through the real detector path (never tool children). Recommendation: remove. Also document in HUD-FORK.md that a Blocked startup returns `agent_blocked` before `agent_not_ready`. Fork worktree on its own branch from `hud`; do not merge (main merges); never push or install.

- [ ] No code path or test claims a detected kind overrides the declaration unless the real detector can observe it (test through the detector, if kept)
- [ ] HUD-FORK.md documents the agent_blocked ordering; release build and full suite no new failures

## Comments
