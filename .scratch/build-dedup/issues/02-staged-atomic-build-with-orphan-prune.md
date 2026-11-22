# 02: Staged atomic build with orphan prune

**Status:** ready-for-agent
**Blocked by:** 01

**What to build:** Slice 2 (:314-327): scripts/build.mjs compiles into a stage dir and renames per file, prunes orphans, keeps dist intact on a failed compile; build/build:test/clean scripts; the panel reloads only when non-mcp files change.

- [ ] A failed compile leaves dist untouched; a successful one never blanks it
- [ ] Orphan .js files are removed
- [ ] tests/unit/build-publish.test.mjs covers the proposal's 7 scenarios

## Comments
