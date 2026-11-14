# 04: exit is a pid fact

**What:** replace `agentMissing()` as an exit test with a `/proc` check of the recorded pid and start time; herdr only
when pid is null, and then three consecutive misses. pid gone with a report → `closed`.

**Who:** imp (agy) · **Size:** ~60 lines · **Blocked by:** QUIET-DECIDE landed · **Status:** wontfix (superseded by 08-one-judge, owner 2026-11-14)

- [ ] herdr errors for 60 s with the pid alive → still working
- [ ] pid gone → failed; pid gone with a report → closed
