# 07: Land train: queued lands share one gate run

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Reviews (fable #5, carbon #1, astra). When a flow takes the main-checkout lease and others are queued, cherry-pick them in queue order into one integration checkout (skip any that conflict — they go the single path), gate once, then record, fast-forward and push together; on red, fall back to one-by-one (no repair from a train failure). One receipt per job, provenance kept. Builds on open-review-fixes/04 tested-vs-published tree rule. Spec §2.1.1 gains a sentence (main session edits it at dispatch).

- [ ] Two or three queued clean jobs land with one gate run; receipts per job
- [ ] A conflicting job drops out of the train and lands alone
- [ ] Red train falls back to single lands
- [ ] Flow timings show the saving on a synthetic 3-job queue

## Comments
