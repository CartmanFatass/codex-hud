# ChatGPT Pro ruling: observation tick budget (P-06-7) and visible-mode cancel (H06), 2026-11-02

Escalated by Oracle consult 6 (H03, H06). Pack: the consult 6 sections, B12D measurements, background. Binding (one review level: not re-sent to the Oracle). Answer as received.

---

Rulings
Decision	MVP ruling	Release consequence
A — Observation tick budget	Choose option 2: retain WAL + FULL, replace the per-sample <50 ms rule with p99 <50 ms and a hard acceptance maximum <200 ms, using the full tick and the measurement rules below.	WSL2/ext4 remains eligible. The supplied measurements do not pass B14, because they exclude parts of the production tick.
B — Visible cancellation	Choose option 1: ship visible mode with launch, observation, and manual stopping in the pane. Programmatic visible cancellation is explicitly unavailable in the MVP.	Replace the positive visible-cancel MVP gate with required refusal and reconciliation tests. For later work, investigate option 2—a bounded native helper—before a launch-topology redesign.

My implementation findings below are based on 
pack.md
. The referenced raw logs, source code, and SQLite-version report were not attached, so I treat their descriptions as reported evidence, not independently verified results.

A. Observation-store tick budget
Decision and reasons

Keep the durable publication semantics and change the latency contract. Do not exclude WSL2 as a class, and do not switch to synchronous=NORMAL.

The reported changed-publication paths each have 9/2,000 samples at or above 50 ms: 0.45%. That implies an empirical nearest-rank p99 below 50 ms for those particular store-pipeline populations. It does not establish the value of that percentile, its stability under production load, or the full-tick percentile.

This is sufficient evidence to reconsider an absolute 50 ms product requirement. It is not sufficient evidence to certify production performance.

I choose 200 ms as the exceptional full-tick acceptance ceiling. This is an explicit product allowance for an occasional slow durable refresh, not a bound inferred from the observed 92 ms maximum. A 100 ms ceiling would leave approximately 8 ms beyond the worst reported store-only sample for all omitted reading, merging, rendering, and scheduling work. That would be a legitimate stricter product choice, but I would not make it the MVP requirement for this observation interface.

The 50 ms target remains meaningful through a p99 requirement, short measurement windows, and separate treatment of changed-publication paths. A fast no-op population must not subsidize slow publications.

There is also a distinction the replacement contract must make explicit: a hard acceptance maximum is not a hard real-time execution guarantee. A synchronous storage operation can exceed the threshold before the application regains control. The contract can classify that as a failure; it cannot honestly promise that a JavaScript timer will interrupt the operation at 200 ms.

Exact replacement wording for P-06-7

I would replace the conflicting P-06-7/G11 latency provisions with the following:

P-06-7 — Incremental observation tick latency

For each declared production support profile, each incremental collection entry point, and each publication class (no-op, summary-only, and new-checkpoint), incremental observation ticks shall satisfy:

An empirical nearest-rank p99 strictly below 50 ms.
An observed maximum strictly below 200 ms.

Acceptance requires at least 10,000 consecutive eligible samples per declared population, collected across at least three fresh application starts. Each start shall contribute at least 1,000 samples. Evaluate both the complete population and every rolling window of 1,000 samples within each run. In each such window, no more than ten samples may be at or above 50 ms. Any sample at or above 200 ms fails that population.

A population is identified before measurement by support profile, entry point, and publication class. Different populations shall not be pooled to conceal failures. All samples and reruns shall be retained. Failed attempts, retries, and overruns shall be identified rather than discarded. An unfinished tick or aborted benchmark is not a passing sample or a basis for omitting the outstanding operation.

A tick begins at the existing incremental collect entry and ends after consistent durable publication and the associated data assembly, rendering, and paint enqueue. Elapsed monotonic wall time includes I/O and scheduling waits; reread, prefetch, signature, and recovery work; preparation and witness work; SQLite waiting and COMMIT; and checkpoint, open, or close work performed on that tick’s execution path. Idle time awaiting the next scheduled tick is excluded.

The existing reader soft allowance, shared continuation deadline, fairness requirements, tree and byte limits, legal-record handling, and freshness requirements remain applicable. The 50 ms target remains the cooperative work budget; it does not authorize unsafe interruption of an in-flight commit.

WAL + FULL remains mandatory. Checkpoint, recovery index, summary, continuity, notice/dedup state, and committed sequence identity shall be published consistently through the same fenced transaction. No new summary, advanced notice cursor, or reader acknowledgement may be exposed before successful durable commit.

A latency overrun shall not cause premature success acknowledgement, publication of partial state, early release of fencing protection, or unsafe retry of an unresolved commit. Report the overrun when execution can resume. A failed publication leaves the last complete committed projection available and does not satisfy required forward progress merely by returning it quickly.

Genuine startup, migration, cold catch-up, and shutdown phases shall be classified before measurement and reported separately. Any open, recovery, checkpoint, or close operation actually performed inside an incremental tick remains part of that tick. An ordinary slow incremental tick shall not be reclassified after the fact.

These thresholds are production acceptance and operational degradation thresholds, not an unconditional real-time guarantee under arbitrary host or storage stalls. F08 and all non-observation latency budgets remain unchanged.

The sample requirement is deliberately stronger than the old minimum of 1,000 ticks: the proposed contract is now about a tail distribution. Statistical coverage becomes part of the replacement for the former per-sample rule.

“Separate populations” does not require inventing a Cartesian product of irrelevant settings. Declare the actual supported combinations before testing; justify any equivalence used to avoid duplicate testing.

Startup must be resolved explicitly

The reported 292 ms first writable open exceeds the proposed 200 ms incremental ceiling.

It is acceptable to initialize the store before incremental collection, provided that this is the actual production lifecycle: the application is visibly initializing, and launch-to-first-consistent-paint is measured. If an incremental collection call opens the store and takes that cost, it fails. The benchmark cannot retain an already-open connection while production routinely opens inside the tick.

Likewise, a checkpoint deliberately postponed until later in the same publication path still counts. Genuine shutdown is separately measurable; periodically closing the store from an incremental tick is not.

What B14 must show
1. The actual production chain

B14 must exercise:

native reader → real lease/fencing behavior → merge/tree construction → preparation/witness → durable publication → render/paint enqueue.

Synthetic contents are acceptable. Replacing real scheduling or lease renewal with a fixed synthetic epoch is not sufficient for this gate.

Measure both declared entry points. Include the existing maximum-size, wide-tree, multi-consumer, recovery-continuation, and cold-catch-up cases. Preserve their existing correctness and fairness gates.

The contractual endpoint is paint enqueue, as the pack specifies. Do not describe that measurement as the time at which the terminal has necessarily displayed the frame.

2. A reproducible support profile

Record the exact production revision, harness/reader versions, Node version, actually linked SQLite version, effective connection settings, WSL/kernel version, filesystem and mount, relevant host/storage details, collection cadence, reader concurrency, and competing CPU/storage load.

“Shared batch load” is useful exploratory context but is not a reproducible production load definition.

Verify effective settings on the connections that actually write and checkpoint. SQLite’s autocheckpoint configuration is connection-associated, and registering a different WAL hook can replace the automatic mechanism. 
sqlite.org

3. Unedited latency evidence

For every declared population, provide:

Chronological raw samples and phase timings.
n, p50, p95, p99, maximum, and counts ≥50 ms and ≥200 ms.
Rolling-window results and the longest consecutive overrun sequence.
Failed/deferred publications, retries, and incomplete runs.
Startup-to-first-consistent-paint, cold catch-up, and dirty shutdown results.

Include ordinary mixed workloads as well as the separately evaluated publication classes. Retain the earlier fast run and the later slow run; do not choose a favorable rerun as the sole acceptance result.

Do not add component percentiles to estimate the full-tick percentile. Measure the full elapsed tick for each sample.

4. Durable recovery and acknowledgement behavior

Require the affected fault cases already identified by the oracle, including failures:

Before commit.
During publication/commit.
After successful commit but before the caller receives the result.
During lease ownership change and stale-writer rejection.
While concurrent readers obtain projections.

Recovery must expose a complete committed state. A lost response followed by retry must not create a second logical publication, duplicate an already acknowledged notice, or reuse an already acknowledged committed sequence identity. An unresolved commit must be reconciled before retry.

Keep the distinction between process-crash testing and power-loss durability. Killing the application does not test whether the entire storage stack honors flushes. SQLite’s durability assumptions ultimately depend on the underlying synchronization implementation. 
sqlite.org

5. WAL progress and resource evidence

Under the supported reader/concurrency profile, show repeated checkpoint progress and WAL reuse over a sustained run, including a run of at least 30 minutes. Include the existing pinned-reader negative case and recovery after that reader releases its snapshot.

The finite 1,200-publication test establishes observed behavior, not a universal WAL-size bound. SQLite’s checkpoint modes explicitly permit incomplete progress under concurrent readers; successful truncation has stronger conditions. 
sqlite.org

I am not authorizing a new flusher, queue, or hard-cap subsystem in this ruling. The supported reader contract must require short snapshots. If the application’s own supported concurrency can keep snapshots overlapping indefinitely and prevent reclamation, the resource gate remains unresolved; it cannot be excused as an external misuse case.

6. Independent control-plane acceptance

Run the existing F08 checks under the relevant concurrent observation load. Relaxing observation latency does not excuse MCP or hook latency failures caused by the same disk, process, or event loop.

The existing 150/50 ms and 30/10/20 ms provisions remain unchanged.

7. An honest qualification result

A pass qualifies the named platform/storage/concurrency profile, not every WSL2 installation.

A failing profile is performance-unqualified or degraded while retaining the same durability semantics. In operation, a maximum breach or failing completed window must remain visible in diagnostics; it must not trigger a silent switch to NORMAL or optimistic acknowledgements.

The supplied B12D results therefore justify proceeding to B14 under the revised contract. They do not themselves clear B14.

Rejected alternatives
Alternative	Ruling and reason
Keep every tick <50 ms and exclude WSL2	Reject for the MVP. It would exclude the actual target environment on limited evidence without establishing that another general-purpose platform provides the desired universal bound.
Use p95 <50 ms alone	Reject. It permits a substantially larger slow population than this case requires and can conceal bursts.
Switch to WAL + NORMAL	Reject. NORMAL changes system-failure durability and supplies no specified time-based loss window. A bounded-loss design would need an explicit durable watermark and recovery rules for sequence identities, consumer cursors, and notices.
Commit asynchronously and stop timing before completion	Reject as a budget fix. Execution placement may improve responsiveness, but durable publication latency still belongs to the end-to-end measurement.
Continue adding latency mechanisms until the old gate passes	Reject. The authorized bounded optimization is complete. This escalation calls for an explicit product contract decision.

Accepted risk: an exceptional durable refresh may take between 50 and 200 ms. Host/storage stalls can still exceed the acceptance ceiling, and finite testing cannot eliminate that possibility. Those are performance failures to record, while preserving correctness.

B. Visible-mode cancellation
Decision and reasons

Remove positive programmatic visible cancellation from the MVP. Keep visible launch, observation, and user-directed stopping in the pane.

The oracle is correct about the current numerical PGID path. A process stamp checked before kill(-pgid, …) does not bind the later syscall to the original group instance. JavaScript synchrony does not make the verification and kernel delivery atomic. Linux’s numerical group-signal interface targets the group identified at delivery time. 
Linux manual page
+1

The current safe refusal is therefore the correct implementation behavior. The required scope decision is to make it a supported, disclosed MVP limitation rather than leave a permanently blocked capability inside an otherwise claimed complete MVP.

This also changes the visible lifecycle promise. Visible mode cannot promise automatic termination on cancel, deadline expiry, parent disconnection, or supervisor death while its only approved actuator is unavailable.

Any workflow requiring enforced cancellation or unattended cleanup must use a separately qualified headless profile, or have its launch refused. Do not silently place it in visible mode.

Exact contract wording

I would adopt the following replacement for the relevant H06 provisions:

Visible-mode MVP capability

The MVP supports visible launch and observation with manual stopping by the user in the terminal pane. Programmatic cancellation of visible runs is unsupported in the MVP. This capability limitation shall be disclosed before launch and returned through capability inspection.

A valid cancellation request may durably record the caller’s intent. Its control result shall be cancel.unconfirmed with reason visible_scope_control_unavailable, explicitly recording that signal delivery was not attempted.

The unavailable-control path shall not send INT, TERM, or KILL; substitute a single-PID signal; inject terminal input; destroy the pane through the terminal host; schedule escalation timers; or retry the unavailable actuator. Duplicate requests shall remain idempotent.

Cancellation intent, actuator availability/delivery, observed liveness, and terminal outcome are distinct facts. Acceptance of cancellation intent shall not be reported as successful cancellation.

A freshly observed live run shall be presented as still running, with automatic cancellation unavailable and an instruction to stop it in its pane. If the internal cancelling state is retained, it shall not imply that an active cancellation procedure or escalation timer exists.

Completion, uncertainty, and resource release shall continue to follow the existing independent scope-evidence rules. Refusal alone does not imply uncertainty about a freshly observed live run. A subsequent end without adequate cancellation-timing evidence shall be recorded as ended + cancel_timing_unknown. Cancellation intent alone shall neither prove completion nor permanently reserve capacity after valid completion evidence arrives.

The visible profile does not guarantee automatic termination after cancellation, parent disconnection, deadline expiry, or supervisor failure. Workflows requiring those guarantees shall not be admitted to this profile.

Controller processes, descriptors, and monitoring resources retain their applicable bounded lifecycle requirements. Supervisor loss shall not trigger automatic input, resume, relaunch, or reacquisition of control authority.

The UI should say something equivalent to:

Still running — automatic cancellation is unavailable. Stop this run in its terminal pane.

An indefinite “Cancelling…” spinner would misrepresent the absence of an actuator.

Required contract and scope changes

Update all locations identified by H06:

Location	Required change
Contract 04, I-04-9/12 and cancellation/parent-disconnection sections	Keep the no-reuse safety requirement; define the visible manual-stop scope and its lifecycle limits.
Visible launch profile	Retain the current trusted foreground admission and TTY/context requirements. This decision does not authorize a topology rewrite.
T-04-22/23/30–33/36	Separate positive control tests from refusal, observation, and manual-end reconciliation.
Contract 05 capability matrix	Mark programmatic visible cancellation unsupported in MVP. Keep headless control as a separate capability.
B13 documentation	Disclose the limitation and document tested manual stopping actions for each declared harness.
B14	Mark positive visible cancellation out of scope for the revised MVP, not “passed.” Require the refusal and reconciliation gate below.
Probe documentation	Preserve historical results while marking numerical PGID delivery and single-PID fallback as non-authoritative prototype behavior.

Any broader claim of a “complete dual-mode MVP” must be qualified to reflect this capability difference.

MVP acceptance criteria
1. Capability disclosure and consistent results

Before launch, each declared visible profile advertises cancellation as unavailable. MCP responses, status/wait behavior, and HUD projections agree on the distinction between accepted intent and unavailable delivery.

A caller requiring enforced cancellation receives an admission failure for visible mode.

2. No actuation through the refusal path

Exercise ordinary, duplicate, concurrent, and delayed cancellation requests. Instrument the actual control boundaries to demonstrate that this path produces:

No INT/TERM/KILL delivery.
No single-PID fallback.
No terminal input or sendKeys.
No host pane destruction.
No escalation timers or delayed retry.

This is a production-path test, not merely a mocked return-value test.

3. Identity and stale-request safety

Test leader exit, surviving members, PID/PGID reuse, pane reuse, stale requests, and failed preflight. None may turn a previously accepted intent into authority over a different run or unrelated process.

4. Manual stopping and independent reconciliation

For each declared real harness/launch profile, demonstrate a documented manual stopping route and reconcile the resulting evidence.

Test normal quit, interruption where applicable, and pane close as distinct cases. If an action leaves surviving processes or insufficient evidence, show that honestly rather than treating the user action as proof of whole-scope termination.

After adequate end evidence arrives, release the appropriate resources and capacity. A prior cancellation request must not leave the run permanently occupying a slot.

5. Failure behavior and bounded controller resources

Exercise parent disconnection and supervisor death. Verify truthful stale/uncertain reporting, the applicable controller-resource bounds, and the absence of automatic input, resume, or relaunch.

A live visible harness may require subsequent user intervention. That consequence must be part of the capability contract.

6. Preserve visible behavior and headless guarantees

Retain real TTY operation, shell context/environment/cwd behavior, private startup FD handling, independent shell wait, and the current trusted direct-foreground launch profile.

Headless positive cancellation, escalation, and completion evidence remain separate required gates. Passing visible refusal tests provides no evidence for them.

Later work: prefer a small native helper, with a bounded proof obligation

I would authorize one later B3b-C investigation of option 2, without making it an MVP dependency.

There is a relevant capability missing from the pack’s discussion: Linux has supported PIDFD_SIGNAL_PROCESS_GROUP in pidfd_send_signal() since Linux 6.9, for a pidfd referring to a process-group leader. The reported 6.18 kernel is nominally new enough. Actual runtime support and correct acquisition still need verification. 
Linux manual page

The current upstream implementation routes that scope through the descriptor’s kernel PID object to group signalling. This is a substantive reason to investigate it before redesigning terminal ownership; it is not evidence that the current wrapper already implements a safe solution. 
Git at Google

B3b-C must establish all of the following:

Safe initial acquisition. Bind the descriptor to the original admitted leader through an authenticated launch protocol. Opening a pidfd from a stale numerical PID can bind the wrong process before any later safety benefit applies. Linux documents specific conditions under which post-fork acquisition remains safe; those conditions must be established, not assumed. 
Linux manual page
Retained authority. Use the retained descriptor for every signal and escalation. Never reopen a numerical target as a fallback.
Correct group lifetime behavior. Test leader exit and reaping while members survive; group emptying; numerical reuse; leader movement; forks; and members leaving through setpgid or setsid.
An explicit scope definition. A stable process-group reference does not automatically represent every descendant forever. Define how escaped descendants affect completion and the control claim.
Failure handling. Test helper crash, IPC EOF, supervisor death, unsupported flags, permission failures, and descriptor closure/reuse. Fail closed.
Bounded integration. No resident daemon; bounded per-run helper processes, descriptors, and IPC; no terminal-input fallback.
Positive production evidence. Demonstrate actual declared-harness cancellation and escalation while preserving TTY/context behavior and independent completion checks.

If that route cannot satisfy the required scope, evaluate option 3 as a separate topology change. I would not approve both expansions in advance.

Rejected alternatives and risks
Alternative	MVP ruling
Add a native helper immediately	Defer. The kernel facility is promising, but acquisition, lifetime, packaging, and failure behavior are not yet demonstrated.
Add an immovable leader inside the pane	Defer behind the helper investigation. It changes foreground/job-control behavior, signal handling, shell context, and exit reporting.
Use Herdr/tmux pane termination as cancel	Reject as an equivalent substitute. The pack provides no proof of a stable run-instance handle or complete containment. Pane destruction is a different operation with potentially broader effects and incomplete descendant coverage.
Add one more procfs check before numerical signalling	Reject. It narrows a race without removing it.
Inject Ctrl-C automatically	Reject. It bypasses the chosen control boundary and does not establish whole-scope termination.

Accepted risk: visible runs require user intervention and may continue consuming resources after a rejected cancellation request. The capability must be explicit enough that an unattended scheduler never mistakes visible mode for an enforceably cancellable execution profile.

Factual corrections and qualifications

The pack is generally careful. I would flag the following, distinguishing actual overstatement from missing context.

1. DELETE + FULL was not an unconditional durability baseline

Any implication that the old DELETE + FULL configuration was universally power-loss durable is too strong. SQLite documents that rollback-journal FULL may lose the last transaction on some filesystems; EXTRA adds directory synchronization after journal deletion. WAL + FULL is the documented durable combination. 
sqlite.org

2. NORMAL’s failure model should remain precisely stated

The pack correctly refers to system failure. WAL + NORMAL preserves atomicity/consistency and transactions survive ordinary application crashes, but recent commits can be lost after a system crash or power loss. Consequently, process SIGKILL tests alone do not distinguish the power-loss durability guarantees of FULL and NORMAL. 
sqlite.org

3. The linked SQLite version is now a material acceptance prerequisite

SQLite documents a WAL-reset corruption race, fixed in 3.51.3, with backports in 3.44.6 and 3.50.7, involving concurrent write/checkpoint activity across connections.

The pack references sqlite-version.log without supplying it. B14 must identify the actual linked version or equivalent fix evidence. This is a missing production prerequisite, not evidence that the project is currently using an affected build. 
sqlite.org

4. The current visible implementation lacks a proven mechanism; Linux does not lack one categorically

The oracle’s implementation-specific conclusion is sound. A broader statement that pidfds only support individual-process signalling would now be false because of the process-group flag described above.

Also, PID = PGID = tpgid is an admission snapshot, not lifetime control authority. “Process-group leader” alone does not mean “immovable”; Linux specifically prohibits changing a session leader’s PGID, while permitting other group changes under defined conditions. 
Linux manual page

5. Manual actions and signal acknowledgements are not completion evidence

Ctrl-C’s signal behavior depends on terminal settings; raw-mode applications may receive it as input. A successful group signal does not prove all members exited. Keep manual action, signal delivery, and scope completion separate. 
Linux manual page
+1

Likewise, no acknowledgement does not universally prove no signal was sent. A future helper could deliver and then die before replying. The current refusal can truthfully say “not attempted”; a lost acknowledgement after a possible attempt requires uncertain-delivery semantics.

6. The performance evidence supports narrower conclusions than a platform verdict

The pack correctly says COMMIT dominated the earlier slow samples and that individual fsync calls were not traced. Preserve that qualification. The observations identify a likely storage/publication bottleneck; they do not prove every tail was an fsync stall or that WSL2 as a whole is unsuitable.

Finally, the quoted T-06-16 row ends in truncated/garbled text. The actual acceptance document must be updated from its complete source; the missing clause cannot be treated as reviewed.
