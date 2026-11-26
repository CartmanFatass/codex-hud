# 01: Record provider served_model and land commit span in archive receipts

**Status:** ready-for-agent
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Design: oracle report j4a570e7da6899cf2 (per-model daily performance, sections A-C). In src/roles/job-usage.ts (piTotals, resultUsage, transcriptUsage, Receipt), collect distinct non-<synthetic> response model IDs observed on assistant/result turns (pi provider/model + fast/ultrafast tier when present, claude message.model or result modelUsage keys, codex turn_context/session_meta model, agy PLANNER_RESPONSE model) as served_model (latest) and optional served_models (capped at 4 when >1 model served the job) in usage.json at settlement before pruneJobLogs deletes stdout.jsonl. In src/roles/job-land.ts, copy base_sha and source_sha onto JobLand so verified slice commit spans survive 1-day flows/f*.json pruning. Project served_model, served_models, and land.{base_sha, source_sha} onto archive/YYYY-MM.jsonl in src/roles/job-archive.ts and document in docs/reference.md. toktrack reads these for per-model daily trends and served-model change points (HUD records facts, toktrack analyses).

- [ ] Pi, Claude, Codex and AGY settlement fixtures in tests/unit/job-usage-stats.test.mjs record exact response served_model (and served_models up to 4 when mixed), ignoring <synthetic> and leaving truncated/missing transcripts absent
- [ ] archiveJobLand and archiveJob copy land.base_sha, land.source_sha, and usage.served_model onto the archive JSONL line (tests/unit/job-archive-diagnostics.test.mjs)
- [ ] Older jobs or flows lacking those fields still serialize without fabricated defaults

## Comments
