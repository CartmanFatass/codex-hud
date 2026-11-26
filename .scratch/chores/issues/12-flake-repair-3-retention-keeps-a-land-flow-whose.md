# 12: Flake repair 3: retention keeps a land flow whose flake collection is still pending

**Status:** done
**Live try:** none
**Blocked by:** none

**What to build:** Repair of chores/04 and chores/09 after milestone review je1cb09e15e4334b8 (finding 1; read its report for file:line). pruneLandFlows (src/runtime/work-retention.ts ~124-150) deletes a flow family (receipt + gate logs) once the source job is gone and the land state is terminal, without looking at `flake_collection`. A green land whose collection is still pending (refused hand edit or dispatch waiting) therefore loses its only record when the source job ages out (src/runtime/watch-runtime.ts ~1080-1089), and a later clearance cannot collect it. Keep the flow receipt and the gate log(s) the pending collection references while `flake_collection.state` is pending; prune them normally once collection succeeds or the target ticket is independently resolved (done/claimed/wontfix). Keep a bound: the retained families are only those with pending collections.

- [x] A completed land older than the retention cutoff whose source job is gone and whose flake_collection is pending keeps its receipt and referenced gate log through pruneLandFlows
- [x] After the refusal clears, exactly one collection happens from the retained evidence (test: expired completed land, source job removed, clear refusal, assert one collection)
- [x] Once collection succeeds or the ticket is resolved, the next prune removes the family as before
- [x] Existing retention tests pass

## Comments

- Landed in this commit (replay base 07b99ffb30221579b9da15190a000733682ec9b7); gate 5/5 passed.
