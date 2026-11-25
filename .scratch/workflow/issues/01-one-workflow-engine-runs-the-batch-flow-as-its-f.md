# 01: One workflow engine runs the batch flow as its first shipped template

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Spec §2.1 (D-2026-11-25-05/06); design in `.scratch/workflow/spec.md` (read it whole; slice 1). Build the engine core by generalising the batch runner: graph types + TOML/JSON loader + validator (strict keys per kind, cycles, ancestor-only `from`, unknown/disabled roles, limits, cost class incl. the large-batch rule), run store under `$HUD_HOME/flows/` (header `<id>.json` as a superset of today's batch shape + `<id>/` dir, `writeJsonPrivate`, `withAbstractLock('flow-state', id)`, one driver via `tryAbstractLock('flow-runner', id)`), DAG scheduler, the shared failure policy (lifted from `settleItem`/`failuresByReason`: breaker `rate|first|none`, first failure of a reason wakes once, pause = implicit hand-back), one notice ledger (same keys/markers as today), a detached `workflow-runner` host that exits when paused/idle and is respawned by control calls and the watcher, and the `batch` step kind. Ship `packages/hud-mcp/workflows/batch.toml`; `hud_create({items})` and `hud_create({batch, action})` become shims over it with unchanged ids (`b…`), scale summary, pilot per preset, reserved slots (cap−2, non-batch first), `manifest.json`/`index.json`, `hud_read` view and notice text. `batch-runner` is replaced by `workflow-runner`. No new public MCP tool; `hud_create` schema size unchanged. Watcher: list active runs once per pass and parse a header only when its mtime changes. Performance is first-class: report runner cold start and watcher pass cost before/after.

- [ ] Capture the batch notice strings and `hud_read` batch view as golden fixtures before changing code; they stay byte-identical.
- [ ] `tests/unit/thin-mcp-fixed-batch.test.mjs` passes unchanged; new unit tests cover validation refusals, scheduling and the failure policy on a fake step kind, crash recovery (dispatched-without-job bound by request key, never reissued) and duplicate runner start.
- [ ] A live 3-item Sonic batch (synthetic briefs) runs end to end through the engine with one end notice.
- [ ] Runner cold start and watcher pass cost reported (before/after) in the report.
- [ ] Land gate passes.

## Comments

- 2026-11-25 main: imp jbd90857fd49955de committed b61136ba (goldens) + e7782305 (engine; worktree
  MyHUD-wt/workflow-9955de). Kill/recovery and dispatcher-loss tests pass; fixed-batch suite unchanged; flow notice
  scan 4.39 → 1.71 ms. Held: land only after the hmasd batch b8d86947d528de015 ends (replaces the batch runner).
  After land, main runs a real-provider 3-item Sonic batch smoke.
