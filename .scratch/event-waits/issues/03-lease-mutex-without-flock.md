# 03: Lease mutex without flock

**Status:** ready-for-agent
**Blocked by:** 01

**What to build:** 07 S3 (owner default B1): src/utils/abstract-lock.ts (Linux abstract socket, as exp-lock and hud-check already do) replaces spawnSync('flock') in src/roles/lease.ts; waits use the shared fs wait; docs drop the util-linux flock requirement. Supersedes async-watch's deferred S4.

- [ ] hud_lease grants on release within ~30 ms with zero subprocesses
- [ ] A SIGKILLed holder is reclaimed within 1 s
- [ ] Control lease rows unchanged

## Comments
