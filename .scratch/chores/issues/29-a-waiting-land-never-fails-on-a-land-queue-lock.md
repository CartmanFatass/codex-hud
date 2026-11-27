# 29: A waiting land never fails on a land-queue lock timeout

**Status:** done
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** 2026-11-27 ~05:05Z three queued lands failed at once with `waiting for f19e4dd6188b00f6e (gate step 3, 0 min): abstract lock timeout (land-queue)` (unattended/13 ff4d4ccd31d0208eb-2, imp-daily-facts/07 f2d9ff6f38e77f4f4, ticket-store/09 fc93b02fed181360a) while another land held the gate. src/mcp/land-runner.ts:127 takes `withAbstractLock('land-queue', …)` with the default 1000 ms timeout (src/utils/abstract-lock.ts:34). Waiting lands call it every lease poll in `acquire` (~251) and `train()` (~516) holds it across per-candidate `runLock` calls (now up to 10 s after 810a146a), so with several waiters a poll times out and the exception fails the land. Fix: a lock timeout inside the waiting loop is a retry, never a land failure; keep the train claim's critical section short (no nested waits that can exceed the waiters' timeout) or give land-queue a timeout above its longest holder. Main re-queued the three lands by hand.

- [x] Test: four lands queued behind a gate, with a train claim holding land-queue longer than the default timeout, all keep waiting and none fails; they land in order after the gate
- [x] Test: a genuine land-queue holder crash still recovers (existing stale-lock behaviour unchanged)
- [x] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments

- Landed in this commit (replay base 9c65a4b842036bc8efa5494170a01ee721be3d25); gate 5/5 passed.
