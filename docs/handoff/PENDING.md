# Pending items (2026-11-25)

Open items left after the 2026-11-25 optimisation pass (eng-hygiene/01–07, claude-mod/10, review-facts/01).
Each item says who decides and what would trigger it. Remove an item when it is done or dropped.

## Needs the owner

- **Advisor injection (advisor/03, needs-info).** Spec §2.2 allows injection only through the Claude mod or the pi
  extension, as a separate switch, after the owner has tried the shadow. A proposal to extend it to Codex (queue) and
  Antigravity (PreInvocation) would need a spec change. Waiting on: the owner's shadow trial and which items to inject.
- **Raise land-gate concurrency from 8 to 16?** The mjs step is ~194 s with 8 slots ~97 % occupied; the perfect-
  scheduling floor at 8 is ~188 s (eng-hygiene/06 report, job j3db5bb81f5cab914). More concurrency is the only
  cheap lever left, at the cost of more load-sensitive flakes. Main session recommends leaving it while a land
  takes ~3 min.
- **`docs/neon-proposal/` (untracked, 25 proposals).** Used as input (e.g. "neon 18"); archive under
  `docs/archive/` or delete. Not deleted without the owner's word.

## Deferred engineering (start when the trigger occurs)

- **Share MCP processes across gate tests.** Slowest files are spawn-bound: thin-mcp-cli-process ~102 s,
  worker-tools ~97 s, create-context ~85 s. Reusing one hud-mcp per file would cut slot-seconds. Trigger: land
  queue wait becomes a bottleneck.
- **fs-wait leftovers from eng-hygiene/02.** Duplicate recheck-timer cleanup in `src/utils/fs-wait.ts`, and
  `recheckMs` has no direct test (covered only through the ticket queue). Trigger: next change to fs-wait.
- **CI action runtime.** `actions/checkout@v4` / `setup-node@v4` run on deprecated Node 20 (forced to 24).
  Bump to v5 on the next CI change.
- **Split `src/mcp/dispatch/orchestrator.ts` (~1,600 lines)** into admission / prewalk / placement / continuation.
  Trigger: the next feature that has to change it.
- **Jobs directory enumeration grows with retained history** (ARCHITECTURE §4 note). Trigger: a measured scan
  cost on the panel or watcher hot path.
- **`bin/codex-hud` (~1,265 lines of Bash)** into `src/cli/`. Low priority; Codex path is stable.
- **Deeper `hud doctor` checks** (herdr, pi-roles, jev-*, trust, native binary). Keep it read-only and offline.

## In progress (2026-11-25)

- Workflow engine, narrowed by the owner (D-2026-11-25-08): workflow/01 landed (4dbb54ab, real 4-item Sonic batch
  smoke passed); 02 prewalk (j5467e4d747739e9f) and 03 council (jf0c28cb0de949fc5) building, 04 land queued
  (j05b45100d93a978c). 05–07 deferred (needs-triage). The council orphan fault stays until 03 lands.
- Pi worker extension: pi-worker/01 landed (e86ed24c + fixture repair 599d2644); DeepSeek search key imported into
  `~/.hud/credentials.env` (backups beside it); live smoke passed (5 Sonic jobs incl. web search + fetch).
  pi-worker/03 (j3bd8576dccfd4ee1) in its third repair after three process-safety reviews; re-review before land.
  pi-worker/02 waits for 03 (same harness files).
- HMASD failure lessons: three neon xhigh writers (A trajectory jda097fc885c09ffb, B evidence j10f1e6c8d46d381e,
  C organization jc35bc55ccab545ba) write to `tmp/tasks/HMASD-RESEARCH/lessons/`; main merges. The labelling batch
  finished (323 label files, 3,502 items). hmasd-wsl git repo repaired (13 missing promisor objects refetched).
- Known HUD bug: resuming a closed tab job (hud_send) emits a spurious "failed | tab closed" notice while the job is
  working (seen twice on j3bd8576dccfd4ee1). Fix after pi-worker/03 lands (same reap code).
- Minor: `deepseek_fetch` cannot reach raw.githubusercontent.com (404); github.com pages work.

## Data waiting to appear

- **Reviewer `findings` / `reviewed` in archive rows (review-facts/01, 8889dc17).** First job with the fields:
  jabf32d65e5bc4332. Archive rows are written only when a job is retired (≥1 day after close, up to 7 days with a
  local pi session), so toktrack sees the first row from ~2026-11-26 onwards.

## Decided not to do (from the 2026-11-25 suggestion review)

- Lengthen the native Git cache beyond 2 s: index/HEAD stamps cannot see work-tree edits, so a dirty repo could
  show clean (spec §4; perf milestone review 2026-11-22).
- Auto-suggest or auto-reuse prewalk scouts: the dispatching session names scouts (D-2026-11-25-01); it can pass
  `from_jobs` itself.
- Deterministic stop-after-ask for headless workers: already handled — messages to a working headless job queue
  for the next turn (auto-route/06, 08).
