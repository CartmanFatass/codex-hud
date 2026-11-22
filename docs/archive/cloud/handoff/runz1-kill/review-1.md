# RUNZ1-KILL final Oracle review, 2026-11-03

## Verdict

**FIX REQUIRED. WIP / NOT ACCEPTED / NOT MERGEABLE.**

The new real-process receiptless-Q positive is genuine, and the retained releasing transactions have correctly bound complete evidence. The legacy no-receipt-implies-held predicate is demonstrably unsound. However, two test-only defects require correction: the diagnostic projection leaves the original boot UUID embedded in scope_id, and the assertion’s held-slot branch classifies an outcome as incomplete without examining its proof. Independently, the required complete candidate checks and Node 22 focused gate are not green. This is not a merge approval or permission for another diagnostic burst.

## Reviewed identity and method

- Repository: CartmanFatass/codex-hud.
- Exact reviewed code commit: **f941f820876687d5b37050809ca8121a6644d9d9**, tree **c685e90a7630c660aa78acfc75d171cba4add157**.
- GitHub’s Git commit response confirms its single parent **37cf7bef3075ffa312c36b8f78102f6c4bd4de67**.
- The complete base-to-code comparison contains exactly three files: tests/unit/run-control.test.ts, tests/unit/run-control-kill-fixture.ts and tests/unit/run-control-kill-evidence.test.ts. No production, existing shared fixture, package/lock/script, contract, runtime-profile or known-flake-list change is present.
- The branch head observed during review was **703a25aa515180ac782631e94baca1b2c4d89226**. Its one additional commit adds only docs/cloud/handoff/runz1-kill/implementation.md. It does not change the reviewed source.
- All three remote file bodies exactly match the frozen local bytes. Their SHA-256 values match manifest.json and frozen-candidate-manifest.txt; the listed generated test/control/process files and package-lock identities also match their frozen hashes.

Read the current universal-hud RUNZ1-KILL brief and diagnosis ruling, pre-run plan, branch implementation report, local RUNZ1 Oracle review, owner report and relevant raw historical logs, README/check policy, STATE, relevant execution/supervision contracts, the complete three-file candidate, and its unchanged control/reconciliation/fake-port/process-fixture context. The current documentary universal-hud ref was 2c9aad6b5fea438f47abcb97b7c8692e8c7c1833; it is not the candidate’s source base.

This review was read-only. I performed file/content comparisons, hash checks and static JSON field audits. I ran no repository test, build, benchmark or process probe, accessed no owner computer, spawned no reviewer, and made no repository/file writes or mutations. Retained execution logs are evidence reviewed, not executions witnessed or repeated by this Oracle.

## Findings

### K1: published diagnostic projection retains the original boot identity

**tests/unit/run-control-kill-fixture.ts:165–206 — key-only redaction misses the boot UUID embedded in scope_id — P2, must fix before diagnostic publication.**

The replacer pseudonymizes values only when the property name is boot_id or pid_domain. The unchanged native-group fixture constructs scope_id from the run ID, actual boot ID, PID and process start. That composed string survives in the projected scope and its copies.

All eight retained real KILL-ladder captures contain an unredacted UUID inside scope_id. For each, hashing that embedded value produces the adjacent redacted boot_id value. This independently establishes that it is the original boot identifier, not an unrelated synthetic UUID. I did not print the identifier.

The report’s claim that boot identity is pseudonymized throughout the publication is therefore false for these captures. The matching archive checksum proves integrity of the affected bytes; it does not make them sanitized.

**Public-exposure check:** the exact committed three source files and the published implementation.md contain neither this actual boot UUID nor any complete generated real scope_id from the captures. Their bytes were verified against the corresponding public files. The source contains the defective serializer, but the identified value is confined to the unpublished captures/archive. No public removal is indicated by this check. The dispatcher confirmed that the candidate raw archive has not been published.

Suggested correction: in diagnostic copies only, consistently pseudonymize composed scope identifiers and every occurrence of protected identity values, while retaining equality relationships and chronology. Add a serializer regression using a deliberately embedded boot/domain value. Preserve the original protected evidence, generate distinctly identified sanitized publication copies, update their hashes and the report, and verify that the raw identifier is absent from the serialized output. Do not alter production scope IDs or overwrite the historical records. Do not publicly publish the present archive as a sanitized artifact.

### K2: held-slot branch does not establish the absence of eligible completion proof

**tests/unit/run-control-kill-fixture.ts:225–233 — incomplete-proof classification is selected from slotHeld alone — P2, must fix for the requested evidence-sensitive oracle.**

The branch checks no release transition, no terminal event, nonterminal state, absent receipt and null terminal fields, then returns incomplete-proof. It never examines final.facts, supplied reconciliation observations or the corresponding decisions.

Consequently, a captured description with a correctly bound, accepted, validly timed, unconflicted complete Q can still pass this branch if a cancellation-specific regression incorrectly keeps the run nonterminal and the slot held. All assertions at lines 225–233 can remain true. A fabricated accepted complete Q alongside an alleged incomplete held outcome is also not inspected here. This is a static counterexample established from the branch’s control flow, not a newly executed mutation test or an observed production failure.

The controlled real-process test separately verifies that its live phase contains no receipt/Q, and its positive phase catches general failure to release. Those are meaningful checks, but they do not make the KILL assertion itself proof-sensitive on its held path or catch a defect restricted to cancelled/lost-wait runs.

Suggested correction: independently establish whether the actual captured transaction has eligible complete terminal evidence, including binding, fact time and unresolved conflicts, before accepting a held/incomplete result. A valid unconflicted complete Q must not be called incomplete merely because the observed slot remains held. Add a cloned-capture assertion negative control that retains valid Q but alleges a consistent nonterminal held result. Preserve the existing live/incomplete, receiptful, receiptless-Q and forged-release controls. Do not reject every Q-shaped object indiscriminately; invalid, incomplete or conflicting evidence must still fail closed.

### G1: complete candidate acceptance remains blocked

**docs/cloud/RUNZ1-KILL.md §§7–8; node22-candidate-focused.stdout:132–148; manifest.json unrun — required gates remain failed or unexecuted — P1 acceptance blocker.**

Node 22’s original three-file focused invocation is 53/54 with a real failure, and final-candidate npm test/test:mjs were not run because their selected suites include previously denied operations. No passing subset or historical test run closes these exact-candidate gates. The old ancestor EACCES result and eventual merged-tree gate also retain their independent dispositions. Address these through their owning review/integration and capable-host evidence routes, not by suppressing warnings, stripping inherited proxy policy, importing unaccepted dependency code or waiving the check set.

## Verified implementation and captured behavior

1. **Original ladder preserved.** The diff changes only the target test’s capture plumbing, evidence assertion and capture-before-cleanup handling, plus its import. INT → TERM → KILL ordering, existing launch topology, fixed TERM grace, readiness/wait behavior and native-null expectation remain. The helper has no process/timer/probe/file side effect merely on import.
2. **Observation rather than injected proof.** captureKill wraps existing MemoryRunFactPort operations and the existing launchNodeGroup seam. The inspected MemoryRunFactPort transactions mutate synchronously, matching the wrapper’s immediate before/after capture assumption. Original operations are called once; actual reconciliation inputs and decisions are retained. No added production probe or reconciliation is inserted into the original ladder. The bounded records and serialization failures are not silently swallowed. Instrumentation can change scheduling and is not a timing-equivalent historical replay.
3. **Actual releasing transitions checked.** The releasing branch verifies one slot transition, the input CAS revision, retained input facts, supporting rather than audit-only evidence, registration/meta/run bindings, native-null fields, claim revocation, terminal event and classification. Its explicit evidence predicates do not use reconcileRun as their sole expected answer. The generic fake-port terminalEvidenceId is not mistaken for the Q identifier.
4. **Real live-to-Q case.** The new test uses the unchanged Python RUNZ1 fixture and unmodified HeadlessRunControl.reconcile. It positively identifies the live original, establishes a fixed scope, and initially retains the slot without receipt/Q. Termination and reaping use fixture events and finite barriers, followed by one explicit reconciliation. No mock proof or injected trusted Q supplies the integration result.
5. **Both runtime captures agree.** Node 22 and Node 24 controlled-live captures show running, slotHeld=true, live/incomplete scope evidence and no receipt or terminal event. Their Q captures show the same original metadata/identity, accepted complete correctly bound scope_reconciled evidence at a valid proof time, R-02-3 ended, one release, revoked claim, null native fields and no exit.json. Subsequent explicit reconciliation is R-02-0 with no second release/transition and no launch or receipt call. controlled-final duplicates the post-idempotence record; it is not an independent extra run.
6. **Meaningful negative controls.** Both targeted logs retain the old predicate’s actual false !== true failure against the genuine receiptless-Q result and successful rejection of remove-Q, incomplete-harness and wrong-run-binding cloned descriptions. The latter are assertion controls, not observed production release defects. The 22 synthetic table cases separately cover completion/cancellation classifications, incomplete prerequisites, run/source/generation/supervisor binding, rejected/pending evidence, invalid fact times and conflicts.
7. **Retained release audit.** All 14 capture files were inspected with an independent read-only JSON audit of release support, binding, timing, CAS/fact retention, terminal fields and receipt-file agreement. No insufficiently supported new release was found. The eight ladder captures all have a final receipt, false KILL acknowledgement, native_unknown group exit and null native fields. Neither the controlled Q case nor these receiptful ladder results reconstructs the missing historical KILL snapshot.

## Diagnostic and check outcomes

Instrumentation-only Node 24 burst, with the original assertion verified intact:
- Three predeclared isolated target invocations: 3/3 pass; every ladder capture receiptful.
- Original three-file focused invocation: 54/54; its ladder capture receiptful.
- Historical receiptless/ambiguous KILL outcome: **NOT REPRODUCED**. No second burst is present in the supplied evidence.

Frozen final candidate:
- Node 24 v24.22.1 serialized evidence plus complete run-control: **43/43**.
- Node 24 original three-file focused command: **54/54**.
- Node 22 v22.23.4 serialized command: **43/43**.
- Node 22 original focused command: **53 pass, 1 fail**. The unchanged one-shot group-launch test’s JSON.parse receives the inherited UNDICI-EHPA warning before JSON. This is not a KILL safety failure, but it remains an actual required-check failure. No retry/filter/proxy removal was used.
- Node 24 build/build:test/build:hud-mcp and final compilation: exit 0. Node 22 final build:test: exit 0. Production build inputs did not change after their builds.
- Node 24 core: **209 pass, 0 fail, 1 existing opt-in skip**.
- Node 24 visual: **319/319**.
- Node 24 hud-mcp: **81 pass, 2 ledger_busy failures, 1 opt-in skip**. B20 advice and B45 accepted spawn each received exactly one permitted isolated rerun: **9/9** and **8/8**. Initial failures and reruns remain retained and qualify for the existing listed-flake treatment. Their treatment does not waive any other gate.
- format:check, check:fixtures and git diff --check: exit 0.
- Final npm test and test:mjs: **NOT RUN / BLOCKED**. No previously denied operation was retried.
- Merged-tree checks: **NOT RUN**. No merge is approved.

The wrapper preserves inherited proxy variables, records their presence without values, selects Node first on PATH, uses fresh temporary HOME/HUD_HOME/TMPDIR and rejects unexpected warning-suppression settings. Its git-diff hash excludes untracked new files; the explicit three-source and generated-artifact hashes supply the missing candidate identity. Local HEAD remains the base because remote publication used the connector; this was not misrepresented as the remote candidate HEAD.

## Previous local-review disposition

- **F2: partly addressed, not closed.** The genuine Q capture and legacy negative control establish a real defect in the old predicate. They do not establish what happened in the owner’s Node 24 failure, and K2 leaves a gap in the replacement oracle. I inspected the specific KILL entries in all six historical full/focused logs: one failure, five passes. The failure at 15:57:06–15:57:26 UTC remains an actual unexplained failure, not a known flake, proxy effect or retrospectively proven safe release. The old log has no final facts/decision sufficient to choose between legitimate Q and unsafe release.
- **F1: still partly resolved, not closed.** Earlier capable-host runs cover the historical capability/mjs gaps for their pinned source. They are not full checks of this new candidate. The retained owner ancestor-environ EACCES remains real. Its absence under this cloud topology and any independent MCP-ANCESTOR remedy do not retroactively pass that matrix or authorize integration of unaccepted code.
- **F3: not closed on this candidate.** The environment-warning mechanism is corroborated and recurs in the required Node 22 focused command. Historical owner no-envproxy success remains distinct evidence, not authority to change the current profile.

No production performance change was made. No new n=1000 scan-cost experiment is required by this narrow ruling or claimed here. Prior RUNZ1 busy-host/refusal-rate and formal-qualification limitations remain unchanged. Local-only real-harness/tmux/install work is unrun and unclaimed.

## Evidence retention and required next disposition

All **121 SHA256SUMS entries match** their retained files. All **124 archive members** match the corresponding local bytes. The tar SHA-256 is **ee18b52892ac7c65a71e6852862c3d8d053fee7a2cf0aa237188401a4961aa79**. The in-memory-original record digests are retained but cannot be independently reconstructed from the projected captures; these checks establish retained-byte integrity, not recovery of omitted originals.

There is **no verified durable external copy** of this candidate archive. Source and the implementation report are published; raw-evidence publication is unfinished. Because of K1, keep the current archive protected and unpublished, preserve it without destructive replacement, and verify a durable appropriately protected copy plus corrected sanitized publication material through the authorized dispatcher route. Do not claim archival completion from a local tar checksum.

The implementer owns K1 and K2 within the test-only scope; the dispatcher owns retention/publication and routing the independent gates. This bounded submission ends **FIX REQUIRED**. The governing ruling grants no automatic second remedy or extra diagnostic burst: obtain a recorded, narrowly scoped continuation before edits or executions. An eventual corrected exact candidate needs fresh review and the complete applicable checks; only an accept verdict followed by green prescribed merged-tree checks can permit normal integration. P065 remains separate, pending its own scheduling/admission; this read-only review neither consumes nor assigns its compute window.

Primary published references:
- Code: https://github.com/CartmanFatass/codex-hud/commit/f941f820876687d5b37050809ca8121a6644d9d9
- Implementation report: https://github.com/CartmanFatass/codex-hud/blob/703a25aa515180ac782631e94baca1b2c4d89226/docs/cloud/handoff/runz1-kill/implementation.md
- Governing ruling: https://github.com/CartmanFatass/codex-hud/blob/2c9aad6b5fea438f47abcb97b7c8692e8c7c1833/docs/cloud/rulings/runz1-kill-diagnosis.md
- Previous local Oracle: https://github.com/CartmanFatass/codex-hud/blob/37cf7bef3075ffa312c36b8f78102f6c4bd4de67/docs/cloud/handoff/runz1-local-review-20261103.md
- Historical failure: https://github.com/CartmanFatass/codex-hud/blob/9be7246c25b5355845e639116c57150ff79d3117/docs/cloud/handoff/local-verification/20261103/logs/runz1/node24/11-focused-runz1.log