# 04: Owner requests in one area at the top of every tab, no rows when empty

**Status:** ready-for-agent
**Owner try:** no
**Live try:** with no open requests the Project tab starts with the Objectives right under the strip; add a synthetic request in a scratch project via hud_objective op request, see it on every tab, resolve it and see the row disappear
**Approved removals:** The separate 等你处理 section on Home and 需要你处理 section on Project (merged into the shared request area with the same requests).
**Blocked by:** 03
**Objective:** interaction

**What to build:** D-2026-11-26-04; template README §2 Request area and §11 item 1, frames ov-req-62 vs ov-quiet-62. Open owner requests of all registered projects (explicit requests only, never failures or completions, spec §2.2) pinned at the top of every tab below tabs and strip. Row: `? project › Objective … 在等你 age`; the sentence sits on that row when at least 24 cells remain, otherwise on a second row cut to one row. Order as spec §2.2 (work waits first, owner priority, oldest open). Four requests, then `另 N 个请求` (Enter expands in place). Enter opens today's request page (whole sentence, `o` opens the file); a try request opens its prepared scene. No open request: no row, no heading, no placeholder. It replaces Home's 等你处理 section and Project's 需要你处理 section (so requests never print twice). Keep the `?N` tab badges. Up from the first body row reaches the last request row. Data reuses ticket 03's every-tab light facts.

- [ ] With requests: every tab shows them at the top in spec order, with the sentence on the row or a second row; 40 columns still shows what is asked
- [ ] Without requests: zero rows on every tab; Home's 等你处理 and Project's 需要你处理 sections are gone
- [ ] Enter opens the request page; try requests open their scene; 另 N 个请求 expands
- [ ] Render and key tests EN/ZH, 40 and 62 columns, no-colour; docs/reference.md updated

## Comments
