# 12: Gate flakes collected after test-flakes/11

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Running list; dispatch when it has a few entries or a case repeats. Same approach as test-flakes/04-06 and /11 (wait on the test's own signal via tests/helpers/until.mjs; keep every assertion and product bound). Cases: (1) `an open sonic child holds the real CLI supervisor; uncollected reports get one fixed prompt` (tests/unit/thin-mcp-quiet-decision.test.mjs), gate fcbf5afcb9206fe39 on 2026-11-26, log ~/.hud/flows/fcbf5afcb9206fe39.json.gate-1.log; repeated in gates fdcf6237e50d3083e, f4e11a395caf1968f and f32689254863c99d4. (2) `cli-supervisor guards pane-exit-only writes against SESSION replacement` (tests/unit/herdr-fork-direct-exec.test.mjs), gate f9537918e0da7e9fe, log ~/.hud/flows/f9537918e0da7e9fe.json.gate-1.log. (3) `land bounds a hung gate and kills children holding the output pipes` (tests/unit/thin-mcp-land-gate.test.mjs), gate f32689254863c99d4, log ~/.hud/flows/f32689254863c99d4.json.gate-1.log (custodian timing from workflow/09). (4) `hud_read wait_ms and hud_wait wake within 100 ms, resist sessions ELOOP, settle on timeout, and leak zero watchers` (tests/unit/thin-mcp-read-wait-send.test.mjs), gate fdcf6237e50d3083e.

- [ ] Each listed case passes 20 consecutive runs under load (tests/run-mjs.mjs with parallel workers)
- [ ] No assertion or product bound weakened
- [ ] Live try: none

## Comments
