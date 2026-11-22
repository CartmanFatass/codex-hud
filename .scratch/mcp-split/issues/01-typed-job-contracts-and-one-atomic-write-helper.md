# 01: Typed job contracts and one atomic write helper

**Status:** ready-for-human
**Blocked by:** none

**What to build:** Proposal docs/neon-proposal/02-decompose-monoliths-and-ts-bins.md S1 (:621): job-contracts.ts, job-io.ts, paths.ts replace the scattered untyped STATUS.json/.tmp+rename writes. Runs after build-dedup 01 (paths move to src/mcp). Zero behaviour change.

- [x] Typed MCP job-file writers use shared names and retain the existing atomic-fs writes; exclusive markers and recoverable worker-tree staging keep their protocols.
- [x] Disk JSON fields unchanged; npm test passes

## Comments
- 2026-11-21: build on primitives/01 (atomic-fs) instead of adding job-io's second atomic layer; S1 keeps only the typed contracts and paths.

- Landed 2b50bd0b80f326fd66afeaebfbde2391becd7c30; gate 6/6 passed.
