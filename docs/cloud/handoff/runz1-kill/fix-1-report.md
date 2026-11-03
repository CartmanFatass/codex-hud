# RUNZ1-KILL fix-1 implementation and correction, 2026-11-03

**WIP / FIX REQUIRED pending fresh re-check / NOT ACCEPTED / NOT MERGEABLE.** This is the single K1/K2 continuation authorized by docs/cloud/rulings/runz1-kill-fix-1.md, not another historical diagnostic burst or acceptance decision.

## Important correction and retention status

The previous implementation report incorrectly claimed that its publication projection concealed boot identity throughout. Review-1 K1 demonstrated that composed scope_id strings retained the original boot UUID. The prior archive with SHA-256 ee18b52892ac7c65a71e6852862c3d8d053fee7a2cf0aa237188401a4961aa79 remains **UNSANITIZED, unchanged and unpublished**. Its integrity hash is not evidence of sanitization. No original raw evidence or historical outcome was overwritten, deleted or reclassified.

A distinct proposed sanitized bundle is prepared locally and remains **WITHHELD pending independent audit and authorized durable delivery**. No capture or archive was externally published by this worker. No authorized private destination was established for a protected durable original backup; that external retention requirement is still incomplete. The first Oracle found no identified boot-value exposure in the previously published source/report; the source-only fix does not itself publish generated identifiers.

## Exact lineage, ownership and publication

- Original RUNZ1 continuation base: 37cf7bef3075ffa312c36b8f78102f6c4bd4de67.
- Reviewed source: f941f820876687d5b37050809ca8121a6644d9d9, tree c685e90a7630c660aa78acfc75d171cba4add157.
- Documentary parent: 41995fa147f20cc217754ca8e5a93a1b4926f21a, tree 85401a26720bc37c4402b870af7d1364e302a3ae.
- Published fix-1 source: **7ba567ee0c3cd12933d79a5029162d32770ee245**, tree **ad4c596860b264d76d4060be90d70337046b92c5**.
- Branch: dots/runz1-kill.
- https://github.com/CartmanFatass/codex-hud/commit/7ba567ee0c3cd12933d79a5029162d32770ee245

Only tests/unit/run-control-kill-fixture.ts and tests/unit/run-control-kill-evidence.test.ts changed in this round. The original target run-control.test.ts remains byte-identical to f941f82. No production, existing shared fixture, package/lock/script, contract, profile, known-flake list or other package code was changed/imported. node_modules/.package-lock.json remains an excluded local setup artifact.

The remote ref, parent-relative two-file comparison and exact remote file bodies were verified through the connector. Local HEAD intentionally remains the original base with frozen edits; explicit source/generated hashes identify the tested content. The wrapper's tracked git-diff hash alone does not cover the two untracked helper/evidence files. GitHub reported zero check runs for this exact commit; no CI-green claim is made.

Initial create_tree was rejected before execution for missing visible source-publication authorization. After the dispatcher supplied exact user authorization and the bounded Oracle continuation context, its single evidence-backed retry succeeded. No bypass or alternate route was used. The branch writer was returned after publication.

## K1 correction and behavioral control

The pure test-only projectKillCapture helper retains the explicit publication allowlist. serializeKillPublication collects protected boot_id, pid_domain and whole opaque scope_id values, creates deterministic SHA-256 identity aliases, and applies one simultaneous replacement throughout projected strings/keys. Equal values stay equal and distinct values stay distinct. It checks both decoded strings and serialized bytes for surviving protected values, fails closed on a leak, and never mutates live identities, evidence or assertion inputs. There is no unsafe serialization fallback. Import-time behavior and original signal/control semantics remain unchanged.

The synthetic K1 regression uses two distinct boot/domain identities embedded inside composed scope IDs and repeated across actual projected startup, before/after/final, events/facts, reconciliation input/result and receipt/exit-shaped copies. It checks absent original markers, equal repeated aliases, distinct identities, preserved fact/record chronology and proof/decision fields, and unchanged input objects. Its executable old key-only serializer fails the embedded-identity assertion. This is the credited behavioral negative control, not the earlier TypeScript setup error.

## K2 correction and behavioral controls

The held branch now independently evaluates every successful captured reconciliation boundary rather than trusting slotHeld or the returned decision as evidence of incomplete proof. It checks registration/meta/run identity relationships, input run/revision, before facts plus actually supplied observations, retained after facts and revision, valid reconciliation/fact times, completion prerequisites and unresolved counter-evidence. It also checks retained final facts against the last successful boundary.

Eligible accepted complete R/Q must not remain held. Wrong binding, rejected/pending evidence or incomplete prerequisites do not demand release. Invalid completion times, persistent scope ties, explicit conflicts, contradictory accepted cancellation chronology and current/undated live/unsealed counters are distinguished as blocked proof. This lost-wait assertion reports unsupported known-native or never-submitted premises instead of fabricating a classification. A null CAS does not adopt its proposed Q; an all-null/unresolved capture is explicitly incomplete.

The releasing branch keeps its original registration/scope, exactly-one-release/event, revoked claim, fencing, receipt/file, null-native and cancellation-classification assertions. Registration checks were extracted unchanged for reuse. The independent eligibility predicates do not invoke reconcileRun as an expected oracle.

The actual real live-to-reaped fixed-identity test and original real KILL ladder remain intact. Additional controls clone the genuine Q boundary while preserving the valid proof and constructing internally consistent alleged held/nonterminal outcomes. The old held branch accepts each counterexample; the new branch rejects it specifically with 'eligible completion proof cannot remain held'. Variants explicitly label no cancellation and synthetic accepted cancellation with absent, unknown and before_exit chronology. None is claimed as a real cancelled receiptless-Q trace.

Nineteen paired mutation descriptions exercise the same held/released assertion: removed Q, incomplete coverage/harness/sealing, wrong run/source/generation/supervisor, rejected/pending validation, four invalid-time cases, live/undated-live/unsealed counters, explicit conflict and persistent scope tie. Coherent fail-closed held descriptions are allowed, and alleged releases are rejected. Separate cancellation-conflict and rejected-CAS controls are included. The original 22 table cases, legacy no-receipt predicate failure and forged-release controls remain. The actual captured evidence is asserted unchanged after all clones.

No genuine unsafe release or genuinely eligible incorrectly held production outcome was observed. Synthetic controls are not claims that such a production defect executed.

## Frozen-candidate execution

All invocation metadata, stdout/stderr and exit codes are retained under the distinct runz1-kill-fix1-evidence directory. No previous evidence label was overwritten. The first preparation build failed a synthetic JSON payload TypeScript assignment; it was corrected before freezing or running final tests, and that failure is retained. Final source hashes remained unchanged through all tests/publication.

Fresh HOME/HUD_HOME/TMPDIR, Node-first PATH, v24.22.1/v22.23.4 and unchanged inherited proxy policy were used. No warning suppression, denied AF_UNIX/ptrace retry, owner-local execution, capability workaround or historical instrumentation burst occurred.

- Node24 final build:test, build and build:hud-mcp: exit 0.
- Node22 final build:test: exit 0.
- Once-per-family targeted evidence plus complete run-control, serialized: **44/44 on Node24; 44/44 on Node22**.
- Once-per-family original concurrent three-file focused command: **54/54 on Node24; 53/54 on Node22**.
- Node22 failure is the unchanged one-shot group-launch JSON.parse case, receiving the inherited UNDICI-EHPA warning before JSON. No rerun or filtering was performed.
- Node24 core: **209 pass, 0 fail, 1 existing opt-in benchmark skip**.
- Node24 visual: **319/319**.
- Node24 hud-mcp aggregate: **80 pass, 3 ledger_busy failures, 1 opt-in benchmark skip**. Failures were B20 advice, B45 MCP resume selection (delegation suite), and G03 old-key replay (resume-expected-run suite).
- Exactly one permitted isolated whole-suite rerun each: **B20 9/9**, **delegation 8/8**, **resume-expected-run 6/7**. The latter failed G03 omitted expectedRun at compiled line 257, again ledger_busy. Its rerun allowance is consumed; no further retry occurred. The original aggregate and all reruns remain retained. The aggregate is not called green.
- format:check, check:fixtures and git diff --check: exit 0.
- Final npm test and test:mjs: **NOT RUN / BLOCKED**, because selected suites include previously denied operations. No filtered subset is substituted for these gates.
- Actual merged-tree checks: **NOT RUN**, no acceptance/merge.

No new performance experiment was required or run. Existing historical performance/qualification limits remain unchanged.

## Sanitization inventory and evidence package

Proposed archive: runz1-kill-fix1-sanitized-v2-pending-audit.tar.gz.

SHA-256: **43afcc2f9bfc464e745b001246b86cac51d0e0c55f1a45f994c4bd0265b31180**; size 290624 bytes.

Local deliverables are under /workspace/shared/runz1-kill-fix1-publication/:
- sanitized-v2/sanitization-manifest.json: every selected input/output hash and transformation.
- sanitized-v2/SHA256SUMS: checksums of the proposed sanitized inventory.
- sanitized-v2/SANITIZATION-NOTICE.md: explicit correction and withheld status.
- sanitization-summary.json and sanitize_inventory.py: safe counts and reproducible local migration method.
- fix-1-manifest.json: source identity and all check outcomes.

Inventory covers all 124 original archive members plus 85 selected fix-1 files: **209 inputs**. It includes JSON captures, inline-capture-capable logs, stderr/errors, source snapshots, manifests and filenames/member names. Ephemeral test homes, raw original tar bytes, protected alias-map contents and offline identity-probe output are excluded. No inline captures occurred in selected logs. A first migration attempt stopped before writes because scope-check references can carry scope_id without a sibling boot_id; the collector was corrected to require a verified witness elsewhere in the complete inventory. This did not change candidate source or rerun tests.

Only **14 historical JSON capture files** changed, solely by declared identity transformations; all other selected bytes remain identical. Whole opaque scope IDs and known boot/domain occurrences receive aliases. Historical redacted-SHA standalone boot/domain aliases normalize to identity-sha256-SHA, preserving equivalence with the new v2 capture aliases. The old original-record hashes remain unchanged historical provenance and cannot reconstruct omitted in-memory originals. Original historical checksum lists remain under historical/ and describe the old bytes; the root checksum list describes the transformed bundle.

Implementer screening completed **27 JSON structural audits**, checked **16224 identity-field occurrences**, verified four new native whole-scope aliases against their locally reconstructed originals, and checked every selected decoded text, filename and archive member name for surviving known protected values. Checks emit only safe status/counts/hashes. Original archive SHA-256 remains unchanged.

These are implementer checks, **not the required independent sanitization audit**. Do not publish this archive/captures until the fresh independent reviewer verifies privacy-only changes, preserved proof/binding/outcome usability and absence of protected originals. No external readback/checksum or private backup was completed, so archival delivery remains incomplete.

## Handoff and remaining gates

The exclusive compute lease was explicitly returned at **2026-11-03T21:06:54Z**. All builds/tests and substantial sanitization processing have stopped. Only this lightweight handoff documentation followed. Source ownership remains reserved pending review; no further fix round is presumed.

The dispatcher owns additive report/evidence publication, independent review/audit and protected durable retention arrangements. A fresh Oracle must re-check K1/K2 against review-1 unchanged, the exact fix/cumulative diff, negative controls, captures, inventory script/manifest and complete check outcomes. It must separately retain G1 and historical F1/F2/F3.

The genuine Q proves the old predicate's defect; neither this correction nor its passes reconstructs the missing historical Node24 failure. The historical one failure/five passes remain. Node22 focused failure, the new retained hud-mcp red rerun, missing exact-candidate full/mjs checks, original ancestor disposition and eventual merged-tree gate remain open. No unaccepted dependency integration, warning suppression, acceptance promotion, main mutation, force-push or merge occurred.
