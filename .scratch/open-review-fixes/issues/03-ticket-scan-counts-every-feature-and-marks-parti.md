# 03: Ticket scan counts every feature and marks partial totals

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Reviews: the ticket scan takes the newest 64 feature directories (src/collectors/project-board.ts:219-239) while this repo has 73+, so ticket meters undercount with no mark. Either scan all with a cheap stat-first pass or mark the total as partial; and $HUD_HOME/flows/ gets retention like jobs (no reader prunes it; 126 files in 1.5 days).

- [x] With >64 features the meter is complete or visibly marked partial
- [x] flows/ older than the job retention window are pruned by the existing retention pass
- [x] Unit tests

## Comments

- Landed in this commit (replay base 6c8b0238cda46f3dc9760ee29f5ea28a4c6c5fd9); gate 5/5 passed.
