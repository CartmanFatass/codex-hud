# 25: Queue admission does not treat a wontfix blocker as satisfied

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** imp-daily-facts/02 (`Blocked by: ticket-store/01`) and ticket-store/04 were admitted while ticket-store/01 was wontfix and its replacement ticket-store/06 had not landed; leads flagged it three times on 2026-11-26. A blocker counts as satisfied only when it is done; a wontfix blocker blocks until a ticket that names it as superseded (or the blocker's own comment naming a replacement `feature/NN`) is done. A wontfix blocker with no replacement is reported in `hud_tickets ready` as a blocked reason the main session must fix by editing `blocked_by`, never silently ignored.

- [ ] Test: blocker wontfix with replacement not done → ticket not ready; replacement done → ready
- [ ] Test: wontfix blocker without a replacement → not ready, `ready` shows the reason naming the blocker
- [ ] Same rule for cross-feature blockers and inside a running queue's admission
- [ ] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments
