# RUNZ1-KILL implementation handoff

Status: WIP / NOT ACCEPTED / NOT MERGEABLE. Fresh final Oracle review pending. The exclusive RUNZ1-KILL compute lease was returned to the dispatcher at 2026-11-03T19:06:52Z; no builds or tests remain running under this worker.

## Identity and ownership

- Base commit: 37cf7bef3075ffa312c36b8f78102f6c4bd4de67; base tree: 5599ac1595a069215850750609f7f64371d1b6f9.
- Published branch: dots/runz1-kill.
- Frozen source commit: f941f820876687d5b37050809ca8121a6644d9d9; tree: c685e90a7630c660aa78acfc75d171cba4add157.
- Commit: https://github.com/CartmanFatass/codex-hud/commit/f941f820876687d5b37050809ca8121a6644d9d9
- Remote ref, parent, tree, three file bodies and comparison verified through the GitHub connector. Exactly three test files changed: tests/unit/run-control.test.ts, tests/unit/run-control-kill-evidence.test.ts and tests/unit/run-control-kill-fixture.ts.
- No production, existing shared fixture, package script, lockfile, contract, supported profile, known-flake list, main or universal-hud change. No dependency branch was imported. node_modules/.package-lock.json remains a local setup artifact and was not published/staged.
- Local worktree remains on base 37cf7be with the three frozen test edits because publication used the connector. This is intentional, not a claim that local HEAD is the remote candidate. Remote file bodies were compared exactly with tested bytes.
- Recovery inspected existing evidence and the visible process namespace before any test/edit. No prior worker was visible; the prior final Node24 focused invocation had already completed 54/54, and it was not repeated. Existing source hashes match the pre-restart frozen manifest. No candidate source was edited during recovery.

## Implementation

The original KILL scenario retains its INT/TERM/KILL order, existing topology, grace and wait semantics, and native-null expectation. Its overbroad no-receipt-implies-held assertion is replaced by a predicate over the actual captured releasing transaction and final snapshot.

The test-only fixture wraps the existing MemoryRunFactPort/group-launcher seams, keeps bounded immutable records and retains actual inputs, decisions, before/after snapshots, signals and receipt calls. It adds no production probes, signals or reconciliations. Publication uses an explicit field projection and stable SHA-256 pseudonyms for boot/PID domains, with original in-memory capture hashes. Instrumentation can perturb timing.

The independent assertion distinguishes incomplete proof, correctly bound complete receiptless Q and a validated final receipt. It verifies a single releasing transaction, valid accepted proof times and bindings, decision support rather than audit-only references, original metadata/registration relationships, null native fields, claim revocation, terminal-event coherence and cancellation classification. It does not use reconcileRun as the sole expected oracle.

The new controlled real-process test starts an existing Python RUNZ1 fixture. A positively identified live original retains its slot with no complete Q. Event barriers then terminate and reap that same original identity; unmodified HeadlessRunControl.reconcile establishes a complete real receiptless Q, releases exactly once with ended/null native status and no exit.json. A subsequent explicit reconciliation preserves the terminal identity/classification without launch or receipt. Deterministic synthetic table guards cover absent/incomplete proof, Q cancellation chronology, binding errors, rejected/pending evidence, invalid fact time and conflicts.

## Actual diagnostic outcomes

Predeclared instrumentation-only Node24 burst, original assertion intact:
- Three separate KILL target invocations: 3/3 pass; all captures receiptful.
- Original three-file concurrent focused command: 54/54 pass; KILL capture receiptful.
- Receiptless/ambiguous historical KILL result was NOT REPRODUCED. No additional diagnostic burst was performed.

Final candidate:
- Node24 v24.22.1 targeted serialized new evidence plus complete run-control: 43/43 pass.
- Node24 original three-file focused command: 54/54 pass.
- Node22 v22.23.4 targeted serialized command: 43/43 pass.
- Node22 original three-file focused command: 53/54 pass, one failure. Unchanged run-process.test one-shot group launch JSON.parse sees the inherited UNDICI-EHPA warning before JSON. Log: node22-candidate-focused.stdout, lines 132-148. No retry, warning filter or proxy removal.
- Controlled live/Q captures are retained for both runtime families. All retained captures passed the independent read-only release-transition screen. This is supplementary screening, not an Oracle accept verdict.

Negative controls genuinely exercised:
- The old no-receipt/slot-held assertion throws false !== true on the actual captured valid Q result.
- Removing Q, making harness termination incomplete and changing Q's run binding in cloned captured descriptions are each rejected by the new assertion while the alleged releasing result is retained.
- These are assertion negative controls, not execution of a production release defect. Table guards construct explicitly synthetic facts and do not inject Q into the real-process integration.

## Checks and limitations

All commands and stdout/stderr, UTC boundaries, exits, runtime/npm paths, parent commit/tree and patch hash are in the evidence directory. Fresh HOME/HUD_HOME/TMPDIR isolation and selected Node-first PATH were used. Inherited proxy values were preserved; only presence is logged. No warning suppression or profile change. The wrapper's git diff hash excludes new untracked source, so the explicit three-source SHA-256 manifest is required to identify the whole candidate; it is retained.

- Node24 build, build:test and build:hud-mcp: exit 0; final assertion compilation exit 0. Production build inputs unchanged after those builds.
- Node22 fresh final build:test: exit 0.
- Node24 test:core: 209 pass, zero fail, one pre-existing opt-in ledger benchmark skip (210 total).
- Node24 test:visual: 319/319 pass.
- Node24 test:hud-mcp: 81 pass, two README-listed ledger_busy failures, one opt-in benchmark skip (84 total). The two failures were B20 advice and B45 accepted spawn. Each received exactly one permitted isolated rerun: B20 9/9 and delegation 8/8. Both original failures and reruns remain in raw evidence. No ancestor EACCES reproduced in this topology; this does not waive or retrospectively resolve the historical owner-local ancestor failure.
- format:check, check:fixtures and git diff --check: exit 0.
- Full npm test and test:mjs: NOT RUN on this final cloud candidate, BLOCKED because their selected suites include previously denied AF_UNIX/ptrace operations. No denied operation was retried. No filtered subset is represented as a complete check.
- Merged-tree checks: NOT RUN, no merge authorized by acceptance yet.
- No performance implementation change; no new n=1000 experiment was run. Prior RUNZ1 performance evidence/limits remain applicable only as previously reviewed. Host reported Linux 6.18.57 x86_64, nine online processors; shared-host noise remains possible.
- Local-only work was not run, simulated or delegated to the owner's machine.

Historical owner Node24 failure remains an actual unexplained failure, not a known flake. New legitimate Q proves that the old predicate is unsound but cannot authenticate the missing historical snapshot. Preserve all six historical owner outcomes. Local review F2 requires the fresh Oracle's explicit disposition; F1's complete-check/ancestor issue and F3's envproxy result remain independent blockers. No unsafe release with insufficient proof was observed in retained new captures.

## Publication and follow-through

Initial GitHub create_tree was rejected before execution for missing visible authorization of public-repository disclosure. After the dispatcher supplied the user's exact repository/publication authorization, the one permitted evidence-backed retry succeeded. Commit/ref publication and verification then succeeded. No bypass or alternate route was used.

Dispatcher-owned report/raw-evidence publication and final Oracle scheduling remain with the dispatcher. Scratch deliverables are under /workspace/shared/runz1-kill-publication; raw evidence under /workspace/shared/runz1-kill-evidence. No repository report path was modified by this worker. Source ownership remains reserved to RUNZ1-KILL pending review; compute ownership has returned.

For owner-run capable-host checks, use the frozen commit and the ruling's complete commands plus the two focused commands on Node22/Node24, fresh builds, fresh HOME/HUD_HOME/TMPDIR, unchanged proxy policy and RUNZ1_KILL_EVIDENCE_DIR pointing to a retained directory. Retain all stdout/stderr, captures, hashes and failures. Do not run an assistant local session. The dispatcher should issue the concise exact-tree request after archiving the wrapper and evidence instructions.
