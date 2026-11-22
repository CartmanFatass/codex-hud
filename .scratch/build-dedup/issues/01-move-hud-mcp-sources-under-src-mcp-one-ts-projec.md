# 01: Move hud-mcp sources under src/mcp, one TS project

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Proposal docs/neon-proposal/03-build-dedup-and-clean-dist.md Slice 1 (:283-312): git mv packages/hud-mcp/src/*.ts to src/mcp, rewrite bin/extension/test/doc paths, drop packages/hud-mcp/tsconfig.json and its dist. Owner defaults taken: Q2 keep build:hud-mcp as an alias, Q3 hint on build before removing the old dist.

- [ ] One tsc build emits dist/mcp/*; packages/hud-mcp/dist is no longer produced
- [ ] ./install --skip-build, hud-mcp, worker tools and the pi extension load from the new paths
- [ ] npm test, test:release and check:fixtures pass

## Comments
