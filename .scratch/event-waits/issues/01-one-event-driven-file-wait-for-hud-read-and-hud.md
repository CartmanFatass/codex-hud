# 01: One event-driven file wait for hud_read and hud_wait

**Status:** claimed
**Blocked by:** none

**What to build:** docs/neon-proposal/07-event-driven-waits-and-leases.md S1: src/utils/fs-wait.ts (fs.watch + fallback tick); hud_read({job, wait_ms}) and waitJobs use it instead of sleep polling (paths now src/mcp/thin-main.ts). Owner default Q3: waitJobs converts too. Tool results unchanged.

- [ ] hud_read wait_ms and hud_wait wake within ~30 ms of the change
- [ ] No watcher leaks on abort; thin-mcp tests pass

## Comments
