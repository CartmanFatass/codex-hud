# P065 pending-intention interruption correction

Date: 2026-11-04 UTC

## Status and immutable basis

This additive report addresses only R1 from the independent source re-check of 888643531ca1f9f9dc53761de59ce5f9b03d48b1. That review found F1–F5 fixed at source level but identified a pre-dispatch pending-row reporting failure. All historical reports, failures and source candidates are preserved.

- Repository: CartmanFatass/codex-hud.
- Authorized branch: dots/p065-budget.
- Exact parent: 888643531ca1f9f9dc53761de59ce5f9b03d48b1.
- Parent tree: c812a831e14a8c8d39ef275850f48766b92fc45d.
- Sole changed source: tests/int/p065-budget-benchmark.mjs.
- Sole new document: this report.
- The holder remains blob b75f9f3c2d477c34a6b44119414f3c77e7157724.
- The frozen fixture, production, audit formatting successor, package/build/lock files, shared status and rulings remain unchanged.

Publication is a normal GitHub connector child commit and non-force expected-head update, with exact changed-path inspection and source/report readback. The commit/tree receipt is returned separately to avoid a self-referential report.

## R1 defect and narrow correction

The pre-journaling design registers both H participants before either frame is sent. An outer timeout or interruption between sequential forced participants can prevent the second participant from entering call's finalizer. Previously, that row lacked numeric and summarize dereferenced it, obscuring the original interruption with a secondary TypeError and omitting the incomplete cell.

The corrected source makes every newly registered intention summary-safe immediately:
- prepareCall assigns the ordinary fail-closed numerical result before pushing or journaling the row. Missing response and diagnostics are invalid, not zero.
- numericalGates defensively treats an absent numeric result as numerical(row), so historical/raw pending inputs also fail closed.
- summarize normalizes missing numeric values on copies, not raw evidence. An unfinished row cannot be counted as semantically successful.
- Instrumentation distributions include only actual recorded numeric measurements. Missing pending transaction/callback/commit/rollback/backoff measurements are no longer manufactured as zero-duration samples.
- Dispatch accounting explicitly reports registered, issued, pending-not-issued, uncompleted and interrupted counts. Missing actual outcomes count as uncompleted rather than disappearing from that count.

The wave records its starting row index and tracks issued primary promises. If one participant fails before dispatch while its sibling is already issued, the bounded sibling promise is allowed to settle before failure records are serialized. This preserves the prior correction that avoids synchronous completion logging inside a sibling's timed interval.

On wave failure, every row registered during that wave is finalized, including never-issued participants and any registered recovery. Each retains the original interruption reason and receives an explicit disposition:
- not_issued_incomplete;
- issued_incomplete;
- issued_completed_wave_failed.

The finalizer does not mark a pending row finished, change its dispatch state, invent a response or end timestamp, replace a primary, or add an attempt. Existing real measurements remain untouched. Each affected row receives a wave_failed raw record. The existing cell-level catch can then append its incomplete summary and snapshot it without the absent-numeric reporting exception.

## Pure checker control added

A fixed evidence-checker control constructs a mixed H=2 collection containing:
- One finalized row with actual control timing fields.
- One pre-journaled pending intention with no response, diagnostics or numeric object.

The control requires summary and direct numerical-gate handling without throwing, both registered/measured intentions retained, one invalid timing, expected timing counts of two versus one valid measurement, incomplete numerical/semantic qualification, and no invented pending latency. It confirms that summary normalization does not mutate the original pending row, and that finalized summary data survives JSON serialization/parsing.

The same control also covers interruption before the first dispatch with two pending intentions. Both remain not issued and unfinished, invalid timing counts are two, response/transaction timing distributions have n=0, and both retain the original interruption reason without manufactured response/diagnostic/end fields.

These are pure checker inputs, not measured calls or replacement benchmark populations. The control has been added as source only and has not been executed.

## Preserved requirements and remaining gates

F1–F5 remain unchanged in purpose: independent measured-primary/recovery percentile gates, per-participant successful-loss coverage, canonical reply checks, narrow deliberate-overrun exemptions and strict timing validity. No operational sample, outcome, exception or population size is relaxed.

The complete matrix remains 126 cells, all six tools, H/R=1/1 and 2/10, 50 warmups and 1,000 measured primaries per cell, totaling 132,300 primary calls plus additive recoveries. The 3,600-second bound is unchanged. Interrupted or timed-out runs remain incomplete and cannot be retried with reduced populations to manufacture qualification.

The real framed/SQLite paths, production monotonic clock, owned holder, legitimate fixture authority, heartbeat contention, observation storage load and bounded owned cleanup are unchanged. No holder change is required for R1.

No compiler, syntax checker, formatter, test, embedded checker control, holder, driver, benchmark, npm command or checkout workload was executed for this correction. Source-only inspection and connector publication do not establish runtime correctness or performance.

Still required:
1. Fresh exact-source review of this narrow correction and preservation of F1–F5.
2. Official Prettier 3.9.9 formatting only for the two driver/holder paths in the separately authorized cloud process, retaining the prior failed check.
3. Exact formatted-tree syntax/build/readiness checks and trustworthy compiled-artifact provenance in an explicitly admitted quiet compute slot.
4. Later authorized interruption/lifecycle validation retaining parseable partial artifacts and accounting for every registered intention. The pure checker is not a substitute for that lifecycle evidence.
5. Full unchanged runtime series and inspection of all raw attempts, gate populations, loss coverage, fault semantics and contention/overhead evidence.
6. Continued AF_UNIX-listen/PTRACE_TRACEME restrictions and independent HYG2/RUNZ1/S3F full-check holds. No bypass or retry authority is supplied here.
7. Separate real harness/capability, real-Claude timing, Herdr/tmux, WSL and B14 qualification, final Oracle acceptance and full green actual merged-tree checks before integration.

No package acceptance, performance qualification, compute admission or merge permission is claimed.
