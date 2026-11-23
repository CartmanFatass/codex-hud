# 04: Watcher-reap read-close flake and install-claude umask dependence

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** (1) Land gate f2ce3cf718a51d534 needed a rerun for `read-close: rejected CLI quit keeps closed while the watcher retries terminal reap` (tests/unit/thin-mcp-watcher-reap.test.mjs); gate f4d39157cd57a8c2c needed it again plus three more: `watcher reaps an exited root without a snapshot once (missing or renamed tab), idles, then archives it at retention` (tests/unit/hud-watch-async.test.mjs), `Claude outside herdr shows no workers from another pane` (tests/unit/native-statusline.test.mjs), `question, follow-up and land repair reopen the same tabless pi session; expiry starts a headless repair` (tests/unit/thin-mcp-headless.test.mjs). Gate logs: ~/.hud/flows/f2ce3cf718a51d534.json.gate-1.log, ~/.hud/flows/f4d39157cd57a8c2c.json.gate-1.log. First look for a shared cause (a common test helper with a fixed deadline or poll interval) and fix it once there; then per-case. Same approach as test-flakes/01 and 03: find the fixed deadline or ordering assumption that breaks under parallel load, replace it with an event/condition wait, keep the assertion. (2) tests/unit/install-claude.test.mjs:114 expects mode 0640 and gets 0600 in worker environments (seen by two workers; the gate passes), so the expectation depends on the process umask. Make the test set or derive the umask so it passes under any umask, without weakening what it checks about the installed file's mode.

- [ ] Each of the four cases passes 20 runs under parallel load (e.g. alongside a full test:mjs) with no assertion weakened
- [ ] install-claude.test.mjs passes with umask 022 and 077
- [ ] No production code change unless a real bug is found; if one is, the report names it

## Comments
