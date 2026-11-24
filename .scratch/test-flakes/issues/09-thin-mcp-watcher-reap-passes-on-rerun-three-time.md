# 09: thin-mcp-watcher-reap passes on rerun three times today

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** `tests/unit/thin-mcp-watcher-reap.test.mjs` ('thin watcher starts once, catches up, respects grace and failed deadline, then exits') failed then passed on immediate rerun in land gates on 2026-11-24 (flows f2a419d33cd28586e, f6061bad8d153df80, and earlier in the day). Logs: `$HUD_HOME/flows/f2a419d33cd28586e.json.gate-1.log`, `$HUD_HOME/flows/f6061bad8d153df80.json.gate-1.log`. Find the timing assumption that breaks under the gate's `--test-concurrency=8` load and make the test deterministic (fake clock or event wait instead of wall-clock sleeps), without weakening what it checks. Also: `node bin/hud-dist.mjs advise --help` hung for over 2 minutes on 2026-11-24 instead of printing usage or exiting; make `hud advise` exit promptly when given no input or `--help` (it must stay silent on stdout/stderr when run by the statusline).

- [x] The watcher-reap test passes 30 runs in a row under `--test-concurrency=8` alongside the full unit suite
- [x] `hud advise --help` and `hud advise` with no stdin exit within 1 s; detached runs from the statusline stay silent (test)

## Comments

- Landed in this commit (replay base 3fff85bf943597f9080e693cd9cf6b867e751422); gate 5/5 passed.
