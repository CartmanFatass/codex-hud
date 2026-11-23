# 08: Sweep fixed short waits in watcher and MCP tests

**Status:** done
**Owner try:** no
**Blocked by:** test-flakes/07

**What to build:** test-flakes/01-07 fixed ~20 gate flakes one by one; nearly every one was a fixed inner deadline (5-10 s or a 200-350 ms sleep) that breaks under parallel load. test-flakes/07's report (job j3b98819a7df56764, hud_read it) lists the remaining explicit sub-10 s waits by file:line across tests/unit/thin-mcp-*.test.mjs, job-retention*, hud-watch*, plus tests/helpers/job-retention-fixture.mjs:73 whose bare waits inherit a 5 s limit. Sweep them in one pass: helpers' default waits follow the enclosing test signal (60 s test timeout) instead of a short fixed limit; sleeps used as 'nothing happened' checks become waits on a later observable event (a watcher summary, a status query) as test-flakes/07 did. Keep every assertion and every product timing bound (e.g. 'within 200 ms', configured graces). Split into two commits if large (helpers first, then call sites).

- [x] No fixed sub-10 s wait remains as a correctness bound in the listed files unless it is a product bound, which the report lists with the reason
- [x] Full `npm run test:mjs` passes 5 times in a row while 3 other test:mjs runs load the machine
- [x] No assertion removed or weakened; test-only unless a real bug is found and named

## Comments

- Landed in this commit (replay base d48eb02cb57cb3776c3870c0da9a70bac6ef65c1); gate 5/5 passed.
