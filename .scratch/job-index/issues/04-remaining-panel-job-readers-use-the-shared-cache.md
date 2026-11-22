# 04: Remaining panel job readers use the shared cache

**Status:** done
**Blocked by:** 01

**What to build:** Proposal 08 S4: project-board.ts recentJobs()/liveCwds(), control-radar.ts job enumeration, and (owner default Q3: include) session-finder.ts codexWorkerSessionIds()/workerSessionCache read through JobIndexCache.

- [x] project-* and control-radar tests pass; several ProjectCollectors in one panel share one parse per job
- [x] Home/Project/Projects/Control show the same jobs as before on a synthetic HUD_HOME

## Comments

- Landed 5745f591814c10bf78333401109f260adced55a7; gate 6/6 passed.
