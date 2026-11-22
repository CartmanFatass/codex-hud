# 02: Tests never leave hud-watch or hud-cli processes behind

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Found 2026-11-22: eight hud-watch/hud-cli processes with HUD_HOME=/tmp/thin-mcp-*/hud_home survived finished test runs (some from an old worktree), likely after timeouts or failures. Fixture teardown kills every process it spawned (process group or recorded pids) on success, failure and timeout; add a guard test that fails when a fixture leaves a live child.

- [ ] After npm test (including a forced failing test) no process has a /tmp/thin-mcp-* HUD_HOME
- [ ] npm test and check:fixtures pass

## Comments
