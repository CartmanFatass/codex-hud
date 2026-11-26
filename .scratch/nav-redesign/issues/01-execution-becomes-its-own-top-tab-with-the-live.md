# 01: Execution becomes its own top tab with the live count

**Status:** done
**Owner try:** no
**Live try:** open /hud panel, press Tab until 执行·N, check N matches hud_read's live jobs for MyHUD and that [ ] switches project on both 项目 and 执行
**Approved removals:** The Execution row in the Project Details list and the Execution sub-page entry under Project (moved to the new tab).
**Blocked by:** none
**Objective:** interaction

**What to build:** D-2026-11-26-04; template docs/design/nav-redesign/ (sample.html frames busy-62, idle-62, busy-40; README §2 Tabs, §6, §8, §11). MAIN_TABS gains `execution` between Project and Control: `首页 项目 执行·N 控制` (EN `Execution·N`), N = the current project's live jobs (running, waiting, queued), omitted at 0. The tab shows today's single-project Execution page for the panel's current project (the same project the Project tab shows; `[ ]` switch it on this tab too, keeping both tabs in step). PROJECT_PAGES loses `execution` and the Details list loses its Execution row; nothing else on the Project page changes in this ticket. Tab/Shift-Tab, Left/Right and click cycle four tabs. Keep the `?N` request badges. Update docs/reference.md (Keys, Execution page) EN/ZH strings, no-colour and narrow widths per ARCHITECTURE §8.

- [x] Tabs read 首页 项目 执行·N 控制 with N the current project's live jobs, no count at 0; EN equivalent
- [x] The Execution tab shows the current project's Execution page and follows [ ] together with the Project tab
- [x] Project's Details list no longer has an Execution row; other rows unchanged
- [x] Render and key tests at 40 and 62 columns, EN/ZH, no-colour; docs/reference.md updated

## Comments

- Landed in this commit (replay base a58940d847d13f1a526e0f28dbaf386038f5c1c8); gate 5/5 passed.
