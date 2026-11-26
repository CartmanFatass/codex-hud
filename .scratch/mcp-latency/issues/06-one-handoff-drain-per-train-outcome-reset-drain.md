# 06: One handoff drain per train outcome; reset drain bookkeeping for the single fallback

**Status:** done
**Live try:** none
**Blocked by:** 05
**Objective:** unattended

**What to build:** Repair for mcp-latency/05 (milestone review jeb31e6e4318ab7e2). In `src/mcp/land-runner.ts` `train()`, when a train partially succeeds and the lease-owning helper's own pick is excluded from `members`, `publish(who, tips)` already drains the handoff snapshot (via `drainHandoff()` at ~:463), then `train()` falls through and calls `drainPendingTicketEdits` again (~:567) before the owner's single attempt — two batches at one handoff, so an edit admitted during the first drain commits ahead of the waiting single. In reverse, `handoffDrained` stays true from that partial publish while the single runs under the same lease, so if the single exits via the failure/cancel `finally` (~:609) it skips its own pending batch. Fix: make one handoff decision per train outcome — reuse the drain a successful publish already did, drain exactly once on a clean unpublished fallback (no publish), and reset `handoffDrained = false` when the single attempt starts so its own exit drains. Delete the now-redundant direct second drain call. Keep CustodianError/publish_pending skips as they are.

- [x] A partial train where the lease owner's pick is excluded drains exactly one snapshot before the owner's single attempt; an edit admitted during the train's publish drain does not commit before the single attempt (regression test that forces the lease owner to be the excluded pick)
- [x] After a partial train publish, a single attempt that then fails or is cancelled still drains its pending batch before releasing the lease (test)
- [x] A train that publishes nothing (clean fallback) drains once before the single attempt, as before
- [x] The steady-stream boundedness test synchronizes at least one receipt admission inside the snapshot drain so it deterministically proves post-snapshot arrivals wait for the next turn
- [x] npm test, npm run test:mjs and check:fixtures pass

## Comments

- Landed in this commit (replay base ddbeb06b20e539cd33e1033e8ca08b9becfcf66b); gate 5/5 passed.
