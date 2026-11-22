# 22: Tests leave no temp dirs or watchers behind

**Status:** ready-for-agent
**Blocked by:** none
**Owner try:** no

**What to build:** On 2026-11-22 /tmp held 5,451 test temp dirs older than an hour (4,945 `thin-mcp-*`, 371 `role-places-*`, 18 `hud-pi-package-*`, 13 `job-retention-*`, a few watch/panel ones), about 1.5 GB of SSD writes kept, and one orphaned `hud-watch.mjs` from `tests/unit/pi-package.test.mjs` (HUD_HOME `/tmp/hud-pi-package-*`) had run for 72 minutes after its worktree was gone. Every test that makes a temp dir removes it in `after`/`t.after` (including on failure), and every test that starts a watcher or MCP child stops it and waits for exit. Find the leakers by running the suite once into a fresh `TMPDIR` and listing what remains; fix the helpers that create `thin-mcp-*` and `role-places-*` dirs first (one shared helper if they already share code). `fixture-process-cleanup.test.mjs` gets one check that a suite run leaves no `hud-watch` child with a temp `HUD_HOME`.

- [ ] A full `npm run test:mjs` into an empty TMPDIR leaves no directories behind (list any deliberate exception in the report)
- [ ] pi-package tests leave no watcher process
- [ ] Targeted tests pass

## Comments
