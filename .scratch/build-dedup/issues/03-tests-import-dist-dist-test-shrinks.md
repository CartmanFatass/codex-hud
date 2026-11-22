# 03: Tests import dist, dist-test shrinks

**Status:** ready-for-agent
**Blocked by:** 02

**What to build:** Slice 3 (:329-335) with owner default Q1 = 1A (declaration:true, dedupe build:test): .mjs and .ts tests import ../../dist; tsconfig.test.json includes only the TS test files.

- [ ] dist-test holds only compiled tests
- [ ] npm test passes from a clean checkout

## Comments
