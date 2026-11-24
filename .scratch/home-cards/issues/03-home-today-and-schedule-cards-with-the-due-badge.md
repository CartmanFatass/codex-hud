# 03: Home Today and Schedule cards with the due badge

**Status:** done
**Owner try:** no
**Blocked by:** 01, 02

**What to build:** Build the cards of the owner-settled design `docs/design/home-cards/` (README sections 2-4, 6, 7; `sample.html` frames are the template; owner answers at the end of the README): Today (landings today across projects, newest 3 with project, ticket title and age, then `另 N 个`; finished and failed jobs by role icon; gate line first-pass vs retried, today only) and Schedule (open `hud_schedule` items sorted by date with countdowns, overdue in amber, today highlighted, project › Objective on a second row when linked, then `另 N 项`; a dim line for active projects quiet for over 2 weeks, skipping paused and maintenance), below the project list and its fold row, folding first in the fold order of section 6 when rows are short. The Home tab badge shows a calendar mark and the count of items due today or overdue, separate from `?N`. The panel only reads the schedule. i18n en/zh, icon sets, theme roles, layout rules of home-portfolio README section 4. Update `docs/reference.md` Home.

- [x] Render tests at 40, 50 and 80 columns zh/en over the design fixture: busy day, quiet day, and a short panel where the cards fold before any project block shrinks; every row exactly the width
- [x] Test: an overdue item shows in amber and counts in the badge; a far item does not count; a done item is gone
- [x] Test: the quiet line skips paused and maintenance projects
- [x] The land gate passes

## Comments

- Landed in this commit (replay base 6649529f13001607ccc96e653d0708cb87ff7912); gate 5/5 passed.
