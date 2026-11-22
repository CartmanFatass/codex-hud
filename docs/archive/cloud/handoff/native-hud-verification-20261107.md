# Native HUD verification record (2026-11-07)

This is source delivery evidence for the owner-approved `universal-hud` revision, not real-client certification. See [local use and validation](native-hud-local-validation.md).

## Implemented and independently reviewed

The default MCP entry uses the detached local native connection host and official Codex app-server, Claude SDK with the user's executable, installed Pi RPC, and the existing Jev Agent. Direct native ownership, raw callbacks/results, explicit native resume, parent-exit continuation, existing wake channels and HUD summaries are retained. The default graph does not use the former business task ledger, claim/slot policy, retirement, or vendor-version qualification. Existing historical code and records have not been wholesale deleted or migrated.

Independent runtime, display, packaging and branch-selection reviews were followed by implementer fixes and independent rechecks. Findings corrected include native locator substitution, dead-connection resume, startup callbacks, native dialog configuration, Pi request expiry, event-buffer gap reporting, live display selection, reader starvation, packaged Pi wake resolution and outdated skill/test contracts.

## Original aggregate run

The original run used Node 24.22.1 with isolated HOME/HUD_HOME, inherited `NO_COLOR=1`, and `/tmp` as TMPDIR. These raw failures are not erased by isolated reruns:

| Check | Original result |
| --- | --- |
| Main, test and MCP builds | PASS |
| MCP suites | 198 PASS, 2 socket SKIP, 0 FAIL |
| Unit suites | 3191 PASS, 42 FAIL, 18 SKIP (3251 total) |
| mjs suites | 293 PASS, 24 FAIL, 1 SKIP (318 total) |
| Core suite | 211 PASS, 1 SKIP, 0 FAIL |
| Visual baselines | 331 PASS, 0 FAIL |
| Public fixture check; diff whitespace | PASS |
| Whole source/test formatting | FAIL in 23 pre-existing, unchanged files; changed-file checks are separate |

## Failure investigation and bounded reruns

- Display tests expecting color were run under `NO_COLOR=1`. Removing that variable without changing source or assertions restored the expected results. The one remaining facts test had a stale field-count constant: baseline already had 72 fields, current code has 73. Its replacement compares the complete constructor key set and retains independent-object/refill/cache assertions; 97/97 targeted tests passed.
- Current native skill schemas and Pi wake payloads replaced obsolete test assumptions. Historical API tests remain separate. The Pi wake test skips only an actual `EPERM` with `syscall: listen`; independent injected `EPERM/open` correctly fails instead of being hidden.
- Eleven SQLite/WAL tests require a non-tmpfs filesystem. All 11 passed unchanged with a private workspace TMPDIR. The snapshot directory-cache test also passed there; its old fixture restores mtime but not directory size, which changes on tmpfs.
- Five historical process-fault tests require `/proc/<pid>/task/<pid>/children`, absent in this executor. An independent topology probe confirmed the processes and parent/group/session IDs were otherwise live and correct. Three ptrace audit tests fail at `ptrace(TRACEME)` with EPERM before reaching the audited driver. These remain environmental FAIL results, not claimed passes or silent skips.
- Pi/Herdr Unix socket cases fail or explicitly skip because this executor rejects listening with EPERM. Herdr accounts for 14 failing leaf cases plus their failed parent in the original mjs run. An elevated attempt did not make listening available.
- Two process/timing tests passed unchanged in isolation after failing under aggregate load. Both outcomes are retained.
- Two display performance targets each passed three sequential isolated runs under the unchanged relaxed CI bounds. Cold 200-row p99 ranged 11.134–23.500 ms (CI bound 50 ms, **not** strict 10 ms qualification); compact no-change p99 0.611–1.888 ms and rich 0.385–0.629 ms. The original parallel failures remain recorded. No performance threshold was changed.

No actual Codex/Claude/Pi provider, Jev browser, installed terminal, real installer or strict WSL performance qualification ran. The owner will exercise these locally; they are not prerequisites invented by HUD for accepting native sessions.

The first controlled rerun selected an overly long workspace TMPDIR: one Jev Unix socket path exceeded the platform path limit and failed with `listen EINVAL`. That run was stopped, not reported as a completed unit run. The final rerun uses a shorter private workspace TMPDIR; no production socket behavior was changed to hide this setup error.

## Final bounded repairs and independent acceptance

The retained Pi disk-resume path now binds an exact native session header without a vendor/header-version gate and rechecks fd/path identity after reading. Independent six-way replacement/append probes verified the reported race repair. Current Pi tool fixtures use the actual native/Jev schemas; their non-socket host port is explicitly synthetic. The retained runtime integrity reader consumes library metadata generated from the same reviewed lock source as packaging, including only the exact reviewed nested libraries and excluding optional vendor clients.

Final independent checks for those repairs: runtime-build 174/174; Pi/context/bridge/historical installed composition 103 PASS plus 1 unselected real Pi package SKIP; 17 library-integrity/path probes PASS. Both generated targets match all 107 library entries and the production-lock digest. This does not restore the former version qualification chain to the default MCP path.

## Final rebuilt aggregate

After the last repairs, all three builds and changed TypeScript/JavaScript/JSON formatting checks passed. With a short, non-tmpfs private TMPDIR:

- MCP: **198 PASS, 2 explicit socket SKIP, 0 FAIL** (200).
- Unit: **3320 PASS, 18 FAIL, 19 SKIP** (3357). Eleven failures are the already-probed socket/procfs/ptrace restrictions. Three legacy Claude rendering assertions conversely expect no-color output, so fail with ANSI when `NO_COLOR` is removed; they passed in the original no-color run. Four load-sensitive failures (one performance target, B11 ledger budget, a synthetic Codex 120 ms startup deadline, and portable waiter timing) all passed unchanged in isolation. The performance target passed three isolated runs with p99 1.584–1.927 ms. These reruns do not rewrite the aggregate result as green.
- mjs: **335 PASS, 15 FAIL, 1 unselected optional Pi SKIP** (351). The remaining failures are exclusively the documented Herdr socket-listen EPERM cases, including the failed parent case.
- Fixture and whitespace checks: PASS. No remaining implementation defect was identified by the independent final reviews. Production/provider acceptance remains explicitly untested.

## Follow-up design correction before publication

A design-focused recheck found a remaining default-path dependency that the earlier functional review had not removed: caller/source registration and Claude hook premises still opened the historical scope ledger. This was more than historical display code. The final source refinement removes that dependency instead of claiming tests alone justified it.

Default MCP registration is now in-memory, and native source resolution plus Claude hook evidence use the actual native session, process/start/boot identity, server and native call ID. Private one-shot evidence and cross-session checks remain. The default main and real synthetic hook subprocesses pass a loader guard that rejects the whole ledger directory, SQLite and old ledger/scope registry modules. Historical budget/scope compatibility is reachable only through explicit historical paths, not the native default.

Two small behavior corrections accompany this:
- Pi respects its native session-storage default and the user's explicit configuration, rather than injecting a HUD-owned session directory.
- Jev forwards the existing `Agent.run()` generator yields as they arrive, retaining the original final receipt. Display labels the last received native output and its receipt time. Explicit snapshot/command/close remain serial with the underlying API; no concurrent scheduler or interrupt promise was added. Display encoding failures do not stop, retry or close the Agent.

After the final explicit close, a host with no retained handles, creation placeholders or in-flight requests releases its server reference and drains naturally. No idle timer, automatic backend close or kill is used. A bootstrap-only host is intentionally not reclaimed between separate wake-register/create calls, avoiding loss of native wake registration.

Source-refinement verification: all three builds PASS; full MCP **209 PASS, 2 actual socket SKIP, 0 FAIL** (211); selected native host/config/wake/display suites **46 PASS, 2 socket SKIP, 0 FAIL** (48). Independent design-focused root/MCP compilation and focused checks produced **92 PASS, 2 socket SKIP** (94). The four outdated aggregate assertions were migrated only in tests: default main now asserts no legacy DB writes and no scope reads, while explicitly historical DelegationService fixtures supply their own historical scope premise. The related three files pass 31/31. Fixture, changed-file formatting and whitespace checks PASS. Earlier full-project environment failures remain recorded above; they were not silently reclassified or rerun as proof of real-client behavior.
