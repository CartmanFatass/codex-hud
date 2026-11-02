# Headless run supervision

`bin/hud-run` loads `dist/core/run/cli.js`. Build first. Linux with matching
procfs/PID namespaces and Node >=22.5 is required by the entry point. Visible
mode belongs to B3b. No dependencies were installed.

B2/B4 integration supplies `HUD_RUN_PORT_MODULE`, an absolute trusted module
exporting `createRunFactPort(hudHome): RunFactPort`. There is no default fake
ledger. `tests/run/file-port.mjs` is explicitly test-only and uses Linux `flock`
for crash-releasing interprocess locks; it is not a production store.

`start` reads one bounded private JSON object from stdin: `{input,ticket,
briefBase64?,env?,managedShellVerified?,parent?}`. The ticket never goes in
meta, events, logs or command-line options. Programmatic `HeadlessRunControl`
also accepts a trusted `identifyHarness` callback for shell profiles. A verified direct-exec argv
profile supplies the directly observed harness. B4 must gate that fallback on its
accepted profile/source proof; argv wrappers and shell profiles use the trusted
independent harness callback. A supplied callback takes precedence for either
launch kind, and command wait status is native only when the verified harness
and command leader are the same full ProcessStamp. Without it, launch remains scope-unknown and cannot receive
signals or an R/Q proof. Short-lived discovery can likewise remain unknown.
Codex profile construction can use `codexClaimArgs` for the four named TOML env
leaves; B4 owns source/profile validation and calls it on every new run.

The adapter must atomically authenticate the original typed initiator, compare
all frozen launch material against its committed intent, verify ticket hash,
slot holder, generation, cancellation/fence/conflict state, and commit consumed
ticket, armed claim, first heartbeat and the full `supervisor.registered` event.
The snapshot includes claim PID/start projections, which must match that event
and the run. It must never reconstruct historical boot/domain from procfs/meta.
`startup` commits immutable command/harness/scope facts; `raw`, `receipt`, phase
and heartbeat methods have no run-state or slot-release permission. Heartbeat
is one tuple CAS every five seconds, without event/evidence/meta writes.

`authorizeManager` and `acceptCancel` are trusted boundaries: adapters validate
UID ownership of private HUD_HOME/ledger paths and current permissions, record
UID/invocation ID/represented owner in actor audit, and reject model/admin flags.
The separate local cancel/reconcile boundary is **待 ARCH 裁决**, confirmed as
the orchestrator's default pending Oracle; the existing A4 local-resume-only
`authorizeControl` is unchanged.

`reconcile` is a reconciler transaction: validate evidence/provenance, compare
the opaque revision under the writer lock, reject stale observations or retry
from fresh facts, invoke A4 `reconcileRun`, and commit state, slot, claim, terminal
basis/conflicts and events atomically. The supplied fake demonstrates this CAS;
B2 must wire real ledger validation. Complete proofs/conflicts are retained for
incremental reconciliation. No recovery observer can consume tickets, submit,
update the old supervisor heartbeat, or write its private artifacts. `status`
only reads committed facts. `cancel` accepts intent and returns; a live supervisor
handles it through an in-process wake or the next heartbeat. No recovery replay
of partially acknowledged signal steps is permitted.

One detached Node helper leads the workload's PGID/session and accepts one IPC
submission. It sends deliverable signals via `kill(0, signal)` inside its own
still-live group, eliminating parent-side numeric-PGID reuse races. Parent probes
may use signal zero only. Helper replacement/death loses the original IPC channel;
control is refused, never downgraded to one PID. It blocks on its direct child,
seals on IPC loss, and exits with the child. Surviving members require on-demand
reconcile. This is one additional process/RSS allocation per active run.

A `/proc` enumeration is always partial evidence. Completion requires frozen
startup authority, correct boot/domain, original harness and every known launcher
terminated, a readable absence scan plus kernel group absence, and permanent
one-shot submission sealing. Z-only scopes conservatively remain unknown until
kernel group absence; live members/escaped original harness always block proof.
No periodic group scans occur. If group control or completeness cannot be proved,
retain the slot and diagnostic facts. PID/PGID reuse tests label the simulated
replacement explicitly. TTY parent/supervisor fault differences remain B3b.

Owned checks: `npm run build && npm run build:test`,
`node --test dist-test/tests/unit/run-*.test.js`, and
`node tests/run/idle.mjs 1 60000` (or `10 60000`). The idle script measures
supervisor/helper ticks, RSS and fake-store I/O separately in temporary homes,
then cancels owned runs and cleans up. The file fake rewrites its snapshot;
its I/O is not a production SQLite heartbeat budget claim.

Resource follow-up: the helper uses `RUN_NODE_FLAGS` (currently only
`--max-semi-space-size=1`). B4 must launch the supervisor as `process.execPath`
plus `RUN_NODE_FLAGS`, `bin/hud-run` and its arguments. The plain Node shebang is
unchanged and remains unoptimised for supervisor memory. It preserves inherited
environment names and exported functions without a shell bootstrap or `env -S`
requirement. The helper receives the flags as Node arguments.
They are never injected into harness argv or `NODE_OPTIONS`. No old-space cap,
JIT change, snapshot change or worker-pool change is imposed.

The Node helper remains intentional pending ARCH's resource choice. A
session-leading `/bin/sh` retains immutable in-group signaling but POSIX wait
status conflates normal exit 137 with SIGKILL. An exec launcher plus a small
blocking shell reader retains the direct Node wait, but the reader is then a
child of the workload: that parent can move it with `setpgid`, so a later
`kill(0)` targets the wrong group. Checking before signaling leaves that race.
Rejected-topology probes and before/after measurements are recorded in the B3a
Fix 1 report; exact native status and complete-scope evidence are unchanged.
