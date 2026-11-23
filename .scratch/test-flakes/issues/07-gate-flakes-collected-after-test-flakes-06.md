# 07: Gate flakes collected after test-flakes/06

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Running list; dispatch when it has a few entries or a case repeats. Same approach as test-flakes/04-06 (wait on events under the test's own signal via tests/helpers/until.mjs; keep every assertion and product bound). Cases: (1) `working tabbed job with unreadable sessions stays open through housekeeping errors and is reaped` (tests/unit/job-retention.test.mjs), gate fc9eab8ce8a033339, log ~/.hud/flows/fc9eab8ce8a033339.json.gate-1.log. (2) `supervisor edges: stalled submission stays supervised; pre-input rejection closes its tab` (tests/unit/thin-mcp-cli-process.test.mjs), gate f255f4d29c99696bf, log ~/.hud/flows/f255f4d29c99696bf.json.gate-1.log. (3) `quiet past grace turns waiting_orchestrator without pane notices and self-wake returns to working` (tests/unit/thin-mcp-cli-turns.test.mjs), gate f255f4d29c99696bf-2, log ~/.hud/flows/f255f4d29c99696bf-2.json.gate-1.log.

- [ ] Each listed case passes 20 runs under parallel load with no assertion weakened
- [ ] No production change unless a real bug is found; if one is, the report names it

## Comments
