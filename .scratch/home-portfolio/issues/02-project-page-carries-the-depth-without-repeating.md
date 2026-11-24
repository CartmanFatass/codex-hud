# 02: Project page carries the depth without repeating Home

**Status:** done
**Owner try:** no
**Blocked by:** 01

**What to build:** Build the Project page from the settled design `docs/design/home-portfolio/` (D-2026-11-24-01): `README.md` sections 3, 4 (layout rules), 5 (Project column) and 6; `sample.html` Project frames are the template; `gen/proposed.mjs` `projectRows` is the prototype. Reuse the text-layout helpers ticket 01 added. In short: identity row (stance, priority, age); Needs you with the whole sentence (up to 4 rows); Objectives: head row (mark, id, `done/total 工单`, state word), full title wrapped (3 rows), next step (3 rows), one bar row per linked feature with counts, the running job under its feature (role icon, ticket, title, age), result (full, with age), evidence links (3, then `另 N 个`); a done Objective is one row; jobs no Objective claims in their own section. Details replaces `进度 / 工单 / 工作区 / 文档`, each row naming what it counts; a partial scan names its bound instead of `不完整`. Acceptance checkboxes only as a muted second figure at ≥ 56 columns. No Home summary bars or load line on Project. Keep the Project navigation ids and actions working. Update `docs/reference.md` Project section to match. i18n en/zh, icon sets, theme roles.

- [x] Render tests over the design fixture at 40, 50 and 80 columns in zh and en: every row exactly the panel width, Objective titles never cut mid-word, the per-feature bars and counts match the fixture, Details rows name their counts and never say `不完整`/Partial
- [x] Test: a done Objective takes one row; a project with no `objectives.md` shows STATE Now/Next
- [x] Enter on a request, Objective, evidence and job row opens the same targets as before
- [x] The land gate passes

## Comments

- Landed in this commit (replay base 0cc012486b9eee6669758658576d0c1d93b76cb4); gate 5/5 passed.
