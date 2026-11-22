# 04: Sonic works in few batched turns and cannot call hud_sonic

**Status:** claimed
**Blocked by:** none

**What to build:** docs/llm/workers-load-2026-11-22.md §3.1, D-2026-11-22-18. Omit hud_sonic from the worker tools of a sonic job (packages/hud-mcp/bin/worker-tools.mjs and the pi extension). packages/hud-mcp/instructions/sonic.md: batch read-only inspection (parallel reads or one compound shell command per turn, not many tiny sed/ls turns), soft budget of about 20 turns (then report facts gathered plus unchecked paths), report at most 60 lines. implementer.md (and reviewer/oracle where they use sonic): give sonic named files, symbols and questions, split broad surveys into narrow parallel sonics.

- [ ] A sonic job's tool list has no hud_sonic
- [ ] Shipped sonic and caller instructions carry the batching, budget and narrow-brief rules
- [ ] npm test and check:fixtures pass

## Comments
