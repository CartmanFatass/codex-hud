# 25: Gate flakes collected after test-flakes/24

**Status:** ready-for-agent
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Running list of gate flakes that passed on immediate rerun; dispatches when a named test repeats or the list reaches 4 cases. Fix each flaky test to wait on observable events instead of fixed timing without weakening assertions or product bounds (fix the product if it is a real bug).

### Cases

- `thin Jev roles keep their stock shell path and deduplicate sends` (tests/unit/thin-mcp-create-context.test.mjs) — flow `f0408e548934fc7a4-2`, log `~/.hud/flows/f0408e548934fc7a4-2.json.gate-1.log`
- `an agy CLI worker settles the current turn through hud_report` (tests/unit/thin-mcp-worker-tools.test.mjs) — flow `f0408e548934fc7a4-2`, log `~/.hud/flows/f0408e548934fc7a4-2.json.gate-1.log`
- `ticket queue runs ready work and releases a queued ticket when another feature lands` (tests/unit/thin-mcp-ticket-queue.test.mjs) — flow `f0408e548934fc7a4-2`, log `~/.hud/flows/f0408e548934fc7a4-2.json.gate-1.log`
- `ticket queue hands back on a worker question without stopping its peer` (tests/unit/thin-mcp-ticket-queue.test.mjs) — flow `f0408e548934fc7a4-2`, log `~/.hud/flows/f0408e548934fc7a4-2.json.gate-1.log`
- `land folds done and its record into one commit without STATE.md change (owner_try no)` (tests/unit/thin-mcp-land-publish.test.mjs) — flow `f0408e548934fc7a4-2`, log `~/.hud/flows/f0408e548934fc7a4-2.json.gate-1.log`
- `qualified none and try-with-detail Blockers land without a lead while recording try notes in run todo` (tests/unit/workflow-lead-acceptance.test.mjs) — flow `f0408e548934fc7a4-2`, log `~/.hud/flows/f0408e548934fc7a4-2.json.gate-1.log`
- `an ordinary run with a landed ticket and a held item never reaches review or finish; head-only change re-judges on resume` (tests/unit/workflow-lead-acceptance.test.mjs) — flow `f0408e548934fc7a4-2`, log `~/.hud/flows/f0408e548934fc7a4-2.json.gate-1.log`
- `one watcher pass approves only the proven worker cleanup; restart, handoff and gone are safe` (tests/unit/worker-permissions.test.mjs) — flow `f0408e548934fc7a4-2`, log `~/.hud/flows/f0408e548934fc7a4-2.json.gate-1.log`
- `unproven targets, nested headings and menu changes go to main without sending a key` (tests/unit/worker-permissions.test.mjs) — flow `f0408e548934fc7a4-2`, log `~/.hud/flows/f0408e548934fc7a4-2.json.gate-1.log`
- `a reflow is never answered again after a lost reply` (tests/unit/worker-permissions.test.mjs) — flow `f0408e548934fc7a4-2`, log `~/.hud/flows/f0408e548934fc7a4-2.json.gate-1.log`
- `Claude keeps native rendering with advisor shadow on unless a notice is live` (tests/unit/native-statusline.test.mjs) — flow `f0408e548934fc7a4-2`, log `~/.hud/flows/f0408e548934fc7a4-2.json.gate-1.log`
- `hud board --open runs the opener detached, and only mentions a missing one` (tests/unit/html-board.test.mjs) — flow `f0408e548934fc7a4-2`, log `~/.hud/flows/f0408e548934fc7a4-2.json.gate-1.log`

- [ ] Each listed case passes 20 consecutive runs under parallel load
- [ ] No assertion or product bound weakened

## Comments
