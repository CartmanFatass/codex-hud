# P065 performance driver and holder: independent source review

Date: 2026-11-04 UTC  
Verdict: **fix required for the evidence driver. No package acceptance, performance qualification, compute admission or merge permission.**

## Reviewed identity and method

- Repository: CartmanFatass/codex-hud.
- Immutable candidate: `8ba05de09e35abe3891ff6f6fb3b35f6065b3d65`.
- Candidate tree: `d69847f7e932d84d8fa98db4c2e31a437e7edc51`.
- Sole parent: `4151debed76b3eca68265d74811b215e62c43546`.
- GitHub's compare response reports one commit ahead, zero behind, and exactly three additions:
  - `tests/int/p065-budget-benchmark.mjs`: 917 lines, blob `e32c276c29d10977fbc1a7b25053e4c86c0d08fb`.
  - `tests/int/p065-ledger-holder.mjs`: 274 lines, blob `b75f9f3c2d477c34a6b44119414f3c77e7157724`.
  - `docs/cloud/handoff/p065-budget/performance-driver-source-20261104.md`: 137 lines, blob `83cd56eb9cac9ddad607cf8c81bd0ab72a998c46`.
- Frozen fixture read at this candidate: `tests/unit/p065-budget-fixture.ts`, blob `4264874ef20ebbae2fabe80fe505785c8a89c191`.
- Read AGENTS.md, dots.md, README.md, architecture §8, P065-BUDGET including §§7/9/10, the release ruling §§5/7/9 and six-design ruling §§2–6/Recording. The rulings and STATE were read at integration commit `c9f64e5534a855b636bf70398aa4b66d9d0d4374`.
- Read both new source files and the complete implementer report, the frozen fixture and its B45 fixtures, and relevant server/stdio, delegation, handshake, read-control, CLI, budget, transaction, ledger, authority, reconciliation, heartbeat, observation-store and checkpoint code.
- Method: connector reads and static inspection of exact source snapshots. I did not run a compiler, syntax check, formatter, test, holder, driver, benchmark, negative control, npm command, or checkout workload. No repository source was changed. Local files are review input copies and this requested review artifact.

The findings below describe source-level counterexamples to the driver's assertions. They are not claims that a runtime series has been executed or that a particular observed host sample failed.

## Ranked required corrections

### F1 — P1: Measured-response p95 can fail while the checked p95 passes

**Location:** `tests/int/p065-budget-benchmark.mjs:740–745,772–774`, with the unconsumed measured-only groups at `:693–702`.

`numeric(selected)` computes its response p95 over all rows supplied to it. The callers pass `rows` or `op`, which include warmups and recovery attempts. The independently reported measured scope does not feed a qualification decision. Even that reported measured scope mixes primary calls and recoveries when they share a bank.

A concrete static counterexample: a status cell has 1,000 successful measured calls, of which 949 are fast and 51 take 60 ms. Its nearest-rank measured p95, rank 950, is 60 ms and fails. Add 50 fast warmups: the checked 1,050-call rank is 998, among 999 fast calls, and passes. The actual-outcome split does not rescue the check because every call has the same outcome. Extra fast recoveries can dilute a primary response-loss or late-COMMIT distribution further.

**Required fix:** Gate the declared 1,000-primary measured population independently, including its actual-outcome splits. Keep the all-attempt/warmup-inclusive numerical results, and gate/label recovery populations separately rather than allowing them to repair a failed primary percentile. Keep every applicable per-call 30/20 ms check on every retained attempt. A measured population failure must propagate through `operationalNumericalQualification` and `acceptanceChecks`.

**Later verification:** Include the 51/1,000 slow-status counterexample and an analogous slow-primary/fast-recovery case. Both must fail qualification without deleting any raw attempt.

### F2 — P1: Response-loss cells can be complete without any successful lost operation or recovery

**Location:** `tests/int/p065-budget-benchmark.mjs:591–592,627–636,755–767`.

For response-loss, per-call verification requires discarded bytes but does not validate a successful server result against its durable requested work. Completeness requires only at least one `deliveryOutcome === 'response_lost'`. When spawn/resume/cancel never established a durable accepted fact, the recovery loop simply continues. The cell can therefore contain 1,000 promptly returned busy responses, lose all their bytes, perform zero canonical recoveries, and still satisfy these population/semantic conditions if the other load checks pass.

A stronger failure is also missed: a successful server reply with no requested durable record enters the response-loss branch rather than the ordinary success/durable assertion. Wave conservation can still pass with zero delta and recovery is skipped. That is not evidence for success-response loss/replay.

**Required fix:** Preserve all actual busy/refused/lost attempts, but require a predeclared successful-lost-result and checked durable-recovery population for every applicable recovery tool and H participant. If the declared attempts do not reach it, report incomplete/failed coverage; do not resample away busy calls or replace the 50/1,000 population. Validate the captured server result against durable truth even when client bytes are discarded. For report, require the relevant successful-lost report and durable inspection, but retain the deliberate no-resubmission policy. Status must have successful read-loss/re-read coverage without becoming a writer.

**Later verification:** An all-busy loss cell and a success-without-durability loss cell must not qualify. Required recovery coverage must be visible in the summary, not inferred from a list of optional recovery rows.

### F3 — P1: The recovery assertions do not establish canonical reply identity or outcome

**Location:** `tests/int/p065-budget-benchmark.mjs:560–567,585,653–660`.

The recovery check requires only `recovered.value?.ok === true`, identical independent database readback, and unchanged counts. It never compares the returned run/link/report identity or returned outcome to the independently retained durable canonical result. The primary successful-late-COMMIT assertions likewise use a broad success predicate plus existence of a durable row.

A regression returning `{ ok: true, runId: 'wrong-run', linkId: 'wrong-link' }` while leaving the correct database unchanged can pass the recovery assertions. A cancel recovery returning `ok: true` with the wrong `accepted` value or `cancelRequestedAt` can also pass. A whoami recovery can return `ok: true, state: 'pending'` and pass. The database is being compared with itself; the client-visible recovered result is not being proved.

**Required fix:** Compare the actual primary/captured server and recovered results against the expected canonical fields from independent durable readback. For spawn/resume, use the saved idempotency outcome and run/link IDs, while allowing only explicitly identified optional advice fields to vary. For cancel, require accepted=true and the original durable cancellation timestamp. For whoami, require bound state and the correct run/link/current binding subject. For status, verify the returned target identity and read facts appropriate to that read, not just ok=true. Preserve the existing no-duplicate counts/launch checks in addition to these reply assertions.

The production intent result is available in `src/ledger/intents.ts:235–248,454`; service output composition is at `packages/hud-mcp/src/delegation.ts:531`. The canonical cancel result is at `src/ledger/reconcile.ts:417–419,437` and `packages/hud-mcp/src/read-control.ts:396–400`. Whoami's bound result is at `src/ledger/handshake.ts:323–330,393`.

**Later verification:** Wrong reply run/link, wrong cancel timestamp/accepted flag and pending-whoami recovery controls must fail despite unchanged durable state and zero duplicate launch.

### F4 — P2: Zero-delay uncertain-COMMIT calls receive an overrun exemption they have not established

**Location:** `tests/int/p065-budget-benchmark.mjs:39–43,323–329,414–417,745–775,879–880`.

Every `commit-uncertain` primary is in the forced bank and therefore omitted from the operational numerical result. Its injected duration is explicitly zero: real COMMIT executes and the wrapper throws acknowledgement loss without the 40 ms stall used for commit-overrun.

The six-design ruling §4 confines the numerical exception to a predeclared injection deliberately forcing callback/COMMIT completion beyond the deadline, and explicitly does not exempt naturally slow callback/COMMIT work or ordinary scheduler interference. A naturally over-30-ms zero-delay uncertainty call can currently be numerically failed in the inclusive report yet not block `acceptanceChecks`, if its semantic result and recovery pass. Declaring a fault in advance does not by itself establish that every natural latency overrun was the approved forced-overrun control.

**Required fix:** Separate semantic-fault membership from eligibility for the forced-overrun numerical exception. Either continue to apply the applicable operational numerical gate to a zero-delay acknowledgement-loss sample, or predeclare and actually apply the bounded synchronous overrun needed to make it an overrun-plus-uncertainty control. Retain all timings and the uncertainty/no-redispatch semantics. Do not widen the ruling to excuse ordinary slow work.

### F5 — P2: Null/non-number budget timings can be accepted as valid write timings

**Location:** `tests/int/p065-budget-benchmark.mjs:399–408`; analogous unvalidated numeric comparisons at `:106–107`.

`completeTiming` only tests that diagnostics are truthy and responseMs is finite. `null <= 30` and `null <= 20` are both true in JavaScript. Thus a write call with a diagnostics object containing null authorizationMs/waitMs is considered complete and within bounds; numeric strings and negative intervals are also not rejected by these predicates. The distribution builder then filters nonfinite diagnostic values out, producing a smaller timing n while the row still qualifies.

The current inspected CallBudget normally returns numbers. This finding is about the evidence checker failing open if required diagnostics are absent/malformed or a write dispatch accidentally receives read-only timing. The implementation report explicitly promises that missing timings invalidate qualification.

**Required fix:** Validate finite, nonnegative required timing fields and the trusted applicability/type for each tool before accepting a row. For a write, require actual write-budget diagnostics; for status, retain explicit read-only N/A fields and require valid response/read timing instead of coercing null to zero. Validate the cold CLI diagnostic fields similarly. Required timing counts must agree with the population whose bound is claimed.

**Later verification:** Null, numeric-string, negative, NaN/missing and wrong-applicability diagnostic controls must fail closed. They must remain visible as invalid attempts.

## Additional supplied check finding

The dispatcher separately reported that a Prettier 3.9.9 all-src/tests check on formatting successor `deb24af` reports formatting differences only in the two driver files. This was supplied during this review; I did not run or independently inspect that check or the successor's full identity.

Preserve that failed check and correct formatting **only** in:
- `tests/int/p065-budget-benchmark.mjs`;
- `tests/int/p065-ledger-holder.mjs`.

Do not expand this into a fixture, production, build/package, lockfile, or unrelated formatting sweep. The line references in this review remain those of immutable candidate 8ba05de, not an assertion that they are unchanged on deb24af.

## Verified source-level properties

These are positive static findings, not runtime passes.

### Scope and matrix

- The delta is exactly the two reserved new source files and one additive implementation report. No fixture, production, rejection-audit, package/build/lock, shared-status or contract file changed in this commit.
- The default matrix is explicit: six non-wait tools × two H/R profiles × eight operational scenarios = 96 cells, plus five write-capable tools × two profiles × three fault scenarios = 30 cells. Total: 126.
- Constants declare 50 warmups and 1,000 measured primary calls per cell. The sequence increments by H and each wave emits H primary calls: 6,300 warmups and 126,000 measured primaries, or 132,300 primary calls in total.
- There is no hidden smaller-population CLI/environment option. The only accepted positional invocation is the output path; extra arguments are refused (`:30–43`). Recovery calls are additive and never replace primary counts (`:411–423,693–696,882–884`).
- Missing/failed/unfinished primary calls and incomplete cells prevent population completeness. The driver retains started/flushed/incomplete/completed records and does not rerun a cell to discard busy or slow calls. This does not cure F2's missing semantic population criterion.
- Nearest-rank percentile arithmetic in `stats()` is correct (`:93–102`); F1 concerns which population is gated.

### Real versus synthetic

- Main calls use the real HudMcpServer, serveStdio, DelegationService and SQLite writer/read paths, imported from the actual compiled test graph (`:831–836`). Production `monotonicClock` is selected, not TestBudgetClock (`:250–253`).
- The source resolver is a visibly synthetic dependency. It returns an independently read current ledger scope premise and fixture process/session facts (`:222–232`); it is not a real harness source/proc resolver benchmark. Physical-process facts, capability and launch are test seams. These limitations are disclosed.
- H=2 has two separate registered caller/context identities, service SQLite connections, server instances and stream pairs. Operational calls are issued before awaiting either response (`:495–508,540–547`). They still share one JS/OS process and do not prove real loaded-harness topology.
- The frozen fixture builds R accepted nonterminal runs with real slots, claims, registered synthetic supervisors and heartbeat CAS, uses permitted synthetic limits 12/12, and asserts baseline and child identity conditions. The driver checks H/R and identities again (`:466–474`).
- Foreground spawn/resume additions and active count changes are retained. Fresh fixture per wave is explicit, with setup separately recorded. It does not restore population by deleting live authority or force-releasing slots.
- Refusal cells use a mismatched physical source ID and execute the real authorization/read predicates. Status bypasses enforcing write budgets by production design, is required to have zero instrumented write transactions, and remains subject to the response gate.
- The whoami forced controls create an additional legitimate fixture actor/context for the same synthetic process/session and use the normal handshake remap path. They do not rewrite existing bindings/claims directly (`:475–486`).

### Streams, faults, durable truth and bounds

- serveStdio serializes newline-delimited JSON and calls server.flushed from its actual Writable acknowledgement (`packages/hud-mcp/src/server.ts:180–211`). The driver provides an asynchronous Writable callback and observes those diagnostics; ordinary received frames check protocol, request ID and text/structured parity (`benchmark:203–219,261–281`).
- Loss discards already-produced bytes at the client while retaining the captured server outcome. It is not a mock return of success.
- Callback injection occurs after the real requested-operation callback and before production's pre-COMMIT check. The late-COMMIT and uncertain-ack injections execute actual SQLite COMMIT before delaying/throwing (`:298–365`). Their source assertions distinguish rollback, durable success and uncertainty rather than claiming every injected result passed latency.
- Fault targeting matches the relevant operation callback shapes in intents, handshake/report and requestCancel. Forced H participants are sequentially isolated, so one intentional 40 ms JS stall does not contaminate an ordinary concurrent operational caller.
- Unknown-COMMIT readback is on a different ledger connection; recovery replaces an isolated original connection. There is no initial synthetic launch for an uncertain spawn/resume COMMIT. Reports are not automatically resent.
- Per-call write and wait gates are present and not replaced by a p95<=30 test. Busy timeout is read from each service and helper SQLite connection and checked at zero. Diagnostic validity still needs F5.
- Response waits are bounded at 5 seconds; helper ready/command waits at 10 seconds; lock requests are bounded to 1–500 ms; scenario locks are 5 or 100 ms. The driver declares a 3,600-second outer bound and reports incompleteness rather than reducing sample counts.

### Owned helper, heartbeat and observation storage

- The helper requires IPC, a random ownership marker, canonical private sandbox/home paths, matching UID and a private existing regular ledger file with nlink=1 (`holder:16–53,147–166`).
- It opens the same ledger with a separate real SQLite connection and takes a real BEGIN IMMEDIATE writer lock, busy_timeout=0, with a bounded release timer (`:155–157,233–241`).
- Heartbeats use createHeartbeatWriter with stored supervisor/initial sequence state and monotonically advancing wall/monotonic facts; both successful results and errors are retained (`:88–99,160–167`).
- Observation load uses the already accepted acquire/renew/publish/readProjection APIs on a separate source-local store, with filesystem device equality checked against the ledger (`:100–115,169–173`). Published bytes/sequences and intervals are returned by the real API. No B10D dependency or ledger observation table is introduced.
- Background metric overflow fails; unexpected heartbeat/CAS/observation failures feed row semantics. Actual recorded overlap, not just a configuration label, is required at cell level.
- Shutdown releases the lock and closes stores. Parent cleanup owns the specific ChildProcess object and uses bounded SIGTERM-to-SIGKILL escalation, with no kill-by-name or unrelated-process operation (`benchmark:148–200,674–688,910–914`; `holder:118–142,262–274`).

## Readiness conditions and limitations that remain after source fixes

1. **Fresh exact-source review and ordinary checks remain required.** Correct F1–F5 within the reserved driver/holder scope and address the two-file formatting failure. No frozen-fixture or production change is justified by these findings. Any genuinely necessary outside-scope remedy must stop for its own disposition.
2. **Do not claim that this review proves syntax or runtime feasibility.** No execution was performed. The declared design creates 99,225 fresh main fixtures per complete series, plus two cold CLI fixtures. Completion within the 3,600-second bound is unverified. Keep the bound and full population; timeout is incomplete/failed, not grounds for shrinking the matrix.
3. **Measure instrumentation and logging overhead before qualification.** The synchronous `raw()` serialization/append at `:449` runs as each H=2 call finishes while its sibling can still be in flight. It can add event-loop/storage delay to that sibling's measured response. Prefer journaling completed measurements after all clocks in the wave have ended, while preserving durable started/incomplete evidence, or explicitly quantify this conservative harness interference. Do not subtract it or silently select favorable samples. The callback/SQL/backoff instrumentation overhead also remains unmeasured.
4. **Interpret first-use/cold labels narrowly.** Every main wave uses a new store/service/server; the success and first-use scenarios therefore both involve fresh compositions. Module imports occur once in the parent and are separately timed. The two fresh-helper CLI probes retain first/second requests through real compiled privateHome/runCommand and lazy independently built MCP imports, but deliberately refuse capability and have only four calls. They are not a warmed MCP cache study, a positive cold acceptance population, or substitutes for any 50/1,000 MCP cell.
5. **Prove build provenance externally.** The driver records source commit/tree, clean tracked/untracked state, compiled graph hashes and driver hashes, but hashes alone do not prove compiled output was built from the named source. A separately admitted exact-tree build, retained raw check outputs and custody records must establish that.
6. **Later authorized execution must inspect the artifacts, not merely exit status.** Require corrected primary/measured/recovery gates, population completeness, all outcome splits, all per-call numerical flags, all fault semantics, actual load/lock participation, and retained partial attempts. Provide meaningful behavioral controls for the false-pass cases above.
7. **Runtime and full-check gates remain independent.** Three isolated complete series on each exact supported Node 22 and Node 24 runtime remain required, without concurrent unrelated controlled builds/tests/benchmarks. Focused passes cannot make blocked aggregates green. Preserve AF_UNIX-listen/PTRACE_TRACEME restrictions and HYG2/RUNZ1/S3F full-check blockers; this review authorizes no retry or environment change to evade them.
8. **No synthetic upgrade.** Real-Claude same-call 150/50 timing, real harness/capability cells, Herdr/tmux, formal WSL and B14 platform qualification remain separate and unverified. Final independent Oracle acceptance and the full green merged-tree check set remain prerequisites to integration.

## Implementer-report assessment

The source-only/nonqualification disclaimer is accurate, as are the three-file scope, fixed primary counts, visible synthetic seams, real SQLite/framed paths, independent helper and no-report-resubmission descriptions.

The stronger statements that the response gate is enforced for the prescribed measured populations, that required recovery populations are complete, that canonical returned outcomes are verified, and that missing timing always invalidates qualification are not established by the present code. F1–F5 must be reflected in an additive correction report. Preserve the original report and failed checks rather than overwriting their historical claims.

## Source links

- [Reviewed candidate](https://github.com/CartmanFatass/codex-hud/commit/8ba05de09e35abe3891ff6f6fb3b35f6065b3d65)
- [Exact two-source-plus-report comparison](https://github.com/CartmanFatass/codex-hud/compare/4151debed76b3eca68265d74811b215e62c43546...8ba05de09e35abe3891ff6f6fb3b35f6065b3d65)
- [Driver](https://github.com/CartmanFatass/codex-hud/blob/8ba05de09e35abe3891ff6f6fb3b35f6065b3d65/tests/int/p065-budget-benchmark.mjs)
- [Holder](https://github.com/CartmanFatass/codex-hud/blob/8ba05de09e35abe3891ff6f6fb3b35f6065b3d65/tests/int/p065-ledger-holder.mjs)
- [Implementation report](https://github.com/CartmanFatass/codex-hud/blob/8ba05de09e35abe3891ff6f6fb3b35f6065b3d65/docs/cloud/handoff/p065-budget/performance-driver-source-20261104.md)
- [Frozen fixture](https://github.com/CartmanFatass/codex-hud/blob/8ba05de09e35abe3891ff6f6fb3b35f6065b3d65/tests/unit/p065-budget-fixture.ts)
- [P065 release ruling](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/rulings/p065-budget-release.md)
- [Six-design dispositions](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/rulings/p065-six-design-dispositions.md)
