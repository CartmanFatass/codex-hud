# 02: ./install --with claude-mod installs and removes the mod

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 01

**What to build:** Spec §2.4 (22.23): the mod becomes an install extension. Register it through Claude Code's official plugin commands (a local folder marketplace pointing at integrations/claude-mod, then install), so a repo update reaches it with /reload-plugins; `hud uninstall` removes it. Keep the plain-backup rule for any client file edited.

- [ ] Install then uninstall against a temp HOME leaves Claude settings as before apart from deliberate foreign edits
- [ ] Re-install is idempotent
- [ ] npm test and test:release pass

## Comments
