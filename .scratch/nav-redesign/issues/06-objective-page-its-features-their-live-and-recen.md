# 06: Objective page: title, next, result, features with activity notes, evidence

**Status:** ready-for-agent
**Owner try:** no
**Live try:** on 项目, Enter on the interaction Objective: its features show with bars and right-hand notes (e.g. `● 1 在跑`), no job rows; Enter on a feature opens its Feature page (or the ticket file until 07 lands); Esc returns to the overview row
**Approved removals:** none
**Blocked by:** 05
**Objective:** interaction

**What to build:** D-2026-11-26-05; build reference docs/design/tab-roles/README.md §1–§2, row shapes from docs/design/nav-redesign/README.md §5 Objective. Enter on an Objective row (Project overview, and Home's goal/result row) opens a sub-page: crumb `‹ project › id` replacing tabs and strip (this project's requests stay on top, [ ] off), right side state and done/total tickets. Title (≤ 3 rows), next step `›`, result `✓` with age. `功能`: one row per linked feature `slug bar done/total note` (bar ≤ 24) with a right-hand activity note (`● 1 在跑`, `✓ 刚落地 02`, `◒ 1 未落地`, `◇ 1 待试用`), no nested job rows. `依据`: every evidence entry. Enter on a feature opens ticket 07's Feature page (until it lands: the feature's first unfinished ticket file); on evidence the file or commit as today. Esc returns to the row that opened the page with the same scroll. Inspector's Objective fact row becomes selectable and Enter on it opens this page.

- [ ] Enter on an Objective (Project row or Home goal/result row) shows title, next, result, linked features with bars and activity notes, and all evidence; no job rows
- [ ] Enter on a feature or evidence opens it; Esc returns to the same row and scroll; Inspector's Objective row opens this page
- [ ] Tests with synthetic Objectives and features in each activity state, EN/ZH, 40 and 62 columns, no-colour; docs/reference.md updated

## Comments

- Rewritten 2026-11-26 for D-2026-11-26-05 (tab roles); held as needs-info until then.
