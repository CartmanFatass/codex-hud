# 15: Two load-sensitive tests pass under a loaded gate

**Status:** ready-for-agent
**Blocked by:** none
**Owner try:** no

**What to build:** 2026-11-22: two tests failed once under a loaded land gate and passed on the immediate rerun: the concurrency-cap test "queued imp starts automatically…" and the thin-mcp-quiet-decision test "an open sonic child holds the real CLI supervisor…". Both look like fixed sleeps or polling windows racing the watcher under load. Replace each timing assumption with a wait on the event or file state the test asserts (bounded by a deadline), without changing product behaviour.

- [ ] Each test passes 20 runs in a row with the full suite running in parallel (or under `stress-ng`/a CPU-bound sibling)
- [ ] No fixed sleep remains in either test's assertion path
- [ ] npm test and check:fixtures pass
