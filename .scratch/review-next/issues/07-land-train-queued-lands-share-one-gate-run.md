# 07: Land train: queued lands share one gate run

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Reviews (fable #5, carbon #1, astra). When a flow takes the main-checkout lease and others are queued, cherry-pick them in queue order into one integration checkout (skip any that conflict — they go the single path), gate once, then record, fast-forward and push together; on red, fall back to one-by-one (no repair from a train failure). One receipt per job, provenance kept. Builds on open-review-fixes/04 tested-vs-published tree rule. Spec §2.1.1 gains a sentence (main session edits it at dispatch).

- [x] Two or three queued clean jobs land with one gate run; receipts per job
- [x] A conflicting job drops out of the train and lands alone
- [x] Red train falls back to single lands
- [x] Flow timings show the saving on a synthetic 3-job queue

## Comments

- Landed in this commit (replay base c3784e555209af03624e348e07e12ec3a6af08f8); gate 5/5 passed.
