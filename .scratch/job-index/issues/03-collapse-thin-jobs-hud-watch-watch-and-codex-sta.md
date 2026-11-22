# 03: Collapse thin-jobs, hud-watch, watch and codex-statusline caches onto the shared one

**Status:** ready-for-human
**Blocked by:** 01, 02

**What to build:** Proposal 08 S3: remove hud-watch's hand-written cache, thin-jobs.ts module-level watchCache/seen/cacheHome/complete, jobRow's double stat of report.md, src/cli/watch.ts direct reads; codex-statusline reads both stamp formats. Panel-actions answer path uses the cache write-through. Retention (24 h) unchanged.

- [x] thin-job-scan (incl. 1,000-job cold start and vanished dirs), thin-panel-jobs, hud-watch, job-retention tests pass
- [x] Codex statusline reminder dot still clears after reading a job; net lines removed

## Comments

- Landed 6a4c18693d7ec15fa47d81e81ef6e5dcafab5417; gate 5/5 passed.
