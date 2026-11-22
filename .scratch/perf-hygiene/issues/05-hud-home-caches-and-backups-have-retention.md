# 05: HUD home caches and backups have retention

**Status:** ready-for-agent
**Blocked by:** 01
**Owner try:** no

**What to build:** Measured 2026-11-22 in ~/.hud: backups/trust 34 MB (562 files; src/cli/trust.ts:99-124 backs up .claude.json and friends on every grant, no limit), display/model-cache/decision-labels 8.5 MB (2,073 files, write-only, src/collectors/decision-labels.ts:59), display/statusline 2.8 MB (425 files, one per historical cwd/transcript, src/statusline-parity/storage.ts), display/state 61 leftover pid-*.json snapshots from unclean exits (src/snapshot.ts:325-337). Fix: trust keeps the newest N backups per file (e.g. 10) and skips a backup identical to the last; decision-label and statusline caches evict by age/LRU (e.g. 30 days, size cap), run by hud-watch's existing retention pass; dead-pid snapshots are removed when their pid is gone. Never delete the newest backup of any owner file.

- [ ] Each directory stays under its bound in a synthetic churn test; the newest trust backup of each file is always kept
- [ ] npm test and check:fixtures pass

## Comments
