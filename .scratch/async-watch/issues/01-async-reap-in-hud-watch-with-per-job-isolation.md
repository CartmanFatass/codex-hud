# 01: Async reap in hud-watch with per-job isolation

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** docs/neon-proposal/06-async-watcher-and-supervisor.md S1: the watcher reaps jobs with async, cancellable commands (bounded concurrency, kill grace), so one slow reap no longer freezes settlement, checks and other jobs for up to 135 s; graceful SIGTERM/SIGINT. Runs after build-dedup/01 (bin import paths). Owner defaults: no new env vars, hud-check only unref'd.

- [ ] A 5 s reap of one job does not delay another job's settlement, checks or failure past 500 ms
- [ ] SIGTERM exits 0, removes watch.pid, leaves no orphan pi-role-reap or herdr
- [ ] watch.log keeps its reap lines; new exit=timeout|aborted|unavailable values

## Comments
