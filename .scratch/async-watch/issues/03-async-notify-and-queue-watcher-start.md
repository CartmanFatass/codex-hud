# 03: Async notify and queue watcher start

**Status:** ready-for-agent
**Blocked by:** 01

**What to build:** 06 S3: hud-notify, worker-tools, thin-main and src/cli/watch.ts drop their remaining blocking spawns; ensureQueueWatcher is fire-and-forget; hud watch --queue answers within 500 ms when codex queue hangs. S4 (lease/job-project) is deferred.

- [ ] hud_create/hud_send lose the 2 s sync block and hud_ask the long freeze
- [ ] hud watch --queue exits within 500 ms with a hung codex queue

## Comments
