# 04: Home sorts projects by what matters

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 03

**What to build:** Owner 2026-11-24: on Home, projects with no Objectives or records (`无目标或交接记录`) sit between MyHUD and toktrack because `src/collectors/home-portfolio.ts` keeps the registration order of `projects.json`. Sort the project blocks: (1) projects with an open owner request first; (2) active stance, by owner priority (high, normal, low), then most recent activity (the age the header shows); (3) maintenance, then paused, each by recent activity; (4) projects with neither `objectives.md` nor STATE; (5) unavailable roots last. Ties keep registration order. The order changes only when activity changes, not per paint. Requests keep their own order. Update `docs/reference.md` Home.

- [ ] Test: a fixture with an active project, a paused one, a no-records one, a maintenance one and an unavailable root in scrambled registration order renders in the order above; a high-priority active project precedes a normal one; between two active normal projects the more recently active comes first
- [ ] The land gate passes

## Comments
