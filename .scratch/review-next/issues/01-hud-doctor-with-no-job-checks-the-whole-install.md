# 01: hud doctor with no job checks the whole install; hud --version

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Open reviews (fable #10, carbon #9, astra #9; reports j5c4cb51dc2240e9f, j91fa6e1950156406, j89d7a94587dc0669). Bare `hud doctor` runs a read-only preflight (<500 ms): Node version, herdr reachable, pi/pi-role/pi-role-reap on PATH, dist build stamp vs running MCP and watcher generation, package-lock vs node_modules, each client's HUD binding and which checkout/Node it resolves, registered projects' CLI trust, credentials.env mode 0600 (never read or print values), stuck leases, orphaned worktrees. One fix hint per failure, exit non-zero on failure. `hud --version` prints version, commit and build time. `hud doctor <jobId>` unchanged.

- [ ] `hud doctor` lists each check pass/fail with one hint; no writes; never prints secrets
- [ ] `hud --version` prints version, commit, build time
- [ ] Unit tests on a synthetic HUD_HOME with a few failures
- [ ] docs/reference.md + zh updated

## Comments
