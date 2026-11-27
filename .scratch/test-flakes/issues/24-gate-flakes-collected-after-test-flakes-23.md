# 24: Gate flakes collected after test-flakes/23

**Status:** needs-triage
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Running list of gate flakes that passed on immediate rerun; dispatches when a named test repeats or the list reaches 4 cases. Fix each flaky test to wait on observable events instead of fixed timing without weakening assertions or product bounds (fix the product if it is a real bug).

### Cases

- `hud_send: preserves the right turn on fast-ambiguous-prompt` (tests/unit/thin-mcp-cli-turns.test.mjs) — flow `f55b22044239c5054`, log `~/.hud/flows/f55b22044239c5054.json.gate-1.log`
- `hud_report during a pending CLI prompt belongs to the old turn (delivered)` (tests/unit/thin-mcp-worker-tools.test.mjs) — flow `fc93b02fed181360a-2`, log `~/.hud/flows/fc93b02fed181360a-2.json.gate-1.log`
- `hud_send: preserves the right turn on rejected-prompt` (tests/unit/thin-mcp-cli-turns.test.mjs) — flow `f7481730d0a511b32`, log `~/.hud/flows/f7481730d0a511b32.json.gate-1.log`

- [ ] Each listed case passes 20 consecutive runs under parallel load
- [ ] No assertion or product bound weakened

## Comments
