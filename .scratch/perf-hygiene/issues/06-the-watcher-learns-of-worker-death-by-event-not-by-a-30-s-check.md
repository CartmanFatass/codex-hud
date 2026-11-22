# 06: The watcher learns of worker death by an event, not by a 30 s check

**Status:** done
**Blocked by:** 01
**Owner try:** no

**What to build:** Owner 2026-11-22: "watcher必须轮询吗 不能事件驱动吗". hud-watch is already event-driven for job files (recursive fs.watch on STATUS/job/report/... in src/runtime/watch-runtime.ts:623) and sleeps on one timer set to the nearest deadline. The remaining periodic wake is `cliCheck` (30 s, HUD_WATCH_CLI_CHECK_MS): while any headless sonic or reap preflight is working, the watcher rescans every 30 s because the death of a process that is not its child leaves no file event (a SIGKILLed runner writes no sonic-exit.json). Replace that with a death event: each runner/supervisor the HUD starts (headless sonic runner, CLI supervisor, land runner) listens on an abstract Unix socket named after its job (src/utils/abstract-lock.ts already uses abstract sockets); the watcher connects once per live job and treats the socket's close as the death signal (the kernel closes it when the process dies, even on SIGKILL); herdr pane/tab-closed events stay as they are. Keep exactly one fallback timer for deadlines (retention, sonic checkpoints, retry backoff), never a fixed-interval scan. Pi workers launched through pi-roles: use the same socket if the runner owns one, else keep the current check only for those and say so.

- [x] With only working headless sonic jobs, the watcher makes no periodic scan; a SIGKILLed runner is noticed within 1 s through the socket close
- [x] strace/timer count shows no wake-ups between events and deadlines in an idle-but-working state (report the numbers)
- [x] npm test and check:fixtures pass

## Comments

- Landed 78d50dfa5e7085b1714bcfd6c1aba1d8614ec0bb; gate 5/5 passed.
