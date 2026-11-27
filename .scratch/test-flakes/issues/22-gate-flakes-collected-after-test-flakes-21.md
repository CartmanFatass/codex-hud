# 22: Gate flakes collected after test-flakes/21

**Status:** needs-triage
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Running list of gate flakes that passed on immediate rerun; dispatches when a named test repeats or the list reaches 4 cases. Fix each flaky test to wait on observable events instead of fixed timing without weakening assertions or product bounds (fix the product if it is a real bug).

### Cases

- `fork Pi tab worker: native pi worker extension, sibling exit ignored, clean exit & crash retention` (tests/unit/herdr-fork-direct-exec.test.mjs) — flow `f54e4d07f88b64b18`, log `~/.hud/flows/f54e4d07f88b64b18.json.gate-1.log`
- `direct-exec CLI and Pi wait for interactive_ready before sending exactly one agent.prompt (and codex unknown)` (tests/unit/herdr-fork-direct-exec.test.mjs) — flow `f54e4d07f88b64b18`, log `~/.hud/flows/f54e4d07f88b64b18.json.gate-1.log`

- [ ] Each listed case passes 20 consecutive runs under parallel load
- [ ] No assertion or product bound weakened

## Comments
