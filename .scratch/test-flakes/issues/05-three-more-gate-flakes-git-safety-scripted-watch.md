# 05: Three more gate flakes: git-safety, scripted watch lifecycle, panel reload

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Land gate fc85f76cee84bccae (gate-2 first run, log ~/.hud/flows/fc85f76cee84bccae.json.gate-2.log) failed then passed on rerun: `Claude: repository` (tests/unit/git-safety.test.mjs), `hud watch scripted lifecycle (quiet)` (tests/unit/hud-watch.test.mjs), `the live panel coalesces build bursts, retains jobs settled during its life, and keeps a broken build alive with a notice` (tests/unit/panel-reload.test.mjs). Same approach as test-flakes/01, 03, 04: find the fixed deadline or ordering assumption that breaks under parallel load, wait on the event or condition under the test's own signal (tests/helpers/until.mjs), keep every assertion.

- [x] Each of the three cases passes 20 runs under parallel load with no assertion weakened
- [x] No production change unless a real bug is found; if one is, the report names it

## Comments

- 2026-11-23: scope added via hud_send — gate fcf1b37affdc9254e also reran `a dead CLI supervisor hands its job to the orchestrator on the next scan; a live one and a pi job do not` (tests/unit/job-retention.test.mjs) and `worker checks share a 60-second deadline and timeouts kill the command process group` (tests/unit/worker-checks.test.mjs).
