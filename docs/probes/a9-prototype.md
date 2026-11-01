# A4b: isolated A9 SQLite / process prototype

- Date: 2026-11-01. Node v24.22.1, SQLite 3.53.4, Linux x64.
- Result after Oracle consult 3 E01–E06 application: **21/21 tagged prototype IDs PASS on two independent runs**. This is A9 feasibility evidence, not A9 approval or B production acceptance.
- Scope: the `A9 prototype` rows in contracts [01](../contracts/01-identity.md), [02](../contracts/02-execution.md), and [04](../contracts/04-supervision.md): 4 identity + 9 execution + 8 supervision entries.

## Method

Run from the repository with Node 24 and Linux `/proc`:

```bash
bash tests/prototypes/a9/run-all.sh
```

The runner creates a private `HUD_HOME` with `mktemp -d`, then runs `identity.mjs`, `execution.mjs`, and `recovery.mjs`. Each scenario uses a separate real SQLite file under that temporary home. Initialization extracts the single SQL block from contract 02 verbatim; it creates 16 tables, 15 explicit indexes, and 11 triggers. Every connection enables foreign keys and zero SQLite busy timeout; the prototype bounds its own lock retry loop. WAL and `user_version=1` are asserted. The extracted SQL is preserved with the logs; its SHA-256 is `04371f26b92c165819e581caf94cb349de877c2f347a465de23572e1a5437039`.

Synthetic harnesses, MCP servers, supervisors, workloads, launchers, and recovery observers run as separate OS processes. The synthetic MCP transport uses Node IPC, not a real MCP client. Current-call source records and session headers are private synthetic files; no real Codex, Claude, pi, model, network, or Herdr tab is started. Configuration tests transport `-c mcp_servers.hud.env.HUD_*` leaves through actual argv and a deliberately small synthetic parser, preserving command/args, other environment entries, and another server. The selected synthetic config env is passed through the actual OS environment to the MCP process, which reads `process.env`; the test asserts this transport source. These test the proposed mechanism; real harness compatibility remains bounded by A3/A8 evidence.

The competing MCPs first establish their contexts. One then deliberately holds `BEGIN IMMEDIATE` for 200 ms, while the other records positive SQLite busy retries. Identical keys return the original outcome, with exactly one synthetic submission. Rekeying is also interrupted in another process: a concurrent WAL reader sees the original complete state, SIGKILL rolls back the merge, and a later committed merge replays the original result. Crash writers announce named IPC barriers and are killed with SIGKILL after each of six intent inserts, before/after commit, after each terminal mutation, and at armed/submitting/after-spawn cuts. Exceptions in the test driver are not used as substitutes for these crashes.

Scope tests create actual detached process groups, a leader that exits before its sleeping member, SIGSTOP members, a deliberately unreaped zombie, and separate-session escape stand-ins. Real `/bin/sh` and `exec` establish distinct versus identical process instances; actual child exit events supply native or shell wait results. Recovery requires the fixed startup record, full scope visibility, original-harness termination, an explicit complete launcher roster with seal/death evidence, and no live escaped writer before Q. Negative cases omit actual persisted scope/startup/harness/launcher/completeness fields, retain a live launcher with no seal, or inject a partial-visibility observation; they hold the slot. A stopped, previously permitted launcher is continued after a DB fence and really submits once, demonstrating why the timestamp alone cannot prove sealing.

Cancellation commits the accepted intent first, then records a sourced scope observation linked to that event. Only a verified live member after acceptance proves cancellation preceded scope end. Direct wait/scope-end observations preserve their producer and monotonic time before receipt import; a later end observation alone cannot prove that ordering. The actual-process case where the child exits while the ledger remains active, cancellation is accepted, and the receipt arrives later resolves to `ended` / `already_ended`. On confirmed scope termination, cancellation with a verified later live member resolves to `cancelled`; complete R/Q with absent reliable ordering resolves to `ended`, releases the slot, and records `terminalNote: cancel_timing_unknown`; `cancelResult` stays null, without inventing confirmed or already_ended. Another OS process holds a real SQLite write lock until a gated child has exited, forcing exit before cancellation can commit. Receiptless Q now ends with the unknown-timing note in this schedule, without treating a stale pre-lock scan as evidence of live workload at acceptance. The later wait receipt preserves that original terminal decision and note, and creates no second completion event. The shared T-04-24 recovery helper also exercises receiptless Q after cancellation with unknown chronology. The positive live-after-acceptance case remains cancelled, and every missing scope/harness/launcher/visibility predicate still holds the slot.

PIDs/start ticks/boot/PID namespace are recorded before signaling. Cleanup revalidates owned instances, stops descendants after each ID and on exit, and removes the temporary database/home. A separate SIGTERM check observed exit 143, removal of the temporary home, and no executing recorded instance. Raw evidence directories remain under ignored task scratch.

## Captured runs

- R1 (O3APPLY): [`tmp/tasks/A4b/run-hjOCfRGW`](../../tmp/tasks/A4b/run-hjOCfRGW/); aggregate output: [`prototype-full-1.log`](../../tmp/tasks/O3APPLY/evidence/prototype-full-1.log).
- R2 (O3APPLY): [`tmp/tasks/A4b/run-6K1BmtzI`](../../tmp/tasks/A4b/run-6K1BmtzI/); aggregate output: [`prototype-full-2.log`](../../tmp/tasks/O3APPLY/evidence/prototype-full-2.log).
- Each directory contains group logs, one JSON evidence file per ID, the exact `schema.sql`, and schema fingerprints. Re-running generates a new directory; archived A8 evidence is read-only.

Both runs printed exactly:

```text
COUNT contract=21 printed=21 unique=21 equal=true
SUMMARY total=21 pass=21 fail=0
```

The count check parses the contract table rows and the actual PASS/FAIL lines, compares the complete sorted ID lists, and rejects duplicates or missing IDs.

## Oracle consult 3 targeted before / after

The same affected IDs, T-02-15 and T-04-24, were run in isolation before and after the change. Both tagged IDs passed against their respective assertions; the old PASS asserted the superseded behavior and is not evidence for E02. Raw outputs: [before](../../tmp/tasks/O3APPLY/evidence/affected-before.log), [after](../../tmp/tasks/O3APPLY/evidence/affected-after.log); scenario JSON: [before T-02-15](../../tmp/tasks/O3APPLY/evidence/affected-before/T-02-15.json), [after T-02-15](../../tmp/tasks/O3APPLY/evidence/affected-after/T-02-15.json), [after T-04-24](../../tmp/tasks/O3APPLY/evidence/affected-after/T-04-24.json).

| Case | Before | After |
|---|---|---|
| cancel-order-unknown, complete R | uncertain, slot held | ended, slot released, terminalNote=cancel_timing_unknown, cancelResult=null |
| cancel-write-lock-exit, receiptless Q | uncertain, slot held | ended, slot released, terminalNote=cancel_timing_unknown, cancelResult=null |
| Same run, delayed wait receipt | uncertain, slot held | original ended and note retained, no second completion event |
| T-04-24 shared receiptless-Q helper, unknown chronology | No positive case | ended/released with note; repeated reconciliation preserves it |
| Proven live after cancel, followed by end | cancelled | cancelled; retained |
| Proven exit before accepted cancel, delayed import | ended / already_ended | ended / already_ended; retained |
| Any missing Q predicate | uncertain, slot held | uncertain, slot held; retained |

E01/E03/E05/E06 use narrow contract/type/fake fixtures; E04 adds factual-time boundary fixtures. They add no real harness, SQLite service, or new production gate. Existing A3/A8 evidence is reused within its original limits.

## Per-ID results

Each row passed in R1 and R2; the links below point to R2 evidence.

| Blocking group | ID | Script | Result / exercised condition | Evidence |
|---|---|---|---|---|
| Identity | T-01-4 | identity.mjs | PASS: live harness, new MCP PID/CallerId/context, continuous owner and original outcome | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-01-4.json) |
| Identity | T-01-5 | identity.mjs | PASS: same harness PID/start switches session; old report/resume rejected; history retained | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-01-5.json) |
| Identity | T-01-27 | identity.mjs | PASS: cc→Codex synthetic source/header/config path, initialize/list and spoof rejection, fork only claimed, old claim rejected, two homes | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-01-27.json) |
| Identity | T-01-33 | identity.mjs | PASS: missing/native toolUseId rejected before context/idempotency; proven root accepted | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-01-33.json) |
| Execution | T-02-1 | execution.mjs | PASS: two MCP OS processes, positive lock contention, one intent/submission; divergent parameters rejected | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-02-1.json) |
| Execution | T-02-3 | execution.mjs | PASS: MCP restart after response and SIGKILL after submission/before reply both replay original outcome | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-02-3.json) |
| Execution | T-02-4 | execution.mjs | PASS: atomic rekey/read/crash, unchanged outcome/time/origin, restart/closed-alias replay, new proc generation isolated | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-02-4.json) |
| Execution | T-02-5 | execution.mjs | PASS: parameter/outcome/double-alias merge conflicts roll back, audit, and submit nothing | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-02-5.json) |
| Execution | T-02-6 | execution.mjs | PASS: eight intent cuts and seven terminal cuts preserve all-or-nothing state/event/slot/claim commits | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-02-6.json) |
| Execution | T-02-8 | execution.mjs | PASS: 0/30000/30001 ms reserved boundaries; two supervisors/one ticket; heartbeat alone, crash and late-fence rejection | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-02-8.json) |
| Execution | T-02-12 | execution.mjs | PASS: N versus log/nonzero-supervisor; command-before-writeback crash remains uncertain without resubmission | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-02-12.json) |
| Recovery | T-02-14 | execution.mjs | PASS: native 0/7, actual shell 0/137 with NULL native, N/Q, actual S/T/Z and escaped writers; D classification only synthetic | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-02-14.json) |
| Recovery | T-02-15 | execution.mjs | PASS: live-group signals hold slot; exit-before-cancel with delayed receipt import stays ended; unknown ordering ends/releases with cancel_timing_unknown and null cancelResult; positive before-exit/after-exit and incomplete-proof counterexamples retained | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-02-15.json) |
| Recovery | T-04-3 | recovery.mjs | PASS: actual shell/harness stamps differ; exec/direct argv preserve instance; sourced native versus separate shell result | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-04-3.json) |
| Recovery | T-04-5 | recovery.mjs | PASS: actual leader exit/S/T/Z and separate-session escapes; D classification only synthetic | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-04-5.json) |
| Recovery | T-04-19 | recovery.mjs | PASS: armed/submitting/after-spawn SIGKILL; actual paused launcher blocks N and can later submit | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-04-19.json) |
| Recovery | T-04-21 | recovery.mjs | PASS: reserved/armed N and zero late submissions; submitting/paused launcher never treated as N | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-04-21.json) |
| Recovery | T-04-24 | recovery.mjs | PASS: receiptless Q ended/cancelled, plus accepted unknown chronology ended with persistent note; each missing predicate keeps uncertain/slot | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-04-24.json) |
| Recovery | T-04-25 | recovery.mjs | PASS: separate recovery process sees live/unknown/empty; H/ticket/exit/submit denied; synthetic cross-boot refuses PGID scan | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-04-25.json) |
| Recovery | T-04-30 | recovery.mjs | PASS: saved accepted A8 context/status/TTY/scope/fault evidence checked with version/foreground boundaries | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-04-30.json) |
| Recovery | T-04-36 | recovery.mjs | PASS: new supervisor SIGKILL and parent-MCP exit distinguished; slot/interaction assertions plus saved TTY evidence | [JSON](../../tmp/tasks/A4b/run-6K1BmtzI/T-04-36.json) |

Signal cleanup evidence: [`signal-cleanup.log`](../../tmp/tasks/A4b/signal-cleanup.log).

## Limits and missing evidence

- Kernel **D-state is not live-induced**. The classification assertion is explicitly synthetic. Live S/T/Z and real separate-session processes are exercised.
- **No reboot is performed**. A labelled synthetic boot mismatch checks refusal before scanning the numeric PGID. This does not prove real cross-boot termination or launcher-death evidence. The orchestrator accepted these two missing live-evidence boundaries for A4b; no ARCH ruling is requested for them.
- T-04-30 and the TTY parts of T-04-36 inspect saved [A8 evidence](./hud-run-visible.md), accepted at `8fdf4cf`, under `tmp/tasks/A8/evidence/hud-run-visible/`. They do not rerun a real harness or terminal. Missing files fail those IDs. Accepted scope is Codex 0.166.0 / Claude 2.1.305 / pi 1.4.0 / Herdr 0.9.5 / Node 24.22.1 / WSL2 kernel 6.18.33.2 and the pane shell waiting for the foreground wrapper. The failed background-wrapper control is checked too. The saved sampled process state is S; the suspended-terminal-read observation comes from pane evidence, not a claim that `/proc` sampled T.
- Private synthetic source records stand in for the real harness's trusted current-call evidence. Neither this parser nor the IPC protocol verifies real Codex TOML/MCP or real Claude toolUseId integration. Source/claim/config feasibility is combined with A3 evidence, not generalized to future versions or shared MCP dispatch.
- Compact receipt observations and explicit actor-role guards exercise the predicates; the complete contract-04 fsync/rename/log protocol, production permissions, actual tool deadlines, high-frequency cost, arbitrary shell launchers, PID/PGID reuse control, all real-parent-MCP fault cases, and the B capability matrix remain production work. The helper is not an OS security boundary or a full production reconciler.
- The 200 ms writer hold and bounded `/proc` sampling are deliberate test instruments, not production scheduling or performance acceptance. The prototype is never imported by `src/`.

The earlier unknown-cancel default was superseded by Oracle consult 3 E02; the updated assertions and two complete runs above cover the revised candidate contracts. No other contract contradiction was found in these exercised cases. Unknown submitting results remain uncertain rather than inventing N or restarting; an already permitted paused launcher remains a blocker even after the DB fence. All production claims remain subject to B3/B4/B5/B14 verification.
