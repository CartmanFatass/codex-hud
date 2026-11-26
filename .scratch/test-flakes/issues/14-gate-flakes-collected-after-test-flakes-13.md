# 14: Gate flakes collected after test-flakes/13

**Status:** needs-triage
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Running list of gate flakes that passed on immediate rerun; dispatches when a named test repeats or the list reaches 4 cases. Fix each flaky test to wait on observable events instead of fixed timing without weakening assertions or product bounds (fix the product if it is a real bug).

### Cases

- `land publishes completed and done in one atomic flow write (clean worktree)` (tests/unit/thin-mcp-land-publish.test.mjs) — flow `fb91cb6d28dbf6c54`, log `~/.hud/flows/fb91cb6d28dbf6c54.json.gate-1.log`
- `hud_send messages sends distinct texts and repairs in input order while keeping jobs fan-out` (tests/unit/thin-mcp-batch.test.mjs) — flow `fb91cb6d28dbf6c54`, log `~/.hud/flows/fb91cb6d28dbf6c54.json.gate-1.log`

- [ ] Each listed case passes 20 consecutive runs under parallel load
- [ ] No assertion or product bound weakened

## Comments
