# 01: Typed job contracts and one atomic write helper

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Proposal docs/neon-proposal/02-decompose-monoliths-and-ts-bins.md S1 (:621): job-contracts.ts, job-io.ts, paths.ts replace the scattered untyped STATUS.json/.tmp+rename writes. Runs after build-dedup 01 (paths move to src/mcp). Zero behaviour change.

- [ ] All job file writes go through the helper
- [ ] Disk JSON fields unchanged; npm test passes

## Comments
