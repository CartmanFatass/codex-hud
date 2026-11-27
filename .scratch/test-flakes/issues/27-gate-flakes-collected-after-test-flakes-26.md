# 27: Gate flakes collected after test-flakes/26

**Status:** needs-triage
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Running list of gate flakes that passed on immediate rerun; dispatches when a named test repeats or the list reaches 4 cases. Fix each flaky test to wait on observable events instead of fixed timing without weakening assertions or product bounds (fix the product if it is a real bug).

### Cases

- `general borrows bundled imp instructions on Antigravity and Claude` (tests/unit/thin-mcp-create-context.test.mjs) — flow `fae3be043f2a14655`, log `~/.hud/flows/fae3be043f2a14655.json.gate-1.log`
- `hud_lease reclaims terminal jobs and a SIGKILLed fallback holder` (tests/unit/thin-mcp-worker-tools.test.mjs) — flow `fae3be043f2a14655`, log `~/.hud/flows/fae3be043f2a14655.json.gate-1.log`
- `pi dispatch passes role skills and the worker prompt, and records skips` (tests/unit/thin-mcp-roster-presets.test.mjs) — flow `fae3be043f2a14655`, log `~/.hud/flows/fae3be043f2a14655.json.gate-1.log`

- [ ] Each listed case passes 20 consecutive runs under parallel load
- [ ] No assertion or product bound weakened

## Comments
