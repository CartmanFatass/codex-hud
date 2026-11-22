# 01: Async reap in hud-watch with per-job isolation

**Status:** ready-for-human
**Blocked by:** none

**What to build:** docs/neon-proposal/06-async-watcher-and-supervisor.md S1: the watcher reaps jobs with async, cancellable commands (bounded concurrency, kill grace), so one slow reap no longer freezes settlement, checks and other jobs for up to 135 s; graceful SIGTERM/SIGINT. Runs after build-dedup/01 (bin import paths). Owner defaults: no new env vars, hud-check only unref'd.

- [x] A 5 s reap of one job does not delay another job's settlement, checks or failure past 500 ms
- [x] SIGTERM exits 0, removes watch.pid, leaves no orphan pi-role-reap or herdr
- [x] watch.log keeps its reap lines; new exit=timeout|aborted|unavailable values

## Comments

- 2026-11-22 landed e049e601 (imp j4c69e5c29fb9a69e): up to 4 concurrent reaps, one task per job, per-repo serialized worktree cleanup, cancellable Pi read-close preflight; herdr-run gains signal/killGraceMs/killProcessGroup (watcher-only, own new group); measured during a 5 s reap: other settle 96 ms, checks 228 ms, tab-close failure 14 ms; SIGTERM exit 0 in 45 ms (TERM-resistant helper 2.0 s), no orphans. Main: 986/986, unit, check:fixtures.
