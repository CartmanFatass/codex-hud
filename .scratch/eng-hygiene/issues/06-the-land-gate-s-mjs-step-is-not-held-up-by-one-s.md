# 06: The land gate's mjs step is not held up by one serial file

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 02

**What to build:** eng-hygiene/02 measured the gate's mjs step at ~187 s median on a 16-core machine (land records show 130-200 s). tests/unit/thin-mcp-land.test.mjs alone takes ~110-116 s (50 sequential tests, real git worktrees/rebases and 8 real `npm run build` calls) and, because tests/unit/*.mjs expands alphabetically, it starts ~70 s in and runs alone at the end. Remove that tail structurally: split thin-mcp-land.test.mjs into a few files by concern so they run in parallel, and where a land test only checks gate-runner semantics, replace the real `npm run build` gate command with a synthetic one (keep at least one test that runs a real build). Optionally order the glob so the slowest files start first, via a tiny script used by both package.json test:mjs and .hud/project.json land.gate. No test removed, no assertion weakened, no deadline shortened, concurrency unchanged.

- [ ] Before/after median of three runs of the gate's mjs command, with the five slowest files after
- [ ] Every former thin-mcp-land test still exists by name in the split files; at least one test still runs a real npm run build
- [ ] The full gate passes three times in a row
- [ ] If the land gate command list changes, .hud/project.json and package.json stay in sync and CI still runs the same set

## Comments
