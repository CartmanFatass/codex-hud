# 03: Async notify and queue watcher start

**Status:** ready-for-human
**Blocked by:** 01

**What to build:** 06 S3: hud-notify, worker-tools, thin-main and src/cli/watch.ts drop their remaining blocking spawns; ensureQueueWatcher is fire-and-forget; hud watch --queue answers within 500 ms when codex queue hangs. S4 (lease/job-project) is deferred.

- [x] hud_create/hud_send lose the 2 s sync block and hud_ask the long freeze
- [x] hud watch --queue exits within 500 ms with a hung codex queue

## Comments

- 2026-11-22 landed b8981a9f (imp jf7461ead1217bfe9): hud-notify/agy-events/worker-tools/watch.ts/thin-main async; ensureQueueWatcher fire-and-forget; the first create reply reuses the tab-placement caller lookup. Synthetic: create 4362→466 ms, send 2060→64 ms, worker ping during hud_ask 1996→2 ms, watch --queue SIGTERM exit 3000→273 ms. Integration exposed a load race in the new hud_ask test (background watcher check vs the Codex stub); test fixed. Main: 998/998 twice, unit, check:fixtures.
