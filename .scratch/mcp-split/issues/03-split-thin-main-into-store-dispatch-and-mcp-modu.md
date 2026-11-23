# 03: Split thin-main into store, dispatch and mcp modules

**Status:** done
**Blocked by:** 02

**What to build:** S3 (:639): thin-main.ts shrinks to the entry point; store/dispatch/mcp modules; MCP tool names, schemas, errors and results unchanged.

- [x] thin-main is the entry point only
- [x] tests/unit/mcp-internals.test.mjs added; npm test passes

## Comments

- Landed 71ffc4a1a36b2ea360b46a482ca8bf413bddaadd; gate 5/5 passed.
