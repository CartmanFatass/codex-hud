# Milestone review: workflow/06 main-composed workflows (2026-11-26)

Reviewer job jdbe5e28cccaf7432 (astra high), commissioned by the project-lead acceptance after workflow/06 landed outside its queue run. Brief: tmp/tasks/review-workflow-06/brief.md. Commits: 783f9222, 2ea6a7e5 (diff 4533da53..2ea6a7e5).

Verdict: changes-required

## Spec

1. **Blocker — the owner grant is bound to the right proposal, but not issued across an owner-only boundary.** `src/cli/hud-main.ts:36–41` distinguishes the owner from a worker solely by the absence of `HUD_JOB_DIR`. A main-session shell meets that condition. So does a main-authored workflow check: `src/mcp/composed-step.ts:145–148` explicitly removes the variable and runs the command with the runner's remaining environment and filesystem access. Consequently a costly start can receive a perfectly valid run/hash grant without owner action. The binding and 30-minute expiry are not the failing checks. Require an owner-mediated approval that the main session and its child commands cannot produce; hiding the issuer from the MCP tool list is insufficient.

2. **Major — a cheap plan can dispatch more than 2 MiB of Sonic input.** `src/mcp/composed-workflow.ts:65–88` measures referenced project files at plan time and freezes the byte count, not those files. If an input grows before start or while an earlier step runs, the hash still matches. Admission at `src/mcp/composed-step.ts:74–81` passes the original cheap classification without remeasuring. This matters for ordinary build-then-analyze workflows. Freeze the counted inputs or reject a cheap admission when the current aggregate crosses the approved limit.

3. **Major — composed batches bypass the declared circuit breaker after the pilot.** At `src/mcp/composed-step.ts:114–133`, a non-pilot failure updates an item, but the next waiting item is still admitted; the engine sees one generic failure only after the batch drains. Even `breaker: first` with `max_parallel: 1` runs the tail after the first post-pilot failure. The shipped adapter applies settlement and pause *before* the next admission (`src/mcp/batch-step.ts:46–58`). Reuse that item policy, including grouped failure evidence, rather than running the remaining paid work.

4. **Major — literal argv is implemented; the promised shell-executable restriction is not.** `src/workflows/graph.ts:56–62` checks the spelling of `argv[0]`, not the executable it resolves to. A shell under another basename or reached through an executable wrapper passes. `shell: false` at `src/mcp/composed-step.ts:148` correctly prevents implicit interpolation by HUD, but it does not constrain what the selected program executes in the source checkout. Treat arbitrary project commands as code with check-only privileges; enforce the executable policy at that boundary rather than extending the basename denylist. This is independent of whether the named command's argv was frozen correctly.

5. **Major — a witnessed pre-input refusal is treated as spending the grant.** `src/mcp/composed-step.ts:39–41,96–105` sets `input_admitted` before dispatch, including when dispatch returns a definite refusal and no job. Stopping such a run cannot release the unused reservation (`src/mcp/composed-workflow.ts:151–154`). The specified transition is reserve → spend on first input, not on first intent (`.scratch/workflow/spec.md`, Cost/grant). Preserve the conservative treatment of *unknown* outcomes, but distinguish known refusals.

No scope creep found. The deferral was lifted. The main-only tool, project-first templates, reserved shipped names, plan/start split and standalone council separation all fit the ticket.

## Simplicity and quality

6. **Major — a check can mistake the source worker's previous report for its repair.** `src/mcp/composed-step.ts:159–170` accepts `observeJob(job)` as proof that the repair turn settled. For an in-place send, the same job already has a settled report; successful delivery of the repair request is not a fresh report. The driver can release the turn and rerun the check against the unrepaired checkout, using up the repair budget. Reuse the existing keyed-turn, report-signature and settlement-time checks in `src/mcp/land-repair.ts:32–55` for in-place repairs.

7. **Major — a failed task-client push can suppress the hand-back wake indefinitely.** `src/workflows/events.ts:29–45` caches the stamp of `flows/` even after returning composed notices. On failed delivery `src/mcp/panel-delivery.ts:68–79` correctly removes the claim, but the composed marker is inside `flows/<run>/` (`src/workflows/store.ts:18–24`). Its removal does not change the cached directory stamp. With a retired driver and a paused run, subsequent timer ticks need never see another header change. Keep failed deliveries eligible for retry without waiting for unrelated flow activity.

8. **Major — a completed worker can be reported as a failed step.** `src/mcp/composed-step.ts:45–51` rejects raw `stopped` before inspecting a completed report. The shared job model explicitly treats `stopped` with `output_written: true` as `done` (`src/collectors/thin-jobs.ts:282–294`), and the fixed batch uses that model (`src/mcp/batch-step.ts:18–21`). A main session can see a finished report in HUD yet be asked to retry the same work in its workflow. Delete the raw-state override and use the shared display-state/report predicate.

**What can be deleted:** the divergent batch settlement logic and the second definition of a settled job are the highest-value targets. Keep the run/hash recheck, queued cheap fence and retiring-driver handoff; each addresses a distinct boundary.

## Other requested risk checks

- Static fan-out sums jobs and batch members across branches. Replanning identical content produces a different run ID; a bound reservation does not match it. The standalone council grant is separate (`src/workflows/graph.ts:217–221`; `src/roles/run-grant.ts:18–35`; `src/mcp/dispatch/orchestrator.ts:624–636`).
- **Queued browser fence: holds on the inspected paths.** The receipt persists `workflow_cheap`; queued launch checks the newly loaded chain, and the attempt loop checks the prepared fallback before launch (`src/mcp/dispatch/orchestrator.ts:784,1003–1007,1175–1179`). This does not cover the input-size issue above.
- Answer persistence is serialized and idempotent. A conflicting duplicate returns the original answer with `written:false`, not a second branch transition. The retiring driver's PID check and re-wake are correctly placed after the election lock is released (`src/mcp/composed-workflow.ts:167–179`; `src/mcp/composed-step.ts:285–294`). Finding 7 concerns notice delivery, not the answer transaction.
- No regression found in shipped template entry points or ticket-queue `hud_respond`: single and batch `q…` answers retain their own handlers (`src/mcp/mcp/operations.ts:624–638,692–695`). Worker and lead MCP surfaces do not advertise or admit `hud_workflow`.

## Evidence and checks

Read `.hud/brief.md`, the ticket and workflow design, `docs/spec.md` §2.1, the named decision and previous engine review. Inspected **all 30 changed paths**, file by file against each commit's parent: ticket; architecture and both references; CLI; composed workflow/step/state; batch and council; dispatch/contracts; MCP operations/server/runner; role grants/tools; watch/retention; driver/engine/events/graph/store; release archive and the four changed unit-test files. Traced unchanged callers including `batch-step.ts`, `land-repair.ts`, `dispatch/context.ts`, `dispatch/places.ts`, `panel-delivery.ts`, `job-store.ts`, `thin-jobs.ts`, `workflows/{policy,scope,wake}.ts` and worker/lead tool surfaces.

`git diff --stat 4533da53..2ea6a7e5`: 30 files, 1,061 insertions, 73 deletions. `git rev-list 4533da53..2ea6a7e5`: exactly `2ea6a7e5` and `783f9222`. `git diff --check 783f9222^ 783f9222` and `git diff --check 2ea6a7e5^ 2ea6a7e5`: both clean. Static read-only review; no build, tests, live grant issuance or workflow launches performed. No repository files changed.