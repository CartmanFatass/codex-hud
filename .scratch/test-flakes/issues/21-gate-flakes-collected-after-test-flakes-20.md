# 21: Gate flakes collected after test-flakes/20

**Status:** needs-triage
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Running list of gate flakes that passed on immediate rerun; dispatches when a named test repeats or the list reaches 4 cases. Fix each flaky test to wait on observable events instead of fixed timing without weakening assertions or product bounds (fix the product if it is a real bug).

### Cases

- `overlapping watcher startups publish only one ready PID` (tests/unit/hud-watch-async.test.mjs) — flow `fecf56de5d9a3a52d`, log `~/.hud/flows/fecf56de5d9a3a52d.json.gate-1.log`
- `supervisor events: 60s at rest means zero spawns and zero STATUS writes; socket loss stays working` (tests/unit/thin-mcp-cli-process.test.mjs) — flow `fa7e566f85d504f2d`, log `~/.hud/flows/fa7e566f85d504f2d.json.gate-1.log`
- `each Settings toggle mirrors only its main client at exact fork widths, and off restores the PTY` (tests/unit/universal-pane-strip.test.mjs) — flow `fa7e566f85d504f2d`, log `~/.hud/flows/fa7e566f85d504f2d.json.gate-1.log`

- [ ] Each listed case passes 20 consecutive runs under parallel load
- [ ] No assertion or product bound weakened

## Comments
