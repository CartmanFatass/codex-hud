# 08: Home key display: one-line goal and recent result per active project

**Status:** ready-for-agent
**Owner try:** no
**Live try:** open 首页: MyHUD shows its header, one goal line and (if recent) a result line, no progress bars; Enter on the goal opens the Objective page
**Approved removals:** Home's per-Objective ticket bars and done/total counts, Home's 未归入目标 row, the running count in 今日, the multi-row Recent advice block on Home (owner D-2026-11-26-05).
**Blocked by:** 04
**Objective:** interaction

**What to build:** D-2026-11-26-05; build reference docs/design/tab-roles/README.md §1 and §4 (Home frame and order). Home keeps: requests of all projects (ticket 04), 今日活跃项目 membership and order, `▸ N 个其他项目` (a), 日程, the opt-in Advisor line and the unattended status line. Each active project is at most 3 rows: header (`mark name · stance ── role load age`), current goal `▸ id (+N) one-line title` shown at every width 40–100 (today it hides below 80 columns, src/render/home-view.ts:158), and `✓ result excerpt age` when the result is at most 3 days old. Remove Home's per-Objective ticket bars and done/total and the 未归入目标 row (src/render/home-view.ts:147-201). 今日 becomes one line `今日 N 已落地 · M 失败` with no running count (src/render/home-cards.ts:32), zero rows when both are zero. Drop the multi-row Recent advice block (home-view.ts:240-258) if it is still shown. Enter on a goal or result row opens that Objective's page (ticket 06), on a project header the Project tab.

- [ ] Each active project shows header, one-line goal at 40, 62 and 80 columns, and a result line only when ≤ 3 days old; no ticket bars, counts or 未归入目标 on Home
- [ ] 今日 is one line without a running count, zero rows when empty; order and folds as §4
- [ ] Enter on goal/result opens the Objective page; on a header the Project tab
- [ ] Render tests EN/ZH, 40/62/80 columns, no-colour; docs/reference.md Home updated

## Comments
