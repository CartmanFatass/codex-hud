# 04: Long-running processes keep bounded caches

**Status:** ready-for-agent
**Blocked by:** none
**Owner try:** no

**What to build:** Outside review 2026-11-22 found module- or process-level maps that only grow (verify each; fix the real ones; the panel runs ~400 MB RSS today): collectGitStatus cache (src/collectors/git.ts:304-389, per cwd), readAgentTokens cache (src/collectors/agent-context.ts:56-194, per rolloutPath) and TokenRateTracker.tools (src/collectors/token-rate.ts:30), hud-mcp createdJobs / landTasks (src/mcp/thin-main.ts:2799, 2897, carried across hot reloads) and tasks kept to TASK_TTL, Notifier.lastFired (src/notify.ts:133-180), TryBriefs.hashes (src/collectors/try-brief.ts:62-85), closedTabs (src/runtime/watch.ts:20) and warnings (src/runtime/watch-runtime.ts:60), ProjectOverviews.pool (src/collectors/project-visits.ts:67-81) and homeTryDates (src/collectors/project-board.ts:147), session-finder's cachePut is FIFO not LRU (src/collectors/session-finder.ts:32-41). Give each a bound that matches its use: drop entries for settled/archived jobs and unseen paths, small LRU caps elsewhere, release a project's collector when it leaves the list. Report panel and hud-mcp RSS after a synthetic hour-long churn before/after.

- [ ] Each confirmed map has a bound and a test that churns past it
- [ ] Panel and hud-mcp RSS before/after in the report
- [ ] npm test and check:fixtures pass

## Comments
