# 15: Follow-ups from the final nav-redesign review: land-prep label, legacy Landed dates, post-publish push failure

**Status:** needs-triage
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Accepted at finish (lead, repair rounds 2/2) from milestone review jab55f6b606d8a729; three in-scope majors left for later: (1) a land still in preparation reads "at gate" on the Objective page; show its real step. (2) A legacy `Landed` comment date is ignored by the Objective/Feature ordering; use it when no structured landing date exists. (3) A push failure after the landed commit is published shows the ticket as failed; show it landed with a push warning. Read the review report for file:line.

- [ ] Test for each of the three cases
- [ ] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments
