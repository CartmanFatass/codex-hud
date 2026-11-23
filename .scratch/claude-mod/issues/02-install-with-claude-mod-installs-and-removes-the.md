# 02: ./install --with claude-mod installs and removes the mod

**Status:** done
**Owner try:** no
**Blocked by:** 01

**What to build:** Spec §2.4 (22.23): the mod becomes an install extension. Register it through Claude Code's official plugin commands (a local folder marketplace pointing at integrations/claude-mod, then install), so a repo update reaches it with /reload-plugins; `hud uninstall` removes it. Keep the plain-backup rule for any client file edited.

- [x] Install then uninstall against a temp HOME leaves Claude settings as before apart from deliberate foreign edits
- [x] Re-install is idempotent
- [x] npm test and test:release pass

## Comments

- Landed in this commit (replay base 5215288d484191e66448c5925e0caf7831bb2ed6); gate 5/5 passed.
