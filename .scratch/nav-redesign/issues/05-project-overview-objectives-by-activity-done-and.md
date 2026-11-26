# 05: Project overview: Objectives by activity, done and paused folded, Details as header links

**Status:** ready-for-agent
**Owner try:** no
**Live try:** open 项目 on MyHUD: Objectives with running work are on top, pi-worker (done) sits in the folded row, the whole overview fits one screen at the panel's height; t opens Tickets and Esc returns
**Approved removals:** The Project Details list rows (Tickets, Progress, Worktree, Docs summaries; owner asked for header links instead) and the Project tab's section of jobs not linked to any Objective (moved to 执行).
**Blocked by:** 02, 04
**Objective:** interaction

**What to build:** D-2026-11-26-04; template README §3, §4 and frames ov-req-62, ov-quiet-62, ov-*-40, en-62. Header: stance, priority, update age and links `工单 进度 工作区 文档` (keys t p b d; each opens today's page unchanged with crumb and Esc back; 工作区 only with Git facts). The bottom Details list goes. Section `目标 ──── 完成/工单`; one row per Objective: `id bar done/total note`, columns per README §3. Tiers (first met wins, note states it): 1 live job on a linked ticket (`● 2 在跑`), 2 a job or run ended in 24 h (`✓ 刚落地 slug`, `◒ 40分前结束 · 未落地`, `✗ 40分前失败`; uses ticket 02's ended list), 3 open request or a ticket to try (`? 在等你`, `◇ 等你试用`), 4 the rest (`空闲 6天`); folded: state done or paused, or every linked ticket done/dropped, into one `▸ 已完成/搁置 N` row that expands in place; an Objective with a live job or open request never folds; a last landing folds at once. Unlinked features stay as Home's one row. Jobs no Objective claims leave the Project tab (they are on 执行). Without objectives.md, Now/Next notes as today. Cursor starts on the first request, else the first Objective. Mapping p and d on Project only (they are decoded for Control/Inspector today, workbench-input.ts:110,117).

- [ ] Objectives sort by the four tiers with the stated notes; done/paused/all-tickets-done fold into one expandable row; live or requested never fold
- [ ] Header shows 工单 进度 工作区 文档 links with t p b d; the bottom Details list is gone
- [ ] Unlinked jobs no longer list on Project; they remain on 执行
- [ ] Render and key tests over a synthetic project covering every tier, EN/ZH, 40 and 62 columns, no-colour; docs/reference.md updated

## Comments
