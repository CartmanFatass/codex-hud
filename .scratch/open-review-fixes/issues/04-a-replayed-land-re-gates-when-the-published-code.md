# 04: A replayed land re-gates when the published code tree differs from the tested one

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Astra review #2: hud_land can replay tested commits onto a newer base when paths are disjoint and fast-forward without a second gate (src/mcp/land-runner.ts:293-349); 33/116 attempts were replayed. Disjoint paths can still break (caller vs callee). Record the tested tree and the tree to publish; reuse green only for an identical tree or a ticket/STATE-metadata-only difference; otherwise re-run the gate once before fast-forward, and push the approved sha only.

- [ ] Flow receipt records tested_tree and published_tree
- [ ] Replay with only metadata differences skips the gate; replay with a code difference re-gates
- [ ] Push publishes exactly the gated sha
- [ ] Unit tests with synthetic repos

## Comments
