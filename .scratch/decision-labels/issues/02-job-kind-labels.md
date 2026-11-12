# 02: Each job is labelled with its kind

**What to build:** each HUD job gets a kind from its brief's title and goal: ui, bug fix, feature, refactor, review,
research, docs, chore (a job may carry more than one). The Inspector shows the kind. Settled jobs of the last 30 days
that have no label yet get one in the background, inside the shared hourly cap, newest first.

**Blocked by:** 01

**Status:** claimed (DL)

- [ ] One call per job, input bounded to the brief's title and goal; cached, so a job is labelled once
- [ ] Inspector shows the kind, EN and ZH
- [ ] Background backfill of the last 30 days, newest first, never above the hourly cap
