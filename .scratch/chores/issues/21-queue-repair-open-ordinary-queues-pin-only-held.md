# 21: Queue repair: open ordinary queues pin only held items' jobs, not every landed item

**Status:** done
**Owner try:** no
**Live try:** none
**Blocked by:** none
**Objective:** unattended

**What to build:** Repair from the chores run q4cb6b4851e0cf926 acceptance (lead j35b4c9db4f262115, reviewer major finding). `pinnedQueueJobs` keeps the job directory and land family of every landed item in any open ordinary queue, which breaks the chores/16 and chores/18 acceptance line "ordinary completed jobs without a hold keep today's retention". Pin only what chores/16 and /18 need: the source job of an unresolved owner hold on a paused ordinary queue (and a manually landed item's receipt needed for resume), released when the hold resolves or the run stops or is superseded. Landed items with no hold follow normal retention.

- [x] A landed item in an open ordinary queue without a hold is pruned on normal retention (test)
- [x] A held item's source job stays pinned until the hold resolves, the run stops or is superseded (existing chores/16 and /18 tests still pass)

## Comments

- Landed in this commit (replay base eff63c1f9a0e6eeb457cb1f8760e17db0806b5ee); gate 5/5 passed.
