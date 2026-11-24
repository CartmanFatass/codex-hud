# 01: Home lists today's projects and folds the rest behind one key

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Owner 2026-11-24 (D-2026-11-24-02, `docs/spec.md` §2.2 Home): Home lists only the registered projects active today: any activity today (a job started, settled or landed today, or a STATE/Objective update today), a running or queued job, or an open owner request. Every other registered project folds into one row at the end of the project list: `其他 N 个项目` / `N other projects` with the expand key shown on the row (e.g. `a 展开`); one key (pick one free on Home, also listed in Help and the footer when the row is selected) and Enter on the row expand them in place in the sort order of home-portfolio/04, and the same key folds them again. The expanded state belongs to the panel session (not Settings) and resets when the panel restarts. With nothing active today, the fold row is the only project row. Requests keep their section. Follow the layout rules of `docs/design/home-portfolio/README.md` section 4. Update `docs/reference.md` Home.

- [ ] Test: a fixture with two projects active today and three not renders two blocks and one fold row naming 3; the key and Enter expand them in sort order; the key folds them again
- [ ] Test: a project with an open request but no activity today is listed; a running job counts as active
- [ ] Every row stays exactly the panel width at 40 and 80 columns zh/en
- [ ] The land gate passes

## Comments
