# toktrack facts: HUD job records that toktrack can join

**Decision:** D-2026-11-23-01 (spec §2.1.6 retention/archive line). Consumer: toktrack
`.scratch/hud-insight/` (owner's usage tracker, separate repo), which reads HUD records read-only and joins them
to native sessions by session id to show per role × model speed, first-pass landing, cost and cost composition.

## What HUD records

- **Native session ids** on every job, live (`job.json`) and in the archive line: `sessions[]` of
  `{harness, id, path?}` for every native session the job ran (pi session file, Claude session id, Codex
  thread id, Antigravity conversation id), including repair continuations in the same job. Unknown stays absent.
- **Land repair causes** in the archive line's `land`: per repair `{step_kind: "conflict" | "gate", step,
  outcome}` and per rerun `{step, passed_unchanged}` from the flow records, so a consumer can tell a merge
  conflict or a flaky test from a code failure.
- **Lineage**: `retry_of` next to the existing `repair_of`, `parent_job` and `ticket`.
- **Retention**: a job directory whose native session file exists nowhere else (headless pi, e.g. sonic) is kept
  at least 7 days; other retention is unchanged.
- **Model tests**: `hud_create({experiment, arm})` (short free text) stored on the job and in the archive line;
  shown nowhere in the panel.

Nothing here adds a reader in HUD; `hud stats` may use the new fields but need not.
