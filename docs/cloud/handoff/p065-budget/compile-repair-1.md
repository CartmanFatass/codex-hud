# P065 compile/fixture repair 1: source-only implementer report

Date: 2026-11-03. Status: **WIP / NOT ACCEPTED / NOT MERGEABLE / NOT PERFORMANCE-QUALIFIED**.

This is the bounded C1–C4 repair requested by the independent compile-triage ruling (supplied SHA-256 `490d5e0dbb6b177430840a2edcd9987c9c4645f28a3e985ba012a138f717c9ef`). It does not reset any consumed package fix round or grant a further submission, compute window, acceptance or merge.

## Immutable source and complete diff

- Repository/branch: `CartmanFatass/codex-hud`, `dots/p065-budget`.
- Exact failed before image: `a2b595ce68a9f295d5147971173ebaa0d874e638`, tree `1bbf38aa42d0ffc2206da1c246ec1f7c9d62c221`.
- New source commit: [`cd2dce1623a07f78a707f8bf0a998ebe8a5c0d66`](https://github.com/CartmanFatass/codex-hud/commit/cd2dce1623a07f78a707f8bf0a998ebe8a5c0d66).
- New source tree: `26c77dcd23b559e405173427bf8681c5b5181675`.
- [Complete two-file diff](https://github.com/CartmanFatass/codex-hud/compare/a2b595ce68a9f295d5147971173ebaa0d874e638...cd2dce1623a07f78a707f8bf0a998ebe8a5c0d66).
- New thirty-file aggregate SHA-256: `83cee903df17f29a53b2a4ab70e49a1c4fda0504214d7a49e31be8c0d311d1cb`.
- New source fingerprint SHA-256: `59d60fde40d02bc1e34ffdc30a99ae82e90f055b0d727f4ac3c707e65ac38088`.
- Thirty source files, 411363 bytes. Exact per-file hashes, modes, Git blobs and five configuration hashes are in `compile-repair-1-source-manifest.json`.
- Historical `continuation-1-source-manifest.json` and every previous report/log/ruling remain unchanged.

Source was prepared directly from the exact frozen connector bytes. No local source checkout was created or mutated; neither held executor checkout was used. The source commit has the failed before image as its sole parent. The branch publication is a normal fast-forward guarded against that exact expected old head, without force.

## Changed files and API

1. `tests/unit/p065-budget-fixture.ts`: 48 additions, 7 deletions.
2. `tests/unit/p065-budget.test.ts`: 299 additions, zero deletions.
3. This additive handoff report and `compile-repair-1-source-manifest.json` are documentation only.

All existing P065 unit test bodies and assertions are byte-for-byte preserved; only additional imports and new tests were added. No production API or externally visible result shape changes. The existing workload-fixture signature and upstream B45 `source()` API remain unchanged. The only added export is the fixture-only `p065SupervisorSeed(seed: ProcessStamp | null): ProcessStamp` validation helper, directly exercised by negative tests.

### C1: use the registered source identity

The workload fixture obtains the stable source ID from `f.parent.registration.source` after checking its presence. It checks equality with the parent's session reference, prepared parameters/run/claim and run metadata. It uses that same ID for added-run task digests and resume reconciliation facts. Every parent/child participant registration, caller and session reference is checked against it.

The overwritten B45 `f.source` function is no longer mistaken for a source record. No resolver call, fabricated alternative ID, cast or upstream fixture API change substitutes for the registered identity.

### C2: preserve a complete registered supervisor stamp

The helper rejects a null/non-object seed, a nonpositive/nonintegral PID, missing/nondigit process start, and missing/empty boot or process-domain strings. It returns an explicitly typed complete stamp. Construction captures it once inside the existing cleanup-protected region and verifies it against the already registered seed run before population setup.

Internal run/target records now require `ProcessStamp`, not a nullable metadata projection. Added supervisors explicitly preserve boot/domain fields while changing only synthetic PID/start. The same complete stamp flows through registration, begin/mark submission, scope metadata and resume evidence. Heartbeat setup compares the ledger's full registered stamp to the corresponding fixture record and passes that record's complete stamp, replacing the old heartbeat non-null assertion.

No production type weakening, `any`, `as ProcessStamp`, fallback identity, direct row fabrication or removed registration/heartbeat assertion is used.

### C3: keep assertions with explicit typing

The dynamic `node:assert/strict` binding now has the explicit module type required for assertion-function narrowing. All original handshake/population assertions remain. Import placement and the existing `began` setup-timing boundary are unchanged. Additional fixture-invariant checks are setup work inside that same reported setup interval; no production request work or clock moved.

### C4: additive serial construction/invariant coverage

Fifteen top-level test cases were authored under the stable `P065 workload fixture` prefix. They have not been executed.

Twelve cases construct/dispose one fresh real-SQLite fixture for each H/R profile (1/1, 2/10) and non-wait tool (status, spawn, resume, cancel, whoami, report). They check:

- Exact baseline active/slot/claim counts, unique slots/claims and exact baseline run IDs.
- Full registered supervisor event stamps, run/claim source identity, registered PID/start projections, valid submission state and heartbeat sequence advancement for every baseline run.
- Added-run task digest source identity.
- H distinct caller/context/process registrations and each returned source proof's own session/process/current scope premise.
- Each target's own claim hash, redeemed context/generation/session and real child binding, with no borrowed parent authority for child tools.
- Resume targets outside the active baseline, ended through reconciler evidence, revoked claims, released slots, exact accepted reconciliation facts including the established source/full supervisor, and expectedRun arguments.
- Retained cross-child refusal with the original error alternatives.
- Exactly one close for the base and every composed service, removed temporary root, and refusal of ledger operations after disposal.

The additional three cases are:

- `P065 workload fixture rejects missing or malformed supervisor seeds`: positive complete stamp plus null, malformed values and each missing field through the actual validation helper. The negative cases expect its specific failure, rather than an import/symbol error.
- `P065 workload fixture failed binding releases its service, ledger and temporary root`: inject a named failure through the existing HandshakeService method seam, preserve the exact error, and check base-service/ledger/root cleanup.
- `P065 workload fixture failed population check releases every composed service`: inject a named failure at the existing population SQL prepare call after all services are composed; check three distinct services closed, one shared owned ledger/home, removed root and closed ledger.

Method mocks are test-context scoped and restored by node:test; construction tests specify serial execution. No new production bypass, global clock patch, altered capacity setting, authority relaxation or fabricated binding was added. These cases are construction/safety evidence only, not framed MCP calls, two server/stream instances, actual harness topology or latency qualification.

## Source and scope verification actually performed

Through connector reads, complete recursive-tree comparison and in-memory content hashing:

- Both new source files were read back from the immutable source commit and matched the prepared bytes.
- All thirty source files and the five configuration files were independently fetched from that commit and SHA-256 checked.
- The other twenty-eight source files are byte-identical to the frozen manifest.
- All five build configurations and all 275 inherited tracked dependency blobs are unchanged.
- The complete source-tree delta is exactly the two owned files, with no deletion, unrelated mutation, dependency/lock/compiler configuration change or generated output.
- GitHub comparison reports one commit ahead, zero behind, with the exact additions/deletions above.
- Existing test bodies are unchanged by a direct text comparison.

The original dependency installation process is still unverified. Preserving inherited dependency blobs does not characterize the historical preservation commit as a clean eventual merge payload. No dependency file was staged/restaged, including `node_modules/.package-lock.json`.

Inputs inspected include AGENTS, dots/cloud workflow and check set, Architecture section 8, the full P065 brief at frozen and current documentary refs, the complete supplied compile ruling, both B45 fixtures, process/supervision and identity types, ledger records/supervisor/reconcile/source-context code, service cleanup/handshake paths, and relevant frozen TypeScript/Node type declarations. No tests-directory AGENTS/CLAUDE note exists in the frozen recursive tree.

## Checks not run, prior evidence and next admitted sequence

**No compiler, test, workload fixture, benchmark, formatter, git CLI check, dependency operation or executable validation workload ran for this repair.** There are no new test pass counts, runtime performance numbers or fresh runtime/compiler validation claims.

The earlier independent compile on the failed before image is a known failure: exit 1, fifteen diagnostics, stdout SHA-256 `7ab3c9968abcd0854dd28d2130c1b319687c1eefcfce767720231c7d4bcea0ba`. It is not UNKNOWN and was not rerun here. The older interrupted invocation's outcome remains a separate UNKNOWN. The historical compiler log supplies the failing-before type-check evidence; the new guard/construction negative tests and any isolated reverted behavioral controls remain unrun.

After lifecycle reconciliation and explicit dispatcher admission, follow the ruling's ordered groups, not an automatic run grant:

1. V0: verify exact source/manifest, executor ownership and cleanup, runtime/compiler/dependency identity, fresh output/evidence locations.
2. V1: one `node ./node_modules/typescript/bin/tsc -p tsconfig.test.json`, using the verified absolute runtime, cap 180 s plus ten-second kill-after. Failure stops for review; do not test stale output.
3. V2 only after successful compile and cleanup: fresh production and MCP builds (180 s each), then `node --test --test-concurrency=1 --test-name-pattern='^P065 workload fixture' dist-test/tests/unit/p065-budget.test.js` (300 s).
4. If that succeeds, the unchanged complete P065 unit/local-gate and MCP-focused commands (300 s each), with fresh temporary HOME/HUD_HOME/TMPDIR and sanitized harness/session environment. Preserve exact negative-control output.
5. V3: separately admitted `git diff --check` (60 s), existing formatter in check-only mode on the two files (300 s), and fresh independent re-check.
6. Node 22 >=22.13 remains its own unrun runtime group; no download/install or family waiver is implied. Broader regression/full-check and real-clock requirements remain outstanding.

Old session 87162 outcome/owned-descendant cleanup remains UNKNOWN. The previous independent compiler PID/PGID 1134 exited 1 and its original group was absent, but completeness for possible escaped descendants remains unestablished. This repair neither clears those holds nor asserts a live runaway. No old-session polling, process probing/killing, wrapper replay or executor migration occurred.

Known aggregate expansions involving Unix-path listen/ptrace remain blocked/unrun pending a separately relevant disposition. The absent P065 benchmark/holder drivers, complete production-clock matrix, cold compiled CLI evidence, Node-family verification, full checks, independent Oracle acceptance and merged-tree gates are not completed by these source edits. No package acceptance, merge, performance qualification or capability promotion is claimed.
