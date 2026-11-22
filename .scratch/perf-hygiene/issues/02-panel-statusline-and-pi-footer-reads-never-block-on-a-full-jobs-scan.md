# 02: Panel, statusline and pi footer reads never block on a full jobs scan

**Status:** ready-for-agent
**Blocked by:** 01
**Owner try:** no

**What to build:** Outside review 2026-11-22 (verify each claim with a measurement before changing code; drop what does not hold): readThinJobs (src/collectors/thin-jobs.ts:619-980) synchronously lstats every job dir (356 today), reads up to 200 jobs' STATUS/job/brief/report/qa and rewrites the 88 KB .hud/display/thin-jobs.json on any change; the pi package runs it every 5 s inside the pi process (src/harness/pi/segment.ts:38-54), blocking input and frames; session-finder's fallback (src/collectors/session-finder.ts:523-534) scans all STATUS.json files the same way. hud-watch (src/runtime/watch-runtime.ts:623) and hud watch / pi (src/cli/watch.ts:136) each hold a recursive fs.watch on ~/.hud/jobs. Fix: one shared, incremental job snapshot (JobIndexCache already exists: reuse it) read off the hot path; the pi footer reads a snapshot file the watcher keeps current instead of scanning, or scans asynchronously and only on change; thin-jobs.json is rewritten only when its content changes; one recursive watch per process tree where possible. Measure before/after: pi main-thread block per tick, ms per panel tick with 356 job dirs, inotify watch count.

- [ ] The pi process never runs a synchronous full jobs scan on its main thread; measured block per tick before/after in the report
- [ ] Panel tick time with 356 synthetic job dirs before/after in the report
- [ ] npm test and check:fixtures pass

## Comments
