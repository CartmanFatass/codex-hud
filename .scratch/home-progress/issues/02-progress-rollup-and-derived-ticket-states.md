# 02: Progress rollup and derived ticket states

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Design slice 2 ROLLUP-TRUTH: Home collector joins live jobs; whole-project ticket totals; feature tags roll into the current milestone; cross-feature <feature>/<NN> blockers; queued (waiting on an unfinished predecessor) apart from stalled; ticket working/try/done derived at read time from jobs, STATE, commits naming the ticket and accepted tries; hud_tickets accepts claimed/done and <feature>/<NN>; hud_create takes optional ticket/slice. Spec §2.1.7 and §2.2.4 sentences as told to the owner.

- [ ] A ticket whose slice landed shows to try without editing its file; accepted shows done
- [ ] A ticket waiting on an unfinished predecessor shows queued, not blocked
- [ ] npm test and check:fixtures pass

## Comments
