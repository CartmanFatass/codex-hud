# RUNZ1 final Oracle review

## Verdict

**FIX REQUIRED — verification blocked. WIP / NOT ACCEPTED / NOT MERGEABLE.**

No new must-fix defect was found in RUNZ1’s implementation, regression tests, or authorized README changes. The mandatory full check set remains red. The environment evidence explains substantial failures; it does not waive acceptance or permit a merge.

## Reviewed target and evidence

- Repository: `CartmanFatass/codex-hud`; package branch: `dots/runz1`.
- Implementation reviewed: `2eb08fbd091a44b77bbaa3761c68ae8b11688778`, against base `f1e2a8408fbc6ddef181978e8a2d9fd5831242e9`.
- Read `AGENTS.md`, `docs/cloud/dots.md`, the cloud README/check set, RUNZ1 brief, relevant STATE/architecture/contracts/design/decision-log sections, all four RUNZ1 rulings, and `docs/cloud/handoff/runz1-implement-report.md`.
- Independently inspected all six changed files and the production completion/reconciliation call sites. The source delta is six files, 994 additions and 34 deletions. The second implementation commit changes only the bounded race-test harness.
- Reviewed the complete dispatcher log for this exact implementation and the retained implementer check, mutation and performance evidence. Dispatcher output is archived as `docs/cloud/handoff/runz1-dispatcher.log.part01.txt` through `part07.txt`, in order. The complete local log and concatenated local seven segments have identical SHA-256: `540b6c39fe87d3a9c26c138ca1d9b159aa0a4553e884f8703471bf21a151f1c2`.
- Performed independent focused tests, three performance executions, and `git diff --check`. No source or Git mutations, subagents, local-only tests, installation operations, or real-user-home operations were performed. The pre-existing `node_modules/.package-lock.json` modification remains excluded.

## Finding requiring resolution

**F1 — `docs/cloud/RUNZ1.md:43`; `docs/cloud/README.md:69–79` — mandatory complete-check acceptance evidence is still failing — accepting this package now would leave 12 unit failures and the independently executed mjs failures unresolved — P1 acceptance blocker — rerun the unchanged complete check set on an authorized capable executor, retain every outcome, and resolve any reproducible product failures through the existing review process. Do not suppress tests, expand skips, relax assertions, or redefine supported profiles to obtain green.**

This is a verification/gate finding, not a claim that RUNZ1 introduced those failures. No RUNZ1 production-code change is prescribed on the present evidence. The exact two helper-discovery failures still need a successful capable-executor run; their current logs are not sufficient to declare their underlying behavior validated.

## Verified

1. **Both success routes enforce original-subject termination.** `process.ts:149–179` checks the original harness and all supplied launchers, including the required original group leader, before either success return. Matching Z/X leaders require validated single-terminal-task evidence. Missing/malformed task data, inconsistent identity/counts, and wrong domains fail closed. Kernel-confirmed disappearance and unambiguously replaced original identities remain usable. Checks are not filtered by the subject’s current SID or PGID. General `processState` classification remains unchanged.

2. **The zombie proof implements the scope ruling.** `process-census.ts:145–181` requires SID = PGID = recorded leader PID, matching boot/domain, an eligible procfs witness, and two strict censuses. First-census session members must be terminal whole thread groups. Every second-census identity must exist unchanged in the full first census, before SID filtering; any newly observed or reused outside-session identity also refuses proof. Remaining session members are checked against first-session membership and terminal task evidence. A changed leader instance cannot corroborate the old scope.

3. **Visibility and read ambiguity are conservative.** `process-census.ts:53–85` validates the active procfs mount and domain, rejects restrictive/unknown superblock visibility options and numeric/self metadata overmounts, and checks the witness again after both censuses. Enumerated stat failures, including ENOENT/ESRCH, invalidate the alternative. Strict parsing prevents malformed membership fields from silently filtering a process out.

4. **ESRCH remains a separate route.** `process.ts:180–192` does not import own-session eligibility, no-live-session requirements, or a stable full-host census into kernel-group-absence proof. The real visible fixture holds its slot while zombies retain the PGID, then finishes after actual ESRCH despite a living unrelated process in the shared session.

5. **Regression evidence is meaningful.** Real Linux fixtures cover the first-snapshot fork, same-session join, second-snapshot fork/setsid escape, live sibling of a zombie TGID, and escaped original harness and launcher while the target group genuinely returns ESRCH. Positive controls terminate the whole escaped subject and then permit completion. The escape fixture actually creates a different SID. The second-boundary test asserts false on every attempted proof and fails unless both boundaries and the surviving original-session grandchild are exercised; its bounded fixture retries do not relax proof assertions or add production polling.

6. **The integration preserves terminality and slot rules.** New tests exercise production `HeadlessRunControl.reconcile` with the in-memory fact port: failed proof stays uncertain, keeps the slot and fabricates no receipt; valid later proof ends the run and releases the slot. The existing run-control receiptless-Q regression is green. Source inspection confirms both final receipt generation and Q reconciliation remain gated by `proveGroupGone`; caller-owned channel sealing is not replaced by a new permission or signal path.

7. **Mutation evidence supports the assertions.** Retained outputs show the zombie positive failing when the new proof is removed; the real fork/setsid regression failing under session-only corroboration; live-sibling cases failing without thread checks; visibility refusal failing without the witness; and both escaped ESRCH regressions failing when the old `processState === dead` prerequisite is restored. These mutation outputs were inspected, not claimed as newly executed by this reviewer.

8. **Scope and hygiene are respected.** Only the two production process files/direct helper, three RUNZ1 test/benchmark files, and the two expressly authorized README paragraphs differ. The README matches the accepted scope/ESRCH distinction. No new timer, observer, signaling authority, launch topology, persistent schema, managed scope, or dependency was introduced. New fixtures and paths are synthetic; processes are owned and cleaned by PID rather than name/pattern.

## Check results

Independent focused command, on Node v24.22.1 with a fresh temporary HOME and overlay-backed temporary test directory:

`env -u NO_COLOR -u FORCE_COLOR -u HUD_HOME HOME=$(mktemp -d /tmp/runz1-oracle-home.XXXXXX) TMPDIR=/workspace/shared node --test dist-test/tests/unit/runz1-process.test.js dist-test/tests/unit/run-control.test.js dist-test/tests/unit/run-process.test.js`

Result: **54 tests, 54 pass, 0 fail, 0 cancelled, 0 skipped**, including all 24 RUNZ1 cases, 20 run-control cases, and 10 run-process cases. Duration: 19,338.890712 ms. Independent `git diff --check`: exit 0.

Dispatcher results on the same implementation:

- `build`, `build:test`, `build:hud-mcp`: all exit 0.
- `npm test`: exit 1 at the unit stage; 2,369 tests, 2,341 pass, 12 fail, 16 skipped, 0 cancelled. All RUNZ1 cases passed in this full parallel run. Its automatic mjs stage was not reached.
- `test:core`: exit 0; 210 tests, 209 pass, 1 skipped.
- `test:visual`: exit 0; 319/319 pass.
- `test:hud-mcp`: exit 0; 84 tests, 83 pass, 1 skipped.
- `format:check`, `check:fixtures`, `git diff --check`: exit 0.
- Explicit `test:mjs`: exit 1; 47 tests, 32 pass, 15 fail, 0 cancelled/skipped. The socket-dependent leaf failures report AF_UNIX `listen EPERM`; Node’s failed-parent count is included in the reported 15.

The 12 unit failures are precisely:

- Four B19 cases with explicit AF_UNIX `listen EPERM`.
- Three B3H real-ledger helper-fault cases with ENOENT reading `/proc/<pid>/task/<pid>/children`.
- Three exec-stop/portable-shell audit cases with explicit `ptrace(TRACEME)` EPERM.
- Two lightweight-leader helper-discovery cases failing `assert.ok(target)`. Their discovery helper reads the same proc children interface and returns an empty list on read failure, so the missing interface is consistent with these failures. Do not relabel them as independently demonstrated ptrace failures or as passed behavior.

The implementer’s earlier final-source hud-mcp run had three ledger_busy failures; retained isolated advice/delegation reruns passed 9/9 and 8/8, followed by a complete 83-pass/1-skip rerun. Both failing and passing evidence remain relevant. The dispatcher’s later complete hud-mcp run also passed.

The CI queries during review returned empty commit-status and PR-triggered workflow-run lists for the implementation SHA. That is not green CI evidence. Because the workflow tool filters to PR-triggered runs, it does not establish the absence of every possible workflow/check execution; interpret the implementer’s broader “no CI exists” sentence with that limitation.

## Performance evaluation

The retained three-run results match the report. Each population uses n = 1,000 after 100 warmups, wall-clock `performance.now`, empirical nearest-rank percentiles, sequential populations, and no explicit GC. Host: `d14215e6cbaa`, Linux 6.18.57 x64, Node v24.22.1. There are three supplied subject stamps representing two unique processes; the reported quiet census is six processes and the sampled churn census eight.

The full zombie measurement includes common subject checks, the existing inspection, both strict censuses, and visibility/task checks. The single-census microbenchmark is not the entire incremental overhead, and percentile components must not be added or subtracted as though they were a paired full-proof distribution. ESRCH is measured separately. Conservative refusals remain in the timing population.

Retained implementer ranges across three runs, milliseconds:

| Population | p50 range | p95 range | p99 range | maximum range |
| --- | ---: | ---: | ---: | ---: |
| Full zombie proof | 0.943839–0.974898 | 2.702679–3.382377 | 5.680556–9.541911 | 12.974568–25.946517 |
| One complete census | 0.074430–0.079358 | 0.118495–0.151725 | 0.161189–0.440493 | 0.679706–12.278106 |
| Full ESRCH proof | 0.143052–0.162651 | 0.261286–0.493109 | 0.721161–3.260825 | 2.252335–8.194291 |
| Full zombie proof under churn | 0.973756–1.026830 | 1.465830–2.483350 | 4.732156–6.726850 | 7.264424–47.885429 |

Quiet zombie and ESRCH refusals were 0/1,000 in each run. Churn refusals were 67, 77 and 96 per 1,000.

Independent command: three sequential executions of `node tests/int/runz1-perf.mjs`, with temporary HOME/HUD_HOME and `TMPDIR=/workspace/shared`, on the same host/runtime. The launch call returned at approximately **2026-11-03 14:04:24 UTC**, and all three processes had finished when output was collected at **14:04:56 UTC**. Exact per-run start/end timestamps were not instrumented. Independent B10B performance work may have overlapped this interval; these results are not an asserted uncontended baseline. No further benchmark runs were performed after the dispatcher raised that possibility.

Independent ranges, milliseconds:

| Population | p50 range | p95 range | p99 range | maximum range |
| --- | ---: | ---: | ---: | ---: |
| Full zombie proof | 0.622311–0.749979 | 0.995964–1.129852 | 1.327875–1.632796 | 2.769168–4.216320 |
| One complete census | 0.044486–0.045217 | 0.072297–0.102792 | 0.153888–0.222479 | 0.291811–0.323980 |
| Full ESRCH proof | 0.085106–0.088170 | 0.182820–0.238402 | 0.315717–0.424067 | 0.607720–2.437527 |
| Full zombie proof under churn | 0.672405–0.730872 | 1.003665–1.062322 | 1.347664–1.354895 | 4.462784–8.927591 |

Quiet zombie and ESRCH refusals were again zero. Churn refusals were 87, 113 and 91 per 1,000. These results satisfy RUNZ1’s requested cost-reporting exercise. They are small-census cloud design evidence, not formal supported-WSL qualification, a high-process-count scalability claim, or a replacement for another package’s performance gates. No GC attribution or threshold relaxation is inferred.

## Required next disposition

1. Keep RUNZ1 marked **WIP / NOT ACCEPTED / NOT MERGEABLE**.
2. Obtain a green unchanged full check set on an authorized environment supporting the required AF_UNIX, ptrace, proc children and native-disk prerequisites. Preserve the current failures and known-flake isolated reruns. If authorization/environment access is unavailable, record that exact blocker; do not silently alter the gate.
3. Give the completed check evidence and any actual fix diff to the prescribed fresh Oracle re-check. No production fix is requested merely to conceal this executor’s limitations.
4. Only after an accept verdict may the dispatcher perform the authorized non-fast-forward merge and run the complete check set on the merged tree before push/state updates. The merged-tree gate has not yet been exercised for RUNZ1.
5. Local-only/real-harness work and formal WSL qualification remain separate and unclaimed. No owner-reserved contract, gate, profile or control decision has been made by this review.
