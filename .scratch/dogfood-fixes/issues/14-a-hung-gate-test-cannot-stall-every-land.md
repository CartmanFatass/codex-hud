# 14: A hung gate test cannot stall every land

**Status:** done
**Blocked by:** none
**Owner try:** no

**What to build:** 2026-11-22 19:36Z: the OPTIONAL-ROLES-01 land's gate sat 45 min in `npm run test:mjs` because one child (`tests/unit/project-progress.test.mjs`, run with `--test-timeout=0`) never exited; five more lands queued behind the main-checkout lease and nothing reported. Killing that child let the gate continue. Fix both sides: (1) every land gate and after command runs under a per-command deadline (`land.timeout_s` in .hud/project.json, default 900 s) that kills the process tree and fails the step as `timeout` with the last output lines; a timed-out test file gets the same one rerun as a red file (DF-09); lands queued on the lease show `waiting for <flow> (gate step N, M min)` in hud_read and the panel. (2) test:mjs and test:unit run with a per-test timeout (e.g. `--test-timeout=60000`, longer only where a file declares it) so one hung test fails fast. (3) Find why project-progress.test.mjs hung under the gate (a child or watcher left open, a wait without a deadline) and fix it. (4) If the main session commits an unrelated ticket after a land has fast-forwarded and before it pushes, allow the checked-out base HEAD to have advanced, provided it still descends from the landed tip (including records) and the landed paths are clean. Push that HEAD and finish cleanup. (5) Reap detached fixture watchers after test timeouts and if a test run is killed, for both thin-MCP and role-places fixtures.

- [x] A synthetic gate command that never exits fails the land step as `timeout` after land.timeout_s and frees the lease
- [x] A test that never resolves fails within the per-test timeout instead of hanging the run
- [x] project-progress.test.mjs passes 20 runs in a row under full parallel load
- [x] A land pushes an advanced base HEAD after fast-forward, including records, and finishes cleanup; it refuses dirty landed paths
- [x] A killed test run leaves no watcher with either fixture's temporary HUD_HOME
- [x] npm test and check:fixtures pass

## Comments

- The live Progress tests removed the fixture before stopping the panel. A removal error skips later `node:test` teardown hooks, so the live panel and its pipes can outlast the test. Teardown now stops the child before removing its files, and the child wait is bounded independently. The focused regressions and `check:fixtures` passed; `npm test` is left to the land gate.

- Landed dc9c20d3cb2dc47ea5ced14bafd249ce27cd8aee; gate 5/5 passed.
