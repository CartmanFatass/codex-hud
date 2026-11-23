# 04: Measure, then maybe add diff size, test result and context fill to Home rows

**Status:** wontfix
**Owner try:** no
**Blocked by:** 03

**What to build:** Second wave from the 2026-11-22 Home row design (owner: core first, these after measuring cost): (a) worktree diff size `Δ+140` (git per job; needs an mtime-keyed cache), (b) test result `✓21`/`✗2` (reliable only for jobs with declared checks), (c) context fill `▮▮▯` (pi has token data; Claude tab and agy may not). First measure the per-refresh cost and data coverage per harness, then decide which to add.

- [ ] A short measurement note: cost per refresh for (a) with and without cache, coverage per harness for (b) and (c)
- [ ] Decision recorded in this ticket before any build

## Comments

- 2026-11-23 main session: wontfix. D-2026-11-22-28 (attention first: show only the most important) came after this ticket; diff size, test counts and context fill are detail for a job you open, not for every Home row. Reopen if the owner asks for one of them.
