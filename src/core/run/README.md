# Run supervision

`bin/hud-run` loads `dist/core/run/cli.js`. Build first. Linux with matching
procfs/PID namespaces and Node 22.x >=22.13 or >=24 is required (23 unsupported).
The bar's Node floor is unchanged. Both headless and the visible wrapper path use
the existing ticket, artifacts, heartbeat and reconciler interfaces.

The CLI uses the real private ledger in `HUD_HOME`. `HUD_RUN_PORT_MODULE` is an
explicit trusted integration/test adapter. `tests/run/file-port.mjs` is test-only;
its rewritten JSON I/O is not a SQLite heartbeat budget measurement. Registration
consumes the original execution ticket once. No helper gets separate execution
authority. Recovery observes the original run without replaying launches/signals.

`start` reads one bounded protected JSON object from stdin:
`{input,ticket,briefBase64?,env?,managedShellVerified?,parent?}`. The ticket is
absent from argv, metadata and logs. Trusted composition supplies
`identifyHarness`; command leader and actual harness are independent full stamps.
Verified direct-exec profiles identify their direct command as harness. Short or
ambiguous discovery remains scope-unknown, with no scope signal or R/Q proof.
Start cwd is the frozen accepted cwd; logs retain raw bytes.

The default headless controller is one detached `/bin/sh` session/group leader.
The supervisor verifies its PID/start/boot/domain, PGID and SID before RUN and
every control request. The leader owns the session and cannot be moved to a decoy
group. Only it delivers group signals, using builtin `kill -s INT|TERM|KILL 0`.
The parent never sends a deliverable signal to a numeric PGID; signal zero remains
an absence query. The cancellation ladder is INT, accepted grace (default 10 s),
TERM, 2 s, KILL. Lost control reports unconfirmed. Escaped original harnesses block
terminal proof. Ordinary outside-scope tool children do not expand the fixed scope.

`group-leader.ts` is fixed code with no eval or prompt/argv/environment splicing.
The leader consumes exactly one RUN on original descriptor 3; EOF before RUN exits
without dispatch. Workload stdin is saved from descriptor 0 to 5 before async
fork, avoiding the POSIX background-job `/dev/null` rule. Two in-group shells merge
control and completion into descriptor 6:

- The forwarder reads only original descriptor 3. It writes bounded CONTROL
  frames to 7; EOF writes SEAL and exits. Input cannot impersonate DONE or SEAL.
- The waiter launches the original command once, writes STARTED, closes reply 4,
  waits/retries interrupted waits, and writes DONE with encoded shell status to 7.
- The leader alone parses control and signals. A second RUN, invalid vocabulary,
  extra fields and commands after SEAL are refused. DONE prompts WAIT on 4. The
  supervisor then closes original 3, and the leader waits/reaps both auxiliaries.

The workload closes 3/4/5/6/7; the leader closes its own 3/5/7 after forking. The
forwarder and waiter catch TERM and survive group INT while the workload inherits
normal dispositions. There is no CHLD/read trap dependence, new idle timer or
polling. This protocol was tested on real dash, Bash with argv0 `/bin/sh`, and
`bash --posix`. The previous single-shell CHLD design was rejected: Bash defers
CHLD while reading; even dash needs protection against check/read event races.
Neither a host refusal for Bash nor a new dash interpreter dependency was chosen.

`group-pipe.ts` uses the absolute system `/usr/bin/mkfifo` from coreutils. In an
owned 0700 directory under `/tmp`, it creates a 0600 FIFO, opens blocking read/write
ends through a temporary RDWR holder (Linux), verifies inode/type/ownership and
passes only descriptors 6/7 to the leader. Immediately after spawn it closes the
parent copies, unlinks the FIFO and removes that exact directory. No reopen path
survives. Failure is explicit, including `headless_control_pipe_unavailable` for
utility failure. There is no Node fallback or extra service.

EOF after RUN permanently seals original control while the existing command
continues. Leader death with live members is unknown. Forwarder-only death loses
commands: cancellation is unconfirmed, but a normal waiter DONE can still finish
and reap the scope. Waiter-only death provides no result: the surviving leader
and forwarder remain controllable, with the scope held until explicit cancellation
or channel closure. It is not automatically completed or claimed reaped. All
three shells are counted separately from the supervisor in resource evidence.

A /proc enumeration is partial evidence. R/Q also requires original harness and
all launchers terminated/sealed plus kernel group absence. Helpers cannot be
excluded from an active scope to fabricate completion. Z-only scopes remain
conservative until absence; no periodic group enumeration was added.

Environment restoration requires absolute system `/usr/bin/env` (GNU coreutils),
with `-i`, `-S`, `--default-signal=INT,QUIT`. Cold preflight checks real expansion
semantics and fails `headless_env_features_unavailable` without fallback. Original
names/values travel only through generated HUD_ENV_n environ chunks. The env -S
argument contains generated references only. GNU env expands each reference once,
without recursively interpreting, escape-processing or splitting its contents.
Adjacent references reconstruct long entries. `-i --` clears transport fields and
ends option parsing before assignments, including original names beginning '-'.
Original HUD_ENV_0 is restored without collision. Exported Bash functions, dotted
names, PWD and NODE_OPTIONS arrive unchanged, with no original environment data in
any exec argv. User data cannot affect helper shell startup variables.

Before confirming command startup, finitely scheduled per-PID probes verify the
kernel original-environ transition, reject exact helper/env bootstrap and empty
command lines, require a stable command line across the read and a matching live
stamp before/after. Linux PF_FORKNOEXEC/PF_EXITING states exclude transient forks
and exiting empty-environ images. Fork alone/failed exec never fixes a harness.
There is no idle probe. GNU env restores INT/QUIT ignored by async jobs; caught
TERM/PIPE dispositions reset across exec. Real direct-spawn disposition comparisons
and exec-stop argv/environ audits pass under all three tested shell forms.

Oversized entries/reference programs or kernel E2BIG explicitly refuse with
`headless_environment_too_large`; data is never truncated. The existing Node string
API retains its UTF-8 conversion; no raw non-UTF-8 argv interface was added.

**待 ARCH 裁决:** argv[0] containing '=' is provisionally refused as
`headless_executable_assignment_unsupported` before registration, dispatch or
spending a ticket. GNU env otherwise treats that executable as an assignment.
This deviates from the generic argv contract. ARCH options are explicit refusal,
Node only for this case, or coreutils supporting `--argv0`. No production fallback
or unapproved dependency/version requirement was selected.

Shared `GroupExit` distinguishes verified_wait/native_unknown. The default returns
native_unknown with null code/signal. `GroupProcess.shellDiagnostic` records only
`posix_shell_wait`, actual independently stamped waiter, command subject and
encoded status. It never becomes harness exit_code or another shell's
ExitObservation. Complete scope end can have both native_exit/shell_exit null,
reason scope_ended. Exit137/SIGKILL may both diagnose137 without being conflated.

`launchNodeGroup`/`group-helper.ts` are compatibility code retained through this
package's acceptance, then due for removal; no user backend switch exists. The
trusted constructor launcher seam keeps exact native tests. Only verified_wait
whose subject fully matches the independently verified harness projects native_exit.
A verified wait for an actual managed shell can separately project shell_exit.
Exact 0/3/137 and SIGKILL/SIGTERM, actual shell137 and mismatch-refusal assertions
remain. `launchShellGroup` is the trusted test seam for real Bash variants.

B45 launches `process.execPath`, `RUN_NODE_FLAGS`, `bin/hud-run` and arguments. The
original environment-preserving Node shebang remains unflagged. Flags never enter
harness argv/NODE_OPTIONS. The leader/auxiliaries are shell processes with no HUD
V8 flags. B14 still owns formal B45/MCP H/R profiles, real ledger/WAL, >=60 heartbeat
boundaries and capability/version/performance acceptance. File-fake idle results
and this implementation do not promote capabilities.


## Visible wrapper (revised 甲)

The pane's interactive shell must launch hud-run as its foreground job and wait
for it. The supervisor never reads the terminal. Visible launch uses
`hud-run start --launch-fd 3`, with a private pipe/socket or owned 0600 regular
file inherited on descriptor 3. The bounded JSON is the same protected start
object, with `input.mode="visible"`, `input.stdin="tty"`, and the trusted addition
`visible: {expectedExecutable: "/absolute/resolved/harness-binary"}`. Descriptor 0
stays the terminal; descriptors below 3, terminal descriptors, foreign or public
launch descriptors are refused. The ticket is never put in argv or environment.
`start` on a terminal without this descriptor refuses without reading stdin.

For example, the host's foreground shell can execute
`/absolute/node /absolute/bin/hud-run start --launch-fd 3 3< /private/launch.json`.
The host owns creation and removal of that private launch channel. There is no
new public command for preparing tickets. The optional profile fields are
`strategy: "wrapper"`, `capture: "tty_passthrough"`, `dispatch: "fresh"`, and an
absolute `shellPath` for argv profiles. Sidecar, PTY capture and unknown dispatch
requests return unsupported before registration, without fallback or a second
start. A failed discovery does not give a new ticket.

Shell launch still requires `managedShellVerified: true`, meaning the trusted
profile has verified one foreground workload and no delayed/background/repeated
submission. It runs the explicit absolute shell with `-ic` and the original text.
Functions and context wrappers remain shell functions. An argv profile runs
`$SHELL -ic '"$@"' hud-visible <argv...>` (or its explicit `visible.shellPath`),
passing arguments as positional parameters rather than interpolating shell text.
No arbitrary shell program is inferred to be a verified managed profile.

Before registration, procfs and `isatty(0)` must show hud-run leading the
terminal's foreground group (PID = PGID = foreground PGID). Membership alone
does not prove foreground-job provenance. Noninteractive wrappers that put
hud-run in the background while retaining `/dev/tty` and surviving briefly are
refused, as are foreground wrappers that keep their own group leader. Only the
documented direct foreground job is admitted; there is no inferred wrapper proof.
Background `hud-run &` and `sh -c '<hud-run> &'` are refused.
The interactive child shell inherits the terminal and creates the foreground
harness job. Discovery requires a live unique foreground group leader with the
trusted expected `/proc/<pid>/exe`, matching TTY/SID, ancestry reaching the full
command-shell stamp, and a rechecked start/boot/PID-domain stamp. It excludes the
supervisor's group. Shared-group/direct-exec or nonleader profiles remain unknown;
there is no single-PID control fallback. The profile must name the actual binary
(interpreter for a script); process names, first matches and a shell status are
never harness identity. `identifyHarness` remains the headless composition seam;
visible uses the separate foreground/executable proof described here.

Discovery reads the terminal foreground PGID directly, without enumerating global
procfs or choosing among process names. Startup has at most three observations,
five seconds apart, with child
exit waking it immediately. It ends after ten seconds even if no candidate exists.
After discovery there is no group polling or scope watcher. The existing five
second heartbeat remains the only idle timer. A shell exit triggers the scope
proof; a surviving member prevents R. Without further member events the original
writer records its last facts and exits, leaving explicit reconciliation to prove
Q later. Z-only groups remain conservative under the existing shared proof:
`proveGroupGone` is unchanged and requires kernel group absence. The startup
observation cannot release the slot as Q ahead of the original writer's R.

Metadata/receipt record wrapper mode, independent command shell and harness stamps,
the fixed PGID/SID/leader scope, and `tty_passthrough` capture. Empty log files do
not mean the harness produced no output. The original shell's real Node child
wait result supplies `shell_exit`; `GroupExit` remains `native_unknown`, so the
harness's `native_exit` is null and a complete normal receipt says `scope_ended`.
Shell 137 is never turned into a harness SIGKILL result. Cancellation classification
still belongs to the existing R-02 reconciler and accepted chronology.

Visible cancellation accepts and preserves the existing authenticated intent but
currently refuses delivery, recording `cancel.unconfirmed` and an unacknowledged
INT step. Even a matching live group has no approved stable delivery capability.
No INT, TERM or KILL reaches a numeric PGID or single PID through this path; no
graces/escalation timer starts after refusal. Duplicate requests retain the
original intent and do not repeat the attempted step. The run continues to hold
its slot until independent scope R/Q is available. A later normal end with no
proven cancellation chronology remains ended, with cancel_timing_unknown.
Supervisor-directed INT/TERM/HUP accepts cancellation through the same local
entry and likewise refuses forwarding. TTY Ctrl-C and terminal-generated HUP
remain operating-system signals to the foreground group.

**待 ARCH 裁决:** procfs verify followed by group kill has an unbounded kernel
scheduling/reuse window; synchronous JavaScript does not make delivery atomic.
Until ARCH approves a stable delivery mechanism/topology, visible group control
is unavailable rather than enabled with this weaker guarantee. No native helper
or new dependency is authorised in this task. A future approved mechanism must
cover the whole fixed scope, refuse reuse, and pass the TTY/context/fault matrix
plus INT → 10 seconds → TERM → 2 seconds → KILL tests. The existing headless
immutable in-group sender and cancellation ladder remain unchanged.

`visibleHostContext(env)` exports HERDR_* values and workspace/tab/pane IDs for a
HostAdapter to consume. It performs no surface, readiness, input or focus actions;
all environment values are passed through to the user's shell. The supervisor
never creates or operates Herdr surfaces. Parent physical-instance loss uses the
existing `parent.offline` fact and frozen continue/stop policy. With continue the
harness remains foreground and interactive. Supervisor death stops heartbeats;
reconcile returns uncertain, holds the slot and exposes no interaction. There is
no automatic input, focus, fg, wrapper reconstruction, takeover or resume. The
existing independent Q proof can finish the run without an exit receipt and does
not rewrite the dead writer's files.

**待 ARCH 裁决:** the existing ledger raw whitelist has no carrier for the
supervisor's own directed signal/HUP observation. New ledger kinds are outside
this task's authority. The handler accepts cancellation but does not pretend this
is `command.exited`, mutate stable metadata or add receipt fields. Persisting that
partial fact would require an explicitly approved supervisor-signal raw kind (or
a future versioned artifact field). Host context remains exported in-process data.

Terminal validation uses only private tmux sockets and mkdtemp TMUX_TMPDIR/HUD_HOME,
with synthetic terminal consumers and a fake HostAdapter. Run
`node --test tests/run/visible-terminal.mjs` after both builds. The suite also
includes real SQLite R/Q tests. Set `HUD_VISIBLE_IDLE=1` and select the test name
`real SQLite R=1 idle` for the 60-second idle sample. Every terminal test kills its
private server, verifies its original process stamps disappeared, and removes its
exact temporary root. `HUD_VISIBLE_AUDIT=/absolute/path` optionally records those
owned roots/sockets/stamps and completed cleanup for an external audit.
