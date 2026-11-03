# RUNZ1-KILL fix-1 independent Oracle re-check and sanitization audit

Date: 2026-11-03. Exact source: 7ba567ee0c3cd12933d79a5029162d32770ee245, tree ad4c596860b264d76d4060be90d70337046b92c5.

## Verdict

**K1 FIXED in the source and independently audited publication candidate. K2 FIXED within the authorized lost-wait test scope. Overall HOLD / FIX REQUIRED / WIP / NOT ACCEPTED / NOT MERGEABLE.**

No additional K1/K2 implementation defect requiring another source round was found. The exact candidate still lacks a complete green acceptance check set, including a retained Node 22 focused failure and a retained red hud-mcp isolated rerun. Historical F1/F2/F3 and the actual merged-tree gate remain independent. This review neither authorizes another diagnostic burst nor grants another fix round.

**Sanitization audit: PASS for the exact 290624-byte archive with SHA-256 43afcc2f9bfc464e745b001246b86cac51d0e0c55f1a45f994c4bd0265b31180.** This is approval of the audited privacy transformation, not proof of durable publication, private-original backup, full check completion or merge readiness. Authorized external delivery and checksum readback were not established in this review.

## Identity, scope and method

GitHub's Git commit response independently confirms the stated tree and sole parent 41995fa147f20cc217754ca8e5a93a1b4926f21a. The branch ref still pointed at 7ba567ee during the final identity check.

The complete parent-to-fix comparison contains exactly two modified files:
- tests/unit/run-control-kill-fixture.ts
- tests/unit/run-control-kill-evidence.test.ts

The original target tests/unit/run-control.test.ts is byte-identical to f941f820876687d5b37050809ca8121a6644d9d9. All three relevant remote source blobs match the frozen local bytes. The cumulative comparison from 37cf7bef3075ffa312c36b8f78102f6c4bd4de67 contains these three test paths plus the prior implementation and review documents. No production, existing shared fixture, package/lock/script, contract, profile or known-flake-list change is included.

The three current source SHA-256 values are:
- run-control.test.ts: 17a1c939420d376550f8ca5b49b121a0f747afc0976a920efa851b7556b9727f
- run-control-kill-fixture.ts: e2830c0c798acdd19e63842329e6ff2596948ebb6eecdc4750ebf48e9fb87bf7
- run-control-kill-evidence.test.ts: 3d45efc9ed246a4572246270d2e7e95a6f53f02f775a53f91b0692ba0e194062

All ten source/generated/dependency entries in frozen-source-manifest.txt match their retained current files. Local HEAD intentionally remains the original base with frozen edits; its tracked diff hash alone does not cover the two untracked new files. The excluded local node_modules/.package-lock.json artifact remains outside publication. GitHub reports zero check runs for this exact commit; that is not CI success.

Read the governing fix-1 ruling, original brief, review-1 unchanged, full fix report, complete relevant source, reconciliation/fake-port/native-group context and applicable contract/check rules. Independently compared the archive, declared inputs, manifest, hashes, decoded JSON, actual captured proof boundaries and retained execution logs. No repository test, build, benchmark, process-control probe, owner-computer action, source/repository write, capture change, deletion or publication was performed. Protected identity comparisons stayed in local audit memory and emitted safe counts/status only. The execution results below are retained evidence reviewed, not tests rerun by this Oracle.

## K1 disposition: fixed

At run-control-kill-fixture.ts:177–259, serialization now collects boot_id, pid_domain and whole opaque scope_id values, assigns deterministic identity aliases and replaces all matching occurrences simultaneously throughout projected strings and keys. The complete scope is replaced before its embedded components can be partially rewritten. Equality is preserved, distinct identities remain distinct, and generated aliases are not recursively reprocessed. Both decoded strings and serialized bytes are checked for survivors. Failure throws; there is no unsafe object-dump fallback.

The existing explicit publication projection remains in use. Runtime identities, original evidence and assertion inputs are not rewritten. The wrapped operations still execute once with unchanged control/signal semantics, and the helper gains no import-time process/timer/probe/file side effects.

The synthetic regression at run-control-kill-evidence.test.ts:30–154 exercises two boot/domain pairs embedded in composed scopes, repeated startup/input/result/before/after/final/event/fact and receipt-shaped copies. It checks marker absence, repeated equality, distinct identities, chronology/proof/decision fields and unchanged input objects. The executable old key-only serializer fails the embedded-identity assertion. Both final targeted logs record this behavioral control. The earlier TypeScript payload assignment failure is retained preparation history, not the credited negative control.

## K2 disposition: fixed

At run-control-kill-fixture.ts:264–414, the held branch now independently assesses each successful reconciliation boundary and retained final facts. It checks registration/meta/run identity, input run/revision, before facts plus actual observations, after fact retention/revision, valid reconciliation and fact times, accepted binding, complete coverage, original-harness termination, sealed launchers and unresolved counter-evidence. It rejects an eligible complete proof even when the returned decision and all alleged outcomes remain nonterminal/held.

Wrong run/source/generation/supervisor, rejected/pending facts and missing prerequisites do not create eligible proof. Invalid complete-proof times, explicit conflicts, contradictory accepted cancellation chronology, persistent same-time scope conflicts and current/undated live or unsealed counter-evidence are distinguished as blocked proof. Unsupported known-native or never-submitted premises fail explicitly rather than being misclassified. Null CAS results must leave retained state unchanged; their offered Q is not adopted. An all-null/unresolved capture is incomplete, not successful proof.

The releasing branch's prior registration/scope, exactly-one-release/terminal-event, revoked-claim, fencing, receipt/file, native-null and cancellation-classification checks remain intact. Registration checks were extracted for reuse; reconcileRun is not used as the independent expected eligibility oracle.

The controls at run-control-kill-evidence.test.ts:158–373 clone the genuine captured Q transaction, retain its valid proof and construct an alleged nonterminal held outcome. The old held branch accepts it; the replacement rejects it specifically with “eligible completion proof cannot remain held.” Both runtime logs retain all four variants: no cancellation, and explicitly synthetic accepted cancellation with absent, unknown and before_exit chronology. These are assertion mutation controls, not observed cancelled receiptless-Q executions or production defects.

Both targeted logs also contain all nineteen paired held/released mutation controls: removed Q; three incomplete prerequisites; four wrong bindings; rejected/pending validation; four invalid-time cases; live, undated-live and unsealed counters; explicit conflict; persistent scope tie. Coherent fail-closed held descriptions pass, while alleged releases fail. Separate contradictory-cancellation and rejected-CAS controls remain. The original 22 table cases, actual legacy no-receipt predicate failure and forged-release controls are preserved. Source assertions verify the actual capture is unchanged by the clones.

## Independent captured-proof audit

All 24 selected captures were checked: 14 historical and 10 fix-1. The audit examined 64 successful captured reconciliation transactions, including 20 retained releasing descriptions and four live-held descriptions. The eight controlled-Q/final files include duplicate post-idempotence captures, not eight independent process executions.

Every retained release has accepted, correctly bound, validly timed complete R/Q without the audited blocking counter-evidence, supporting rather than audit-only references, one release/terminal transition, revoked claims, fencing, correct cancellation classification and null native fields. No genuine eligible-but-held outcome or insufficiently supported release was found.

All twelve ladder captures retain the INT → TERM → KILL sequence, false KILL acknowledgement, native_unknown group exit, final receipt and null native result. The four fresh ladder captures are receiptful; they do not reproduce or explain the historical ambiguous outcome.

The real controlled cases retain the same startup identity from live-held/no-R-or-Q through reaped complete receiptless Q. Their subsequent reconciliation is R-02-0 with no second release/transition, launch or receipt. No synthetic chronology variant is misrepresented as a genuine cancelled receiptless-Q trace.

## Independent sanitization audit

Audited proposed bundle: runz1-kill-fix1-sanitized-v2-pending-audit.tar.gz.

- Archive SHA-256: 43afcc2f9bfc464e745b001246b86cac51d0e0c55f1a45f994c4bd0265b31180; size 290624 bytes.
- Exactly 209 declared selected inputs: all 124 original archive members plus 85 fix-1 files.
- Exactly 212 regular output archive members: the 209 transformed inputs and three publication metadata/checksum files. No unexpected path, duplicate member, symlink or hardlink was found.
- All 209 input hashes, 209 output hashes and 211 root SHA256SUMS entries match. Every archived output matches the prepared directory byte-for-byte.
- Only fourteen historical JSON capture files changed. Every change is exactly a declared simultaneous identity substitution; all other selected bytes are unchanged.
- All 27 JSON structural comparisons preserve arrays/order, keys apart from declared identity substitution, timestamps, facts, proof flags, decisions, evidence references, binding relationships and outcomes. No transformed-key collision or unrelated identity collapse was found.
- Independently counted 16224 identity-field occurrences, 766 historical raw-scope occurrences, seventeen protected/replacement strings, one witnessed embedded boot identity and four verified whole native-scope aliases. These counts exactly match sanitization-manifest.json.
- Historical standalone redacted-SHA aliases normalize to the same identity-sha256-SHA identities used by v2. Boot/domain equivalence was independently verified against read-only host inputs. Whole generated scope aliases were independently reconstructed and hash-checked locally without emitting their originals.
- Absence checks covered all selected output text, decoded JSON strings/keys, filenames, member names, tar metadata and the complete decompressed tar stream. No original protected value or raw PID-domain encoding survived. Selected logs contain zero inline RUNZ1_KILL_CAPTURE payloads.
- Nine current source/publication-metadata files outside or alongside the archive were additionally screened; none contains an identified actual protected boot/domain/generated-scope original.

The original archive remains byte-identical at SHA-256 ee18b52892ac7c65a71e6852862c3d8d053fee7a2cf0aa237188401a4961aa79. It remains UNSANITIZED and must not be published as the corrected bundle. The historical checksum lists and original-record digests are unchanged provenance; they do not describe transformed bytes or reconstruct omitted in-memory originals. The root checksum list describes the corrected package.

Audit-method caveat: an initial identity comparison was inconclusive and stopped before completing the audit; direct cross-version/current-host comparison and the complete subsequent audit resolved it. A separate first capture-reader pass used the wrong GroupExit discriminator key; correcting that reader to the declared source field allowed the complete 24-capture audit. No package test, evidence byte, candidate source or historical outcome was altered or rerun. These incomplete audit passes are not credited as package behavioral controls.

## Exact retained verification and remaining findings

The final targeted command was run once per runtime family:
node --test --test-concurrency=1 dist-test/tests/unit/run-control-kill-evidence.test.js dist-test/tests/unit/run-control.test.js

Result: Node 24.22.1 44/44; Node 22.23.4 44/44.

The original concurrent focused command was also run once per family:
node --test dist-test/tests/unit/runz1-process.test.js dist-test/tests/unit/run-control.test.js dist-test/tests/unit/run-process.test.js

Result: Node 24 54/54; Node 22 53/54. The retained Node 22 failure is the unchanged one-shot group-launch JSON.parse case receiving warning text before JSON. Inherited proxy policy was retained; no filtering, warning suppression or retry closes this gate.

Other retained final checks:
- Node 24 build:test, build and build:hud-mcp: exit 0. Node 22 build:test: exit 0.
- Node 24 core: 209 pass, 0 fail, 1 existing opt-in skip.
- Node 24 visual: 319/319.
- Node 24 hud-mcp aggregate: 80 pass, 3 ledger_busy failures, 1 opt-in skip. Failures are B20 advice, B45 resume selection and G03 old-key replay.
- One permitted isolated whole-suite rerun each: B20 9/9; delegation 8/8; resume-expected-run 6/7. The last fails a different G03 case, omitted expectedRun, with ledger_busy at compiled line 257. That suite's rerun allowance is consumed. The aggregate and remaining red rerun are not green.
- format:check, check:fixtures and git diff --check: exit 0.
- Preparation build:test failed the synthetic ProcessScope-to-JsonValue assignment before the final frozen candidate; that failure is retained separately.
- Final-candidate npm test and npm run test:mjs: NOT RUN / BLOCKED because selected suites include previously denied operations. No subset substitutes for these gates.
- Actual merged-tree checks: NOT RUN. No merge approval.

All eighteen logged command/exit entries match fix-1-manifest.json, and each combined log matches its retained stdout plus stderr. The wrapper selects the stated Node first, isolates HOME/HUD_HOME/TMPDIR and retains proxy presence/policy without values. Existing one-rerun treatment applies only to its listed family; it does not turn KILL, envproxy or ancestor failures into known flakes.

**G1, P1, remains open:** node22-final-focused.stdout:132–148, node24-final-hud-mcp-resume-isolated.stdout:19–26 and fix-1-manifest.json:107–110 establish failed or missing required exact-candidate checks. Obtain the required capable-host/exact-tree evidence or a separately authorized integration disposition. Do not alter warning policy, import unaccepted dependency code, retry denied operations or widen this test-only round.

**Archival completion remains open:** fix-1-manifest.json:129–130 records no verified durable external sanitized delivery and no protected-original backup. The dispatcher may deliver this exact audited sanitized bundle only through an already authorized destination, then verify remote readback/checksum. A protected durable original copy requires a separately verified authorized private destination. Preserve local originals if none is available. Neither this audit nor local hashes supply new recipient/storage authorization.

## Historical disposition and final boundary

- F2: the replacement assertion defect is now addressed, but the historical failure remains unexplained. Genuine Q proves the old predicate unsound; it does not establish the missing facts of the owner's 15:57 Node 24 failure. Preserve the historical one failure/five passes. No safe-release reconstruction or new known-flake label is justified.
- F1: still not closed for this candidate. Historical capable-host evidence belongs to its pinned source. Missing current full/mjs checks and the original ancestor EACCES disposition are not resolved by a different cloud topology or an independent package's work.
- F3: still not closed. The required Node 22 focused failure recurs. Historical no-envproxy success does not authorize changing this candidate's inherited profile.

No new production performance experiment is required by these two test-only changes. Prior RUNZ1 performance/formal-qualification limitations and unrun local-only work remain unchanged.

**Final Oracle disposition: K1 fixed, K2 fixed, exact sanitized bundle audit passed; overall acceptance and merge HOLD.** Complete authorized durable delivery and independently resolve the remaining gates. No further K1/K2 source remedy, historical diagnostic burst, capability bypass or integration is released by this re-check.

Primary references:
- Source: https://github.com/CartmanFatass/codex-hud/commit/7ba567ee0c3cd12933d79a5029162d32770ee245
- Governing continuation: https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/rulings/runz1-kill-fix-1.md
- Unchanged initial review: https://github.com/CartmanFatass/codex-hud/blob/41995fa147f20cc217754ca8e5a93a1b4926f21a/docs/cloud/handoff/runz1-kill/review-1.md
- Original brief: https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/RUNZ1-KILL.md