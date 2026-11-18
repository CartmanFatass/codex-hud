# 04: Worker activity sparklines, progress milestones and nested sonic subtrees

**Status:** done (b3cf5852)
**Blocked by:** 03

**What to build:** `docs/spec.md` §2.2 & `.scratch/panel-v2/spec.md` §4. Visualize real-time worker activity cadence with a 10-minute sparkline, show `hud-progress` milestones, and render nested `sonic` child topologies cleanly under parent cards.

- [x] Activity sparkline collector (`src/collectors/`): maintain a lightweight rolling 10-bucket (1 minute per bucket) activity ring per active worker (thin jobs & native subagents) driven by observed transcript/session byte growth, `progress.jsonl` updates and `STATUS.json` / report writes. Render as a 10-cell sparkline (`▁▂▃▄▅▆▇█` in unicode, `..--==##` in text mode) in `work-inspector.ts` (`activity` / `pulse` row) and expanded running cards. A `progress.jsonl` write counts as activity when the file exists (it appears with mcp-next 06); the milestone text line itself is shown by mcp-next 06, not here.
- [x] Nested `sonic` subtrees on Home (Classic `work-lanes.ts` & Split `split-home.ts` preview): group child HUD jobs (`parentJobId`) directly beneath their parent job card as compact 1-line tree branches (`├─ ⚡ sonic · <short title>  <elapsed> <glyph>`, last child `└─`), showing live count (`⚡ 2 sonic`) on the parent card's right badge when folded.
- [x] Add EN/ZH translations and unit tests for sparkline bucket decay/rendering and parent-sonic tree rendering at 40 and 80 columns.

## Comments

- Orchestrator 2026-11-18 (owner: keep slices serial, adjust tickets as needed): the latest `hud-progress` milestone line moved to mcp-next 06, which creates `progress.jsonl` and `latest_progress`; this ticket no longer waits on the MCP chain.
