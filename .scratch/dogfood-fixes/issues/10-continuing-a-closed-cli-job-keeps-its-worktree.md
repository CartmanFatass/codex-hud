# 10: Continuing a closed CLI job keeps its worktree

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Found 2026-11-22 with an agy imp (toktrack job jce83401c4ba59339, worktree toktrack-wt/imp-a59339, commit 0b90916): hud_read closed it, then hud_send started continuation jc861c53af68a964d, which failed at once with agent_pane_busy ("agent target pane w5D:p6R is not an available shell") — the old pane was still being reaped. hud_create retry_of then started jbb5a15f6bb7214b3 in a fresh worktree from main, without the source job's commit, so the follow-up had to be told to cherry-pick it. A continuation (hud_send to a closed job, or retry_of a failed continuation) of a managed-worktree job runs in the source job's worktree when it still exists and is clean; a pane still being reaped is waited for (bounded) or a new pane is used, never a failed dispatch.

- [ ] hud_send to a just-closed CLI worktree job continues in the same worktree without agent_pane_busy
- [ ] retry_of a failed continuation keeps the source worktree
- [ ] npm test and check:fixtures pass

## Comments
