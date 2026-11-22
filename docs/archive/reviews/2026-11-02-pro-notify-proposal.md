# ChatGPT Pro review: NOTIFY proposal (parent wake, bounded lifecycle, cache-aware scheduling), 2026-11-02

Reviewed pack: owner requirements, two research reports and proposal v1 (`tmp/tasks/NOTIFY/`, git-ignored). Owner decisions after this review: HUD-managed warming off by default; supervisor-death containment routed to Oracle consult 6 (Q10). Text below is the answer as received (math rendering flattened).

---

1. Rulings on the open questions in §8

Approve the architectural direction, with required revisions before Part D becomes an implementation baseline. The ledger, native wake adapters, bounded wait primitive, and shared termination machinery are sensible choices. The main weaknesses are the guarantees built around them: wake recovery is incomplete, retirement sometimes infers inactivity without evidence, and the cache policy claims more precision than its inputs support.

I reviewed the supplied pack and checked material claims against current public documentation. The underlying contracts, R-02 evidence rules, repository implementation, and local probe records are not included in full, so I cannot independently certify their implementation or exact compatibility. I accept the opening note’s P-N1 observation as local evidence for the tested interactive Claude TUI.

§8 question	Ruling and short justification	Alternative rejected
Q1. Retirement through the cancel ladder	Accept reuse of the existing ladder. Add an explicit policy cause, eligibility checks, and termination evidence. ended + retired_* is acceptable only if ended means that the supervised scope is proven terminated; it must preserve the task outcome and actual exit/signal evidence.	A second independent termination engine. Also reject classifying an exit as retirement merely because retire.accepted exists.
Q2. Count uncertain runs against capacity?	Yes. Their resources may still be alive. Release capacity when reconciliation establishes termination, rather than when certainty is lost. Show which uncertain runs occupy slots.	Excluding them, which allows repeated supervisor failures to produce unbounded replacement work.
Q3. Store wake registration in the ledger or a separate file?	In the ledger, transactionally with acceptance. Bind it to owner generation, harness session, process incarnation where applicable, and adapter capability. Socket and hint files are disposable transport artifacts.	A separate file becoming an independent authority for ownership or routing.
Q4. Codex queue-only MVP or daemon integration now?	Accept A/C: queue-only, preserve the wrapper’s identity path, and make embedded mode explicit. Require the mixed daemon/embedded probe and expose degraded delivery. Treat approximately ten seconds as a version-specific idle pickup expectation.	Requiring daemon attachment and steer now. That expands identity and lifecycle scope without being necessary for basic notification.
Q5. Keep the 120-second wait cap?	Keep 120 seconds as the portable default; allow a finite per-client override after timeout and cancellation tests. A longer event-responsive wait can be preferable when the parent intentionally remains active.	A universal hard-coded cap justified by caching, unbounded waits, and the proposed Codex sleep-based warming loop.
Q6. Cache advice in MCP responses or a static skill table?	Expose validated configuration and uncertainty through MCP, from an already loaded snapshot; keep the decision parent-side. Return unknown when context size, prices, or retention semantics are unavailable.	Duplicated static tables, and precise warmBreakEvenMs recommendations generated from missing inputs.
Q7. Record handoff lineage?	Yes, as provenance for an actual successor, with immutable content or hash verification. It grants no control over existing children.	File-only authoritative lineage, or treating a handoff reference as ownership transfer.
Q8. Product defaults?	Accept 6 global / 4 per owner and 10-minute / 2-minute post-report graces as initial configurable values, subject to the retirement eligibility rules below. Replace “60 minutes since last ledger event” with verified idle time. Give blocked sessions an explicit waiting deadline.	Treating ledger silence as inactivity, or retaining blocked sessions indefinitely while claiming bounded lifecycle.
Q9. Exclude Claude channels and --bg?	Confirm exclusion from MVP. The observed background-waiter path is sufficient to proceed. Keep headless children under hud-run’s actual control.	Making preview channels or Claude-managed background-session supervision prerequisites for this release.
2. Design errors, missing failure modes, and constraint contradictions
2.1 The commit-to-send crash window breaks the claimed wake guarantee

Part D §§3.2–3.5 permits this sequence:

The child’s report commits.
Its MCP process dies before touching the hint file or sending the native wake.
A Codex or pi parent remains idle.

For Claude, an already armed waiter can recover through its bounded ledger reread. For Codex/pi’s proposed plain idle plus native wake, no such reader necessarily remains active.

The ledger preserves the result, but does not cause anyone to look at it. Therefore, “lost wakes cost at most one bounded reread” is unsupported.

Required change: make wake delivery recoverable from the ledger. Use the authoritative event stream plus a durable delivery cursor, or a small pending-wake record committed with the event. An existing parent-side hud-mcp process can drain this work, using file hints for prompt discovery and a bounded reread for recovery. It can invoke the out-of-band adapters even though ordinary MCP notifications do not wake its client. This needs no additional resident daemon.

Specify the guarantee narrowly:

While the registered parent process and its delivery worker are alive, committed events are rediscovered within the configured recovery interval. Native scheduling and transport availability determine when a model turn actually begins. Otherwise, the events remain recoverable on explicit restart.

Also change the adapter result from simply sent | dropped to something like accepted, rejected, or outcome unknown. A queue command can commit its message and then time out before returning. That is an ambiguous result, not proof of a drop.

2.2 Cursor deduplication does not prevent duplicate model turns

§3.5 performs deduplication after the parent has already been invoked. A duplicate can therefore consume a model turn before the model discovers that there is nothing new.

The statement that it costs “one short tool call, not a turn” is misleading. Likewise, three event classes do not establish a maximum of three wakes: repeated blocked reports or uncertainty transitions can exceed it unless another contract explicitly forbids them.

Make these changes:

Coalesce pending hints before native delivery, by owner generation and event high-water mark.
Keep a durable observation cursor if deduplication across compaction or restart is promised.
Distinguish observed events from completed parent actions. The latter need normal idempotency keys or state preconditions.
Drain all pages up to a captured high-water sequence.
Remove afterSeq: seq−1 from the suggested wake command. It can skip earlier unconsumed events. Use the receiver’s own cursor.

The appropriate guarantee is duplicate-tolerant notification and idempotent handling. Exactly one model invocation per event is unnecessary and unsupported.

2.3 A replaced parent must invalidate its wake registration

§3.6 explicitly allows the sender to continue sending after /clear or another generation change. This is unsafe, particularly for pi: the process and socket can survive while the session owner changes.

Checking OwnerKey only after a new model turn starts is too late to prevent an unsolicited turn in the wrong session.

Bind registration to:

OwnerKey and generation;
harness session/thread identity;
verified process incarnation where relevant;
adapter version/capability;
validity and revocation state.

The pi receiver should reject a stale generation before calling triggerTurn. Revalidate or suspend registrations on session replacement. A persistent Codex queue entry can still be encountered on a later explicit resume, so the receiver must validate its ownership before acting.

Also remove the pi socket’s retire message from MVP. A notification endpoint should initially have only the authority to request a ledger read.

2.4 The waiter needs a complete race and cleanup contract

The shared waiter is a good primitive, but its sequence should explicitly be:

Read a short snapshot → subscribe → immediately read a fresh snapshot → wait for a hint or bounded deadline.

The immediate second read closes the registration race. Do not hold a SQLite read transaction open throughout the wait.

Define behavior for watcher failure, unspecified filenames, directory replacement, and missing hint files. Node documents platform and inode limitations for fs.watch; it cannot be the delivery authority. 
Node.js v26.13.0 Documentation

There are two additional omissions:

Hint cleanup: §4.5 requires hints/ to become empty, but no component owns deletion or handles a late sender recreating a terminal run’s hint.
Payload consistency: §3.4 promises a small hint without report material, but Claude receives a JSON event page. Introduce a compact background-notification output mode; retrieve full events through the ledger API. Do not assume stderr is delivered to the model in the required form without testing it.

For P-N1, invoke the command through Claude’s actual run_in_background: true mechanism. Appending shell & is not an equivalent test.

2.5 Wake coverage misses at least one stated intervention case

The lifecycle table includes interrupted reports, but D4 wakes only for completed | failed | blocked, terminal commits, and uncertainty.

Define whether interruption is normalized to blocked. Similarly, any delegated question or approval that requires parent attention must either produce an existing wake-worthy event or have its own explicit mapping. Otherwise a child can require intervention without waking its parent.

A native agent_completed notification or process exit remains evidence to ingest. Neither should silently become a successful delegation report.

2.6 Moving work after response flush does not establish the performance budget

Deferring a wake protects the current response only if the work is genuinely asynchronous and bounded. It can still block the event loop, contend on SQLite, accumulate subprocesses, or delay the next MCP call.

Required implementation rules:

No synchronous subprocess startup, filesystem scans, or artifact hashing on the non-wait response path.
Bound concurrent sends and buffered subprocess output.
On timeout, terminate and reap the owned adapter process; timing out a promise alone does not bound its lifecycle.
Keep transport work outside write transactions.
Remove the per-advice-call stat in §5.2, or stop claiming §5.4 performs no I/O.
Measure non-wait p95 during concurrent spawns, reports, reconciliation, and slow wake adapters.

SQLite WAL still permits only one writer at a time. An indexed count is useful, but cannot establish a 30 ms transaction budget without accounting for contention. 
sqlite.org

Finally, retaining schema version 1 is not automatically compatible merely because the DDL is unchanged. New event kinds, strict configuration keys, and terminal classifications require an explicit reader/writer compatibility rule.

3. Cache-aware scheduling

Keep configurable cache metadata and its provenance. Replace the automatic TTL estimator and the published warming horizons.

3.1 A safe assumption about Codex caching

I would reject the owner’s “Codex caches never expire” assumption.

The safe operating assumption is:

Session history persists independently of prompt caching. Cache reuse is an optimization. The workflow must remain correct if the next request is cold.

Current OpenAI API documentation describes finite, model-dependent retention. It does not establish an indefinite-retention promise or the effective policy of ChatGPT-authenticated Codex. 
OpenAI API

For that backend, my default would be:

纯文本
effective retention: unknown
evidence basis: unknown
HUD-managed paid warming: off

A five-minute estimate may be displayed as a conservative planning assumption, but it should not automatically authorize recurring model calls. If the real retention is much longer, the supposedly conservative estimate can cause unnecessary spending.

Keep these concepts separate:

Field	Meaning
Configured retention	What the user or harness requested
Documented semantics	What the relevant provider/model documentation promises
Observed reuse	What comparable historical requests actually achieved
Planning assumption	A fallback used when evidence is incomplete

A miss should not overwrite documented retention or promote an assumption to a measurement.

3.2 Passive hit/miss gaps do not identify TTL

The proposed rule, min(configured TTL, minMissGap × 0.9), is unsound.

For example, a sixty-minute cache can miss after two minutes because the prefix changed. The rule then turns that miss into an effective lifetime below two minutes and increases warming frequency. Five misses do not resolve the causal ambiguity.

The proposed observation method also needs to account for:

comparable cached prefixes and cache boundaries;
routing, eviction, eligibility, and partial hits;
request start timestamps rather than arbitrary assistant-message timestamps;
normalized token accounting across providers;
missing cache-write fields;
hidden request changes and auxiliary requests.

A useful passive report would show hit fractions and hit/miss/unknown counts by elapsed-time bucket, grouped by model, provider/auth, and comparable request configuration. It should not claim to have measured an expiry boundary.

P-N8 should therefore validate parsing and descriptive statistics. Requiring one week of data to reproduce a sixty-minute boundary is not a sound acceptance criterion: the necessary gaps may not occur, and misses may have other causes.

3.3 The scheduling algorithm omits cache age

Even with a known TTL, the first deadline is not “wait starts now plus TTL minus margin.”

For Claude, the documented lifetime starts at the beginning of the request that writes or reads the entry; generation time already consumes part of that lifetime. 
Claude Platform Docs

Where those semantics apply, calculate:

纯文本
next refresh deadline =
    last qualifying request start + effective TTL − safety margin

If the last qualifying use is unknown, the remaining warm window is unknown.

Validate configuration as well: null TTLs, TTL <= margin, invalid prices, or missing context size must disable arithmetic-based warming rather than produce zero/negative periods.

3.4 Use an incremental cost comparison

The proposal’s n = ceil(S / (T−m)) is ambiguous: it might include the eventual useful request or only extra warming requests. Make that distinction explicit.

Let:

𝑘
k: additional warm-only requests;
𝐶
keep
C
keep
	​

: actual cost per warm-only request;
𝐶
hit
C
hit
	​

, 
𝐶
miss
C
miss
	​

: reusable-prefix cost of the eventual useful request;
𝑞
idle
q
idle
	​

, 
𝑞
warm
q
warm
	​

: estimated hit probabilities under the two policies.

Warming is economically justified only when:

𝑘
𝐶
keep
<
(
𝑞
warm
−
𝑞
idle
)
(
𝐶
miss
−
𝐶
hit
)
.
kC
keep
	​

<(q
warm
	​

−q
idle
	​

)(C
miss
	​

−C
hit
	​

).

Under optimistic assumptions—certain cold continuation without warming, certain hit with warming, fixed prefix 
𝑃
P—this becomes:

𝑘
(
𝑟
𝑃
+
𝑐
)
<
(
𝑤
−
𝑟
)
𝑃
,
k(rP+c)<(w−r)P,

where 
𝑐
c includes properly priced new input, output, reasoning, and accumulated tool-message overhead.

This exposes several problems with §5.3:

o ≈ 200 output tokens cannot be added as though they cost the same as input tokens.
Warming can grow the context.
Thresholds are not independent of 
𝑃
P when overhead and a dollar cap are included.
contextTokens: null and a “30 tool calls” proxy cannot support a precise economic recommendation.
API-equivalent dollar costs are not an established subscription-quota conversion.
A skill-driven loop cannot honestly promise a hard dollar cap unless something measures and enforces it.

I would delete the worked 19-hour / 56-minute / 45-minute warming windows.

3.5 The Codex warming recipe conflicts with queue-only delivery

The loop in §5.3 keeps the parent in an active turn:

纯文本
sleep → read ledger → sleep → …

Under the queue behavior described in Part C, queued messages dispatch when the thread becomes idle. Returning from a tool call does not make a continuing model turn idle.

Consequently:

The queue cannot interrupt the sleep.
Repeated sleeps can postpone queue dispatch until the whole turn ends.
Completion is discovered by the periodic ledger reads instead.
Delayed queued hints can trigger additional turns afterward.

For queue-only Codex, end the turn and idle. When an active parent must wait responsively, use the event-responsive ledger wait. Do not describe a pending sleep or tool call as refreshing a provider cache.

Claude /loop also is not a guaranteed refresh deadline: scheduled prompts wait while the harness is busy. 
Claude Code Docs

3.6 Recommended MVP decision procedure
Unrelated work: start a new session with a clean brief. Do not carry unrelated task state.
Related work with outstanding children or approvals: preserve the owner session until those obligations are resolved, unless an explicit ownership-transfer protocol exists.
Short pause: use native wake or a bounded ledger wait. Accept whatever cache reuse occurs.
Long or unknown pause: write a handoff/checkpoint at a safe boundary. Starting a fresh session remains a context-quality and cost decision; cache expiry alone does not invalidate the old conversation.
HUD warming: off by default. Later opt-in support needs known prices, context size, retention semantics, finite duration/tick limits, and cancellation on completion or generation change.
pi: leave its existing native warming policy as the sole warming owner. Public pi documentation already describes eligible-model and estimated-savings checks; HUD should not add a second loop. 
Pi

The owner’s preference for a fresh session after a long pause is reasonable. The handoff must account for its own creation cost, successor rereads, and possible loss of useful detail. Keep the 60,000-token threshold, if desired, as a configurable advisory threshold rather than an automatic economic verdict.

4. Lifecycle, retirement, and concurrency
4.1 The cancel ladder is suitable; retirement eligibility is incomplete

A live supervisor reusing verified scope control is the right execution mechanism. The unsafe part is deciding when to use it.

“Time since the last ledger event” does not measure inactivity.

An agent can work for an hour without writing a delegation event. Conversely, heartbeat or administrative events can keep resetting that clock forever.

Before ordinary post-report or idle retirement, establish:

the report releases the current assignment;
no newer assignment or continuation supersedes it;
the relevant harness is quiescent, if claiming idle retirement;
pending human input is handled by an explicit policy;
the supervisor still owns the verified scope;
the frozen policy authorizes the applicable deadline.

Recheck eligibility immediately before signaling, against the current assignment/generation. A timer scheduled before new work arrives must not terminate that new work.

If quiescence cannot be observed reliably, disable idle-based retirement. A separately named, pre-authorized maximum runtime can still interrupt active work; its semantics are clear.

4.2 Preserve outcome, intent, and observed termination separately

retire.accepted records an intention. The process could fail naturally immediately afterward, before receiving any signal.

Keep separate:

Task outcome: completed, failed, blocked, or unknown.
Termination cause requested: user cancellation, retirement, runtime limit, orphan policy.
Observed result: exit code, terminating signal, forced escalation, scope-death evidence.
Attribution certainty: whether the requested action actually caused termination.

This permits “completed; retired after report” without concealing “failed; subsequently retired” or “runtime limit reached; task incomplete.”

The two proposed retired_* notes do not cover hard-runtime expiry and forced termination adequately. Extend the evidence/classification contract, while retaining one shared ladder.

4.3 hud-mcp does not currently have a working idle death detector

Checking ppid only during a call or at EOF cannot detect parent death if neither occurs. Inherited pipe writers can delay EOF, and Linux may reparent an orphan to a subreaper rather than PID 1. 
Linux manual page

Bind helpers to the verified harness incarnation, using a process handle/pidfd, correctly established parent-death mechanism, non-inheritable lifetime channel, or a small bounded lifecycle check inside the existing process.

A parent-death mechanism also needs its setup race handled; it is not automatically a guarantee for an entire descendant tree. 
Linux manual page

On shutdown, cancel outstanding waits. “Finish the in-flight call” must not allow a 120-second wait to override the two-second exit requirement.

Apply equivalent lifetime rules to background waiters and adapter subprocesses.

4.4 Supervisor death remains an unresolved bounded-lifecycle failure

The proposal deliberately leaves a child alive after supervisor death and waits for manual reconciliation. That preserves conservative control semantics, but it does not provide a hard bound on process lifetime.

For the stated bounded-lifecycle requirement, establish prearranged scope cleanup that survives supervisor failure, using suitable existing host/OS containment. Prove it covers the owned descendants. If the platform cannot provide that, declare the limitation explicitly rather than claiming unconditional bounded cleanup.

This is compatible with the ban on automatic input/resume: terminating an already-owned scope through prearranged containment does not type into a shell, reattach a session, or resume work.

Also distinguish this from notifying a still-live parent that a child became uncertain. Such a notification does not authorize intervention in the orphaned child.

4.5 Surface closure needs corrected ordering and stronger ownership

The sequence “hud-run exits → HostAdapter.closeSurface” lacks an executor after exit.

Use this order:

Establish scope termination.
Commit terminal evidence and recoverable wake work.
Request bounded, conditional closure of the owned surface.
Exit.

If closure can kill the caller, make it the final action after durable bookkeeping.

A matching shell PID alone is insufficient: the same shell may now be running unrelated foreground work. Check surface ownership, generation, and current occupancy. Close only the surface created for this run; closing an entire tab with unrelated splits is unacceptable.

If the host cannot provide sufficiently safe conditional closure, leave the pane visible. A stale pane is preferable to terminating unrelated work.

4.6 Recommended lifecycle defaults
Setting	Recommended initial default
Visible implementer after final release/report	10 minutes, provided no newer work and verified retirement eligibility
Visible reviewer after final release/report	2 minutes, with the same conditions
Idle retirement	60 minutes of verified inactivity; disabled when inactivity cannot be established
Blocked / awaiting parent	Separate 60-minute waiting deadline, configurable at spawn; preserve blocked as the task outcome
Maximum runtime	Explicit finite value for every delegated profile; 4 hours is a reasonable starting value, configurable for longer work
User-owned parent	No automatic retirement
Lost supervisory authority	No automatic input/resume; use only the established containment/recovery policy

Specify whether a maximum runtime starts the ladder or bounds its completion. Include termination grace in the advertised lifecycle bound.

4.7 The concurrency cap is in the correct place

Enforce capacity within atomic intent acceptance, with this order:

Resolve an already accepted idempotency key and validate its payload identity.
Replay that result even if capacity is now full.
For a new request, check capacity and reserve the starting run in the same transaction.
Release its slot only after scope termination is established.

A transient concurrency_limit rejection without a permanent rejection row is reasonable.

Further qualifications:

“Global” means global to this ledger/HUD_HOME.
A completed report does not free a still-running child’s slot.
Retained visible children occupy slots during their grace; show that clearly.
Nested delegation can exhaust all slots while parents wait for children they cannot spawn. Return a usable capacity failure and require replanning or inline work, rather than blind retries.
A run cap alone does not bound native subagents, shell subprocesses, waiters, or adapter helpers. Their lifecycle/resource bounds must also be explicit.
5. MVP cuts and mandatory additions
Cut or defer
Adaptive TTL inference and automatic changes based on minMissGap.
HUD-managed warming loops and precise break-even recommendations.
hud run wait --follow / Monitor integration.
The pi wake socket’s retirement command.
Automatic replacement of user-owned parent sessions.
Seamless handoff of active delegations without a proper transfer protocol.
Claims of exactly one sample per wake or at most three wakes per run.

Keep the fixed handoff template, basic cache configuration/provenance, shared waiter, and three native wake paths.

Must be included

Recoverable delivery and generation fencing. These complete the basic notification design.

Real death binding and bounded helper shutdown. These are necessary to meet the lifecycle requirement.

Truthful retirement evidence and activity-aware eligibility. Resource cleanup must not silently reinterpret ongoing work as idle.

A safe handoff boundary. For MVP, a handoff may describe outstanding children, but switching ownership should wait until those obligations are resolved. If continuation during live delegation is essential, explicit transfer/adoption becomes mandatory.

Reliable handoff artifacts. Write atomically, use collision-resistant names, retain the content for the successor, and verify its hash. A hash alone does not make a mutable or deleted file available. Stage artifact work outside the spawn hot path. Replace “synthetic examples only” in the operational template with “actual task state, excluding secrets and unnecessary transcript excerpts.”

Failure-focused acceptance tests, especially:

Crash after event commit, before wake.
Queue acceptance followed by sender timeout.
Lost watch events and the read/subscribe race.
Duplicate, reordered, and multi-page events.
/clear with the same pi process/socket.
hud-run SIGKILL during retirement and terminal import.
Parent death with inherited stdio.
Retirement racing with new work, cancellation, and natural failure.
Simultaneous requests for the last slot; replay while capacity is full.
Pane reuse before closure.
Non-wait MCP p95 while adapters are slow or failing.

The existing test that kills the parent while leaving hud-run alive does not test supervisor failure.

6. Factual claims requiring correction or qualification
Publicly checkable corrections
Claim in the pack	Assessment
Part D §5.1: OpenAI writes cost 1×, reads 0.1×, and extended retention applies only when requested.	Incorrect as a general current API statement, and inconsistent with Part C. GPT-5.6+ documents a default 30-minute minimum at 1.25× write cost and a 12-hour option at 2.5×. Some models have 0.05× reads. Earlier-model defaults can depend on organizational retention policy. This does not establish ChatGPT-authenticated Codex’s policy or quota conversion. 
OpenAI API

Part B/D: Claude cache reads universally cost 0.1×.	Incorrect across currently documented models. Examples include 0.025× for Fable/Mythos 5.1 and 0.05× for Opus/Sonnet 5.5. Use model-specific rates. 
Claude Platform Docs

Subscription authentication is sufficient to assign Claude a one-hour TTL.	Needs qualification. Public Claude Code documentation confirms one hour for the main conversation within included subscription usage; usage credits and other request buckets can use five minutes. A spawn-time auth label can become insufficient. 
Claude Code Docs

Adding an MCP server necessarily invalidates Claude’s cache.	Incorrect. With deferred tool search, Claude Code can preserve the cached prefix when servers connect or disconnect. The determining factor is the actual request-prefix change. 
Claude Code Docs

A killed Claude parent guarantees background-command cleanup after 1.5 seconds.	Unsupported. The changelog describes orderly exit after asking commands to stop. That does not establish behavior after SIGKILL or a crash. 
raw.githubusercontent.com

pi ctx.shutdown() provides prompt graceful retirement.	Needs qualification. It is deferred until idle in interactive/RPC modes and is a no-op in print mode. It cannot replace a bounded supervisor deadline. 
raw.githubusercontent.com

Custom Claude channels in -p/SDK are merely unknown.	Now publicly resolved for the development-channel path. Current documentation says the development flag is ignored there and the channel does not register. This supports the MVP exclusion. 
Claude Code Docs

Session cron expiry was unverified; scheduled warming can be treated as a precise timer.	Current documentation describes seven-day expiry and between-turn scheduling. A busy harness can delay execution. 
Claude Code Docs

pi model cache lifetimes establish backend retention.	Too strong. Public model documentation describes them as best-effort metadata. They support a scheduling estimate, not proof that a provider honored a guarantee. 
Pi

Also update P-N1’s label throughout Part D: its basic interactive wake behavior is locally observed according to the pack’s opening note. Keep the reliability, death, and version-regression probes.

Claims that should retain their narrower evidence status

The public Codex documentation confirms codex queue, and its changelog confirms the 0.166 addition of queue --resume. 
ChatGPT Learn
+1

However, public documentation alone does not establish all the pack’s exact deployment properties:

the ten-second SQLite watcher interval;
the precise 0.166 -c daemon-exclusion rules;
the installed wrapper and dangling socket state;
mixed daemon/embedded delivery behavior;
exact timeout constants and outgoing request fields;
_meta.sessionId matching the queue target in every supported caller mode;
signal behavior, transcript resumability, and pane ownership on the owner’s machine.

Those may be valid pinned-source or local findings. Preserve that distinction and test the integration. Do not silently turn them into cross-version guarantees.

Finally, narrow “no MCP server can start a turn” to ordinary MCP notifications provide no verified universal wake path. Claude channels and the proposed out-of-band adapters are explicit exceptions.

Concrete changes to Part D, ordered by importance
Replace fire-and-forget-only wake delivery with ledger-recoverable pending work, consumed by an existing live process. Document offline and degraded behavior.
Bind and revoke wake targets by owner generation and session incarnation. Reject stale pi hints before triggering a turn.
Replace ledger-silence retirement with verified eligibility, and distinguish idle, blocked-wait, and hard-runtime deadlines.
Fix parent/helper death detection and the supervisor-death containment gap. Add direct hud-run failure tests.
Preserve task outcome, termination intent, actual exit evidence, and certainty separately. Retirement intent alone cannot determine terminal classification.
Remove Codex’s in-turn warming loop from queue-only mode. Use idle queue delivery or an explicitly selected event-responsive wait.
Restrict MVP handoff to safe ownership boundaries. Eliminate automatic retirement of user-owned parents and implicit adoption of children.
Correct cursor handling and coalesce native wakes. Remove afterSeq: seq−1, unsupported duplicate-cost claims, and the unproved three-wake limit.
Correct surface-close ordering and require exclusive ownership. Leave a surface open when conditional closure cannot be established.
Make capacity acceptance replay-safe and atomic, with uncertain runs retained and nested-delegation exhaustion handled explicitly.
Reduce cache policy to configuration, provenance, and honest uncertainty. Remove minimum-miss TTL inference and automatic paid warming defaults.
Update the factual tables and acceptance plan, including model-specific cache economics, P-N1’s local status, real background invocation, crash windows, and concurrent p95 measurements.
