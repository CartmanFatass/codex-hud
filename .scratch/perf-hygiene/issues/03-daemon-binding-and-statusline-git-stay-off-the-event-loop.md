# 03: Daemon binding and statusline git stay off the event loop

**Status:** ready-for-agent
**Blocked by:** none
**Owner try:** no

**What to build:** Outside review 2026-11-22 (verify with a measurement first; drop what does not hold): src/collectors/daemon-binding.ts:313-431 runs spawnSync('tmux', …) (1 s timeout) and a synchronous full-column `LIKE '%rpc.method="thread/%'` query over ~/.codex/logs_2.sqlite (97 MB + WAL today) from the bar's 1 s tick and the panel's finder.check(); src/statusline-parity/git.ts:22-45 runs several synchronous git commands every 2 s. Fix: async subprocesses with the existing budgets; the SQLite lookup runs only when the binding is unknown or stale, bounded (rowid/time window, LIMIT, an index-friendly predicate if one exists) and cached; statusline git reuses the 2 s cache without blocking a render. Read-only toward the Codex database, never vacuum or modify it. Report event-loop block per tick before/after.

- [ ] No spawnSync or synchronous SQLite scan on the bar/panel tick path; before/after block times in the report
- [ ] npm test and check:fixtures pass

## Comments
