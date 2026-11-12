Verdict: changes-required

Reviewed `4bbb56a1^..b3fdd830` on `universal-hud`, against `docs/spec.md` §§2, 4 and M3b, `docs/delegation.md` step 5, and the review brief's deliberate design choices. Two blocking findings remain; the cleanup suggestion below does not affect the verdict.

## Axis 1 — Spec / scope creep

### 1. Enter does not expand an ordinary job card

**Severity: major** — `src/render/work-card.ts:178–186` (toggle: `src/render/workboard-input.ts:97–106`).

Select a running or finished thin-job card whose model sentence is longer than the panel width, then press Enter. The expansion bit changes, but the displayed card does not: `open` only controls an open question's context/options, while the model sentence always goes through the same single-line clipping function. The owner cannot reveal the rest of that sentence or the underlying factual line using the advertised expand action, on either tab.

The orchestrator confirmed that ordinary job cards must expand too, not only question/decision cards.

**Smallest fix:** when an ordinary card is expanded, wrap the complete model sentence and show its factual line underneath; keep the collapsed model sentence on one row. Preserve the current in-place toggle and question expansion.

Apart from this gap, the settings simplification, intentional model/authority deletions, panel changes, quota selection and pi launch options match the stated scope; I found no actionable scope creep.

## Axis 2 — Simplicity / quality

### 2. A short continuation can permanently retain the previous turn's final result

**Severity: major** — `src/collectors/job-sentences.ts:174–178, 207–211`.

After a pi implementer settles and receives its final sentence, continue that same job with `hud_send` for a small correction. If it settles again within the two-minute floor, no intervening running request replaces the saved row. Every later update then exits at `final && old?.final`, even after the floor expires. The card indefinitely presents the first turn's result instead of the correction's result, including when the correction failed. Reopening the panel retains the stale result because the boolean is persisted.

This is a normal supported continuation path: `hud_send` retains the job id (`packages/hud-mcp/src/thin-main.ts:659–680`). The orchestrator confirmed that final-once applies per settlement, not forever per job id.

**Smallest fix:** persist the settlement identity, such as `settledAt`, alongside the final sentence and freeze only that settlement. A later settlement should become eligible after the existing shared two-minute floor, without requiring a running request in between. Mere report edits within the same settlement can remain frozen.

## Optional — Does not affect the verdict

- **Minor, follow-up:** `src/render/work-visibility.ts:14–25` and `src/render/i18n.ts:47–50` retain orphaned JobProgress remnants. Removing the collector's last caller leaves `jobInspectorTargets` unused; the four inspector labels (`Model assessment`, `Job sentence`, `Empty assessment`, `Generated at`) also have no remaining source/test references. The owner sees no functional defect. **Smallest fix:** delete the unused helper and those dead translation entries; no replacement abstraction is needed.

## Verified

- Traced job-file material collection, keyword rendering, factual fallback, persisted caches, cross-language throttling, final retries, and decision-title generation/application. The decision-title path reads the question and answer, limits titles to eight segmented words, and admits at most three outstanding requests.
- Traced pi launch switches and `pi_args` through validation, job recording, `hud_read`, pi-role argv construction and herdr launch. Arguments remain argv elements rather than shell text; repeated request keys return the original job before processing new options.
- Checked the settled-job `done` projection, role-specific running verbs, Home summaries, decision expansion, tab navigation and the tightest-window quota selection.
- Read the changed tests. They exercise the real collectors/renderers and MCP dispatch path with synthetic provider/CLI boundaries. The Enter test exercises question cards, not the ordinary model-sentence expansion missing in finding 1.
- Read-only commands included `git log --oneline 4bbb56a1^..b3fdd830`, milestone diff/source inspection, and reference searches. `git diff --check 4bbb56a1^..b3fdd830` completed successfully with no diagnostics.
- `git status --short` showed only the pre-existing `M node_modules/.package-lock.json`, with no untracked files. No repository files were changed by this review.
- No builds, tests or real provider calls were run, as explicitly required by the brief. Its reported full-suite result at `b3fdd830` is **29 unit + 48 mjs passed**; that result was supplied, not independently rerun here.

Report: `/home/fires/.hud/jobs/j7192d001c4feeaf9/report.md` — 2 blocking findings, 1 optional follow-up.
