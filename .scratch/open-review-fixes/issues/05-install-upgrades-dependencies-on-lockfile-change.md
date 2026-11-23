# 05: Install upgrades dependencies on lockfile change and selective uninstall keeps shared commands

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Reviews (carbon #9, astra #9): `install` runs `npm ci` only when node_modules is missing (install:64-75), so `git pull && ./install` keeps stale deps; selective uninstall unlinks core commands other extensions still use (install:48-59); re-running ./install without --with does a core-only build and leaves client integrations stale. Store the lockfile hash and run npm ci when it changes; keep core commands on selective uninstall; remember installed extensions in $HUD_HOME and upgrade them on a bare ./install.

- [x] Changed package-lock.json triggers npm ci; unchanged does not
- [x] Uninstalling one extension leaves core commands and other extensions working
- [x] Bare ./install upgrades previously installed extensions
- [x] Installer tests cover the three cases

## Comments

- Landed in this commit (replay base 010a42080abc5246bab32b0e1c1d83dfb195f633); gate 5/5 passed.
