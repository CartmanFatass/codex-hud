# 03: Home: every project says something, and fresh finished work stays visible

**Status:** done
**Owner try:** no
**Blocked by:** 01, 02

**What to build:** Main session's live check of 01/02 on the owner's real panel (40 columns, zh) found three gaps against the design (`docs/design/home-portfolio/`, D-2026-11-24-01): 1. **Liveness mark missing.** `src/render/home-view.ts:56` draws `' '` for a reachable project that has no running jobs and is not `snapshot.idle`, so such a header starts with blank cells while a running project has ●. The design: ● running jobs, ○ no running jobs, ✗ root gone. Draw ○ whenever the root is reachable and nothing runs; keep the `空闲` word rule as designed. 2. **Projects with neither `.hud/objectives.md` nor STATE show only the name and a rule.** Three of the owner's five projects look like this. Give them an age on the header from the newest HUD job in that project (the job facts the panel already collects; no git or file scan at paint), and one dim line `无目标或交接记录` / `no Objectives or handoff notes`. A project with no jobs either keeps the dim line and no age. 3. **Fresh finished work disappears.** Home hides done Objectives, so a project that finished two Objectives today says nothing. A done Objective whose result is dated and at most 3 days old (the owner's 3-day rule) stays on Home as one bar row with a ✓ mark and a full green bar, plus its result line as designed; after 3 days it goes. It counts toward the per-project 2-row cap like the others (active and blocked first). Update `docs/reference.md` Home to match. i18n en/zh.

- [x] Render tests at 40 and 80 columns zh/en: a reachable project with no running jobs shows ○; a project with no objectives.md and no STATE shows the dim line and the age of its newest job; a done Objective with a 4-hour-old dated result shows ✓, a full bar and the result line, and one with a 4-day-old result is absent
- [x] Every row stays exactly the panel width
- [x] The land gate passes

## Comments

- Landed in this commit (replay base 69ae48625744f8bb3a5fe0ac1ef54cccc3cb8b02); gate 5/5 passed.
