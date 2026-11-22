# B10B-S3F next-route ruling after PERF review

Date: 2026-11-03.

## Decision

**The owner's latest instruction authorizes a fresh Oracle to decide a new, precisely bounded B10B follow-on without another general owner-approval request. It does not automatically renew B10B-S3F-PERF's consumed one-submission allowance.** I authorize a read-only diagnosis and complete-brief preparation step now. **Further implementation is not released by this ruling.** Its distinct release disposition must be recorded after a concrete mechanism, exact ownership and validation plan are established.

Keep B10B-S3F and B10B-S3F-PERF **fix required, unaccepted and unmerged**. Preserve every failed and passing experiment. Do not begin another optimization, expand a cache, undo the reviewed memo, or rerun until a favorable subset appears under the old brief.

**Owner-run local verification is not required before making this route choice or before starting the read-only preparation.** Continue permitted cloud preparation while the owner tests. Local results may materially inform the next remedy, but waiting for them is not a blanket prerequisite for all cloud work. Conversely, the owner's willingness to test does not supply a missing pass or authorize the assistant to restart local testing.

## Authority and relationship to prior rulings

The supplied latest owner instruction is:

> 后续你有本地测试需求可以发给我 然后继续工作即可 我有空会完成测试 队列任务你直接完成即可 无需我批准 有需要抉择的地方请让oracle直接决定

This expressly delegates queue execution and project choices to the Oracle, while the owner undertakes local tests when available. It is materially new authority for deciding what happens after the consumed PERF submission. The old brief and its final review were correct to stop automatic implementation. That stop has now reached the designated decision-maker; it need not become another generic request for permission from the owner.

The delegated decision made here is limited: open a bounded preparation step and preserve a separate implementation release. It does not retroactively accept the failed submission, reset any previous fix counter, grant an open-ended sequence of remedies, change a contract or supported profile, or relax any gate. A new package name alone cannot evade the consumed limit. Any eventual extra implementation must cite this delegation and a separately recorded scope/round decision explicitly.

The queue-progress ruling remains controlling. This follow-on concerns an unresolved wave-1 package; it does not release wave 2, make a later package independent, or reorder the queue. This consultation does not repeat or overturn the designated final review.

## Inspected state and evidence

Read the current universal-hud AGENTS, STATE, dots workflow, cloud README, B10B-S3F and PERF briefs, memo and validation rulings, queue-progress ruling, engineering-plan brief requirements, and the PERF final review. The inspected universal-hud head is `f26124235480d6d6d9f588c3bd62b47388467302`. Since the queue consultation's `2249ab5952b2b4ba6fa8cefaf14c06ea97118c9e`, its two commits add the queue ruling and update factual STATE entries only.

The current PERF branch head is `e5ccee38165b30809bd537e7f31cfed7f227f152`. Comparison with the reviewed evidence head `94969100ec85a41f93eb2a0d677aefc886290691` shows only the addition of `docs/cloud/handoff/b10b-s3f-perf-review-1.md`. There is no new implementation to review. The formal review establishes the measured code-tree equivalence between local `5f2134d0ccedeca4d4fe184699b3bdd2307a65f4` and published `d9225d2ad149bf20cf2d03ab0b9414403ae66376`; this route ruling relies on that review rather than claiming a new artifact verification.

The applicable findings remain:

- R1 is fixed and must be preserved. R3 remains non-blocking and outside this performance work.
- R2 is not fixed. The implementer candidate has Node 24 compact-changed p99 10.579 ms. The later dispatcher series has 10.233 and 12.314 ms compact-changed failures plus a 15.716 ms rich-changed failure. Node 22 passes do not close Node 24.
- The STATE exception for one compact-changed overrun followed by its recorded isolated rerun cannot cover repeated compact failures and a rich failure. No unsupported flake waiver is available.
- V1 remains open: the exact candidate lacks the full npm test and separate mjs results. Earlier failures and unrun stages remain failures and unrun stages, respectively. Focused suites do not replace them.
- V2 remains an historical evidence limitation: the dispatcher reused preceding compiled output without independently rebuilding or recording its digest, and its archived header omitted the actual isolation wrapper. Later well-identified verification can supply new evidence; it cannot retrospectively repair that historical record or justify discarding its failures.
- The one-entry memo has no newly established must-fix semantic defect. Its limited performance signal, mixed profiles and higher sampled old-space peaks do not establish a leak, general GC-tail improvement, host-contention cause, or the next remedy.

## Released now: read-only B10B-S3F-NEXT preparation

Commission one fresh read-only design Oracle to return a complete proposed `docs/cloud/B10B-S3F-NEXT.md` and a distinct release disposition as text. This is preparation, not a source-change package. It may read source, contracts, tests, reports, existing raw profiles, build manifests and measurements. It must not edit source or tests, create a branch/worktree, build, run benchmarks/tests/probes, introduce instrumentation, or mutate repository state during this consultation. The dispatcher may archive the returned text and factual status under its existing recording role, serializing shared document edits.

Inputs must include the pinned heads above; the prior PERF base `bd7e77a0f9a17c3d333527d82fcb4c56f8c72e60`; the complete reviewed implementation/evidence and final findings; the frozen benchmark; design §6 and architecture §8; applicable contracts and segment-2/3 rulings; actual delegation projection, facts, plan, row and monitor call paths; and current wave-1 ownership. Do not substitute the unaccepted PERF branch for an accepted universal-hud base in another package.

Required preparation output:

1. Reconcile source, build and experiment identities, preserving the installed/pre-install baselines, implementer candidate, dispatcher series and instrumented diagnostics separately. Identify what the existing records establish and what is still unknown. Do not infer that a provenance gap caused an observed failure.
2. Trace the changed-view path and the allocation/recomputation sites already represented in the evidence. Inspect actual callers before recommending a different memo policy. Distinguish projection containers, complete facts comparison, plans, row work and caller-held snapshots. State a concrete, falsifiable mechanism for any proposed remedy and why it addresses measured work inside the frozen boundary. Merely repeating “GC” or “host noise” is insufficient.
3. Select the smallest justified next scope. Prefer a strict subset of the old PERF production whitelist: `src/render/delegation/facts.ts`, `projection.ts`, `rows.ts`, `cards.ts`, `lines.ts`, `panel.ts`, `selection.ts`, and the delegation-only portions of `src/render/monitor.ts`. Identify exact functions, tests, documentation/evidence paths and ownership. The old whitelist is an outer bound for this preparation, not renewed permission to edit it. Preserve the reviewed one-entry policy unless a separate, evidence-backed design disposition explicitly changes it.
4. If existing evidence cannot justify a production mechanism, return the exact missing observation and the smallest proposed diagnostic experiment as a separately bounded option. Do not fill the gap with a speculative optimization or an indefinite profiling project. Read-only preparation may conclude that new, declared evidence is the correct next step.
5. Supply every existing complete-brief field: pinned input/base and branch lineage, goal, output paths, complete allowed-file whitelist, commands, expected state assertions, per-command timeouts, evidence locations, role hierarchy, ownership comparisons and stop conditions. Preserve the full README check set, benchmark plan and evidence requirements. A diagnostic plan must distinguish its instrumented observations from acceptance measurements.
6. Give a distinct release disposition: either release one specifically described diagnostic-only step; release one narrowly specified additional remediation submission plus its fresh final review; or hold that step for a named factual/design/ownership prerequisite. If implementation is released, record the exact extra submission allowance and no automatic further fix budget. Explain that it occupies the unresolved wave-1 B10B scope and does not advance any dependent wave. Do not release both several alternative remedies and an implementation search budget.

A sufficiently grounded future Oracle release need not wait for the owner's local results merely because they are pending. It must, however, use the results if they have arrived and could change the choice. Where the missing local observation is actually necessary to choose between mechanisms, say exactly why and hold only that dependent choice while other permitted preparation continues.

## Implementation release disposition: held

**No new production or test change is released now.** The reasons are the absence of a newly selected, evidence-backed mechanism and complete follow-on brief, not an unresolved general permission request and not a requirement that all local tests finish first. The current candidate's correctness review is not evidence that an additional speculative change will help.

The next design Oracle may make the bounded release decision under the owner's delegation after completing the preparation above. This is the existing brief/ownership/design decision process, not an added acceptance or timing gate. The dispatcher must record the exact disposition and act only on the scope actually released. It must not infer a release from a draft brief, a suggested experiment, elapsed time, or an apparently disjoint directory.

Any released work must retain the older candidate and its evidence as an identifiable snapshot. Do not rewrite a branch being tested by the owner or silently substitute a newer candidate for the requested local target. A later source change creates a new tested tree; verification of the previous tree does not transfer automatically.

## Verification while preparation proceeds

The owner's local-testing withdrawal recorded in current STATE takes precedence over the older question file's authorization for assistant-run local sessions. Do not restart a local Codex/testing session. Send the owner a concise exact-target test need only when useful, then continue cloud preparation. Preserve source and artifact identities so independently supplied evidence can be assessed when it arrives.

Any new authorized verification must independently build the pinned target, identify generated output, record the actual command wrapper and relevant environment including NODE_OPTIONS, and use fresh temporary HOME and HUD_HOME for each strict process. Preserve the unchanged Node 22/24 strict series requirements and all outcomes. Coordinate serialized performance windows; do not overlap agent-controlled builds or benchmarks. An appropriate capable executor can address the socket, ptrace and process-topology test coverage; a diagnosis of unavailable kernel/security facilities is not a passing execution. Do not bypass denials, change security settings, simulate local-only work or touch live home/configuration paths.

No new full-suite runtime matrix, timing threshold or statistical rule is added here. Apply the existing candidate and final merged-tree check requirements. If npm test stops before mjs, retain its failure and run/record mjs separately where authorized. Formal supported-WSL P-06-7 qualification remains the existing local qualification, distinct from cloud design evidence.

## Unchanged boundaries and stopping conditions

The strict benchmark remains blob `371b8f784229636f66e88434c422484dd85251eb`: 1,000 samples after 200 warm-ups, nearest-rank, the same fixture, runtime families, preconditioning, movement and measured work. Compact/rich no-change p99 remain at most 2 ms; compact changed at most 10 ms; rich changed at most 15 ms. No trimming, GC subtraction, pooled replacement percentile, best-run selection, heap/GC tuning or benchmark-aware production shortcut is allowed.

Preserve complete invalidation, immutable older frames and exact descriptors, selection/topology semantics, direct-child navigation, visual baselines, existing cache limits and disappeared-node cleanup. Do not add dispatcher effects, change monitor-input/frame-diff, touch other packages, or alter contracts/profiles/gates under this ruling. A need outside the released scope stops that dependent action and returns to the authorized decision process; safety-required action-time approvals or handoffs remain necessary despite general project delegation.

DOC2 and TPD1 implementation still wait for the actual B10B-S3F merge. Later Inspector/data/B10D/LEG1/RCP1 work keeps the recorded queue and separate briefs. P-06-5 and other already permitted read-only preparations can continue, with shared records serialized.

Acceptance still requires the applicable fresh Oracle verdict and verified report. Integration still requires an authorized --no-ff merge, the complete green check set on its final merged tree with only the existing named-flake handling and both logs retained, and only then push and STATE/plan updates. If the merged-tree checks fail, do not push; follow the existing Oracle disposition process. Never touch main, force-push, rewrite history or stage node_modules/.package-lock.json. This ruling grants no merge and no gate waiver.

## Sources and method

- Governing tree: https://github.com/CartmanFatass/codex-hud/tree/f26124235480d6d6d9f588c3bd62b47388467302
- PERF brief: https://github.com/CartmanFatass/codex-hud/blob/f26124235480d6d6d9f588c3bd62b47388467302/docs/cloud/B10B-S3F-PERF.md
- Queue ruling: https://github.com/CartmanFatass/codex-hud/blob/f26124235480d6d6d9f588c3bd62b47388467302/docs/cloud/rulings/queue-progress-20261103.md
- Final review: https://github.com/CartmanFatass/codex-hud/blob/e5ccee38165b30809bd537e7f31cfed7f227f152/docs/cloud/handoff/b10b-s3f-perf-review-1.md
- Review-only branch advancement: https://github.com/CartmanFatass/codex-hud/compare/94969100ec85a41f93eb2a0d677aefc886290691...e5ccee38165b30809bd537e7f31cfed7f227f152
- Memo ruling: https://github.com/CartmanFatass/codex-hud/blob/f26124235480d6d6d9f588c3bd62b47388467302/docs/cloud/rulings/b10b-s3f-perf-memo.md
- Current STATE, including owner-run local verification: https://github.com/CartmanFatass/codex-hud/blob/f26124235480d6d6d9f588c3bd62b47388467302/docs/handoff/STATE.md

Method: read-only repository/file/metadata inspection and supplied final-review evidence. No implementation, source/test edits, builds, tests, benchmarks, profiles, repository writes, git mutations, local-machine actions or new gate were performed or introduced by this consultation.