# 04: Home rows keep their order, wait lines name the job, and zh shows route reasons and titles

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 02

**What to build:** Acceptance pass 2026-11-22 (frames 01-04, 14, 16, 23): working Home rows swapped places between consecutive frames; a land waiting for another shows the raw holder id (`waiting for ffac82c255bad0b73`) instead of the ticket it waits on; in zh the Inspector route reason stays English, the Latest row AUTO-ROUTE-07 shows an English title and 06/05 none; the Inspector 类型 row lists 6-7 kinds. Fix: a stable sort key for Home rows (e.g. created time, not changing fields); wait lines show the holder's ticket id/title; route reason and Latest titles go through the existing translation path (WaitingBriefs cache) in zh; 类型 shows at most the top 2 kinds.

- [ ] Two renders with changed progress but the same jobs keep row order (test)
- [ ] Wait line shows ticket id (fallback short title) of the lease holder
- [ ] zh: route reason and Latest ticket titles appear translated (cached; no model call for zh text); 类型 shows ≤2 kinds
- [ ] npm test and check:fixtures pass

## Comments
