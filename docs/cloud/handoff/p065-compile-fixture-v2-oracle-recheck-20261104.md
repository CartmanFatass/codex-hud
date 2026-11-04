# P065 compile/fixture repair: independent V2 re-check

Date: 2026-11-04, approximately 00:36 UTC. Fresh Oracle review of the bounded C1–C4 repair and existing V1/V2 evidence. No validation workload was run by this reviewer.

## Decision

**ACCEPT C1–C4 as repaired for frozen source `cd2dce1623a07f78a707f8bf0a998ebe8a5c0d66`, and accept the five-stage V2 group as completed focused Node 24 validation within its declared synthetic, ordinary-descendant scope.** The new construction/invariant cases now have runtime evidence, rather than merely an authored test plan. No further source repair, repetition of V1/V2, launcher redesign, bootstrap experiment or executor-selection cycle is warranted by this re-check.

The committed-repair diff hygiene check has since returned exit 0. The next minimum step is **V3 check-only formatting**, after the narrowly scoped formatter sourcing and authorization decision below. This review supplies the independent C1–C4 re-check; do not commission another full review of the same two-file repair merely to restate it. Any later actual change or failed check should receive its own narrow disposition.

This is **not P065 package acceptance, full-suite acceptance, Node 22 coverage, performance qualification or merge permission**. V3 diff hygiene is recorded as passed; its formatter stage is BLOCKED / NOT RUN because the pinned formatter is absent. P065 remains **WIP / NOT ACCEPTED / NOT MERGEABLE / NOT PERFORMANCE-QUALIFIED**.

## 1. Immutable source and scope verified

- Repository: `CartmanFatass/codex-hud`.
- Failed before image: `a2b595ce68a9f295d5147971173ebaa0d874e638`.
- Repaired source: `cd2dce1623a07f78a707f8bf0a998ebe8a5c0d66`.
- Repaired tree: `26c77dcd23b559e405173427bf8681c5b5181675`.
- Manifest/report ref: `2aaafc23cffcab14e0d540551e25c45440f9581e`.
- Manifest SHA-256: `9a307ad9ed971b8efa450b546ccd15f0df7ac84623b470d6edce47f949c16185`.
- Thirty-file aggregate: `83cee903df17f29a53b2a4ab70e49a1c4fda0504214d7a49e31be8c0d311d1cb`; 411,363 source bytes.

I read both complete repaired source files and their complete diff. I independently compared the complete, non-truncated before/after Git trees: exactly these two blobs changed, with no deletion or mode change:

| Path | Git blob | SHA-256 independently calculated from connector-returned source |
|---|---|---|
| `tests/unit/p065-budget-fixture.ts` | `4264874ef20ebbae2fabe80fe505785c8a89c191` | `3c7c777e2b29e8712e9cb53d83084e5a0cc61cb205b617e113120ab0db99ec87` |
| `tests/unit/p065-budget.test.ts` | `7c0d9b190c684509002dd8646d751828f5ec8fb0` | `190e03adeff542c36cd815bd5c464611d0066e16e87494a64f99178707eabb32` |

Their lengths are 14,853 and 27,862 bytes. All thirty source and five configuration manifest entries match the immutable Git tree's blob and size identities. The other twenty-eight source files, all five build configurations and all 275 inherited dependency blobs are unchanged. The source commit has the failed before image as its sole parent. The original unit-test body is byte-for-byte retained; the repair adds imports and appends the new cases.

I independently hashed the manifest and recomputed its declared aggregate from its thirty entries. This does not mean I independently SHA-256 rehashed every unchanged source/dependency byte in the execution environment. That broad execution-side byte verification remains the recorded validation owner's check.

The scope excludes production changes, upstream B45 API changes, dependency/configuration changes, drivers, generated source commits and historical evidence rewriting. No such change appears in the source delta. The inherited dependency installation history remains unverified; preserving those blobs does not certify the preservation branch as a clean eventual merge payload.

## 2. C1–C4 disposition

### C1: registered source identity — fixed

The fixture now takes the stable ID from the present `f.parent.registration.source`, after asserting its presence. It checks the parent reference, prepared parameter/run/claim and metadata source IDs, and later checks participant registrations, caller records and references. Added-run task digests and resume reconciliation facts use that same ID.

The B45 return value still intentionally replaces its original `source` member with the per-call `source()` function. The repair does not mistake that function for a source record, call an unrelated resolver, invent an ID or change the upstream API. Added assertions independently compare the ledger run/claim source, added-run digest and exact accepted resume facts with the established participant source.

### C2: complete registered supervisor stamp — fixed

`p065SupervisorSeed` validates the actual seed before population setup: object presence, positive safe-integer PID, digit-string process start and nonempty boot/domain strings. It returns a complete explicitly typed `ProcessStamp`. Construction calls it inside the existing cleanup-protected region and compares the seed with the registered baseline run.

Added runs override only synthetic PID/start while retaining boot/domain. Internal run/target records are non-null `ProcessStamp` records. Registration, submission, scope metadata, reconciliation and heartbeat setup consistently use that stamp; heartbeat setup also checks the ledger stamp against the corresponding fixture record. The former heartbeat non-null assertion is replaced with a real record-presence and equality check.

No production type is weakened, and no `any`, `as ProcessStamp`, identity fallback or fabricated DB row repairs the error. The executed malformed-seed case checks the real guard with a valid control, null, malformed values and every missing field, expecting its specific semantic error. It is not an import-failure control. The guard is directly tested; the complete malformed-fixture construction path is not a separate executed case. Its early connection into construction is verified from source.

### C3: explicit assertion target type — fixed

The dynamic strict-assert binding now has the explicit assertion-module type. Original handshake and population assertions remain intact. Import placement and the existing setup-timing boundary are unchanged. New invariant checking is setup work inside that same interval; no production request work or clock is moved.

The earlier failed compiler record supplies the genuine failing-before type-check result. The accepted V1 compile supplies the repaired-after result. No additional deliberately broken compiler run is needed.

### C4: actual construction and invariant coverage — fixed within the requested scope

The fifteen added top-level cases are twelve fresh-fixture combinations, H/R = 1/1 and 2/10 across status, spawn, resume, cancel, whoami and report, plus three semantic negative/cleanup cases.

Source inspection and the returned fifteen individual passing results establish:

- Exact baseline active/slot/claim populations, distinct slots/claims, matching registered supervisor event payloads and advancement of every baseline heartbeat.
- Distinct participant caller/context/process registrations, each proof's own session/process and current scope premise.
- Each target's own claim hash, redeemed context/generation/session and real handshake-created child binding.
- Resume targets outside the active baseline, ended through reconciler evidence, with released slots, revoked claims and exact source/supervisor-bearing accepted facts.
- Preserved cross-child refusal and no use of parent authority for child tools.
- Successful disposal with one close per owned service, removed fixture root and closed ledger.
- A deliberately injected binding error preserves the exact error and releases the base service, ledger and root.
- A deliberately injected population-query error after composition releases all three distinct services and the shared ledger/root.

The twelve construction cases and both method-mocking failure cases specify serial execution; mocks are test-context scoped. The guard case has no method mutation. Real SQLite and the existing registration/handshake/reconciliation APIs remain in use. The launch dependency is still the clearly synthetic B45 mock; the cancel path retains its pre-existing trusted synthetic probe seam.

These are meaningful positive and negative construction checks. They do not establish actual foreground calls for all twelve labels, two framed server/stream instances, real harness topology, or any latency bound. The displayed per-test durations are construction/test durations, not P065 request samples. No additional failing-before behavioral experiment is necessary merely to close this limited C1–C4 repair. Broader package-required independent behavioral controls remain separate.

## 3. Execution evidence and independent checks

### Evidence references

Cloud task: `01a1a3c0-8454-762a-a04c-d71a10b710c9`.

- V2 execution turn: `01a1a3ee-e61f-710a-b815-d16ea544e5e7`; completion message `msg_0812e22e6b1044d1016aea7b8b80b487d289df43d5183f77a8`.
- First completed read-only evidence turn: `01a1a3f3-40b4-721c-a1ee-c8ba558f0b9a`; raw lifecycle message `msg_0812e22e6b1044d1016aea7bca43bc87d297fdcc79e4a4f6be`.
- Supplemental completed read-only evidence turn: `01a1a3f5-e90c-73ad-9f44-74c66fe2c430`; complete mechanical diffs and construction results message `msg_0812e22e6b1044d1016aea7c75615c87d2be5dc568a934b331`.
- Exact base-launcher source message: `msg_0812e22e6b1044d1016aea76217b6487d28461c7ebfacc6acd`.
- Existing V1 result, admitted test scope and bounds: `/workspace/shared/p065-v1-and-test-route.md`, read in full.

The selected checkout remains `/workspace/p065-repaired-verify`. Runtime/compiler are the admitted absolute Node v24.22.1 and TypeScript 5.9.3. The exact Node, Python, TypeScript and manifest digest predicates are unchanged in all five launcher variants.

### Launcher verification

I recovered the complete 15,798-byte base launcher text and independently rehashed it to the admitted `c4f56dc06cf481df00ca5e23539f319a6fe362c4a1ee591d94590115742b6e5b`.

I then applied each returned unified diff **as inert text in memory**, checking every hunk/context, and hashed each reconstructed full launcher. All five digests exactly match the actual launcher hashes in the raw initial lifecycle events:

| Stage | Reconstructed and recorded launcher SHA-256 |
|---|---|
| 1 | `7ee3b90d9cd0ffef8a7b1b36f9a2befbed4778d0ff292a4b6eff9ac29aa52958` |
| 2 | `a19c3e813fc1114d804b0a71170f59ca75ff3f0156ad853e2162dca9aeb2054c` |
| 3 | `bf0e01b4c5ec5096dd8fc418e93f3c2d818c77bc4fc9ba68de7a2267cce65eca` |
| 4 | `7cf4a35612bfe612c40cfcf8d9424b130f1b7863c6c5156ad400d7a6becf8e15` |
| 5 | `f07851ab888881ac7e182e1ba71f1dba14ade453735aaadc486729690126db39` |

The only changes are the permitted label, evidence path, fixed argv, declared output/input-presence check, output inventory target and test deadline constants. Bootstrap ownership, child gate, pidfd-only control, wait/reaping, signal/error handling and result classification remain unchanged. There is no unreviewed lifecycle redesign.

The returned outer invocation retains cleared environment, foreground timeout, `-I -S -B`, and `/dev/null` stdin. Build outer guards are 230 seconds plus ten-second kill-after; test guards are 350 seconds plus ten-second kill-after. Each raw initial event records a distinct HOME/HUD_HOME/TMPDIR within its exclusive stage directory.

### Commands, results and raw monotonic arithmetic

The following are the exact inner commands after the pinned absolute Node executable:

| Stage | Command | Result | Release → direct status | Direct status → ECHILD | Outer duration |
|---|---|---|---:|---:|---:|
| 1 | `./node_modules/typescript/bin/tsc` | exit 0 | 6.493315069 s | 0.051086941 s | 6.854177921 s |
| 2 | `./node_modules/typescript/bin/tsc -p packages/hud-mcp/tsconfig.json` | exit 0 | 5.124750128 s | 0.050974442 s | 5.683218763 s |
| 3 | `--test --test-concurrency=1 '--test-name-pattern=^P065 workload fixture' dist-test/tests/unit/p065-budget.test.js` | 15/15 | 1.305442838 s | 0.050833758 s | 1.711178939 s |
| 4 | `--test dist-test/tests/unit/p065-budget.test.js dist-test/tests/unit/p065-local-gate.test.js` | 58/58 | 1.558644657 s | 0.050833189 s | 1.957732179 s |
| 5 | `--test packages/hud-mcp/dist/tests/hud-mcp/p065-budget.test.js` | 28/28 | 0.904023539 s | 0.050871072 s | 1.295158701 s |

The stage-3 pattern is one argv element without literal shell quote characters. All three reported summaries have fail/cancelled/skipped/todo = 0. Stage 3's fifteen names and results were returned individually with raw reporter summary lines. These are Node's human-readable spec-reporter lines, not TAP; the earlier generic request for “TAP” does not change their actual format.

The five returned raw event sequences each contain normal direct status 0, then genuine `wait_echild`, error-channel EOF with no error data, and final `closure=true`, `lifecycle_valid=true`, `postcheck_ok=true`, `unexpected_descendant=false`, `failure=null`, `interrupted=null` and `post_error=null`. Outer statuses are all 0.

I calculated the intervals from the raw monotonic integers. Release-to-ECHILD totals are respectively **6.544402010, 5.175724570, 1.356276596, 1.609477846 and 0.954894611 seconds**. All workload, internal closeout and outer bounds are comfortably met; no late-observation exception applies.

The unchanged bootstrap releases the child only after its identity predicates, enabled subreaper readback and initial all-child ECHILD succeed. The returned scalar extraction explicitly reports readback 1, initial ECHILD, 42 identities and matching postchecks for every stage. The verified exact launcher plus the raw release/result sequence supports that narrow bootstrap/result inference even though the large identity payloads were omitted from the transcript.

The conservative `exit_status_observed_exec_unverified` label does not invalidate success: the already accepted narrow inference still applies to this unchanged child branch, whose caught pre-exec failures exit 127. Normal exit 0 after release and a clean EOF establishes execution of the selected command. This is ordinary-descendant closure, not a host-wide census or cleanup of historical invocations.

### External checks, outputs and retained limits

The owner reports every external pre/post check as PASS, with pinned HEAD/tree, empty tracked/untracked status and ignored-input list, all thirty source/five configuration checks, 275 matching dependency blobs and retained incoming compiled-output equality. The supplemental response gives the exact external UTC boundaries. Their individual spans are approximately 0.234–0.314 seconds; postchecks complete 7.354–9.332 seconds after their corresponding outer end, within the admitted capture window. Stages are sequential and each next preflight follows the prior postcheck.

Reported supervisor output inventory entry counts are 1,101 for production output, 264 for MCP output and 1,045 for each test stage's retained dist-test inventory. The supervisor's test-stage inventory alone does not establish all compiled-input equality; that broader check is explicitly attributed to the external pre/post checks. The three test-stage HOME/HUD_HOME/TMPDIR inventories are reported empty. Process ECHILD and filesystem cleanup are distinct facts; the positive/negative fixture assertions also check their own roots and ledger disposal.

I did **not** directly access the cloud filesystem, independently rehash the full events/stdout files or all emitted/dependency files, read every line of the stage-4/5 full stdout, or repeat any workload. The 58/58 and 28/28 counts and exhaustive external inventories are owner-returned records, consistent with the exact commands and independently inspected normal exits. The full stage-4/5 stdout remains preserved but was not reproduced in the transcript. Do not upgrade this review into a claim that I personally inspected every warning/output line. Empty stderr is not a proof that stdout contains no diagnostic warning.

These attribution limits do not justify rerunning a known terminal successful group. The returned complete stage-3 case results, exact-source review, verified launcher artifacts and raw lifecycle records are sufficient for this bounded repair decision. Further archival inspection, if desired, is read-only.

### Retained evidence identities

Record directory: `/workspace/p065-v2-record-01`. Raw stage directories: `/workspace/p065-v2-evidence-stage-{1..5}-01`.

| Stage | Reported complete events.jsonl SHA-256 | Reported complete stdout.raw SHA-256 |
|---|---|---|
| 1 | `e49936662da9d04ef7139462aa1c0f9b36d975afc19b80b663a15dba02d6d508` | empty |
| 2 | `b003a68c827d9c0b08786f752820fa7adcf5320fad3684fbb08bb3421d894f9a` | empty |
| 3 | `b88cac63f74ada0057938de4094179a2689c5910d9dbf36a8d67e0d55bbbd15f` | `6d64c526d10c8f3627dc98cf7d878c79bb199a4d597505445e949ce768f80f41` |
| 4 | `aa78c252c57e25cc8f123f123fbe0b6b23a396fc77a72d5f14a361543f2ffae6` | `c51933ff673296b5f9ff94a4204ac3e400f9cb3a60baeeca67c6668542c84702` |
| 5 | `03cc35fb090811d0bcd8d6023cd28eaf8c546216cd9dc40948596bb16de9e651` | `6d2c4678d485571ffa8feef08b4a9a44dbafe7a3f60c18f79e115c520c53659c` |

All stage stderr and outer stdout/stderr are reported empty. Empty-file SHA-256 is `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. Preserve these original files and their checks, rather than substituting this ruling for the raw evidence.

## 4. Minimum next path

### V3 status update and remaining check

The completed cloud read-only turn `01a1a3f9-2987-73ac-8037-30f6161804be`, message `msg_0812e22e6b1044d1016aea7d55d43087d2be6bcad4dce95dde`, reports the exact committed repair diff check exited 0 with no whitespace-error output, 347 additions/7 deletions in exactly two files, unchanged HEAD/tree and empty checkout status. I read that result; I did not execute the Git command independently. **Do not rerun this passed check.** The same completed record reports no Prettier in the repaired checkout, PATH or the inspected runtime/system Node-module locations. Its format check was correctly left NOT RUN.

Complete only the remaining bounded check in the same admitted executor, against the frozen source and retained output/dependency identities:

1. Completed: the **actual committed repair diff**, not merely an empty clean worktree: `git diff --check a2b595ce68a9f295d5147971173ebaa0d874e638 cd2dce1623a07f78a707f8bf0a998ebe8a5c0d66 -- tests/unit/p065-budget-fixture.ts tests/unit/p065-budget.test.ts`, cap 60 seconds.
2. Resolve the missing exact formatter through the separate narrow route below, recording its version/bytes before using Prettier in check-only mode on precisely those two files, cap 300 seconds. Retain the frozen `.prettierrc.json` and `.prettierignore`. No `--write`, install, dependency replacement or whole-repository formatting is included.

The frozen complete tree contains no `node_modules/prettier` entry, although package.json names `node ./node_modules/prettier/bin/prettier.cjs`; the completed executor check now confirms that prerequisite is missing in the inspected locations. This is **not a formatter execution failure**. Do not execute a missing-path command merely to manufacture failure, silently use a different version or run npm ci under the old admission.

Keep the existing supervision/evidence method and source/config/compiled-input postchecks. Adapt only the declared command/output/deadline fields for this separately assigned group; no lifecycle redesign or new capability probe is needed. On a genuine diff/format failure, preserve its result and return the exact bounded correction needed. A check-only formatter failure does not retroactively turn V1/V2 into failures; a subsequent source change would require a new immutable identity and an appropriately scoped verification decision.

The dispatcher may record the successful V3 result directly against this ruling if source and scope remain unchanged. Another general C1–C4 review is unnecessary.

### Minimum safe formatter sourcing route

I independently read the frozen `package-lock.json`. It pins:

- Package/version: `prettier` **3.9.9**.
- Exact official registry tarball: `https://registry.npmjs.org/prettier/-/prettier-3.9.9.tgz`.
- Required SRI: `sha512-Z/CJHIkdujO/OtN7nXUii0Rf3VT5SRuhjBA82Xvu2XhBUgX3nhP67T0LHceBdQLex7OOFGTox+Q5Yg8Jk2Qivg==`.
- CLI: `bin/prettier.cjs`; declared Node requirement `>=14`; no package runtime dependency set is declared in this lock entry.

**Technical route:** create one fresh, collision-checked off-repository tooling/evidence directory; download only that official tarball with a bounded transfer; preserve it and the response/provenance record; verify the full archive against the exact SHA-512 SRI before extraction. Inspect archive members and extract only safe regular files/directories confined to that fresh directory, rejecting absolute/traversal paths, escaping links or special files. Verify the extracted package name/version/CLI and retain an inventory/hash. No package-manager install, lifecycle hook, dependency resolver, global installation, `npx`, checkout symlink or write to the frozen checkout's `node_modules` is needed. If the package unexpectedly requires additional runtime dependencies, stop and report rather than resolving them implicitly.

Run the existing pinned absolute Node against that extracted **absolute** `bin/prettier.cjs` path, from the frozen checkout, with `--check tests/unit/p065-budget-fixture.ts tests/unit/p065-budget.test.ts`. Use the unchanged frozen configuration/ignore rules, fresh stage-local HOME/HUD_HOME/TMPDIR, and the declared supervised 300-second check. Keep any formatter cache path in the fresh evidence/tooling scope, not in the checkout; do not enable reuse of an old cache. Preserve complete output/status and verify source/config/dependency/compiled-output bytes unchanged afterward. Prettier's official CLI documentation distinguishes check-only output from `--write` and documents its exit statuses and cache behavior: [Prettier CLI](https://prettier.io/docs/cli).

This route preserves the code-write prohibition and avoids changing the inherited dependency population. However, downloading and running a previously absent executable package is **new tooling setup**, not part of the previous explicitly no-install V1/V2 grant or the already completed read-only V3 lookup. A separate narrow dispatcher admission must identify the package, official source, off-repository destination, check command and applicable user authorization. If current explicit user permission already covers this tooling download/run, reuse it without asking again. If the only available authorization is the general phrase “cloud testing,” it does not by itself establish approval of this additional software-setup action; obtain the specific permission before proceeding. No additional C1–C4 or supervisor-design review is required merely to source the exact permitted tool.

Availability of the specific tarball and matching bytes is not established by this report. A public read attempt through the web tool could not access the version metadata; that is not proof that the version is absent. A 404, transport denial, integrity mismatch, unexpected archive content or changed package identity is a bounded tooling blocker, not permission to use another version or source, ignore integrity or widen the operation.

### Remaining P065 work is not bundled into V3

After hygiene, use the existing package queue/ownership rules for any further admitted work. Still outstanding or unestablished here:

- Applicable Node 22 >=22.13 build/focused evidence on an explicitly identified supported runtime.
- Broader shared-writer/authorization/security regressions, full README checks and package-required independent behavioral controls.
- Actual cold standalone compiled CLI evidence, not merely an in-process CLI-to-MCP semantic case.
- The complete P065 benchmark and holder drivers. I confirmed `tests/int/p065-budget-benchmark.mjs` and `tests/int/p065-ledger-holder.mjs` are still absent from this exact source tree.
- Two genuine server/stream compositions for the synthetic H=2 framed workload, full tool/profile/outcome populations, same-ledger heartbeat and writer contention, concurrent accepted observation-store load, production clocks, 50 warmups plus at least 1,000 measured calls and three isolated series per supported Node family.
- Separate operational numerical, forced-control semantic, inclusive-all-samples numerical and population-completeness results, with unchanged numerical gates.
- Final package Oracle acceptance and green merged-tree gates, plus the distinct real-harness/platform/local-only obligations.

Known Unix-path-listen/ptrace aggregate boundaries remain blocked/unrun unless separately resolved with relevant evidence. No skip, transport substitution, tracing workaround or executor move is authorized. Old session `87162` and former compiler PID/PGID `1134` retain their different historical outcome/cleanup limitations. The five new closed invocations do not erase them. Package fix/submission counters, withdrawn assistant-run local testing and acceptance/merge rules are unchanged.

## Sources and method

- [Frozen repaired source](https://github.com/CartmanFatass/codex-hud/commit/cd2dce1623a07f78a707f8bf0a998ebe8a5c0d66).
- [Complete repair diff](https://github.com/CartmanFatass/codex-hud/compare/a2b595ce68a9f295d5147971173ebaa0d874e638...cd2dce1623a07f78a707f8bf0a998ebe8a5c0d66).
- [Repaired fixture](https://github.com/CartmanFatass/codex-hud/blob/cd2dce1623a07f78a707f8bf0a998ebe8a5c0d66/tests/unit/p065-budget-fixture.ts) and [unit construction/negative tests](https://github.com/CartmanFatass/codex-hud/blob/cd2dce1623a07f78a707f8bf0a998ebe8a5c0d66/tests/unit/p065-budget.test.ts).
- [Repair report](https://github.com/CartmanFatass/codex-hud/blob/2aaafc23cffcab14e0d540551e25c45440f9581e/docs/cloud/handoff/p065-budget/compile-repair-1.md) and [manifest](https://github.com/CartmanFatass/codex-hud/blob/2aaafc23cffcab14e0d540551e25c45440f9581e/docs/cloud/handoff/p065-budget/compile-repair-1-source-manifest.json).
- [Original C1–C4 bounded repair ruling](https://github.com/CartmanFatass/codex-hud/blob/88633ef53490f213b6ec987fdafec4f3fd1aa0a5/docs/cloud/rulings/p065-independent-compile-failure-bounded-repair-20261103.md).
- [P065 brief and full qualification boundaries](https://github.com/CartmanFatass/codex-hud/blob/33c0cf6ef6e57c187d8b4e352cd609768073c63b/docs/cloud/P065-BUDGET.md).
- Exact cloud messages and local prior rulings identified above.

This reviewer used connector reads, modest read-only file inspection, in-memory source/diff comparisons and hashing, and arithmetic on existing evidence. No compiler, test, fixture, benchmark, formatter, process probe, cleanup, dependency operation or repository mutation ran. No subagent was started. Only this requested ruling file was written.
