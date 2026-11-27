# 31: A land waits for its repair worker's answered question instead of failing

**Status:** ready-for-agent
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** 2026-11-27: land ff4d4ccd31d0208eb-3 failed the moment its repair worker j927cfddb5c6d5ef6 asked main a question (`failed: cherry-pick (repair 1): … needs the main session: q1`). Main answered within minutes, the worker finished the repair and committed, but the land was already terminal, so main had to start a new land (-4) by hand. Same pattern earlier with je97ca49a97171be5 and j7f534f864a751fa0. While a repair worker has an open question the land stays in a waiting step (`repair 1: waiting for main (q1)`), and continues with the gate when the worker settles with a commit; it fails only if the worker fails, is closed, or the question goes unanswered past the normal question timeout.

- [ ] Test: repair worker asks q1, main answers, worker commits: the same land flow runs the gate and lands
- [ ] Test: repair worker closed or failed while waiting: land fails with that reason
- [ ] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments
