# 19: The remaining load-flaky tests wait on state

**Status:** done
**Blocked by:** none
**Owner try:** no

**What to build:** dogfood-fixes/15 (landed a03fb09d) hardened 11 tests. Its own land gate still needed a rerun, for four others:
- job-retention-watch-faults "transient later error: a working watch does not poll after recovery"
- statusline-agy "Antigravity quota follows the model id or display name without falling back to another family"
- thin-mcp-cli-turns "supervisor events: a report with a missed status push settles on the safety tick"
- thin-mcp-cli-turns "done without report keeps the job open and a later report settles it"

Earlier gates also flagged these, and 15 did not cover them:
- hud-watch-async "watcher dispatches at most four concurrent reaps…"
- sonic-process "hud_report captures a detached helper before pi exits…"
- statusline-tps "Claude statusline estimates the latest linked response…"
- thin-mcp-scout "scouted create returns one MCP task…"

Apply 15's pattern: wait on the asserted state with a deadline, using its shared helpers in tests/helpers.

- [x] Each listed test passes 20/20 under parallel test:mjs load
- [x] No product change unless a real race is found (then report it)

## Comments

- Landed 355a5575ebab467286cd2bb7dbfe3ef2b4b147b4; gate 5/5 passed.
- 2026-11-22 after landing (f4854555): new load-flaky tests seen in gates, not covered here: thin-mcp-headless "question, follow-up and land repair reopen the same tabless pi session; expiry starts a headless repair" and "old report cannot settle a resumed turn…"; thin-mcp-read-wait-send "hud_read wait_ms and hud_wait wake within 100 ms…"; concurrency-cap "a headless sonic starts even when a legacy sonic fills the role cap"; fixture-process-cleanup; hud-watch "preserves a shared worktree while a continuation job is active". Next flaky batch.
