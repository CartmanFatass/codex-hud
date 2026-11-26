# 22: Land repair: a source worker that committed a fix is not judged 'output missing, empty or unchanged'

**Status:** done
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** 2026-11-26, land f0420ffb9f71dede4 (unattended/05, job j0420ffb9f71dede4, pi gpt-6.2-sol): gate[3] failed; repair 1 resumed the source worker, which rebased, committed 897d5548 on wt/imp-1dede4 and wrote a new report (digest: 'Rebased and committed 897d5548 ... passed 58 targeted tests'). The land still recorded the repair outcome 'output missing, empty or unchanged', marked the land and the job failed, and hud_land then refuses the job (state failed). Main had to start a fresh imp job to carry the commits. Find why the repair settlement missed the new report/commit (stale report hash, receipt timing, resumed pi session, rebase changing the branch base) and fix it so a repair that commits and reports is accepted; a genuinely empty repair still fails. A wrongly failed job must not lose its branch.

- [x] Regression test reproducing this case (resumed pi source worker rebases, commits and rewrites its report) passes the repair step and retries the gate.
- [x] A repair turn with no new commit and no new report still fails as today.
- [x] hud_land on a job failed only by a land repair verdict explains the next step instead of a bare state refusal (or the job keeps a landable state).

## Comments

- Landed in this commit (replay base fac48037b2b88230731050be045e4ece1f83de8c); gate 5/5 passed.
