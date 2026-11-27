# 07: Two gate tests that failed once under load pass deterministically

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** The land gate's first mjs run failed and an immediate rerun passed twice today. (1) tests/unit/thin-mcp-read-wait-send.test.mjs:647 'hud_read returns unread reports in idle grace, omits read bodies, supports full and observes a second report' failed after 350 ms with `TypeError: Cannot read properties of undefined (reading 'result')` (flow log ~/.hud/flows/f23e2c0c383f2d633.json.gate-1.log line 16): an MCP reply the test indexes was missing. (2) tests/unit/thin-mcp-quiet-decision.test.mjs:310 'low probability, cap reached, and provider error all fall back to needs-human without prompting worker' got null instead of 'finished-no-report' (~/.hud/flows/f3f889d660a50be5b.json.gate-1.log line 2). Find each cause (test race, harness reply matching, or a product race) and fix it at the cause: wait for the observed event or reply rather than adding retries, longer timeouts or sleeps. If the cause is in product code, fix the product. Do not touch thin-mcp-land.test.mjs (eng-hygiene/06 owns it).

- [x] Report names each cause with file:line
- [x] Each test passes 20 consecutive runs under load (e.g. run it alongside the rest of tests/unit/*.mjs at concurrency 8, or with a CPU hog), and the report shows how you reproduced the failure before the fix if you could
- [x] No timeout raised, no retry loop added, no assertion removed

## Comments

- Landed in this commit (replay base bffe9648806a6dc68894ffc67b8dbca04caf9e5e); gate 5/5 passed.
