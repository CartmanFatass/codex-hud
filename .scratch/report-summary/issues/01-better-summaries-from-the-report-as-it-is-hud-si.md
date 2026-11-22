# 01: Better summaries from the report as it is (HUD side only)

**Status:** done
**Blocked by:** none

**What to build:** docs/neon-proposal/18-structured-hud-report.md, owner 2026-11-22 layer A (no worker change). (1) sampleTask's wake Summary takes the first prose line (skip headings, list items, tables, rules, code fences). (2) JobSentences and DecisionLabels see the report's head plus its not-done / blocked / test-result sections (or its tail), bounded, instead of only the first 4 / 12 lines; outcome stays an independent Decision-API judgement. (3) A settled job's final result line is made at once, not held by the 2-minute spacing; the stale running sentence clears on settle. (4) src/roles/report-meta.ts: the signature-bound read/write helper (report_sig = mtime:size:sha256), and src/roles/job-checks.ts reuses its signature cache instead of its own.

- [x] Synthetic reports whose result is at the end (tests failed, items not done) give a partial/blocked-aware sentence input and a prose wake summary
- [x] Final result line appears on the first tick after settle; no extra model calls per job
- [x] npm test passes

## Comments
