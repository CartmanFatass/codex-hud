# 04: Home rows keep their order, wait lines name the job, and zh shows route reasons and titles

**Status:** done
**Owner try:** no
**Blocked by:** 02, home-compact/03

**What to build:** Acceptance pass 2026-11-22 (frames 01-04, 14, 16, 23): working Home rows swapped places between consecutive frames; a land waiting for another shows the raw holder id (`waiting for ffac82c255bad0b73`) instead of the ticket it waits on; in zh the Inspector route reason stays English, the Latest row AUTO-ROUTE-07 shows an English title and 06/05 none; the Inspector 类型 row lists 6-7 kinds. Fix: a stable sort key for Home rows (e.g. created time, not changing fields); wait lines show the holder's ticket id/title; route reason and Latest titles go through the existing translation path (WaitingBriefs cache) in zh; 类型 shows at most the top 2 kinds.

- [x] Two renders with changed progress but the same jobs keep row order (test)
- [x] Wait line shows ticket id (fallback short title) of the lease holder
- [x] zh: route reason and Latest ticket titles appear translated (cached; no model call for zh text); 类型 shows ≤2 kinds
- [x] npm test and check:fixtures pass

## Comments

- Landed in this commit (replay base f67e6e717ca5617f1c8f4beed722f82851414fef); gate 5/5 passed.
