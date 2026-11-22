# 01: Split thin-mcp.test.mjs into ten files behind a shared harness

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** docs/neon-proposal/09-split-tests-for-parallel-speed.md S1: tests/helpers/thin-mcp-harness.mjs plus the ten tests/unit/thin-mcp-*.test.mjs files; delete tests/unit/thin-mcp.test.mjs. Pure move: every existing test case kept with its body unchanged (count them before and after; the sonic count was 158 top-level test( calls / 162 fixture uses), no production code change. Line refs in the proposal drift; check against the current file.

- [ ] Same number of test cases before and after; none skipped or merged
- [ ] test:mjs passes and its wall time is reported before and after

## Comments
