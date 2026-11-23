# 01: Four gate flakes wait on events, not fixed deadlines

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Land gates 2026-11-22 each needed an immediate rerun for: (a) hud-watch-async 'read-close preflight: external close' and (b) job-retention 'an unreadable job.json counts as possibly open until it can be read' — both `AssertionError: watcher condition did not settle` from `until` in tests/helpers/job-retention-fixture.mjs:75 after ~5.1 s (excerpt: ~/.hud/flows/f87f184a7bbf6b792.json.gate-1.log); (c) sonic-process 'sonic checkpoints reach the caller and keep the original pi process running'; (d) fs-wait 'waitUntilFs wakes within 100 ms of a file change and closes all watchers'. Under the parallel full suite fixed deadlines (5 s settle, 100 ms wake) are too tight. For each: wait on the real event or scale the deadline to load, and if a test asserts latency (100 ms), keep the product promise but measure it in a way that load cannot break (e.g. relative to when the watcher was armed, or a separate perf check). Fix a real product gap in the product, not the test.

- [ ] Cause named per test (fixture timing vs product)
- [ ] Each of the four passes 20 consecutive runs alongside a parallel `npm run test:mjs` (command and counts in the report)
- [ ] No test loses what it asserts; a latency claim stays tested

## Comments
