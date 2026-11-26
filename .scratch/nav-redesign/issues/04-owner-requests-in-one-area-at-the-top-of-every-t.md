# 04: Owner requests scoped per tab, no rows when empty

**Status:** done
**Owner try:** no
**Live try:** with no open requests the Project tab starts with the Objectives right under the strip; add a synthetic request in a scratch project via hud_objective op request: it shows on 首页 and on that project's 项目 tab only (not on 执行 or 控制, not on another project's 项目), the strip shows `?` on that project; resolve it and every row disappears
**Approved removals:** The separate 等你处理 section on Home and 需要你处理 section on Project (replaced by the scoped request rows with the same requests).
**Blocked by:** 03
**Objective:** interaction

**What to build:** D-2026-11-26-05 (supersedes the every-tab rule of D-2026-11-26-04); build reference docs/design/tab-roles/README.md §1, row shape from docs/design/nav-redesign/README.md §2 Request area and §11 item 1. Explicit owner requests only (never failures or completions, spec §2.2), pinned below tabs and strip: 首页 shows all registered projects' requests as `? project › Objective … 在等你 age`; 项目 and its sub-pages show only the selected project's requests as `? Objective … 在等你 age` (no project name); 执行 and 控制 show none. The sentence sits on the row when at least 24 cells remain, otherwise on a second row cut to one row. Order as spec §2.2 (work waits first, owner priority, oldest open). Four requests, then `另 N 个请求` (Enter expands in place). Enter opens today's request page (whole sentence, `o` opens the file); a try request opens its prepared scene. No request in scope: no row, no heading, no placeholder. Replaces Home's 等你处理 and Project's 需要你处理 sections. `?N` tab badges stay: 首页 counts all projects, 项目 counts the selected project. Up from the first body row reaches the last request row. Data reuses ticket 03's every-tab light facts.

- [x] 首页 shows all projects' requests, 项目 (and Objective/Feature pages) only the selected project's, 执行 and 控制 none; spec order; 40 columns still shows what is asked
- [x] No request in scope: zero rows; Home's 等你处理 and Project's 需要你处理 sections are gone; ?N badges count per tab as stated
- [x] Enter opens the request page; try requests open their scene; 另 N 个请求 expands
- [x] Render and key tests EN/ZH, 40 and 62 columns, no-colour; docs/reference.md updated

## Comments

- Rewritten 2026-11-26 for D-2026-11-26-05 (tab roles); held as needs-info until then.

- Landed in this commit (replay base 6a57187ded1037b889d9b0365055a1ff46e89b5f); gate 5/5 passed.
