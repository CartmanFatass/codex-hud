# 12: The orchestrator is woken only for events it must act on

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Owner decision 2026-11-25: the main session is woken only when it has something to do. Today every single job's routine checkpoint (`still working at 10 min: tool ...`) and queue position (`queued (#N)`) produces its own orchestrator wake line, although main never acts on them: HUD's stall detection already delivers a failure, and `hud_create` already returns the queued state and position. Change the shared quiet watcher (Claude mod, pi, `hud watch` incl. `--queue`; same scope as claude-mod/11 in `src/cli/watch.ts` / `src/cli/watch-batches.ts`) so it delivers: report ready/settled, failed/stalled/stopped, questions, failing checks results, land/flow results, and batch rollups/final lines from claude-mod/11. Routine checkpoints and queue positions are no longer delivered as wakes; they stay visible in the panel, `hud_peek` and `hud_read`. Verbose watch keeps showing everything. Update docs/reference.md and any convention/skill text that tells the main session to expect checkpoint lines.

- [ ] A single job's `still working` checkpoints and `queued (#N)` positions produce no orchestrator wake in quiet watch; they remain visible via hud_peek/panel.
- [ ] Report-ready, failure/stall/stop, questions, failing checks and land/flow results still wake immediately.
- [ ] Verbose watch unchanged; claude-mod/11 batch behaviour unchanged.
- [ ] Tests cover the dropped and kept event kinds.
- [ ] Land gate passes.

## Comments
