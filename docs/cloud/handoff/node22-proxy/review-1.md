# NODE22-PROXY exact-candidate final Oracle review

Date: 2026-11-03.

**Verdict: fix required. NODE22-PROXY and its inherited HYG2 candidate remain NOT ACCEPTED and NOT MERGEABLE.**

The six-path compatibility correction is consistent with the approved design, and the inspected focused evidence supports its intended behavior. I found no new production-code defect in that amendment. Acceptance is blocked by the missing complete verification matrices, the unresolved inherited registration gate, and incomplete durable evidence handoff. This is not permission for another implementation round, an unrelated repair, or a combined WIP integration.

## Scope and exact identity

- Candidate: `b4047320262f72f401a513db07236ff1473db933`.
- Candidate tree: `d9be29f28da496a880802c267a08e8bb4fcbee74`.
- Exact parent: `ce5e6961a0e6de1304dcebb00fc1b8c805573ec6`, tree `455e5cb8fce558bcb0a0f014e0e192a637b7dd2f`.
- GitHub independently reports the candidate one commit ahead of that parent, zero behind, with exactly the six reserved source/test paths. Each remotely fetched blob matches the local candidate and archived source copy.
- The observed remote branch later points to `5a030320057f306ce4a7b182c0b86c63fae643fa`. Its sole change after the candidate is `docs/cloud/handoff/node22-proxy/implementation.md`. It does not change the reviewed source tree.

Read AGENTS, dots/README workflow and check rules, the current NODE22-PROXY brief and profile ruling, relevant current STATE and MCP-ANCESTOR disposition, HYG2 and its warning/ownership ruling, previous HYG2 re-check and local-evidence review, contracts 04/07, architecture section 8, the implementation report, the complete amendment, inherited HYG2 provenance and relevant production/test helpers. Primary Node sources were checked at the pinned runtime tags.

This review used remote reads and read-only source/evidence/hash inspection. It ran no build, test, workload, proxy server, benchmark, capability probe or user-computer action; made no repository write or git mutation; and started no subagent. RUNZ1-KILL's execution lease was not taken.

Sources: [candidate](https://github.com/CartmanFatass/codex-hud/commit/b4047320262f72f401a513db07236ff1473db933), [implementation report](https://github.com/CartmanFatass/codex-hud/blob/5a030320057f306ce4a7b182c0b86c63fae643fa/docs/cloud/handoff/node22-proxy/implementation.md), [binding brief](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/NODE22-PROXY.md).

## Findings and required disposition

### F1. Required final-candidate verification is incomplete — P2 acceptance blocker

`docs/cloud/handoff/node22-proxy/implementation.md:106–110`, NODE22-PROXY sections 10–12 — the name-selected 15-test commands do not establish either required unfiltered three-file command, and the complete README matrix has not been obtained on this dependent candidate.

The missing work includes both serialized and normal unfiltered export/run-process/run-light-leader commands for all three profiles; `npm test`, separately labeled mjs when unit failure prevents that stage, `test:core`, `test:visual`, and `test:hud-mcp`; and pending Node 22 build/per-profile attribution. Node 24 builds and shared unchanged-tree formatting checks cannot stand in for those runtime results. No commit statuses were returned for the candidate, which supplies no additional positive CI evidence.

Failure scenario: fixture-wide descriptor and profile-hook changes can affect tests outside the selected targets, while inherited product/capability failures remain unexercised on the final tree. A focused pass cannot establish the full-green acceptance rule.

Required action: obtain the specified checks in separately assigned windows on authorized capable execution, preserving exact identities, raw outputs and failures. Known AF_UNIX/ptrace denial and missing proc-children capability remain blocked cells, not waived checks or reasons to retry denied operations unchanged. The owner's exact required enabled-profile evidence remains pending: these cloud proxy values are not a reproduction of the owner's exact environment. Do not restart assistant-run local testing. Keep HOLD if capable execution is unavailable.

### F2. The inherited physical-registration failure remains unresolved on this candidate — P2 cross-package blocker

`packages/hud-mcp/src/process.ts:29,62–65`, `packages/hud-mcp/src/registry.ts:84–88`, `tests/hud-mcp/int-ledger-registry.test.ts:47` — the HYG2 local review's exercised ancestor-environ EACCES gate remains applicable. NODE22-PROXY does not change these files and supplies no final-candidate passing result for that gate.

Failure scenario: physical caller registration reaches an unreadable ancestor and aborts before the real procStart/cwd assertions. The earlier three owner HYG2 matrices all recorded this failure; new export/routing evidence does not resolve it.

Required action: preserve the blocker and its original evidence. Resolve it through the separately scoped MCP-ANCESTOR work and a precise integration disposition, with unchanged mandatory identity/logical-authority requirements. Do not import unaccepted production into NODE22-PROXY to manufacture green. This review requests no reopening of HYG2's already-fixed buffered-message P2, SQLite filter or B45/helper implementation.

Source: [inherited HYG2 local review](https://github.com/CartmanFatass/codex-hud/blob/ce5e6961a0e6de1304dcebb00fc1b8c805573ec6/docs/cloud/handoff/hyg2-local-review-20261103.md).

### F3. Raw evidence is internally consistent but durable publication is not established — P2 evidence-handoff blocker

`docs/cloud/handoff/node22-proxy/implementation.md:93–100`, local courier `README.md` and `INDEX.json` — the complete archive and lossless courier are available locally, but no externally retrieved copy was verified in this review. The source commit and report being on GitHub do not establish persistence of their raw evidence.

Failure scenario: replacement of the executor loses the sole verified raw archive and the evidence needed to reproduce this review. The courier is deliberately a selected subset, not the complete archive.

Required action: the authorized serialized publisher must durably save the intended evidence, preserve hashes/identities and read it back. State exactly whether the full archive or only the 706-file courier is durable; do not relabel a subset as the full archive. This is an archival action, not a request to rerun tests or reacquire the compute lease. Publication after this review can be recorded as a factual supplement without changing the still-open F1/F2 verdict.

## Verified implementation

1. **Ownership and production boundary.** Only `src/cli/link-export.ts`, the three named existing unit-test files, new `tests/unit/node-proxy-profile.test.ts`, and new `tests/int/node-startup-diagnostics.ts` change. The production delta is exactly the two approved public-help sentences and their heading separation. Parsing, serialization, exit mapping, routing/environment transport, launch topology, dependencies, contracts, capability/performance gates and the ledger runtime predicate are unchanged.

2. **Strict diagnostic construction.** The test helper constructs expected Node 22 startup bytes from the pinned version, declared activation/proxy settings, known PID and executable presentation. Its no-HUD/no-SQLite/no-fetch child must match those bytes before they are used for HUD children. Actual streams are retained and compared as Buffers; they are not stripped, normalized or learned as an arbitrary warning template. Unknown profiles/settings fail rather than being counted as a skip. The pinned expectations are test profiles, not a new product runtime floor.

3. **Primary-source correspondence.** Node 22.23.4 startup installs the environment dispatcher when enabled and an HTTP(S) proxy is present. Its bundled agent emits UNDICI-EHPA, and warning.js prints a single trace hint per process. Node 24.22.1's bundled agent has no corresponding constructor warning. The source-derived difference agrees with the inspected captures. Sources: [Node 22 startup](https://github.com/nodejs/node/blob/v22.23.4/lib/internal/process/pre_execution.js), [Node 22 agent](https://github.com/nodejs/node/blob/v22.23.4/deps/undici/src/lib/dispatcher/env-http-proxy-agent.js), [warning presentation](https://github.com/nodejs/node/blob/v22.23.4/lib/internal/process/warning.js), [Node 24 agent](https://github.com/nodejs/node/blob/v24.22.1/deps/undici/src/lib/dispatcher/env-http-proxy-agent.js).

4. **Exact exports and unrelated warnings.** Launched help has exact EXPORT_HELP stdout and independently expected runtime-only stderr; a literal wording assertion prevents tautological approval by importing the same constant. In-process HudIO remains application-only. Refusal lines/statuses, output-failure behavior, database/WAL no-write assertions and the producer-byte comparison remain. The raw SQLite-notice negative assertion is explicit. Successful/failing initialization restoration checks and exactly two loader sentinels plus the later unrelated warning remain; no broad warning suppression is introduced.

5. **Separate process captures.** Both fixtures use distinct 0600 descriptors. The target stdout payloads are unchanged and compared byte-for-byte. The deterministic stderr sentinel establishes separation without depending on runtime warnings. The native-helper test retains exit 7, null signal, scope/helper/workload checks, helper death and final scope proof; its enabled Node 22 expectation has two distinct process warning contributions. The production shell-leader target has one workload warning contribution and preserves the original brief/EOF and forbidden-file assertion.

6. **Frozen HYG2.** The archived inherited patch exactly matches `f1e2a8408fbc6ddef181978e8a2d9fd5831242e9..ce5e6961`. Runtime/B45/ProcessClient and their assigned callers are unchanged by the candidate. The utility still rejects after terminal failure before consuming buffered messages, clears that buffer and ignores later messages. The previous P2 remains fixed and is not reopened.

## Verified recorded execution and negative controls

For each of `node22-envproxy`, `node22-noenvproxy-control`, and `node24-envproxy`, raw command output and metadata record:

- Serialized selected export/two-process targets: 15 tests, 15 pass, zero failure/cancellation/skip, exit 0.
- The same selected targets under normal runner concurrency: the same 15/15 outcome.
- Complete new diagnostic/routing suite: 5/5, zero failure/cancellation/skip, exit 0.
- Original HYG2 six-suite command: 76/76, zero failure/cancellation/skip, exit 0.

All eleven previously failing export cases and both process targets are present among the passing named tests. Their assertions after the historical failure points now execute. These are recorded implementer runs, independently inspected here, not fresh reviewer executions.

Each routing log contains fourteen real workload observations: seven declared cases on direct Node and production launchGroup. Uppercase proxy use, uppercase bypass, disabled activation, lowercase proxy/no_proxy precedence, lowercase bypass/disabled behavior, and lost-environment controls have the expected singleton target/proxy counts and transport bytes. I independently compared the retained workload streams/status metadata with the declared payload and runtime diagnostic construction. The three matrices contain 42 matching routed/control child records. The parent no-envproxy matrix still intentionally runs enabled and disabled synthetic children; that label is not a claim that every routing child has activation disabled.

The routing evidence establishes the specified loopback HTTP/default-fetch behavior. HTTPS variables are transported, but TLS/HTTPS routing, external connectivity and real harness capability are not established. launchGroup status in this witness comes from its shell diagnostic; this review does not promote that to a verified native harness result.

The retained isolated generated-JavaScript mutations fail at their intended behavioral assertions: joined descriptors fail both targets with and without envproxy; restored SQLite initialization fails the explicit notice assertion; broadened suppression loses loader warnings; omitted restoration fails reference equality; reverted help fails the literal wording assertion. The first missing-fixture SQLite attempt is a retained setup failure, not the credited negative control. Closed Buffer-copy controls cover missing/extra/duplicated/wrong warnings, PID/text/code/hint/newline changes, application-line/status changes and still-parseable stdout corruption. Actual route controls reject the enabled/bypass/transport expectations. These mutations were not independently rebuilt source trees, and are not described as such.

Node 24 build, corrected build:test, build:hud-mcp, format, fixtures and whitespace commands record exit 0. The initial Node 24 profile-hook failures and missing-fixture control remain retained. The first missing-prettier error is described in the report/courier, not supplied as a separate raw command log.

## Independent integrity audit and provenance limits

Read-only hashing established:

- Archive: 545,457 bytes, SHA256 `bf22a3540b29458741609aa8e811917ec4ff48774f3df1a662e0d085727d45fc`.
- SHA256SUMS: SHA256 `0f78caf0c81c9b9e396921c75ebbab5d3894a148ddb2708ebb6970078136b99d`; all 1,588 entries match the local evidence files and corresponding archive members. The archive additionally contains the manifest itself.
- Final source/build manifest: SHA256 `7725258b6debf2bd198290c400dcb455069253dafd705bd373ccc72cbb6ab7cb`; all 12 source entries and 770 generated-artifact entries match the frozen checkout.
- All six archived final source copies match the pinned candidate's blobs, independently fetched through GitHub.
- All thirteen courier parts match INDEX.json. Their concatenation is 759,388 bytes, SHA256 `3d31b7116a57d48e9971d2e632147503ce43e8af65f2210bfd0d94d3bee23757`. It decodes to exactly 706 original files and 591,420 original bytes; every decoded size/hash/content matches the corresponding local evidence file.
- Independent byte inspection of the three selected final capture sets confirms 26 export child records per profile with the expected runtime prefix/application suffixes and no SQLite initialization notice, the exact two original process stdout payloads, the required one/two Node 22 startup contributions and sentinel, and the exact restored-warning sequence.

These hashes establish consistency, not independent authentication of historical execution or remote durability. The command headers identify the prepublication parent/tree and tracked patch hash; the later freeze reconciliation binds the final source/build manifest. The tracked patch alone covers only four modified paths and omits the then-untracked additions. The six archived source files, final manifest and remote blob matching provide that additional binding. Future acceptance sweeps should run the frozen committed candidate and embed its exact identity directly.

One non-blocking reporting precision: implementation.md:88 says actual child flags are explicitly supplied to the diagnostic guard. Positive validateStartup calls use the default empty childExecArgv array; the explicit flag argument is exercised by negative tests. The positive child launch sites are fixed and were inspected, but the guard is not a general monitor of every launch site's argv. Do not broaden that claim. No source remedy is requested for this wording note.

## Closeout

Preserve this candidate and all red/historical evidence. Complete durable archival and the authorized verification/integration dispositions; do not infer acceptance from the scoped correction or W2 completion. No unrelated production change, suppression, runtime/profile waiver, performance/capability promotion, new fix round, later-wave release or merge is authorized by this report. A complete green exact-dependent-candidate result and appropriate final acceptance must precede the normal merged-tree gate.

**Final verdict: fix required; verification and integration HOLD.**