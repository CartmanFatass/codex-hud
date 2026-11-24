# 01: Home as a one-glance portfolio

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Build Home from the settled design `docs/design/home-portfolio/` (D-2026-11-24-01): `README.md` sections 2, 4 (the ten text layout rules), 5 (Home column), 6 and 7 with the owner's answers at the end; `sample.html` frames are the template; `gen/proposed.mjs` `homeRows` and `gen/fixture.mjs` are the prototype rows and synthetic portfolio to port from (prototype only, not product code). In short: requests first only when any (header `? project › Objective`, work-waits flag, age; then the bare sentence, 2 rows); then one block per registered project: header row with liveness mark (running / idle / root gone), name in a fixed column, stance word when not active, priority arrow when not normal, idle word, running and queued jobs per role with the statusline's role icons, age; one stacked ticket bar row per open Objective (linked features' tickets, done/total, dropped excluded; panel's own bar glyphs and inks), ticketless Objectives a dotted track, paused Objectives grey (owner: show them), at most 2 then `另 N 个`; a result line under its Objective only if dated and at most 3 days old (owner); no `objectives.md` → one dim STATE Now line; unavailable root → mark and word only. Density tiers by free rows (drop separators → results → extra Objectives → one row per project); membership and requests never drop. Drop the pane load line (`This pane · N running`, owner approved this deletion). Carry the bare request sentence as a field instead of parsing the joined display text (README section 6). Keep navigation ids as listed in section 6 so Enter/click keep working. Update `docs/reference.md` Home section to match. Put shared text-layout helpers (sentence rows with a fixed hang, token columns, ages) where `project-view.ts` can reuse them in ticket 02. i18n en/zh, Nerd/Unicode/text icon sets, theme roles, no raw ANSI in `none` mode.

- [x] Render tests over the design fixture at 40, 50 and 80 columns in zh and en: every row exactly the panel width, no row hangs deeper than 2 cells under a label, the blocked Objective shows its bar and blocked mark, the paused project shows a grey bar, the STATE-only project shows its Now line, the unavailable root shows its mark
- [x] Test: 17 registered projects in a short panel give one row per project and keep the request rows
- [x] Test: a result older than 3 days or undated is not on Home; a 4-hour-old dated result is
- [x] The pane load line is gone; Enter on a project, Objective, result and request row still opens the same targets
- [x] The land gate passes

## Comments

- Landed in this commit (replay base ad283566492589f1f64bee128424a6b555c66075); gate 5/5 passed.
