# 02: A worker report sent in the gap before its next turn prompt is accepted, not lost

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Scan (sonic j2cfddd907cde7d8c F1): agy `hud_report` rejected with `use the turn token from the prompt you are answering` because HUD advanced the job turn before the turn-2 prompt was delivered (2 of 60 agy reports; worker re-sent the whole report). Accept the previous turn's token while the next prompt is not yet delivered (or park the report for that turn), so no finished report is refused.

- [ ] Reproduced in a unit test: turn advanced, prompt not delivered, report with the old token is accepted for the old turn
- [ ] A report with a token older than that still fails as today
- [ ] No double settlement when the next prompt then arrives

## Comments
