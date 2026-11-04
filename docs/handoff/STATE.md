# State of the universal-hud effort (handoff to remote orchestration, 2026-11-03)

From 2026-11-03 development runs remotely: first Claude Code cloud (`docs/cloud/README.md`), then dots
(`docs/cloud/dots.md`). The local machine only does the work listed under "Local only". This file replaces the
local orchestrator's scratch notes. Keep it current: the remote orchestrator updates it whenever a package merges
or a decision is taken.

Read first: `AGENTS.md` (the remote entry point), `docs/cloud/dots.md`, `docs/universal-hud-engineering-plan.md` §1
and §4, `docs/universal-hud-concept.md` §15 (decision log), `docs/handoff/integration-notes.md`. `docs/delegation.md`
describes the former local routing only.

## Remote roles

| Phase | Implementer | Oracle (architecture, design incl. frontend, review) |
|---|---|---|
| Claude cloud | per `docs/cloud/README.md` (Opus high for core and tests, Sonnet xhigh for rendering) | Opus max |
| dots | Astra high (all packages, frontend included) | Astra max |

Owner decisions of 2026-11-03:
- In remote phases the Oracle also decides frontend design forks. Locally that was a Fable max subagent.
- On dots, the main session only dispatches. Every judgment goes to a subagent; see `AGENTS.md`.

## Merging (changed 2026-11-03)

The remote orchestrator merges accepted packages into `universal-hud` itself; there is no local merge step any more.
Merge only when:
- the package's Oracle verdict is `accept`;
- an Oracle has verified the report against the branch;
- the full check set in `docs/cloud/README.md` is green on the merged tree, with known flakes rerun alone and both
  runs recorded.

Rules for every merge:
- Use `--no-ff`; never force-push, never rewrite history, never commit to `main`.
- Only one environment merges at a time: whichever phase is active.
- After each merge, update this file and the plan §1 status line (`docs/universal-hud-engineering-plan.md`).

## Status

**Merged on `universal-hud`** (newest first):

- HYG1, the clean cloud test baseline, from cloud run 2. Its handoff is `docs/cloud/handoff/hyg1.md`. One test stays red
  on purpose: `run-control`, which RUNZ1 fixes.
- The cloud run-2 docs, summarised in `docs/cloud/handoff/run-2.md`.
- B10B-s2, the delegation panel: cloud run 1. See `docs/cloud/handoff/b10b-s2.md`.
- B12M, metered recovery reads: cloud run 1, additive. See `docs/cloud/handoff/b12m.md`. B10D adopts it.
- B10b segment 1: the delegation presentation core, bar and statusline line 2.
- B10C:
  - the observation publisher, with production publishing **off**;
  - the native node `{title, kind}`;
  - the owner-approved worker route and split timing gates, recorded in contract 06 「B10C 增补」 and
    `docs/reviews/2026-11-02-astra-b10c-worker.md`.
- B10A: data and tick wiring.
- Earlier: batches 1–5, B13. See plan §1.

Local acceptance of the merged tree (`b42ab16`, WSL, 2026-11-03): build, `npm test` (2329 + 47 pass, 0 fail; HYG1's
red `run-control` test passes on WSL), core, visual 319/319, hud-mcp 83/83, format and fixtures are green; b12m perf
passes. The `b10b-s2-perf` compact changed tick is borderline: p99 10.151 / 8.389 / 9.290 ms over three runs against
the 10 ms gate (rich changed tick 8.77–9.06 ms, rows200 cold 5.63–5.93 ms). Treat a single run above 10 ms as a known
flake only after rerunning it alone, and record both runs; B10B-S3F reruns the gate three times.

**Stopped, not accepted:** B10D, the observation worker. Branch `b10d-worker`, commit `4f2c4ac`, pushed as frozen work
in progress and NOT mergeable. It is based on `6fcf08a`, so merge `universal-hud` (`997c4ab` or later) into it before
any further work. That merge also brings in B10B-s2, which the panel needs to paint delegation content.

The final Oracle verdict is NOT ACCEPTED. Evidence is in `docs/handoff/b10d/`:
- `report.md`, which contains the Handoff section;
- `oracle-1.md`, the design rulings §1–§19;
- `oracle-review-1.md` and `oracle-review-2.md`;
- `performance-summary.json`.

What works:
- Worker isolation. Store stalls of several seconds no longer block paint.
- Legacy output stays byte-identical, with publication only in the worker and zero workers for CLI status/wait.
- 156/156 focused integration tests pass, and the full checks pass.

What fails, measured at n = 1000 per population on 200 nodes and 20,000 headers:

1. **Legacy collection.** The Codex subagent tree and file listing run on the main thread and cost about 85–132 ms
   per tick. This holds on today's synchronous path too: the matched synchronous reference already fails P-06-7 at this
   profile.
   - Bar paint p99 is 93–154 ms; bar operation p99 is 112–282 ms.
   - Simultaneous mixed: bar paint p99 168 ms (max 212 ms), full operation p99 253 ms (bar) and 338 ms (panel).
2. **Storage stalls.** A single `publishPrepared` call took 888 ms, giving an operation max of 1,184 ms. The worker
   keeps paint unaffected, but the operation gate fails.
3. **Liveness.**
   - The 16 reader slots fill with checkpoint-only recoveries, which hold no native reader yet. Full fair traversal plus
     the 15 s lease expiry can rebuild them repeatedly.
   - Large shares of the new-checkpoint and mixed populations fail with `reader_slots_pinned`: 791–920 of 1000.
   - The 30-minute paired soak's no-rescue drain left 166 of 200 targets unsettled after 5,000 operations.
   - §18 also pins accepted history that cannot be proven evictable, such as approval pauses and ended turns.
4. **Retirement recapture.** Progress evidence is still missing.

The owner-authorized §19 fairness exception is Oracle-confirmed in [B10D route §4 and §8](../cloud/rulings/b10d-route.md#4-confirmed-fairness-exception) and recorded in contract 06 “B10D 公平续读增补”, design §6 #13 and concept §15. A normal fair admission that completes verified exact recovery but has no first native result because its granted slice ended may create one ticket for the next already-authorized ordinary collection opportunity's single reader grant. Bind it to full session identity, scope/source generation, exact accepted target and authority generation/current compatible context. Spent, refused or unusable attempts cannot rearm an immediate priority chain; stale context/head/source/scope, expired/lost/follower authority or completed capture invalidates the ticket, and the ordinary cursor resumes.

For a fixed continuously eligible set of N, a regular traversal may consume at most 2N ordinary opportunities, with regular visits and inserted attempts reported separately. Keep blocked targets and original debt/pending-request/latency ages visible. No new operation, timer, root allowance, read/publication grant, authority renewal, numeric-gate waiver or §18 exception is granted. This is opportunity ordering, not a wall-clock completion guarantee.

Implementation and focused evidence remain pending. The next separately admitted B10D work must first incorporate current universal-hud into b10d-worker, adopt B12M's metered recovery handoff, preserve the retained-order cursor correction, and implement/test the bounded ticket and authority housekeeping serially with overlapping collector/link work. It must show actual next-opportunity native progress without repeating the exact recovery, one-use/refusal/expiry/ABA safety, ≤400-opportunity regular traversal for 200 targets at C=1 s and C=5 s, unchanged age/accounting and real publication settlement. This documentation does not start that work or grant a compute window.

B10D remains frozen at 4f2c4ac, NOT ACCEPTED and NOT MERGEABLE. The measured failures and retirement-recapture gap above remain open. LEG1/RCP1 need their own separately resolved and recorded package scope/ownership release; this fairness amendment neither implements nor releases them. The full route is already recorded in docs/cloud/rulings/b10d-route.md, with the owner-decision record in docs/handoff/questions/B10D-route.md.

**Not merged:** `cloud/b10b-s3-wip`, B10B segment 3 (selection, navigation, control bar). Fix round 1 has been
applied, but the re-check is still pending. B10B-S3F finishes it.

## Dots wave 1 checkpoint (2026-11-03)

No wave-1 implementation package below has been accepted or merged. Preserve their branches and full evidence; the merged-tree check gate remains outstanding.

- **B10B-S3F**, `dots/b10b-s3f`: R1 is fixed, R2 and the full-check gates remain open. The owner-approved follow-on `dots/b10b-s3f-perf` candidate has received a fresh Oracle verdict **fix required**, not accepted: repeated Node 24 strict performance failures and missing full checks remain. See `docs/cloud/handoff/b10b-s3f-perf-review-1.md` on that branch and `docs/cloud/B10B-S3F-PERF.md`. Preserve the failed and passing runs; no gate is waived.
- **HYG2**, `dots/hyg2`: Oracle re-check found the P2 fix correct, but the full checks remain red. See branch handoff `hyg2-review-2.md` and `hyg2-topology-diagnosis.md`.
- **RUNZ1**, `dots/runz1`: Oracle final review found no new must-fix code issue, but the full checks remain red. See branch handoff `runz1-review-1.md`.
- The executor denies synthetic Unix sockets and ptrace; its kernel lacks `CONFIG_PROC_CHILDREN`. HYG2 diagnosis reproduced the five corresponding process-topology failures on pinned baseline and current snapshots with both Node 22 and 24. This is not evidence that the affected lifecycle behavior passes.
- The owner withdrew assistant-run local testing for this project; both local test sessions stopped without completing tests. Owner-arranged local Claude evidence has now been received on `local-verification/20261103` (see the follow-on checkpoint below); independent Oracle verification remains pending. See `docs/handoff/questions/B10B-S3F-verification.md`. Assistant continues cloud work. Wave 2 requires B10B-S3F to merge; see `docs/cloud/rulings/queue-progress-20261103.md`.

## Follow-on work checkpoint (2026-11-03)

- The owner directs cloud work to continue while local evidence is reviewed; Oracle decides project forks. No merge or check gate is waived. The [local verification report](https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/REPORT.md) has been received at `local-verification/20261103` commit `9be7246c25b5355845e639116c57150ff79d3117`. The report itself says the HYG2, RUNZ1 and B10B-S3F-PERF README check sets are not green. Independent Oracle verification remains pending; receipt is not acceptance or a green merged-tree result.
- `docs/cloud/B10B-S3F-NEXT.md` defines one released follow-on implementation, with all previous performance failures retained. It is in progress, not accepted. The prior large profile archive and three instrumentation scripts were lost when the executor was replaced; a fresh Oracle consultation is deciding a transparently labeled replacement diagnostic. Text reports, checks and hashes remain recorded; no claim of original raw-archive recovery is made.
- `docs/cloud/rulings/p065-metadata-exception.md` approves the precise fixed private-store metadata exception under the owner's delegated Oracle authority and resolves the P065 local-gate contract fork. Contracts 01–06, concept §15 and `docs/cloud/P065-BUDGET.md` were synchronized through `448c58b1f386f72d74b730018a659c6a75068cea`. The archived [P065 scheduling release](../cloud/rulings/p065-budget-release.md) releases the bounded scope and reserves `dots/p065-budget` plus `/workspace/shared/p065-budget` from accepted integration base `26f6fba36948e6c96e2e109cb374c0d4dbb9ab22`. The initial WIP implementation was published on `dots/p065-budget` at `346b3d6300a2e3f340f22e832c459371c19e2646`, exact source tree `613c6bb048dc6b8616617b2d061232807102e9cb`, followed by handoff documentation including the [implementation report](https://github.com/CartmanFatass/codex-hud/blob/dots/p065-budget/docs/cloud/handoff/p065-budget/implementation.md). The first compute lease was returned at 20:02 UTC on 2026-11-03. The [six design questions](../cloud/rulings/p065-six-design-dispositions.md) have been ruled, and their exact P065/contract-06/concept amendments were recorded through `cb90d0a7806e09685096814fe023491db6e3d02c`. The candidate remains **NOT ACCEPTED, NOT MERGEABLE and NOT PERFORMANCE-QUALIFIED**; work may resume only in a separately assigned dispatcher window under [the resource-window ruling](../cloud/rulings/wave1-resource-windows-20261103.md). Publication and documentation recording do not grant a compute window or satisfy acceptance/merge gates. The historical local-gate ruling remains intact; the startup-registry process-I/O issue remains separate and unresolved.

- **P065 interrupted continuation, 21:20 UTC checkpoint:** The separately admitted 21:07 continuation remains frozen, uncommitted WIP, **NOT ACCEPTED / NOT MERGEABLE / NOT PERFORMANCE-QUALIFIED**. The [prior continuation report](https://github.com/CartmanFatass/codex-hud/blob/dots/p065-budget/docs/cloud/handoff/p065-budget/continuation-1.md) preserves its source identity and earlier checks; those checks precede the final workload-fixture addition and do not validate it. Per the authoritative [interrupted-build ruling](../cloud/rulings/p065-interrupted-build.md), the fixture append and formatting executed at 21:14:05 UTC, and the build reached the TypeScript invocation, but its exit status and authoritative session/owned-descendant termination remain **UNKNOWN**. The first empty status poll was denied; exactly one authorized empty recovery poll at 21:19:48 UTC returned `write_stdin failed: Unknown process id 87162`. No further poll or replay occurred. The reported 21:15 lease return, elapsed time and namespace-limited process snapshots do not prove termination. New controlled workloads on the shared executor remain held pending authoritative lifecycle/cleanup evidence, or a separately authorized genuinely independent executor for distinct validation under the ruling's prerequisites and a new bounded dispatcher window. Do not replay the already-executed append/format/build wrapper or infer a build pass/failure; preserve all prior evidence and restrictions.

## Package queue for dots

Run the items in order. Packages in the same wave touch disjoint files and may run in parallel. A package without a
brief gets one from an Oracle first (`docs/cloud/dots.md`, step 0).

| Wave | Package | Brief | Notes |
|---|---|---|---|
| 1 | B10D route consultation | `docs/handoff/questions/B10D-route.md` | Oracle only, no implementer. Its recommendation goes into the question file for the owner. |
| 1 | P-06-5 scope consultation | `docs/handoff/questions/P-06-5.md` | Oracle only. The recommendation is for the owner. |
| 1 | B10B-S3F | `docs/cloud/B10B-S3F.md` | rendering |
| 1 | RUNZ1 | `docs/cloud/RUNZ1.md` | `src/core/run` |
| 1 | HYG2 | `docs/cloud/HYG2.md` | ledger runtime warning and tests |
| 2 | DOC2 | `docs/cloud/DOC2.md` | starts after B10B-S3F; design doc only |
| 2 | TPD1 | `docs/cloud/TPD1.md` | starts after B10B-S3F; `src/tree-page.ts` dispatch |
| 3 | B10B-s4, the Inspector (design §4.11) | an Oracle writes it | Delegation keys, reasons for a greyed Open, the Resume diagnostic, Coverage with `omittedConflictRows` |
| 3 | Data-layer additions (B9/B16) | an Oracle writes it | See below. |
| 4 | B10D-2 | an Oracle writes it, after the owner decides the route | Merge `universal-hud` into `b10d-worker` first. |

Data-layer additions for wave 3:
- the action, brief and rate fields, and the native digest;
- `node.parent` for the viewpoint root;
- a reconcile descriptor for each conflict relation;
- the picker-label inputs.

The real resume gate waits for B14.

After the queue: B14, the production acceptance and capability matrix, is mostly local; see below. Then B15, the phase
review (ARCH); B3b-C after B15; then phases C–F of the plan.

## Decisions recorded on 2026-11-03

- B10D fairness exception: owner-approved and Oracle-confirmed; contract 06, design §6 #13 and concept §15 record one-use next-normal-opportunity continuation and the explicit fixed-N ≤2N ordering bound. Original debt/request ages, blocked backlog, one-reader/one-publication limits and all numeric/durable-semantics gates remain unchanged. Implementation/evidence are pending and B10D remains NOT ACCEPTED / NOT MERGEABLE. See questions/B10D-route.md and ../cloud/rulings/b10d-route.md.
- P-06-5 scope: owner authorized the Oracle recommendation; the 30 ms budget includes pre-lock preparation and is not reset at lock acquisition. See `questions/P-06-5.md` and `../cloud/rulings/p-06-5.md`. The later precise metadata exception in `../cloud/rulings/p065-metadata-exception.md` resolves the local-gate contract fork without changing numeric budgets; P065 scope and branch/worktree ownership are released by `../cloud/rulings/p065-budget-release.md` on base `26f6fba36948e6c96e2e109cb374c0d4dbb9ab22`; the initial WIP source is published at `dots/p065-budget@346b3d6300a2e3f340f22e832c459371c19e2646` (tree `613c6bb048dc6b8616617b2d061232807102e9cb`), and the first lease was returned at 20:02 UTC. The six questions are ruled in `../cloud/rulings/p065-six-design-dispositions.md` and their exact documentary amendments are recorded through `cb90d0a7806e09685096814fe023491db6e3d02c`. The candidate is NOT ACCEPTED and not performance-qualified; resumption requires a separately assigned dispatcher window.

## Open owner decisions

- O1: the implementer-comparison B14 idle-cost runner. None of the three arms met the merge bar.
- Whether to rename the real project names `shenlun` / `atlas-launch-sources` used in some tests.
- Whether to rewrite git history to remove old private paths. Those commits are already public on `main`.
- Statusline wiring: nothing calls the statusline renderer yet. Candidates are a `hud statusline` entry, or plan D3.

## Local only (needs the owner's machine)

- Herdr integration tests (`npm run test:herdr`) and anything that creates or reads Herdr panes and tabs.
- Real-harness tests that need logged-in Codex or Claude CLIs: `B13_REAL=1`, the B45 real closures, and B14's
  real capability evidence (visible cc→Codex, resume, wake delivery).
- Jev / shared browser and the Hermes human-interaction tests.
- The final P-06-7 qualification on the supported WSL platform. Remote numbers are evidence for design, labelled with
  their host. They are not the formal qualification.
- Switching the live statusline (`claude-hud` replacement), and anything touching `~/.hud`, `~/.claude`, `~/.codex*` or
  `~/.pi`.

## Rules (unchanged)

These are in `docs/cloud/README.md` "Rules every agent keeps":

- The repo is public: synthetic data only.
- Tests use a temporary `HOME` and `HUD_HOME`.
- Only hud-mcp, hud-run and the reconciler write the ledger.
- Contracts and the design are the spec.
- Performance is acceptance.
- One review per change; at most two fix rounds, then ask the owner.
- Never stage `node_modules/.package-lock.json`.
