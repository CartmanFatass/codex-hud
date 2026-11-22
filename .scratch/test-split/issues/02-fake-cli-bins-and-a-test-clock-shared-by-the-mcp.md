# 02: Fake CLI bins and a test clock shared by the MCP test files

**Status:** ready-for-agent
**Blocked by:** 01

**What to build:** Proposal 09 S2: tests/helpers/thin-mcp-fake-bin.mjs and thin-mcp-clock.mjs; harness shrinks; role-places.test.mjs drops its duplicate fixture (it spans :22-79 now); package.json gains test:mcp, test:panel, test:fast. Existing test, test:unit, test:mjs scripts unchanged.

- [ ] test:mcp, test:panel, test:fast run their subsets; test:mjs unchanged and green
- [ ] No test case removed

## Comments
