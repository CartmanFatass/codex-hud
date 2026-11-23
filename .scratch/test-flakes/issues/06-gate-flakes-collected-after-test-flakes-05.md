# 06: Gate flakes collected after test-flakes/05

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Running list; dispatch when it has a few entries or a case repeats. Same approach as test-flakes/04-05 (wait on events under the test's own signal via tests/helpers/until.mjs; keep every assertion). Cases: (1) `sonic stops as stalled and preserves its last progress in the digest` (tests/unit/sonic-process.test.mjs), gate f5a3bfcd187e55afa, log ~/.hud/flows/f5a3bfcd187e55afa.json.gate-1.log. (2) `bin/hud watch flushes already-failed arrivals and exits cleanly on SIGTERM` (tests/unit/hud-watch.test.mjs), gate f12118da526549850, log ~/.hud/flows/f12118da526549850.json.gate-1.log. (3) `hud-watch updates work-summary.v1.json within 200 ms of job changes and staleness is detected on watcher exit` (tests/unit/work-summary-snapshot.test.mjs), gate f83b2d2a331a03651, log ~/.hud/flows/f83b2d2a331a03651.json.gate-1.log.

- [ ] Each listed case passes 20 runs under parallel load with no assertion weakened
- [ ] No production change unless a real bug is found; if one is, the report names it

## Comments
