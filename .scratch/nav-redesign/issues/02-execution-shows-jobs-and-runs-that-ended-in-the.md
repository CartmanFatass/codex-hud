# 02: Execution shows jobs and runs that ended in the last 24 hours

**Status:** ready-for-agent
**Owner try:** no
**Live try:** after a worker in MyHUD settles, open 执行 and see it under 刚结束 with 已落地/未落地/完成 matching hud_read and the land record; Enter opens its Inspector
**Blocked by:** 01
**Objective:** interaction

**What to build:** D-2026-11-26-04; template README §6 and frames busy-62, idle-62, idle-40. Add a 刚结束 (EN `Recently ended`) section after open runs: one row per job or ticket-queue run of the current project that ended in the last 24 h, newest first: `mark icon title ··· result age`. Result from observed facts only: 已落地 (a land flow with a landed commit), 未落地 (worktree job ended, no landed commit), 完成 (nothing to land), 失败 / 已停止 (job state); no word when the landing record cannot be read. A run is one row (`队列 label · N 张工单`; 失败 if any ticket failed, else 已落地 if all landed, else 未落地) and its member jobs are not repeated. Enter on a job row opens the Inspector, on a run row the run detail. Data: a bounded 24 h list from job records (cap count, off the paint path, no model calls, existing header-scan helpers), landing from land flows; ended runs kept 24 h instead of 1 h (ENDED_MS in collectors/execution-runs.ts). The delegation tree moves to the end of the page. With no live job and no open run the page is only 刚结束 (no readout or empty sections); with nothing in 24 h either, today's empty line. Keep screen thumbnails at 6 rows.

- [ ] 刚结束 lists the current project's jobs and runs ended within 24 h, newest first, with result word and age; a run is one row and its jobs are not repeated
- [ ] Result words come only from job state and land-flow records; unreadable landing shows no word
- [ ] Idle page shows only 刚结束; nothing at all shows today's empty line
- [ ] Enter opens Inspector / run detail; Esc returns to the row
- [ ] Collector is bounded and off the paint path; tests with synthetic job and flow records, EN/ZH, narrow, no-colour; docs/reference.md updated

## Comments
