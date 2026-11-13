# Finite opt-in synthetic statusline observation

Run explicitly from a built checkout on Linux with Node 24+:

```sh
npm run build
node scripts/observe-statusline.mjs --synthetic
node scripts/observe-statusline.mjs --synthetic --samples 3
```

The default is **20 invocations per positive scenario**, maximum 100, strictly
integer. A run has five separate positive populations and three one-shot correctness
controls. Only `--synthetic`, optional `--samples N`, and standalone `--help` are
accepted. There is no live mode, arbitrary input file, stdin ingestion, source/home
argument, executable override, settings installation or continuous monitoring.

**Exit 0 means a completed, correct finite observation, not performance
qualification.** Advisory latency can visibly FAIL while the command exits 0.
Exit 1 means runtime, correctness, interruption, cleanup or report-write failure.
Exit 2 means invalid usage or a missing runtime/build prerequisite.

## Inputs and isolation

Fixture revision `statusline-observation-v1` uses the
[official main statusline JSON documentation](https://code.claude.com/docs/en/statusline),
accessed 2026-11-06, and the repository v1 committed-summary schema. The upstream
page is unversioned; neither its example version nor this report proves an installed
Claude client version. All labels, identities, ledger records and input are synthetic.

Every run creates a private owned directory under ignored `tmp/cloud-development`,
with new HOME, HUD_HOME and source directories. Children receive only explicit
HOME/HUD_HOME, optional synthetic CLAUDE_CONFIG_DIR, COLUMNS and LANG. They inherit
no provider credentials, NODE_OPTIONS or ambient configuration. The command runs
`process.execPath` with the actual absolute `bin/hud-statusline`, no shell, from that
owned directory. It does not execute a provider CLI, contact a provider, read real
settings/transcripts, or install/change a default. Existing
[preview/apply/restore](product-settings.md) is separate and is not invoked.

Five positive populations run serially:

1. `stdin-normal`: model, native context 42%, estimated cost $0.12; width 80.
2. `narrow`: the same facts at width 10; cost/context omitted and model shortened.
3. `missing-summary`: explicit synthetic source/parent and real temporary ledger,
   but no summary and no child links; first line only.
4. `fresh-summary`: synthetic v1 envelope, actual ledger identity, direct-child
   `partial` second line; stdin first line unchanged. Fresh fixture is regenerated
   immediately before each sample.
5. `expired-summary`: timestamps more than five seconds old; no invented child
   facts. This is a deliberately expired fixture, not production publication.

Single controls cover malformed JSON (expected exit 3, empty stdout, fixed
`invalid_statusline_input` diagnostic), sparse `{}`, and zero-valued facts with an
unknown field. Controls are not positive performance populations. Source/thread
mismatch, populated fallback and full security/freshness cases remain in existing
regression suites; this observer does not claim to replay all of them.

## Report and timing

Stdout contains one JSON v1 report, not rendered content. Redirect it to a private
file yourself if wanted. The tool stores no report/log file and no raw payload.
Fields include source HEAD and dirty/unknown state; Node and OS release/platform/
architecture (no hostname); source/fixture revision; limits; requested, attempted,
successfully completed, failed, censored, not-attempted and uncompleted counts per
scenario; and minimal attempt rows. Censored attempts are a subset of failed
attempts, not an additional failure count. All eight scenario records remain
present after a fixture/runtime failure, with completed attempt receipts retained
and fixed incomplete reasons; untouched scenarios are NOT_RUN.

The observer **does not rebuild or attest `dist`**: `buildStatus` explicitly says
`NOT_VERIFIED_BY_OBSERVER`. Build first against the reported source. A source SHA
alone does not identify stale or independently modified build output.

Timing starts immediately before each spawn and ends at direct-child `close`.
Each invocation is a new Node process; OS filesystem caches are uncontrolled, so
this is not a claim of a cold filesystem cache. There are no warm-up exclusions.
Quantiles use nearest rank (`ceil(p*n)-1`); small-n p99 can equal max. Only
validated successful observations with confirmed spawn, exit and close enter
quantiles and the completed count. Failed attempts, including wrong output,
timeouts and spawn errors, retain their individual durations and outcomes outside
successful latency statistics. Unclosed/censored attempts also retain elapsed time
but cannot claim spawn-through-close latency. Empty quantiles are null.

`advisoryP95AtMost150Ms` is PASS/FAIL only for a complete correct positive
population, otherwise NOT_RUN. It does not impose a new cloud CI gate. `status`
separately represents tooling/correctness. Expected malformed-input rejection is
a passing control, not an unexpected product failure.

For comparative timing, run three independent finite observations, preserve all
three outcomes and report each scenario's range, n, source/build and host. Do not
pool unlike scenarios, silently discard failures or retry until green.

## Deadlines and honest cleanup

The sampling deadline is 30 seconds. No new child starts after it; an active
sample receives the smaller of remaining time and the two-second sample deadline.
On timeout/output overflow/interruption, TERM is sent only to the owned direct
child while it has not exited; after 100 ms, KILL is attempted if it still has not
exited. Cleanup waits at most one second after the first stop. No process group or
unrelated process is signalled. Setup/OS operations and final report output are
outside the sampling interval; these deadlines are not hard real-time guarantees.

The receipt separates spawn, direct exit, close, exit code/signal, reason and
`cleanupUncertain`. A successful kill request or exit does not prove close or
arbitrary descendant cleanup. If a descendant holds pipes after direct exit, the
tool never signals the exited PID again: at the cleanup deadline it destroys only
owned handles, unreferences the child, marks uncertainty and stops all sampling.
It makes no general descendant-cleanup guarantee.

Each output stream is retained in memory only up to 16 KiB for correctness checks,
then discarded. Receipts retain byte counts and fixed reason codes, not input,
output, environment, account details or real paths. Interruption or uncertain
cleanup stops further samples. Fixtures are removed only after all spawned direct
children have confirmed close; uncertainty retains them and reports
`cleanup: retained_uncertain` without publishing their absolute path. Inspect the
owned `tmp/cloud-development/statusline-observation-*` directory locally before
cleanup. Report-write/EPIPE failure or a one-second write timeout produces a fixed
stderr diagnostic and nonzero exit, never success.

## Explicit non-claims

Historical ≥1000 samples per entry, internal reader ≤20 ms, live Claude, supported
WSL/Windows Terminal visuals, at least two weeks of observation, and default
readiness always remain NOT_RUN in this report. The 150 ms comparison does not
replace those gates. Neither a PASS here nor shipped settings tooling completes
D4/D5, enables D6, proves native subagent interface support, or changes any runtime
capability grant. See [feature coverage](feature-coverage.md).

## Focused verification

```sh
npm run build
npm run build:test
node --test tests/unit/statusline-observer.test.mjs
node --test dist-test/tests/unit/statusline-preview.test.js dist-test/tests/unit/statusline-settings.test.js dist-test/tests/unit/statusline-summary.test.js dist-test/tests/unit/delegation-summary.test.js
```

Tests narrowly skip ledger/product observations on unsupported Node/platforms,
and the /proc process-ownership case outside Linux. Portable parsing, statistics,
mocked lifecycle and report-writer tests still run; prerequisite refusals are tested.
Tests cover strict opt-in parsing, import/help inertness, actual product populations,
private environment/durable fixture integrity, nearest-rank/incomplete statistics,
malformed/wrong/oversized output, spawn failures, owned hanging and TERM-ignoring
children, exited-parent/held-pipe uncertainty, interruption and output-write failure.
Test-injected spawn/writer seams are exported JavaScript functions, not CLI options.
Only test-owned descendants are cleaned by the held-pipe test.
