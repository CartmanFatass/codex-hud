# 05: Worker report checks the branch still applies on the current base

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Fable #1: at `hud_report` for a worktree job with commits, run `git merge-tree --write-tree` of the job branch against the current base tip (src/worker/tools.ts finishReport, next to the uncommitted-changes refusal). On conflict refuse the report once, naming the paths: rebase onto <sha>, rerun tests, report again; a second report is accepted (land repair then handles it). Brief line in .hud/brief.md: rebase only when the report tool says so.

- [x] Conflicting branch: first report refused with paths and base sha; second accepted
- [x] Clean branch: no change in behaviour or measurable delay (<300 ms)
- [x] Unit tests with synthetic repos
- [x] Brief updated

## Comments

- Landed in this commit (replay base b60384ec55ae6bbde1feabf26782ec4969a8708b); gate 5/5 passed.
