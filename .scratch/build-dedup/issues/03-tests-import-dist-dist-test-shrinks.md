# 03: Tests import dist, dist-test shrinks

**Status:** done
**Blocked by:** 02

**What to build:** Slice 3 (:329-335) with owner default Q1 = 1A (declaration:true, dedupe build:test): .mjs and .ts tests import ../../dist; tsconfig.test.json includes only the TS test files.

- [x] dist-test holds only compiled tests
- [x] npm test passes from a clean checkout

## Comments

- 2026-11-22 landed b32b4c45 (imp ja564dec47ff76916): 40 files, path rewrites + tsconfig.test.json rooted at tests/; dist-test 524 → 40 files, no dist-test/src; build:test needs build's dist/*.d.ts (npm test already orders build → build:test). Clean-clone run green. Main: 973/973 twice, unit 92, check:fixtures, test:release green. Two load flakes seen during integration fixed in tests.
