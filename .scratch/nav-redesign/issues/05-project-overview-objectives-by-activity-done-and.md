# 05: Project overview: Objectives by activity with a subtitle, folds, header links, no job rows

**Status:** done
**Owner try:** no
**Live try:** open 项目 on MyHUD: Objectives with running work are on top with `● N 在跑`, pi-worker (done) sits in the folded row, no job rows anywhere on the page, the header shows 工单 工作区 文档 (no 进度); t opens Tickets and Esc returns
**Approved removals:** The Project Details list rows (Tickets, Progress, Worktree, Docs summaries; header links instead), the Progress (进度, `p`) page (owner D-2026-11-26-05; the STATE.md link moves under 文档), the Project tab's job rows (Jobs section, hub job rows, Progress Now jobs, Working tree `editing` jobs; jobs live on 执行).
**Blocked by:** 02, 04
**Objective:** interaction

**What to build:** D-2026-11-26-05; build reference docs/design/tab-roles/README.md §1, §2, §4 (Project frame) plus docs/design/nav-redesign/README.md §3 for row columns. Header: stance, priority, update age and links `工单 工作区 文档` (keys t b d; each opens today's page unchanged with crumb and Esc back; 工作区 only with Git facts); the bottom Details list goes; the 进度 page and its `p` key go, its STATE.md link moves into 文档. Section `目标 ──── 完成/工单`; one row per open Objective `id bar done/total note` plus one muted subtitle row (`✓ result` when the tier-2 note has a dated result, else the title), dropped first when the viewport is short. Tiers (first met wins): 1 live job on a linked ticket (`● 2 在跑`, add `· 1 门禁` while landing), 2 a job or run ended in 24 h (`✓ 刚落地 slug`, `◒ 40分前结束·未落地`, `✗ 40分前失败`; ticket 02's ended list), 3 open request or a ticket to try (`? 在等你`, `◇ 等你试用`), 4 the rest (`空闲 6天`); folded: state done or paused, or every linked ticket done/dropped, into one `▸ 已完成/搁置 N` row that expands in place; an Objective with a live job or open request never folds; a last landing folds at once. Unlinked features stay one row. No job rows on the Project tab: remove the Jobs section, hub job rows, Working tree `editing` job lines (src/render/project-view.ts:402) — jobs are on 执行. Without objectives.md, Now/Next notes as today. Cursor starts on the first request, else the first Objective.

- [x] Objectives sort by the four tiers with the stated notes and one subtitle row; done/paused/all-done fold into one expandable row; live or requested never fold
- [x] Header shows 工单 工作区 文档 with t b d; the bottom Details list and the 进度 page are gone; STATE.md is reachable from 文档
- [x] No job rows anywhere on the Project tab or its Working tree page
- [x] Render and key tests over a synthetic project covering every tier, EN/ZH, 40 and 62 columns, no-colour; docs/reference.md updated

## Comments

- Rewritten 2026-11-26 for D-2026-11-26-05 (tab roles); held as needs-info until then.

- Landed in this commit (replay base 044fc1da0f168226f03154a6942cc56dc7564d8a); gate 5/5 passed.
