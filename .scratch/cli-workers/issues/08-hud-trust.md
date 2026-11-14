# 08: `hud trust <dir>` adds a project to the CLIs' trust lists

**What to build:** the owner runs `hud trust <dir>` once for a project; afterwards grok, agy and claude workers start
there without a trust dialog. The HUD writes each CLI's own trust file directly (owner, 2026-11-13), after a backup
under `$HUD_HOME`. Codex is skipped: the worker's bypass flag shows no dialog, and its home is picked by the owner's
shell. The dispatch failure for an untrusted directory names `hud trust <cwd>`. Dispatch never trusts on its own.

**Blocked by:** 01, 04, 05

**Status:** resolved

- [x] grok `~/.grok/trusted_folders.toml`, agy `~/.gemini/antigravity-cli/settings.json` `trustedWorkspaces`,
      claude `~/.claude.json` `projects[dir].hasTrustDialogAccepted` (honours `CLAUDE_CONFIG_DIR`)
- [x] Only adds; an existing entry is left alone; a missing file means "not installed" and is not created
- [x] Backup before each edit; atomic write keeping the file mode; nothing else in the file changes
- [x] Unit tests on a synthetic HOME; real run by the orchestrator: a fresh dir trusted, then grok, agy and claude jobs start

## Comments

- 2026-11-14 orchestrator: resolved in e99d7acf (0.1.1). Tests: tests/unit/trust.test.ts. Real run: a fresh /tmp dir trusted, then grok, agy and claude jobs started there and settled; codex skipped (bypass flag, no dialog).
