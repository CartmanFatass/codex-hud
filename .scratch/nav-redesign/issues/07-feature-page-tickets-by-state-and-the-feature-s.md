# 07: Feature page: tickets by state with job status on the ticket row

**Status:** done
**Owner try:** no
**Live try:** from 项目 → interaction → nav-redesign, see the tickets with state marks and, on tickets built today, their job status on the same row; Enter on such a ticket opens its Inspector, o opens the ticket file
**Approved removals:** none
**Blocked by:** 06
**Objective:** interaction

**What to build:** D-2026-11-26-05; build reference docs/design/tab-roles/README.md §2, row shapes from docs/design/nav-redesign/README.md §5 Feature. Enter on a feature row (Objective page, the Unlinked list, and the Tickets page `t`) opens: crumb ending in the slug (project name leaves below 56 columns); stacked bar with a legend of counts; `工单` ordered to-try → working → blocked → ready → queued (by number) → done (newest first), each one row with state mark, word, blockers (`← NN`) and, when a live or ≤ 24 h job exists, its observed status on the right (`◐ 工作中 14分`, `门禁 2/3`, `◒ 未落地 40分`, `✓ 已落地 30分`). No separate 运行中/刚结束 sections. Enter on a ticket with a live or retained job opens that job's Inspector; without one, Enter expands its checklist and Landed comment inline; `o` always opens the ticket file. `g P H` act on a live tab job's ticket row as on Execution. Esc returns to the feature row.

- [x] Feature page lists tickets in the stated order with marks, blockers and job status on the same row; no job sections
- [x] Enter opens the Inspector for a ticket with a live/retained job, else expands checklist inline; o opens the file; g P H work; Esc returns
- [x] Tests with a synthetic feature in every ticket state, EN/ZH, 40 and 62 columns, no-colour; docs/reference.md updated

## Comments

- Rewritten 2026-11-26 for D-2026-11-26-05 (tab roles); held as needs-info until then.

- Landed in this commit (replay base a3ed77424fe12bc57c7094007a5289fd56fc8ee4); gate 5/5 passed.
