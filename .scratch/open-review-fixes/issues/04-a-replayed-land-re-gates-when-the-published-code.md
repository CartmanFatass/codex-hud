# 04: A replayed land re-gates when the published code tree differs from the tested one

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Astra review #2: hud_land can replay tested commits onto a newer base when paths are disjoint and fast-forward without a second gate (src/mcp/land-runner.ts:293-349); 33/116 attempts were replayed. Disjoint paths can still break (caller vs callee). Record the tested tree and the tree to publish; reuse green only for an identical tree or a ticket/STATE-metadata-only difference; otherwise re-run the gate once before fast-forward, and push the approved sha only.

- [x] Flow receipt records tested_tree and published_tree
- [x] Replay with only metadata differences skips the gate; replay with a code difference re-gates
- [x] Push publishes exactly the gated sha
- [x] Unit tests with synthetic repos

## Comments

- Landed in this commit (replay base acb1e185b254f5de67af3123d02bb07249fe458b); gate 5/5 passed.
