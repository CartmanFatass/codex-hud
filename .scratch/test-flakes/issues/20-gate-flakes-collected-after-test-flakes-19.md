# 20: Gate flakes collected after test-flakes/19

**Status:** ready-for-agent
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Running list of gate flakes that passed on immediate rerun; dispatches when a named test repeats or the list reaches 4 cases. Fix each flaky test to wait on observable events instead of fixed timing without weakening assertions or product bounds (fix the product if it is a real bug).

### Cases

- `overlapping watcher startups publish only one ready PID` (tests/unit/hud-watch-async.test.mjs) — flow `f2852544b4cb525a5`, log `~/.hud/flows/f2852544b4cb525a5.json.gate-1.log`
- `overlapping watcher startups publish only one ready PID` (tests/unit/hud-watch-async.test.mjs) — flow `f698c9aad9433b9d8`, log `~/.hud/flows/f698c9aad9433b9d8.json.gate-1.log`
- `MCP tasks: batch responses deliver per-job compact notices with check-wait, changes fallback and disconnect fallback` (tests/unit/thin-mcp-batch.test.mjs) — flow `f698c9aad9433b9d8`, log `~/.hud/flows/f698c9aad9433b9d8.json.gate-2.log`
- `the MCP entry, dispatch and worker modules resolve and share job receipts` (tests/unit/mcp-internals.test.mjs) — flow `f698c9aad9433b9d8`, log `~/.hud/flows/f698c9aad9433b9d8.json.gate-2.log`

- [ ] Each listed case passes 20 consecutive runs under parallel load
- [ ] No assertion or product bound weakened

## Comments
