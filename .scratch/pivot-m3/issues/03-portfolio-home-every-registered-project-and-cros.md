# 03: Portfolio Home: every registered project and cross-project requests

**Status:** done
**Owner try:** no
**Blocked by:** 01, 02

**What to build:** Spec §2.2 Home bullets and §5 M3. Home today reads only the panel's cwd (`src/panel/controller.ts:184,200`, `src/render/home-view.ts:11-25`). Make Home a portfolio: first the owner requests of all registered projects (`src/roles/projects.ts projectList`, max 16 as today), ordered by `compareOwnerRequests` with project priority now taken from objectives.md (high > normal > low), each row naming its project; then one block per registered project: name, declared stance, priority when not normal, current goal (its active Objectives' titles, or STATE Now when no objectives.md), latest result with its date where known, and update time. Paused, idle (no running jobs) and unavailable (root missing) projects stay listed and identifiable; bound detail per project, never membership. Keep the existing pane load line. Enter on a request opens that project's waiting page; Enter on a project opens its Project tab (navigation only, no worker grant). Reads stay off the draw path: collect per project with the existing memo and file stamps, and only for Home. Band and badges keep their current-project scope (spec: Home, Project, band and badge show the same requests within their stated scopes). EN and ZH strings. Size budget about 600 lines incl. tests; perf: a Home tick with 8 registered projects and no file changes does no file reads beyond stats (test it).

- [x] Render test: Home with three synthetic registered projects (one paused, one with no objectives.md, one unavailable) at 120x40 and 200x55 in EN and ZH
- [x] Test: requests from two projects order by waits, then project priority, then age
- [x] Test: an unchanged Home tick with 8 projects only stats files
- [x] Input test: Enter on a cross-project request opens that project's waiting page
- [x] `npm test` passes

## Comments

- Landed in this commit (replay base 93ed617a38ed62402a7c1cd5debc5b09b532d28c); gate 5/5 passed.
