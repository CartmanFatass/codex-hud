# 11: Gate flakes collected after test-flakes/10

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Running list; dispatch when it has a few entries or a case repeats. Same approach as test-flakes/04-06 (wait on events under the test's own signal via tests/helpers/until.mjs; keep every assertion and product bound). Cases: (1) `watcher polls after permanent startup failure, handles a newly settled job and exits` (tests/unit/job-retention-watch-faults.test.mjs; an earlier fix was test-flakes/03), gate feff4a7a7da010134 on 2026-11-26, log ~/.hud/flows/feff4a7a7da010134.json.gate-1.log. (2) `land train timings count one paid gate for a synthetic three-job queue instead of three` (tests/unit/thin-mcp-land-train.test.mjs), gate fc63a9336ac721a5f, log ~/.hud/flows/fc63a9336ac721a5f.json.gate-1.log; probably the same land-train test that fails in worker shells where GIT_EDITOR=false (passes in the gate): now seen in the gate too. (3) `oracle runs locally on claude fable with oracle.md and falls back to pi architect` (tests/unit/role-places.test.mjs), same gate.

- [ ] Each listed case passes 20 consecutive runs under load (tests/run-mjs.mjs with parallel workers)
- [ ] No assertion or product bound weakened
- [ ] Live try: none

## Comments
