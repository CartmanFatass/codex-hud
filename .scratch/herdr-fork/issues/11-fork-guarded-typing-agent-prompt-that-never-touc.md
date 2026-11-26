# 11: Fork: guarded typing (agent.prompt that never touches a draft)

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** herdr-fork/07
**Objective:** herdr-fork

**What to build:** D-2026-11-26-01 step 2c, moved into the first install. A guarded form of `agent.prompt` (flag or method): it types and submits only when the agent is idle and interactive_ready, the prompt line is empty, the pane is not scrolled back, and no key arrived from a client in the last few seconds (configurable, default 3 s); otherwise it refuses with a machine-readable reason (`draft_present`, `scrolled_back`, `recent_input`, `not_ready`). Prompt-line emptiness is per agent kind (claude, codex, agy, pi); where herdr cannot tell, it refuses with `prompt_unknown` rather than guessing. The guard's state is in memory only, never recorded or exported. Capability flag in ping. Branch hud-11 from `hud`, merge; never push; never install or touch the running server.

- [ ] Tests per kind: empty idle prompt submits; a typed draft, scroll-back or a key 1 s ago refuses with its reason and writes nothing
- [ ] Unknown prompt state refuses with prompt_unknown; no guard state appears in snapshots, handoff or logs (tests)
- [ ] ping capability; release build; full suite no new failures; merged on `hud`

## Comments
