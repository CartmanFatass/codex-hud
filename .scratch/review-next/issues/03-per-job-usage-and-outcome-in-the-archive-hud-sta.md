# 03: Per-job usage and outcome in the archive; hud stats and hud day

**Status:** ready-for-agent
**Owner try:** yes
**Blocked by:** none

**What to build:** Reviews (fable #6, carbon #4, astra #10). At settlement record, where the harness reports it, tokens (input/cache/output) and cost: pi session totals, Claude/agy/codex headless stream or transcript result lines; unknown stays unknown, never estimated. Extend the archive line (src/roles/job-archive.ts) with ticket, route tier/mode, question count, land outcome (attempts, reruns, repairs, sha), usage, and the worker's one-line summary (bounded, home paths stripped; spec §2.1 'no report text' allows the summary line — owner approved A–G 2026-11-23). Add `hud stats [--days N] [--by role|model|route|feature]` and `hud day [--project]` (landed tickets with one-line summaries, failures, flaky gate tests from flows, time and cost by role, coverage). Control → Usage reads the same.

- [ ] Archive lines carry the new fields; old lines still parse
- [ ] `hud stats` and `hud day` render from archive + live jobs + flows with coverage shown
- [ ] Unknown cost shown as unknown
- [ ] Unit tests on synthetic archives
- [ ] Live: `hud day` on the real HUD_HOME prints today's summary

## Comments
