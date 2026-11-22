# 04: A process starting during a build never loads a mix of old and new modules

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Seen live 2026-11-22 08:55: an oracle's hud_sonic call failed with "The requested module '../collectors/thin-jobs.js' does not provide an export named 'jobRowReportMeta'" because it started while scripts/build.mjs was publishing REPORT-SUMMARY-03 file by file (new dist/mcp/thin-main.js, old dist/collectors/thin-jobs.js). BUILD-DEDUP-02 made each file atomic, not the tree. Fix with the smallest mechanism: e.g. scripts/build.mjs marks a publish window (the existing lock or a marker file) and the node entry points that spawn fresh processes (packages/hud-mcp/bin/*.mjs, bin/hud, the panel reload) wait briefly for it to clear before importing dist; or publish in an order that keeps imports satisfiable. No symlink tree switch (rejected in 02), no resident process.

- [ ] A test that starts an entry point while a publish is in progress never sees a missing-export error
- [ ] Publish time and normal start time unchanged when no build runs; npm test passes

## Comments
