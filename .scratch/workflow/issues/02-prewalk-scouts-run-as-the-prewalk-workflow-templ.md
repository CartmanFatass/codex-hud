# 02: Prewalk scouts run as the prewalk workflow template

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 01

**What to build:** `.scratch/workflow/spec.md` slice 2. Add the `job` step kind and an inline host (in the MCP, `host: "mcp"` recorded) plus watcher adoption of an orphaned inline run into a detached runner. Ship `prewalk.toml` (optional Sonic fan-out → target job, `from` scouts, breaker `none`, scouts outside the role cap, target id reserved before scouts). Both launch paths (`dispatchWithKey` and `startQueuedJob` in `src/mcp/dispatch/orchestrator.ts`) call the engine; remove the duplicated scout orchestration (`runPrewalkScouts`, `pendingScouts`, `scoutedCreates`). Behaviour unchanged: `scouting` status, `prewalk`/`scout_state`/`scout_error` receipt fields, the "Scout failed" brief note, owner pool picks, stop text, MCP task continuity.

- [ ] `thin-mcp-prewalk` and scout tests pass unchanged.
- [ ] A test kills the inline host mid-scout and the watcher adopts the run; the target still starts once.
- [ ] Added time per scouted create measured and reported.
- [ ] Land gate passes.

## Comments

- 2026-11-25 main: scope (owner, D-2026-11-25-08): the engine ships only batch, prewalk, council and land templates; tickets 05-07 are deferred. workflow/02, 03 and 04 are built in parallel on the landed engine (4dbb54ab) and each adds a step kind: keep step-kind registration additive so the lands compose. Run the focused tests once at the end; the full gate is the land's job.
