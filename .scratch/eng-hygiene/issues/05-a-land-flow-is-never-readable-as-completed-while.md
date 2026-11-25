# 05: A land flow is never readable as completed while its step is still cleanup

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** CI run 45612067863 (colour cell) failed tests/unit/thin-mcp-land.test.mjs 'land cleanup removes clean source worktree when picked patch differs from source commit': after until(state in failed/completed) the hud_read of the flow returned state 'completed' with step 'cleanup' (expected 'done'). So the land runner (src/mcp/land-runner.ts and the flow record writer) can publish state completed before the cleanup step finishes and step done is written. Find the write order and make the terminal state and the final step (done, plus any cleanup_note and worktree_removed_at receipt) appear in one atomic flow write, so no reader sees completed with a non-final step. Do not change the semantics in the sibling test 'a cleanup error after push completes as landed with a cleanup note'.

- [ ] Report names the write sequence that allowed completed+cleanup
- [ ] A deterministic test (hook or injected delay between the two writes, not a timing loop) fails before the fix and passes after
- [ ] thin-mcp-land.test.mjs passes 5 runs in a row locally

## Comments
