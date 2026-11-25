# 08: Engine milestone fixes: prewalk survives MCP disconnect, batch presets stay pinned, land retry and upgrade

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none
**Objective:** engine

**What to build:** Fix the four blocking findings of `docs/reviews/2026-11-25-engine-milestone.md` in one pass (read it; file:line evidence there). (1) An orderly MCP disconnect (stdin close) must retire the host without stopping an accepted prewalk: cursor, scout jobs and reserved target stay adoptable; only an explicit job stop cancels. Test with stdin close during a live scout. (2) A fixed-batch member keeps its frozen preset in the reserved (prewalk) launch path: no even-pool replanning or quota rotation when `batch_flow` is set; a refused scouted pilot reports failure. Fix it by sharing one attempt/fallback decision between the direct and reserved launch loops in `src/mcp/dispatch/orchestrator.ts` (the review's optional item; the drift between them is the cause), leaving admission, task creation and caller hooks outside it. (3) Land: a witnessed Git refusal that provably left main unchanged clears `publish_pending` so a later `hud_land` can retry; host death, timeout or an unknown result keep the interlock. Test both. (4) Compatibility bootstrap `packages/hud-mcp/bin/land-runner.mjs`: do not send `ready` to a pre-upgrade caller it cannot serve; refuse before ready with an explicit incompatible-generation error the old ticket queue reports (simplest; no legacy-protocol emulation, no replay of legacy Git effects). Also delete the `pane!` assertion at `src/mcp/dispatch/orchestrator.ts:601` (review: unreachable, no new guard). Out of scope: the other optional items (tracked separately or dropped), workflow/05-07.

- [ ] Stdin close of the MCP during a live prewalk scout: after restart the target launches once; an explicit stop still cancels
- [ ] Two-preset imp batch with scouts and a refused pilot reports the failure and never runs on the other preset; direct and reserved launches share one attempt/fallback decision
- [ ] Refused ff-merge with main unchanged: a new hud_land attempt runs; unknown result: no new attempt
- [ ] Old-generation land caller gets an explicit incompatible-generation failure, never a silent exit after ready
- [ ] pane! assertion removed
- [ ] Land gate passes

## Comments
