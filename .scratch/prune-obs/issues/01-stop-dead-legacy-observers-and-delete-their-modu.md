# 01: Stop dead legacy observers and delete their modules

**Status:** ready-for-human
**Blocked by:** none

**What to build:** Proposal docs/neon-proposal/01-prune-legacy-observers.md Slice 1 (PRUNE-OBS-01, :406-431): the panel main loop stops spawning herdr agent list and sweeping assoc/native-relations/jev-runtime/delegate.json; the 15 listed dead files go; live files trimmed. No user-visible change.

- [x] The 15 Slice 1 files are deleted and the 11 live files trimmed as the proposal lists
- [x] A clean build (rm -rf dist dist-test packages/hud-mcp/dist) passes npm test and check:fixtures with zero visual change
- [x] The panel no longer spawns `herdr agent list` (fake-herdr assertion)

## Comments
