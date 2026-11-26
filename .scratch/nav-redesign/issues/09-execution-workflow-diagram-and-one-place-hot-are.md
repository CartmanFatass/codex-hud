# 09: Execution workflow diagram and one-place hot area

**Status:** ready-for-agent
**Owner try:** no
**Live try:** while a hud_tickets run works in MyHUD, open 执行: the queue shows as a wave diagram with the running tickets as nodes and the review/accept spine, each running worker once as a card with 3 screen rows; Enter on a node opens its Inspector
**Approved removals:** The Runs section's layout (replaced by 工作流 with the same data), the bottom 派工关系 delegation tree (one-line child summary on cards instead), screen thumbnails beyond 3 rows (owner D-2026-11-26-05).
**Blocked by:** 02
**Objective:** interaction

**What to build:** D-2026-11-26-05; build reference docs/design/tab-roles/README.md §1 and §3 (grammar and frames). Add 工作流 above 工作者 when any flow of the current project is open (working or paused), zero rows otherwise: one block per open flow (paused/held first, then working oldest first) for ticket-queue `q…`, batch `b…`, council and scouting prewalk `j…`, standalone land `f…` and `graph.json` flows, read through the existing header-scan cache off the paint path. Vertical waves: collapsed settled prefix `✓ 已落地 K: 01, 02`; one selectable row per node of the current wave (`├─ ◉ 03 Title ⚒ 工作中 14分`, `└─ ◉ 04 Title 门禁 2/3`); blocked waves `▼ ○ 05(←03,04) ─▶ ○ 06(←05)` (one wave per row when narrow); spine `▼ ○ ⚖ 评审 ─▶ ○ ★ 验收(lead) 待办 N · 挂起 N`; fixed flows as in §3 (land gate/repair/lease wait, council members → synthesis, batch pilot → pool counters → summary). Live: marks `○ ◉ ? ! ✓ ✗`, elapsed, gate index, lease wait, active lead, batch counters. Enter on a node opens its Inspector, on a flow header the Run Detail; `X` batch control works here. This replaces today's Runs section (its data stays). Hot-area de-duplication: a live job appears once (as a 工作流 node only if part of an open flow, and as its 工作者 card); screen thumbnails 6 → 3 rows (collectors/execution-screens.ts SCREEN_ROWS); the bottom 派工关系 tree goes and each parent card gains one line `ϟ 子任务: code 探路 ✓ · docs 探路 ✓` (full list stays in Inspector). 刚结束 collapses ended batch and council flows to one row like queue runs, and its collector scans job dirs down to the 24 h cutoff rather than a fixed 64-dir cap.

- [ ] 工作流 renders open q/b/j/f flows in the stated wave grammar, zero rows when none; Enter opens Inspector / Run Detail; X works on batches (tests with synthetic flow records)
- [ ] Each live job appears once on the page; thumbnails are 3 rows; 派工关系 is gone and parent cards show the one-line child summary (tests)
- [ ] 刚结束 collapses ended batch/council flows to one row and covers the full 24 h window (tests)
- [ ] EN/ZH, 40 and 62 columns, no-colour; reads stay off the paint path; docs/reference.md Execution updated

## Comments
