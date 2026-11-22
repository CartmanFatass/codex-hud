# 03: Lease mutex without flock

**Status:** ready-for-human
**Blocked by:** 01

**What to build:** 07 S3 (owner default B1): src/utils/abstract-lock.ts (Linux abstract socket, as exp-lock and hud-check already do) replaces spawnSync('flock') in src/roles/lease.ts; waits use the shared fs wait; docs drop the util-linux flock requirement. Supersedes async-watch's deferred S4.

- [x] hud_lease grants on release within ~30 ms with zero subprocesses
- [x] A SIGKILLed holder is reclaimed within 1 s
- [x] Control lease rows unchanged

## Comments

- Targeted checks: release-to-grant 17.3 ms, SIGKILL-to-grant 753.7 ms. No lock or wait subprocesses; the existing Git project lookup remains. Control lease rows passed in both layouts and languages.
