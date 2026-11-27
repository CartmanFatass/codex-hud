# 34: A tab worker whose first prompt was never submitted gets its Enter resent

**Status:** done
**Owner try:** no
**Live try:** Start a lead with the submit key swallowed once and confirm it starts on its own
**Blocked by:** none

**What to build:** 2026-11-27: two lead sessions (Claude Code, opus) sat 20 and 32 minutes in `waiting_orchestrator` ("quiet without a report"). Their panes showed the brief prompt typed into the input box but never submitted (context 0%). One `herdr pane send-keys <pane> Enter` started both. The launch path must verify the first prompt was submitted (the input box no longer holds it, or the client shows activity) and resend Enter once within a few seconds; if that also fails, report a launch failure instead of a quiet worker. The unattended service should treat "prompt still in the input box, context 0%" as this case.

- [x] Test: a fake Claude pane that drops the first Enter receives one resend and the job starts
- [x] Test: when the resend also fails the job reports a launch failure, not quiet without a report
- [x] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments

- Landed in this commit (replay base 95ce99cc910e6e1863a4f91c2dedb3a74e3636bc); gate 5/5 passed.
