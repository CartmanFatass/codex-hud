# 23: Gate flakes collected after test-flakes/22

**Status:** done
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Running list of gate flakes that passed on immediate rerun; dispatches when a named test repeats or the list reaches 4 cases. Fix each flaky test to wait on observable events instead of fixed timing without weakening assertions or product bounds (fix the product if it is a real bug).

### Cases

- `hud_sonic accepts a project cwd relative to the parent and refuses paths outside the project` (tests/unit/thin-mcp-worker-tools.test.mjs) — flow `f5acc05806011084a`, log `~/.hud/flows/f5acc05806011084a.json.gate-1.log`
- `hud_read lists only the caller project, including its linked worktrees` (tests/unit/thin-mcp-read-wait-send.test.mjs) — flow `f5acc05806011084a`, log `~/.hud/flows/f5acc05806011084a.json.gate-1.log`
- `MCP tasks: follow-up sends and live hud_respond carry on one task and extend TTL` (tests/unit/thin-mcp-tasks-checks.test.mjs) — flow `f5acc05806011084a`, log `~/.hud/flows/f5acc05806011084a.json.gate-1.log`
- `a blocked CLI turn needs the owner once, then returns to working` (tests/unit/thin-mcp-cli-turns.test.mjs) — flow `f2ec750bbed70fec0-2`, log `~/.hud/flows/f2ec750bbed70fec0-2.json.gate-1.log`

- [x] Each listed case passes 20 consecutive runs under parallel load
- [x] No assertion or product bound weakened

## Comments

- Landed in this commit (replay base d0995cafb79fb18a31cb14aedbbb8c879a02d804); gate 5/5 passed.
