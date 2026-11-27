# 26: Gate flakes collected after test-flakes/25

**Status:** ready-for-agent
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Running list of gate flakes that passed on immediate rerun; dispatches when a named test repeats or the list reaches 4 cases. Fix each flaky test to wait on observable events instead of fixed timing without weakening assertions or product bounds (fix the product if it is a real bug).

### Cases

- `hud_create and hud_send do not wait for a slow queue-watcher lookup` (tests/unit/thin-mcp-roster-presets.test.mjs) — flow `f1e863617831b98a0`, log `~/.hud/flows/f1e863617831b98a0.json.gate-1.log`
- `pi reap: --done snapshot rename ENOSPC before native shutdown` (tests/unit/thin-mcp-watcher-reap.test.mjs) — flow `f1e863617831b98a0`, log `~/.hud/flows/f1e863617831b98a0.json.gate-1.log`
- `batch code jobs keep per-job worktrees and report-declared files in the index` (tests/unit/thin-mcp-fixed-batch.test.mjs) — flow `f1e863617831b98a0`, log `~/.hud/flows/f1e863617831b98a0.json.gate-1.log`
- `a blocked CLI send is not queued and the worker can still report with its original token` (tests/unit/thin-mcp-worker-tools.test.mjs) — flow `f19e4dd6188b00f6e-2`, log `~/.hud/flows/f19e4dd6188b00f6e-2.json.gate-2.log`
- `a queued land names the job it waits on: its ticket id, else the holder’s flow id (panel-polish/04)` (tests/unit/thin-panel-jobs.test.mjs) — flow `f19e4dd6188b00f6e-2`, log `~/.hud/flows/f19e4dd6188b00f6e-2.json.gate-2.log`

- [ ] Each listed case passes 20 consecutive runs under parallel load
- [ ] No assertion or product bound weakened

## Comments
