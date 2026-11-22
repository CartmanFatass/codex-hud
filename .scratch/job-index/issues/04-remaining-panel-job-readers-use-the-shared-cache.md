# 04: Remaining panel job readers use the shared cache

**Status:** claimed
**Blocked by:** 01

**What to build:** Proposal 08 S4: project-board.ts recentJobs()/liveCwds(), control-radar.ts job enumeration, and (owner default Q3: include) session-finder.ts codexWorkerSessionIds()/workerSessionCache read through JobIndexCache.

- [ ] project-* and control-radar tests pass; several ProjectCollectors in one panel share one parse per job
- [ ] Home/Project/Projects/Control show the same jobs as before on a synthetic HUD_HOME

## Comments
