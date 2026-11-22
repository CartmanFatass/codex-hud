# 01: Overlay state, dead fields gone, one input guard

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** docs/neon-proposal/04-monitor-state-machine.md S1: monitor-state.ts module, zombie MonitorState fields removed, OverlayState, one tree-page guard. Fixes the live panel dropping `/` filter input, `g` and Add back drafts on reload. Runs after prune-obs is done. Owner defaults: an open filter or confirm-stop blocks auto-reload.

- [ ] `/`, `g` and Add back survive a panel reload
- [ ] check:fixtures shows no frame change; npm test passes

## Comments
