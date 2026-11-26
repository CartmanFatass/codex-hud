# 13: Gate flakes collected after test-flakes/12

**Status:** needs-triage
**Owner try:** no
**Blocked by:** none

**What to build:** Running list; dispatch when it has a few entries or a case repeats. Same approach as test-flakes/11-12 (wait on the test's own signal via tests/helpers/until.mjs; keep every assertion and product bound; fix the product when it is a product bug). Cases: (1) tests/unit/thin-mcp-council.test.mjs, two different tests: `shipped council defaults to main synthesis and returns member digests and instructions` (gate fc1160458e4c531cc, log ~/.hud/flows/fc1160458e4c531cc.json.gate-1.log) and `shipped council runs three independent members and one browser synthesis; only the council notifies` (gate fdb813f60a81801ef, log ~/.hud/flows/fdb813f60a81801ef.json.gate-2.log). (2) `hud-mcp updates work-summary.v1.json on hud_respond without overriding a fresh matching hud-watch snapshot` (tests/unit/work-summary-snapshot.test.mjs), gate fdb813f60a81801ef.

- [ ] Each listed case passes 20 consecutive runs under 16-way load
- [ ] No assertion or product bound weakened
- [ ] Live try: none

## Comments
