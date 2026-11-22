# 15: Load-sensitive tests pass under a loaded gate

**Status:** done
**Blocked by:** none
**Owner try:** no

**What to build:** 2026-11-22: two tests failed once under a loaded land gate and passed on the immediate rerun: the concurrency-cap test "queued imp starts automatically…" and the thin-mcp-quiet-decision test "an open sonic child holds the real CLI supervisor…". The statusline-workers land (4654c342) then needed a rerun of test:mjs with six red tests: fixture-process-cleanup "SIGKILL of the node --test coordinator leaves no watcher…"; thin-mcp-cli-launch-trust "an agy worker prepends role instructions…" and "a claude role launches with its flags and settles through idle grace"; thin-mcp-quiet-decision "an open sonic child holds…" and "quiet without a report and an in-turn child…"; thin-mcp-read-wait-send "hud_wait all wakes after the last explicit target settles". These look like fixed sleeps or polling windows racing the watcher under load. Replace each timing assumption with a wait on the event or file state the test asserts (bounded by a deadline), without changing product behaviour.

- [x] Each listed test passes 20 runs in a row with the full suite running in parallel (or under `stress-ng`/a CPU-bound sibling)
- [x] No fixed sleep remains in either test's assertion path
- [x] npm test and check:fixtures pass

## Comments

- Landed 92ae5407f7eca47c23baec6df0b4be5745f476f4; gate 5/5 passed.
