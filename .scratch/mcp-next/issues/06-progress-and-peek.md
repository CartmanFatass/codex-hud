# 06: Worker progress heartbeats (hud-progress) and read-only hud_peek tool

**Status:** done (2a464fdf)
**Blocked by:** 05

**What to build:** `docs/spec.md` §2.1 & `.scratch/mcp-next/spec.md` §6. Give workers a zero-friction CLI to log milestone steps and give main sessions `hud_peek` to inspect live pane output and progress without disturbing job state.

- [x] Create `packages/hud-mcp/bin/hud-progress.mjs` (`node <hud>/bin/hud-progress.mjs [--dir <job-dir>] <message>`): validates `dir` under `$HUD_HOME/jobs`, sanitizes single-line text (≤240 chars), and atomically appends `{ at, text }` to `progress.jsonl` (retaining at most the newest 50 entries). Include a one-line optional usage hint in `pi` and `cli` `brief.md` footers.
- [x] Expose `progress` (latest up to 10 entries) and `latest_progress` in `thin-jobs.ts` (`OwnerWorker` / `JobRow` display metadata without spamming `jobChanges` on `working` steps) and in `hud_read(job)` observations.
- [x] Register read-only `hud_peek({ job, lines?: integer })` (`lines` 1..120, default 40) in `thin-main.ts` and `PI_ROLE_TOOLS`: reads `STATUS.json`, `progress.jsonl`, and (when `LEFT` pane exists in `SESSION.txt`) runs `herdr pane read <LEFT> --source recent` to return the tail lines. Never stamps `read_at` or `observed_at` and never triggers read-close.
- [x] Add unit tests for `hud-progress` rotation/validation, `hud_read` progress fields, and `hud_peek` non-mutating pane tail inspection.

## Comments

- Orchestrator 2026-11-18: took over panel-v2 04's milestone line (above), so the panel chain does not wait on this ticket. Progress stays out of the compact `hud_read({})` rows and `hud_wait` rows (MCP-READ-COMPACT: no ordinary working narration); it is in `hud_read(job)` and `hud_peek` only.
