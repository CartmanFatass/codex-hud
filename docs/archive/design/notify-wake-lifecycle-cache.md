# Design: native parent wake, bounded lifecycle, cache-aware scheduling (NOTIFY v2)

Status 2026-11-02: proposal v2 by a Fable max designer after the ChatGPT Pro review ([../reviews/2026-11-02-pro-notify-proposal.md](../reviews/2026-11-02-pro-notify-proposal.md)). Owner decisions: HUD-managed warming off by default; defaults of §4.3 / §4.9 accepted (6 / 4 slots; 10 min / 2 min after report; 60 min verified idle; 60 min blocked-wait; 4 h max runtime; `wake.recoveryMs` 30 s); after-report retirement proceeds after the grace when pending input is unobservable (recorded as `pendingInput: unobservable`); `hud cache report` deferred to v1.1; the Codex stale-queue residual (§3.3) accepted as documented behaviour; `waitCapMs` override not in MVP; the surface-close executor is chosen by the implementing work package with tests. Decided on the Pro review alone (owner rule: one review level per decision, no Oracle re-check): supervisor-death cleanup uses prearranged containment set up at run start where it can be proven to cover the owned scope (never TTY input or resume), otherwise the platform limitation is declared explicitly (§4.7); the wake-recovery drainer and the 30 s parent-liveness check are accepted as budgeted exceptions to P-06-3 (amendment A6, §9 items 1–2); the compatibility rule for new event kinds / notes is v2 D15 (unknown kinds opaque to state derivation, readers never fail on them, export 07 tables extended in the same change).

---

# NOTIFY proposal v2: native parent wake, bounded lifecycle, cache-aware scheduling

Author: Fable max design subagent, 2026-11-02. Status: v2 after the ChatGPT Pro review (`pro/answer.md`, verdict: approve the direction with required revisions) and two binding owner decisions (HUD-managed warming off; supervisor-death containment routed to Oracle Q10). v1 (`proposal.md`) is unchanged. Inputs as v1 plus the Pro review, ORACLE6 Q10, contracts 01–07 (terms re-read), `src/core/run/control.ts`, `src/core/interfaces/host-adapter.ts`, `bin/codex-with-herdr-context`, pi 1.5.0 docs, the Claude Code CHANGELOG, the OpenAI prompt-caching guide, Node `fs.watch` caveats and `PR_SET_PDEATHSIG(2const)` (all read 2026-11-02). code.claude.com still refuses connections from this host, so Claude Code doc facts are marked **V-excerpt** (official page text via search excerpt). All examples are synthetic.

Evidence marks: V-doc / V-src / V-changelog / V-binary / V-local / V-excerpt as above; **U** = unverified, listed as a probe in §7.3; **P-N1 observed** = the orchestrator's own interactive Claude Code TUI started a new turn when an idle session's `run_in_background` command exited (pack note); reliability, death and version-regression remain probes.

## 1. Summary of decisions

| # | Decision | Why (short) |
|---|---|---|
| D1 | **The ledger is the only truth; a wake is a hint; delivery is duplicate-tolerant, never exactly-once.** No "one sample per wake" and no "≤ 3 wakes per run" claims. The parent always re-reads with its own cursor (`delegate_wait{runId, afterSeq: <own cursor>}`), drains until `hasMore=false`, and only parent *actions* carry request keys. | Pro §2.2; 03 wait rules. |
| D2 | **One primitive, `hud run wait`**: read-only CLI with the explicit race contract snapshot → subscribe → snapshot → wait, a compact one-line notification mode, no open read transaction while waiting, and its own death binding. `--follow`/`Monitor` cut. | Pro §2.4, §5. |
| D3 | **Wake delivery is ledger-recoverable pending work drained by an existing live process**: for Codex and pi parents the parent's own hud-mcp (alive iff the parent session is alive); for Claude parents the armed background waiter. Committing writers only commit and touch a hint file; they never spawn adapters. Adapter results are `accepted | rejected | unknown`; at most two attempts per pending set. | Pro §2.1, §2.6; no new daemon (06 P-06-1). |
| D4 | **Wake-worthy events**: `report.received` with any status (completed, failed, blocked, interrupted), run terminal commit, `run.uncertain`, and attention requests (approval/question) expressed as a blocked report. Native `agent_completed` / process exit are evidence for hud-run, never a report. | Pro §2.5. |
| D5 | **Hint = one empty file `$HUD_HOME/hints/<runId>.<seq>`** created by the committing writer; one `fs.watch` per waiting process; the parent-side hud-mcp owns cleanup. `fs.watch` is prompt discovery only; the bounded re-read is the recovery. | 06 I-06-8; Node caveats (V-doc). |
| D6 | **Codex parents: queue-only MVP** (`codex queue --thread <id>` through the direct binary, correct `CODEX_HOME`, no `-c`, never `--resume`), embedded mode made explicit, mixed daemon/embedded probed, degraded delivery surfaced. The wrapper keeps its `-c` overrides; only its comment changes. v1 option C (`--no-daemon` in the wrapper) is withdrawn: `codex queue` rejects the flag (V-help). | Pro Q4; research §1. |
| D7 | **Wake registrations live in the ledger, in the intent transaction, bound to `{OwnerKey, contextGeneration}`, the parent SessionRef, the parent `ProcessStamp` where relevant, and adapter version; revoked on generation change or session replacement; the pi receiver rejects a stale registration before `triggerTurn`.** No pi `retire` command. | Pro Q3, §2.3. |
| D8 | **Retirement = policy cause + verified eligibility + live supervisor + the existing ladder**, with separate deadlines (after-report, verified idle, blocked-wait, max runtime), a recheck immediately before the first signal, and separate records for task outcome, requested cause, observed termination and attribution certainty. | Pro Q1, §4.1, §4.2, §4.6. |
| D9 | **Capacity is enforced in atomic intent acceptance**, replay-safe (idempotent replay first, even when full), counting all non-terminal runs including `uncertain` and retained children in grace; slots are released only at established termination; the failure lists occupants and says whether retrying can help. | Pro Q2, §4.7. |
| D10 | **hud-mcp and every helper are bound to the process they serve**: stdin EOF plus a bounded `ProcessStamp` check (30 s) plus a check on every call; in-flight waits are cancelled on shutdown; exit ≤ 2 s; adapter subprocesses are killed and reaped on timeout. | Pro §4.3. |
| D11 | **Supervisor-death containment is not decided here** (Oracle Q10). v2 states the gap and the options; nothing in D1–D10, D12–D14 depends on its answer. | Owner decision 2. |
| D12 | **Cache policy = configuration + provenance + honest uncertainty.** Four separate fields (configured / documented / observed / planning assumption); no TTL inference from miss gaps; Codex retention `unknown`; HUD-managed warming **off** in v1; pi's native warming is the sole warming owner; the Codex sleep loop and all break-even numbers are gone. | Owner decision 1; Pro §3. |
| D13 | **Handoff skill**: fixed template, atomic and collision-resistant file, hash verified on the delivered bytes with a retained copy, lineage recorded as provenance only; **no implicit adoption of live children** (resolve them first; explicit transfer is v1.1). | Pro Q7, §5. |
| D14 | **Channels and `--bg` stay out of MVP**; `-p`/SDK ignore the development-channel flag (V-excerpt), which supports the exclusion. Headless children stay under hud-run's control. | Pro Q9. |
| D15 | **Compatibility rule for new event kinds and notes**: schema v1 DDL unchanged is necessary, not sufficient. Unknown `events.kind` values never change derived state; new `terminalNote` values map to `null` in older readers and in export v1's closed table until that table is extended in the same change; B14 adds an old-reader-on-new-ledger test. | Pro §2.6. |

## 2. Capability matrix

Legend as v1; "our TUIs" = Codex launched through `bin/codex-with-herdr-context`. Version-specific facts are labelled with the version they were read from and are not cross-version guarantees.

### 2.1 Claude Code (parent is Claude Code 2.1.305)

| Mechanism | Status | Cost | Latency | Failure mode | Modes |
|---|---|---|---|---|---|
| Background shell `hud run wait … --notify` exits → `<task-notification>` | **P-N1 observed** (idle interactive TUI starts a new turn); `-p`/SDK answer queued completions in one call (V-changelog 2.1.274). Reliability (10 trials, mid-turn, real `run_in_background: true`) → P-N1 | 0 while waiting; one turn on wake | hint (ms) + waiter exit + model scheduling | Orderly parent exit force-kills background commands still running 1.5 s after the stop request (V-changelog 2.1.300); after SIGKILL/crash nothing is documented → the waiter binds itself to its parent (§3.5). Unattended sessions cap background commands at 30 min default / 2 h max (V-changelog 2.1.285/288) → waiter exits `timedOut`, skill re-arms. Chained sleeps are forbidden by the tool text → one command, no loops | interactive (no limit), `-p`/SDK (limit); Herdr/tmux irrelevant |
| `Notification` hook `agent_completed`; `claude --resume <id> "prompt"` into a running `--bg` session | V-changelog 2.1.198 / 2.1.285 | 0 / one turn | — | the hook fires in the *child* (evidence, never a report); interactive parents are not `--bg` and have no documented lock → never used | child side (v1.1) / not in MVP |
| Channels | research preview; org gate; dev flag; tool restrictions (V-changelog); **ignored in `-p`/SDK, channel does not register** (V-excerpt, channels reference) | one turn | ms | gated, interactive only, protocol may change | not in MVP |
| `/loop` + `ScheduleWakeup` 60–3600 s; session cron | V-changelog; cron tasks **expire 7 days after creation and fire between turns, only while idle** (V-excerpt, scheduled-tasks) | one sample per tick | tick, delayed while busy | timer, not a push; not a precise refresh deadline | not used as a warm loop (§5) |
| Blocking `delegate_wait` ≤ 120 s | existing (B6; 05 `effectiveWaitMs`) | 0 while blocked; one sample per return | ≤ effectiveWaitMs | `MCP_TOOL_TIMEOUT` default unknown → profile sets it | all |

### 2.2 Codex CLI 0.166 (parent is a Codex TUI)

| Mechanism | Status | Cost | Latency | Failure mode | Modes |
|---|---|---|---|---|---|
| `codex queue --thread <id> --message <text>` (embedded path) | V-help + V-src 0.166: durable `queue_1.sqlite` row; the owning TUI's `QueuedItemService` checks SQLite's data version every 10 s (version-specific); dispatch only when idle. **Runtime U → P-N3** | 0 while idle; one turn on wake | ≤ ~10 s + model | guard error when a daemon runs and the call is forced embedded (any `-c`); archived/ephemeral threads rejected; max input length; never delivered mid-turn, skipped while `Interrupted`/plan mode; **`--no-daemon` rejected** | TUI (embedded or daemon); not `codex exec` |
| `codex queue --resume` | V-help: daemon/remote only; would auto-resume a dormant parent → never passed | — | — | — | — |
| `turn/steer` / `turn/start` via app-server socket; built-in `sleep` tool | V-schema/doc; V-src | wakes an in-turn `sleep` | sub-second | our TUIs are embedded (`-c` exclusion, V-src `daemon_startup.rs::config_exclusion`) → no socket; a queued message waits for the turn to end, so `sleep` is **neither a wait nor a warm mechanism** in queue-only mode | deferred adapter `codex_steer_v1` |
| Blocking `delegate_wait` | existing | 0 while blocked | ≤ `tool_timeout_sec` (V-src default 300 s; docs say 60 s → set explicitly) | Esc cancels the call (server may not see `cancelled`) | all |
| `notify` / Stop hook / async hook; `wake_on_agent_messages` (off, under development) | V-doc; V-help features | 0 | — | child-side completion signals only; a Stop-hook `block` keeps a child alive, never wakes a parent | child |

**Wrapper/daemon finding (option C withdrawn).** The wrapper's `-c shell_environment_policy.set.HERDR_*` overrides keep every TUI we launch off the shared daemon; `codex queue` works through its embedded path because no daemon runs here (V-local: dangling control socket). If a daemon ever starts (a raw `codex` invocation auto-starts one), a wrapper-launched TUI stays embedded while an override-free `codex queue` goes to the daemon's queue service; whether the embedded TUI's watcher then sees the row is U (P-N3c); the adapter reports `rejected{guard}` / `unknown` either way. Recommended **A**: keep the wrapper, fix its docstring, document the exclusion, `hud` calls `codex queue` override-free. **B** (Herdr context out of `-c`, TUIs on the daemon, `codex_steer_v1`) changes the identity path (§15: daemon-started MCP unsupported) → v1.1.

### 2.3 pi 1.5.0 (parent is a pi TUI or rpc process)

| Mechanism | Status | Cost | Latency | Failure mode | Modes |
|---|---|---|---|---|---|
| HUD extension `hud-wake.ts`: unix socket → session check → `pi.sendMessage({customType:'hud_wake'}, {deliverAs:'followUp', triggerTurn:true})` | V-doc API; runtime U → P-N5 | 0 while idle; one turn on wake | ms idle; after tools finish when streaming | extension not loaded → no socket → `rejected{no_endpoint}`; socket exists but session replaced → `rejected{stale_session}`; `accepted` means queued for delivery, not "turn started" | TUI, rpc (when hud-run owns the parent's stdin it sends rpc `follow_up` directly) |
| `cacheWarming: "idle"` | V-doc (`settings.md`): warms only when the model declares a lifetime and ≥ $0.05 avoided cost is estimated; logged as `cache_warm` usage; `cache_warming_decision` override | — | — | Mistral entries without `promptCache` lifetimes are not eligible (U) | sole warming owner (§5) |
| `ctx.shutdown()` | V-doc: interactive **deferred until idle**, rpc deferred until next idle, print mode no-op; emits `session_shutdown` | — | — | not a bounded retirement mechanism; the ladder remains the bound | not used by the wake socket (D7) |

### 2.4 Cross-cutting facts

- Ordinary MCP notifications provide no verified universal wake path (Codex logs them, V-src; Claude: no source says they start a turn; pi: only via extension). Claude channels (gated preview, interactive only) and our out-of-band adapters are the explicit exceptions.
- Two of the three wakes are idle-only queues (Codex queue; Claude task notification at the next sampling); pi `followUp` waits for tool calls to finish. None interrupts.
- Every wake costs the parent one model sample whose cost depends on cache state the HUD cannot measure precisely (§5); the design therefore minimises wakes by coalescing (§3.4), not by promising counts.

## 3. Parent notification design

### 3.1 The guarantee, stated narrowly

While parent and worker live, eligible registrations make fair progress by one pending-event page (≤200 rows) per recovery allowance; hints may use the next available allowance early. Full backlog recovery scales with its page count. Native scheduling still determines turn start. At most two irrevocably charged native attempt slots can cover an event; a crash may consume a slot without a send. Retry after an unknown requires continuous observed parent-call silence; inherited unknowns without that proof stay unconfirmed. After the bounded terminal tail `max(5 min,10*recoveryMs)` and known pending work drains, later lost-hint reports are read on the next hint or explicit parent call. No exactly-once or parent-consumption guarantee is made.

*(B19 amendment, 2026-11-02, replaces the earlier text; see contracts 02 A1 and 06 A6.)*

### 3.2 Components and who does what

| Component | Owner process | Does | Never does |
|---|---|---|---|
| `wake.registered` / `wake.revoked` events (link level) | parent's hud-mcp, in the intent transaction (spawn/resume) and on generation change | records the target and its binding (§3.3) | stores secrets or paths outside `HUD_HOME`/`CODEX_HOME` |
| Hint file `hints/<runId>.<seq>` | the committing writer (child's hud-mcp on `delegate_report`; hud-run on terminal import; reconciler on `run.uncertain`), after commit, outside any transaction | `open(O_CREAT\|O_EXCL)` + close, ≤ 1 ms | spawn subprocesses, read registrations, send anything |
| Drainer | parent's hud-mcp (all harnesses) | `fs.watch(hints/)` + recovery timer while the owner has non-terminal runs; derives pending work (§3.4); calls the adapter (Codex/pi); writes `wake.delivered`; unlinks hints; janitor at start | start a turn in its own client; run inside a tool response; retry beyond two attempts |
| Waiter `hud run wait` | the parent harness (Claude: background shell) | bounded ledger wait, compact notification on exit (§3.5) | write the ledger; delete hints |
| Adapters `codex_queue_v1`, `pi_extension_v1` | drainer, one in flight per process, ≤ 2 s wall, output ≤ 4 KiB, kill + reap on timeout | returns `accepted \| rejected{reason} \| unknown` | run inside write transactions |
| pi extension `hud-wake.ts` | the parent pi process | listens on `$HUD_HOME/wake/pi-<pid>-<procStart>.sock` from `session_start`, closes it in `session_shutdown`; validates, then `sendMessage` | accept any command other than "read the ledger" |

Pending work needs no DDL: **pending(registration) = wake-worthy events for the link's runs with `seq > throughSeq` of the latest `wake.delivered` for that registration**, read in one indexed page per registration (`events_link_cursor`; wake-worthy run events carry `link_id`, A1; ≤ 200 rows) in the same snapshot that confirms the registration is not revoked. A crash anywhere between commit and send leaves the event pending; the next hint or recovery tick drains it. This is the "durable delivery cursor" Pro asked for, kept as events under the existing whitelist rule.

### 3.3 Registration binding, validity, revocation

```ts
wake.registered payload (link): { adapter: 'claude_background_wait_v1'|'codex_queue_v1'|'pi_extension_v1'|'none', adapterVersion: 1,
  ownerKey, contextGeneration, parentRef: SessionRef, parentStamp: ProcessStamp|null,
  target: { codexHome?, threadId? } | { socketPath? } | {}, reason?: string /* for 'none' */ }
wake.revoked payload (link): { registrationSeq, reason: 'generation_changed'|'session_replaced'|'parent_offline'|'link_closed'|'adapter_rejected' }
```

- Decided once at spawn by the parent's hud-mcp from facts it already verified for identity (harness, Codex `_meta.sessionId`, `caller` ProcessStamp, `CODEX_HOME` from the verified source root). Claude parents register `claude_background_wait_v1`, i.e. "no sender action; the waiter is the worker"; the spawn response returns the exact arm command.
- Valid while: the registration is the latest for the link, not revoked, the owner's `contextGeneration` is current, and (Codex) `threadId` still equals `links.parent_ref`; (pi) the socket's handshake session id equals `parentRef`. The drainer re-checks all of this in the read snapshot of each drain; the pi extension re-checks `parentSessionId === ctx.sessionManager.getSessionId()` **before** `triggerTurn` and answers `rejected{stale_session}` otherwise; `/new`, `/resume`, `/fork` close the socket (`session_shutdown`) and re-open it bound to the new session (`session_start`, V-doc).
- Revocation: the hud-mcp that bumps the context generation (`/clear`, dual-MCP generation change per 01) writes `wake.revoked{generation_changed}` for older registrations in the same transaction; hud-run writes `wake.revoked{parent_offline}` together with `parent.offline` (04); a `rejected{stale_session|archived|guard}` result revokes with `adapter_rejected` and `delegate_status` shows `wake.state='degraded'` with the reason. A revoked registration is never sent to; a new round (`delegate_resume`) registers afresh.
- Residual, documented: a Codex queue row is durable. If the parent thread is replaced before pickup and the user later resumes it explicitly, the old row is dispatched then (V-src `on_thread_resume`). The message only says "read the ledger"; the resumed session's hud-mcp validates ownership on `delegate_status`; the cost is one unsolicited sample. No receiver-side fence exists for Codex; P-N3 records the behaviour.

### 3.4 Drain algorithm (parent's hud-mcp)

Use one watcher and one unref'd scheduler in the parent's hud-mcp. Startup, hints, recovery, and page continuation share the per-registration read allowance. In one snapshot validate the latest registration, owner generation and target, derive its fixed pending page or exact retry interval, and inspect actual wait coverage. Coalesce that page per registration and preserve a fixed high-water across continuation. Charge an available attempt slot in a short transaction before transport; recheck sender fences immediately before invoking it. Refine accepted/rejected afterward; rejected also revokes. Unknown retains its fixed retry identity and never becomes a parent's consumed page. Charge attempt 2 only after recovery delay and proven continuous silence; never invoke a charged slot twice or issue attempt 3. Record wait_return only for actual successful wait coverage. Unlink only hints within ledger-accounted coverage, never unread later pages. Maintain the bounded terminal tail and explicit late-report degradation in 06 A6. Keep the timer only while registrations are eligible or known work must settle.

For Claude registrations steps 3–5 are skipped (the waiter delivers by exiting); the drainer still runs steps 1, 2 and 6 as janitor and records nothing.

*(B19 amendment, 2026-11-02, replaces the earlier text; see contracts 02 A1 and 06 A6.)*

### 3.5 `hud run wait` contract

```
hud run wait (<runId> | --link <linkId>) [--after-seq N] [--until report,run_terminal,uncertain]
             [--owner-generation N] [--timeout-ms 7200000] [--notify | --json]
```

- Sequence: (1) read a short snapshot (fix `runId`, page from `afterSeq`); if matched → exit; (2) subscribe (`fs.watch` on `hints/`, one watcher); (3) **read again** (closes the registration gap); (4) wait for a hint or the bounded deadline (≤ `recoveryMs`), then re-read. No SQLite transaction stays open while waiting; each read is one page in one snapshot (03 wait rules, zero writes).
- Watcher failure cases: `fs.watch` throws or errors → continue on deadlines only and flag `watchUnavailable:true` in the output; `filename` null → re-read; the `hints/` directory replaced or removed → re-subscribe on the next deadline (Linux `fs.watch` follows the inode, V-doc); missing hint file at read time → ignore (the ledger is read regardless).
- Output: `--notify` (default when stdout is not a TTY) prints **one line ≤ 512 bytes** and exits 0: `[hud] wake link=<linkId> run=<runId> kinds=report:completed throughSeq=412 stale=false — call delegate_wait{runId, afterSeq:<your cursor>} and drain until hasMore=false; the ledger is the truth.` `--json` prints the page `{runId, events, nextSeq, matched, timedOut, current, hasMore, asOfSeq}` for scripts. No report text, paths or summaries in either mode. P-N1 verifies what the task notification actually carries (output file vs inline text) before the skill relies on the line.
- Death binding: records `ppid` and the parent's `ProcessStamp` at start; at every deadline (≤ 30 s) exits `orphaned` if either changed (reparenting to a subreaper counts); exits `stale_generation` if `--owner-generation` no longer matches the ledger. `--timeout-ms` default 2 h interactive, 25 min when the skill knows the parent is `-p`.
- Authorisation: `trusted_local` read of the private `HUD_HOME` (04 F05); the CLI cannot spawn, resume, cancel or report.

### 3.6 Message format

Codex queue text and pi `content` are the same ≤ 512-byte line as `--notify`, listing every coalesced run; pi additionally gets `details: {linkId, runs:[{runId, kind, seq}], throughSeq, contextGeneration}`. The line never says `afterSeq: seq−1`: the receiver uses its own cursor and drains all pages up to `throughSeq`.

### 3.7 Cursors, duplicates, compaction

- The skill keeps `lastSeenSeq` per run in the parent's context and records it after every wait/status. After compaction or a restart the cursor may be lost: the parent calls `delegate_status{runId}` (latest report + current state in one read) and resumes from `asOfSeq`. No durable per-parent observation cursor is promised in MVP (wait stays zero-write).
- A duplicate wake (hint + native, Codex re-dispatch, waiter exit after an in-turn wait) **costs a model turn** whose only work is one short tool call that returns an empty page. This is the honest cost of duplicate tolerance; §3.4 steps 3–4 keep duplicates rare.
- Observed events vs parent actions: reading is idempotent by construction; anything the parent does in response (spawn a follow-up, resume, cancel) uses a request key or a state precondition (02), so a duplicate wake cannot duplicate an action.

### 3.8 Wake mapping for intervention cases

| Child situation | Ledger fact | Wake | Parent reads |
|---|---|---|---|
| finished / failed | `report.received{completed\|failed}` | yes | report via `delegate_status` (07 material rules) |
| needs a decision, approval or answer | `report.received{blocked, needs:'approval'\|'question'\|'decision'}` (role templates' question channel, B13) | yes (attention class) | report; decides resume/cancel |
| interrupted (user Esc/Ctrl-C in the child, or hook `Interrupt`) | `report.received{interrupted}` if the child reports it; else hud-run terminal evidence | yes | status |
| process exit / `agent_completed` / `notify` without a report | hud-run terminal commit (`ended`/`failed`) with `outcome:'unknown'` | yes (terminal) | status shows "no report" |
| supervisor lost | `run.uncertain` | yes | status; `hud run reconcile` command shown, not executed |

### 3.9 Parent state cases

| Parent state | Claude (`claude_background_wait_v1`) | Codex (`codex_queue_v1`) | pi (`pi_extension_v1`) |
|---|---|---|---|
| idle at prompt | waiter exits → notification → new turn (P-N1 observed; reliability P-N1) | row picked up ≤ ~10 s → new turn (P-N3) | socket → `triggerTurn` → new turn (P-N5) |
| mid-turn / inside a blocking `delegate_wait` | delivered at the next sampling; the skill arms either the in-turn wait or the waiter, not both | dispatched after the turn ends (skipped while interrupted/plan mode); the drainer records `wait_return` and sends nothing | `followUp` after tool calls finish; same |
| offline, killed or replaced (`/clear`, `/new`, generation +1) | waiter exits `orphaned` ≤ 30 s or `stale_generation`; the skill ignores a stale line | registration revoked (`parent.offline` / generation change) before any send; residual §3.3 | `rejected{no_endpoint}` / `rejected{stale_session}` → revoked |
| cache expired at wake | one cold sample; the HUD does not try to prevent it in v1 (§5) | same | pi may have warmed natively |

### 3.10 Performance rules (child-side and parent-side hud-mcp)

No adapter runs inside tool responses or transactions. All pending-page reads count against one ≤200-row indexed page per registration per recoveryMs, including hint and continuation triggers. Registration metadata and short reservation/outcome transaction queries are separately measured; they cannot hide an unbounded pending scan. Hint touch remains exclusive-create plus close after commit; no directory scan/hash/subprocess enters non-wait responses. Helpers remain ≤1 in flight per hud-mcp, ≤2 s, ≤4 KiB output and kill+reap on timeout/shutdown. Parent binding is checked every 30 s and every call. Concurrent non-wait p95 <50 ms and F08 transaction budgets remain unchanged. B19 reports active/terminal-tail/fully-suspended/no-registration page reads and timers separately.

*(B19 amendment, 2026-11-02, replaces the earlier text; see contracts 02 A1 and 06 A6.)*

## 4. Lifecycle and retirement

### 4.1 Rules per process / session type

| Process / session | Lives while | Ends on | Action | Bound |
|---|---|---|---|---|
| **hud-mcp** | its stdio is open and its harness process (ppid + `ProcessStamp` captured at start) is unchanged | stdin EOF; `ProcessStamp` check (every 30 s and on every call) fails; SIGHUP/SIGTERM | cancel in-flight `delegate_wait` (return immediately), stop drainer, kill + reap adapter child, close SQLite, exit | ≤ 2 s after detection |
| **hud-run** | the run is non-terminal | terminal receipt imported (04) | retirement runs before the terminal import; then import → hint → conditional surface close → exit | ladder ≤ graceMs + 2 s + reap |
| headless child (`codex exec`, `claude -p`, `pi -p`) | its turn | own exit; if alive after a completed/failed report → after-report retirement; `maxRunMs` | ladder on the verified scope | `maxRunMs` + ladder |
| visible implementer (TUI left at its prompt) | until retired | eligibility per §4.2 for after-report / idle / blocked-wait / max runtime; user `delegate_cancel`; `orphan_policy=stop` after confirmed parent loss | ladder (signals only) → hud-run exits → conditional surface close (§4.8) | see §4.3 |
| visible reviewer | same | same, shorter after-report grace | same | same |
| blocked / awaiting parent | until the parent decides or `blockedWaitMs` | separate deadline; outcome stays `blocked` | same | `blockedWaitMs` + ladder |
| uncertain run | — | never automatically | `hud run reconcile`; shown as a leak; holds a slot | ARCH item §4.7 |
| user-owned parent | user-owned | never by us | — | — |
| pi rpc child (hud-run owns stdin) | run | report / deadline | `abort`, close stdin, ladder if still alive | 30 s + ladder |
| waiter, adapter subprocess | §3.5, §3.2 | orphaned / stale / deadline; result or 2 s timeout | exit; kill + reap | ≤ 30 s; 2 s |

The ladder is the existing one: SIGINT → accepted grace (default 10 s, 0–60 s) → SIGTERM → 2 s → SIGKILL, scope re-verified and R/Q/N re-checked before each step (04; `src/core/run/control.ts`). Harness exit behaviour is P-N6.

### 4.2 Retirement eligibility (verified, not inferred from ledger silence)

| Cause | Required before the first signal (all; rechecked in one read snapshot immediately before SIGINT) |
|---|---|
| `after_report` | latest accepted `report.received` for the run is `completed\|failed` at seq S; no intent accepted on the link after S and the run is still the link's current run; grace `afterReportMs` elapsed since S; pending human input per policy (observed `approval\|question` → treated as blocked-wait; unobservable → proceed); supervisor holds verified scope; frozen policy authorises |
| `idle` | no completed/failed report; **observed quiescence** `quiescent:true` with `since ≤ now − idleMs` from an evidence source (below); no pending input observed; scope + policy as above. **Unobservable quiescence disables idle retirement for that run** (only `max_runtime` remains) |
| `blocked_wait` | latest report `blocked\|interrupted`, or observed pending input, at time T; `blockedWaitMs` elapsed since T with no parent decision (resume/cancel resets); outcome preserved as `blocked`; scope + policy |
| `max_runtime` | `maxRunMs` elapsed since `started`; no eligibility beyond scope + policy; may interrupt active work by design |

Quiescence evidence (`{quiescent, since, pendingInput, source, asOf}`), evaluated by hud-run at deadline time only: (1) the B16 projection published in the observation store (B12 `readProjection`) when fresh; else (2) the harness facade's transcript tail (Codex rollout, Claude transcript, pi session jsonl: last record is a completed turn and the file is unchanged for the window; ≤ 64 KiB tail, ≤ 20 ms soft); else `null`. One check per deadline event, one recheck before signalling; when idle quiescence is not yet established the timer re-arms at `max(idleMs/4, 5 min)`. A timer armed before new work arrived must not kill that work: the recheck compares the assignment (latest report seq, intents, current run, registration generation) captured when the deadline was armed with the current snapshot and aborts on any change.

### 4.3 Deadlines (initial defaults, configurable per profile in `delegate.json`)

| Setting | Default | Note |
|---|---|---|
| `retire.afterReportMs` (implementer) | 10 min | after a final completed/failed report, eligibility §4.2 |
| `retire.reviewerAfterReportMs` | 2 min | same |
| `retire.idleMs` | 60 min of **verified** inactivity | disabled when unobservable |
| `retire.blockedWaitMs` | 60 min | configurable at spawn (`delegate_spawn{retire:{blockedWaitMs}}`), preserves `blocked` |
| `retire.maxRunMs` | 4 h, finite for every profile | **starts the ladder**; advertised lifecycle bound = `maxRunMs + graceMs + 2 s + reap` |
| user-owned parent | none | never retired |
| lost supervisory authority | none | no input/resume; containment is the open ARCH item §4.7 |

### 4.4 Evidence: outcome, requested cause, observed termination, attribution

`retire.requested` (run) is written before the first signal: `{cause, rule, actor:{kind:'policy'}, deadlineAt, eligibility:{reportSeq?, newerWorkChecked:true, quiescence:'observed'|'not_required'|'unobservable', pendingInput:'none'|'unobservable'|'policy_override'}, graceMs}`. It is an intention, never a classification. The terminal event's whitelist payload gains a `termination` object:

```ts
termination: { outcome: 'completed'|'failed'|'blocked'|'unknown',            // from the latest accepted report, else unknown
  requestedCause: 'user_cancel'|'retire_after_report'|'retire_idle'|'retire_blocked_wait'|'runtime_limit'|'orphan_policy'|null,
  observed: { exitCode: number|null, signal: string|null, escalatedTo: 'INT'|'TERM'|'KILL'|null, scopeEvidence: 'R'|'Q'|'N' },
  attribution: 'caused'|'not_caused'|'unknown' }                             // did the requested action end the scope?
```

Classification keeps 02's chronology: R-02-2 (`cancelled`, proven `before_exit`) stays for user cancels and for the existing `orphan_policy=stop` cancels; retirement and runtime-limit causes never produce `cancelled` and end as `ended` with `attribution:'caused'` when the scope was alive at the first signal and ended after it, `not_caused` when the scope was already gone (natural exit; `retire.requested` stays as audit), `unknown` otherwise with `terminalNote:'retire_timing_unknown'`. `terminalNote` therefore grows by one value only (`'cancel_timing_unknown'|'retire_timing_unknown'|null`); cause and outcome live in `termination`. B16/B6 display them separately: "completed; retired after report", "failed; later retired", "no report; runtime limit; task incomplete".

### 4.5 Why this stays inside contract 04

Retirement runs only while hud-run is alive and holds verified group control; it uses signals, never TTY bytes (`/quit` is explicitly not used); it is a pre-authorised, frozen policy with an audit event; it never resumes, re-launches or re-attaches; surface close happens after the harness is gone and only under §4.8's ownership proof. After supervisor death there is no retirement: §4.7.

### 4.6 Death binding (hud-mcp and helpers)

MVP mechanism: stdin EOF (primary) **plus** a bounded lifecycle check: at start capture `ppid` and the parent's `ProcessStamp` (04); every 30 s (`unref`'d timer) and on every call compare; any change (reparenting to PID 1 or to a subreaper, PID reuse) → shutdown as in §4.1. Why not `PR_SET_PDEATHSIG`/pidfd now: Node exposes neither without native code; the death signal is bound to the *thread* that forked, is cleared across `fork(2)` and set-id/capability `execve`, and is not delivered if the parent already died before the call (V-doc man-pages 6.19) — it would need a harness-side wrapper (`setpriv --pdeathsig`) and a spawning-thread guarantee per harness. v1.1 may add it where the harness's spawning thread is known stable. On shutdown an in-flight `delegate_wait` is cancelled immediately so a 120 s wait never extends the 2 s exit. Equivalent rules bind the waiter (§3.5), the adapter subprocess (§3.2) and the in-group helper (G01).

### 4.7 Supervisor death: open ARCH item (Oracle Q10)

The gap, stated plainly: if hud-run dies while a child is alive, contract 04 leaves the child running (`uncertain`, slot held, no automatic input/focus/resume) until a human reconciles. That is conservative control, not a hard lifetime bound; the owner's bounded-lifecycle requirement is therefore met only while the supervisor lives. Options for Q10, not decided here:

| Option | Shape | Cost / risk |
|---|---|---|
| A. Prearranged containment | arm an OS/host mechanism at run start that ends the owned scope when hud-run dies and proves coverage of owned descendants: `PR_SET_PDEATHSIG` on the group helper (e.g. `setpriv --pdeathsig`, new dependency; thread/fork caveats above), a per-run cgroup or `systemd-run --scope` where available (WSL2 dependent), or host-level pane teardown bound to the supervisor | compatibility with 04 (headless and visible 甲) must be ruled; evidence and terminal classification the reconciler records; escaped descendants (`setsid`) still uncovered unless cgroup-based |
| B. Explicit limitation | document that bounded lifecycle holds while the supervisor lives; after supervisor death the leak is visible (HUD, `hud run status`), holds a slot (§4.9) and is reconciled manually | no new mechanism; the requirement is narrowed, not met |

Independence: wake delivery (§3), eligibility (§4.2), evidence (§4.4), capacity (§4.9) and the acceptance tests (§4.10) are the same under A or B; a `run.uncertain` wake notifies a live parent but authorises no intervention in the orphaned child. B14's existing "kill the parent, leave hud-run alive" test is kept and labelled as *parent* failure; **direct hud-run failure tests** (SIGKILL during the ladder, during terminal import, with inherited stdio) are added regardless of Q10's answer.

### 4.8 Surface close: ordering and exclusive ownership

`HostAdapter.closeSurface(locator, proof: {createdForRun, occupantGeneration, occupantStamp})` is a new method (today's adapter has `openSurface/runInSurface/locate/checkLocator/focus/sendKeys/attachIdentity`). Order inside hud-run: (1) scope termination established (R/Q); (2) terminal evidence committed and the hint touched (recoverable wake work); (3) bounded (≤ 2 s) conditional close request; (4) exit — the close may pre-empt the exit, which is why bookkeeping precedes it. Conditions, all rechecked at execution: the surface was created by `openSurface` for *this* run (recorded at spawn as a `surface.created` link event with locator + generation); `checkLocator` matches server, generation and occupant; the pane's foreground process group is hud-run's own job or the pane shell at its prompt (`/proc/<shell>/stat` tpgid; tmux `pane_pid` + `pane_current_command`; Herdr equivalent in B7) — a shell running unrelated foreground work fails the check; the host primitive closes exactly that split/pane (closing a tab that holds other splits is refused). Any failed or unknown condition leaves the pane open; a stale pane is the accepted failure mode. Alternative kept for B3b: the pane shell's launch line runs `hud surface close --if-created-by <runId>` after hud-run exits (prearranged, not typed input), which avoids a close pre-empting hud-run.

### 4.9 Concurrency cap

Order inside `acceptIntent` (`BEGIN IMMEDIATE`): (1) resolve the idempotency key under the caller's `OwnerKey` and validate the payload digest; (2) replay the stored result even if capacity is now full; (3) for a new request count `runs WHERE state IN ('starting','running','cancelling','uncertain')` (served by `runs_reconcile`) globally for this ledger/`HUD_HOME` (`limits.maxActiveRuns`, default 6) and per owner (`limits.maxActiveRunsPerOwner`, default 4), and reserve the `starting` run in the same transaction; (4) over the limit → rollback, `{ok:false, code:'concurrency_limit', active, limit, occupants:[{runId, linkId, state, since, holder:'self'|'other', retireEta|null}], retryAdvisable}` with **no** idempotency row (transient). Slots are released only when R-02 establishes termination: a completed report does not free a running child's slot; retained visible children in grace and `uncertain` runs occupy slots and are listed as such in `delegate_status` and the HUD. `retryAdvisable=false` when every occupant is the caller's own non-terminal child (nested exhaustion: the caller must wait on, cancel or inline the work; the skill never loop-retries) or when occupants are `uncertain` (needs reconcile). The run cap does not bound native subagents, shell subprocesses, waiters or helpers; those have their own bounds (§3.10, §4.1).

### 4.10 Acceptance (B14 additions, failure-focused)

| Test | Expected |
|---|---|
| Baseline after N (v1 §4.5 kept: 10 delegations, mixed headless/visible, test graces 5 s/10 s) | per-class process counts back to baseline, RSS ≤ baseline + 32 MiB, no pane created by a run remains, zero `uncertain`, `hints/` empty within 60 s after the last grace |
| crash of the child's hud-mcp after `report.received` commit, before the hint | parent's drainer delivers within `recoveryMs`; `wake.delivered` present; one wake |
| `codex queue` accepted then sender timeout (fault-injected slow binary) | `unknown`, attempt 2 only if the parent stays silent, then `unconfirmed` in status; no third send |
| lost `fs.watch` events; subscribe/read race (event committed between snapshot 1 and subscribe) | waiter returns within the bounded deadline; no missed event |
| duplicate, reordered and multi-page (> 200) events | parent drains to `throughSeq` with its own cursor; no skipped seq |
| `/clear` / `/new` with the same pi process and socket | stale hint `rejected{stale_session}`, no turn; new registration works |
| hud-run SIGKILL during the ladder; during terminal import; parent death with hud-run's stdio inherited by a child | reconciler: `uncertain` with slot held or terminal per R-02 evidence; no auto input/resume; hud-mcp exits ≤ 2 s despite inherited pipes (lifecycle check) |
| retirement racing new work (resume accepted after the timer armed), user cancel, natural failure | new work untouched; user cancel keeps cancel semantics; natural exit → `not_caused` |
| simultaneous requests for the last slot; replay while full; nested exhaustion | exactly one accepted; replay succeeds; `retryAdvisable=false` reported |
| pane reused by an unrelated foreground job before closure | pane left open |
| non-wait MCP p95 while adapters are slow/failing and spawns/reports/reconcile run concurrently | < 50 ms (P-06-4), slow samples reported |
| old reader (pre-change build) on a ledger with new event kinds and `retire_timing_unknown` | state derivation unchanged; note reads `null`; export v1 rows valid |

## 5. Cache-aware scheduling

### 5.1 Corrected fact table (what is actually known)

| Fact | Value | Evidence (2026-11-02) |
|---|---|---|
| Claude Code main-conversation TTL | **1 h only on a Claude subscription within included plan usage**; 5 min on usage credits, API key, Bedrock, Vertex, Foundry; a `1h` setting is ignored while the subscription is on usage credits; subagents and other buckets default to 5 min | V-excerpt (`prompt-caching` page), V-binary (`promptCacheTtl` text: "within its usage limits") |
| Claude cache economics | writes 1.25× (5 m) / 2× (1 h); **reads model-specific**: 0.025× Fable 5.1 / Mythos 5.1, 0.05× Opus 5.5, ≈ 0.1× others (Sonnet 5.5 is $0.20/$2.00 = 0.1× in the price list I can read, not the 0.05× the review states); lifetime measured from the **start** of the request that wrote or read the entry | V-doc (platform price list and caching docs via the claude-api skill) |
| MCP connect/disconnect and Claude's cache | with deferred tool search (default on supported models) the tool list from the first request is kept for the conversation, so a server connecting or disconnecting does not disturb the cached prefix; without tool search a mid-session tool-list change invalidates | V-excerpt (`prompt-caching`), V-changelog 2.1.267/2.1.281/2.1.302 |
| Claude native idle behaviour | idle compaction of 200K+ conversations at ~54 min (`idleCompaction:false` disables); `/loop` wake-ups 60–3600 s, fired between turns only while idle; session cron tasks expire after 7 days | V-changelog 2.1.299/2.1.304, V-excerpt (`scheduled-tasks`) |
| OpenAI API retention | earlier models: in-memory "around 5 to 10 minutes of inactivity, up to one hour"; extended 24 h retention default for non-ZDR orgs on supporting models; **GPT-5.6+: 30 min minimum by default at 1.25× write, 12 h option at 2.5×**; reads 0.1× on most GPT-5.6+ models, **0.05× on GPT-6.1 Sol/Terra**; "OpenAI may retain entries longer"; nothing about ChatGPT-authenticated clients | V-doc (fetched guide) |
| Codex 0.166 requests | sends neither `prompt_cache_retention` nor `prompt_cache_options`; cache key session-derived; ChatGPT backend retention **unknown** | V-src; U for the backend |
| pi | per-model `promptCache.{short,long}` lifetimes are best-effort metadata driving pi's own warming (`cacheWarming`, ≥ $0.05 rule) | V-doc (local pi docs) |
| Subscription quota ↔ API dollars | no established conversion; dollar figures are never shown for subscription usage | — |

### 5.2 Configuration `~/.hud/cache.json` v2 (provenance kept separate)

```json
{ "version": 2, "handoffMinTokens": 60000,
  "entries": [
    { "match": {"harness":"claude","auth":"subscription_included"},
      "configured":  {"ttlMs": 3600000, "source": "promptCacheTtl unset = automatic (binary text 2.1.305)"},
      "documented":  {"ttlMs": 3600000, "writeMultiplier": 2.0, "readMultiplier": {"claude-fable-5-1": 0.025, "claude-opus-5-5": 0.05, "default": 0.1},
                      "lifetimeFrom": "request_start", "source": "code.claude.com prompt-caching; platform docs"},
      "planningAssumption": null, "warming": "off" },
    { "match": {"harness":"claude","auth":"usage_credits|api|bedrock|vertex|foundry"},
      "documented":  {"ttlMs": 300000, "writeMultiplier": 1.25, "readMultiplier": {"default": 0.1}}, "warming": "off" },
    { "match": {"harness":"codex","auth":"chatgpt"},
      "configured":  {"ttlMs": null, "source": "0.166 sends no retention option"},
      "documented":  {"ttlMs": null, "note": "API only: GPT-5.6+ >= 30 min at 1.25x write; reads 0.1x (0.05x GPT-6.1 Sol/Terra); ChatGPT backend not covered"},
      "planningAssumption": {"ttlMs": 300000, "label": "conservative, display only"}, "warming": "off" },
    { "match": {"harness":"pi"}, "documented": {"source": "models.json promptCache, best-effort"}, "warming": "native" } ] }
```

Rules: `observed` data never overwrites `documented`; a miss never promotes an assumption to a measurement; `ttlMs: null`, `ttlMs ≤ marginMs`, missing multipliers or missing context size disable every arithmetic field (they become `null`, never zero or negative). The file is loaded once at hud-mcp start and read by `hud cache show`; no per-call `stat` (a change takes effect in the next session). The `auth` label is set by the launcher from what it can verify, else `unknown` (never guessed to `subscription_included`).

### 5.3 Advice and decision procedure (parent-side; hud-mcp supplies facts, not verdicts)

`delegate_spawn`/`delegate_status` carry `advice: {harness, auth, model|null, configuredTtlMs|null, documentedTtlMs|null, planningTtlMs|null, provenance, lastQualifyingRequestStartAt: null, remainingWarmWindowMs: null, warming:'off'|'native', wake:{adapter, state, armCommand?}}` from the loaded snapshot — pure lookup, no I/O, `null` wherever an input is unavailable (in MVP `remainingWarmWindowMs` is always `null` because the last qualifying request start is not observed). The skill (B13) then applies, in order:

1. **Unrelated work** → new session with a clean brief; carry nothing.
2. **Related work with outstanding children or approvals** → keep the owner session alive until they are resolved (no ownership transfer exists in MVP, §6).
3. **Short pause** (the parent expects the child back soon) → native wake or an event-responsive bounded `delegate_wait`; accept whatever cache reuse happens. For Codex queue-only parents: **end the turn and idle**; a pending `sleep` or tool call does not refresh any cache and blocks queue dispatch until the turn ends.
4. **Long or unknown pause** → write a handoff at a safe boundary (§6) and continue in a fresh session; `handoffMinTokens` (60 000, configurable) is an advisory context-quality threshold, not an economic verdict; cache expiry alone does not invalidate the old conversation.
5. **HUD warming: off.** pi's `cacheWarming` remains the only warming loop. Opt-in HUD warming is deferred until prices, context size, retention semantics and the last-request timestamp are known, with a finite tick limit and cancellation on completion or generation change (v1.1 preconditions, §7.1).

Chained `delegate_wait` loops are still not a warm mechanism; the skill never loops waits faster than the parent actually needs the result.

### 5.4 `hud cache report` (descriptive only)

Reads the user's own usage records through the existing readers (Claude usage per `message.id`; Codex `token_count` with `cached_input_tokens`/`cache_write_input_tokens`; pi `cacheRead`/`cacheWrite`). For consecutive requests in one session it classifies **hit** (cache read ≥ 0.8 × previous input), **miss** (cache write ≥ 0.8 × previous input) or **unknown** (missing fields, partial hit, detectable compaction/model/tool-set change, auxiliary request) and reports counts and hit fraction **by elapsed-time bucket** (<1, 1–5, 5–10, 10–30, 30–60, >60 min) grouped by harness, auth and model, using request-start timestamps where the record has them and flagging approximations. It never estimates an expiry boundary and never feeds the advice. Local only, counts and timestamps, ≤ 1000 ms soft, never on the hot path (A8).

## 6. Handoff skill (`hud-handoff`)

**Purpose.** When §5.3 step 4 applies, or the user ends a long session, the session writes a fixed-form handoff that a fresh session (same or another harness) continues from. It is a brief for the successor, not a ledger object.

**Template** (sections mandatory and in this order; empty sections say "none"):

```
# Handoff: <slug>
- from: <harness> session <short id or n/a>, link <linkId or none>, run <runId or none>; date
- to: <harness/role of the successor>; reason: long_pause | context_budget | user
- repo/branch/commit: <path> <branch> <sha>
## Task (what the successor must deliver; acceptance commands)
## State: done / in progress / not started (file paths; tests green; verified vs assumed)
## Decisions made and why (bullets; cite docs/contract sections, not chat)
## Open questions and known risks
## Outstanding delegations (linkId/runId, state, what the successor may only *observe*; resolved before handoff unless listed here)
## Next steps (ordered; command and expected result)
## Pointers (files to read first; report paths; the handoff's own path)
## Content rule: actual task state the successor needs; no secrets or credentials; no transcript excerpts beyond what the task needs;
   no paths outside the repo or HUD_HOME
```

(The examples in this proposal are synthetic because the repository is public; operational handoffs live in git-ignored `tmp/` and carry real task state under the content rule.)

**Artifact rules.** Path `tmp/handoff/<date>-<slug>-<8 hex random>.md`; written to a temp file, fsync'd, renamed (atomic, collision-resistant). The successor is started with the handoff as its brief: delegated via `delegate_spawn{brief: <path>}`, human-driven via `hud claude|codex|pi --brief <path>`. B4's brief handling applies unchanged: byte cap, sha256 computed on the delivered bytes outside the transaction, and the delivered copy retained under `$HUD_HOME/runs/<runId>/brief.md`, so a later edit or deletion of the `tmp/` file cannot change or lose what the successor received. hud-mcp records `handoff.recorded {sha256, bytes, retained:true, fromLinkId?, fromRunId?}` on the successor's link in the intent transaction (path only under `--paths local` in export). The Inspector shows "continues from …" as candidate-grade provenance; it is never a parent edge, never `predecessor`, and grants nothing.

**Ownership boundary (MVP).** A handoff transfers no runs. Outstanding children are resolved (waited for or cancelled) before the predecessor ends; if the predecessor must stay alive for them, it stays alive and its hud-mcp keeps draining wakes. A successor that is a different OwnerKey gets `not_owner` on the predecessor's links (03 T-03-14). Explicit transfer/adoption uses the v1.1 cross-owner credential already specified in 03; until then "continue during live delegation" is unsupported, not improvised.

## 7. Work packages, contract amendments, probes

### 7.1 Mapping

| WP | Addition | Role |
|---|---|---|
| B2/B4 ledger, spawn | `wake.registered/revoked/delivered`, `retire.requested`, `surface.created`, `handoff.recorded` in the whitelist; `termination` payload; capacity in `acceptIntent` (§4.9); `limits`/`retire` profile fields; brief retention path reused for handoffs | CORE |
| B6 wait/status | wait core shared with the CLI (§3.5 sequence); `advice`, `wake.state`, capacity occupants, `termination` projection in `delegate_status`; optional per-profile `waitCapMs` override (Pro Q5) only for profiles with verified client timeouts, after timeout/cancel tests | CORE |
| B3a/B3b hud-run | deadlines and eligibility (§4.2–4.3), `retire.requested`, ladder reuse, evidence (§4.4), hint touch on terminal import, conditional `closeSurface` ordering (§4.8), direct hud-run failure tests | CORE |
| B7 Herdr layer | `closeSurface` for splits with occupancy/foreground checks; tmux variant in core; refuse tab-level close | CORE |
| B11 launcher/CLI | `hud run wait`; wrapper docstring fix; `hud pi` loads `hud-wake.ts`; `hud cache show/report`; `--brief`; auth label capture | CORE (wait, launcher) + ORD (report script) |
| B13 skill | wait strategy §5.3; arm one waiter per Claude parent wait; dedup/cursor rule; `concurrency_limit` rule; question channel → blocked report; `hud-handoff` template | ORD |
| B14 acceptance | §4.10 table; P-N1–P-N9; mixed-version reader test | ORD + HUI |
| **B19 wake delivery** (new, M) | drainer in hud-mcp, pending derivation, adapters `codex_queue_v1` and `pi_extension_v1`, `hud-wake.ts`, registration binding/revocation, janitor | CORE |
| **B20 cache config** (new, S) | `cache.json` v2 loader/validator, advice snapshot, `hud cache report` reader job | CORE (loader/advice) + ORD (report) |
| v1.1 | `codex_steer_v1`; `claude_channel_v1`; `Notification`-hook child signal; `delegate_close` manual retirement; opt-in HUD warming with preconditions (prices, context size, retention semantics, last-request start, finite ticks, cancellation); explicit handoff transfer; `PR_SET_PDEATHSIG` wrappers where the spawning thread is known | — |

### 7.2 Contract amendments

| # | Contract | Amendment |
|---|---|---|
| A1 | 02/03 events | new kinds and payloads: `wake.registered`, `wake.revoked`, `wake.delivered` (link); `retire.requested`, `surface.created` (run/link); `handoff.recorded` (link); wake-worthy run events carry `link_id`. **Compatibility rule (D15)**: unknown kinds are opaque to state derivation; readers must not fail on them; whitelist versioned `events.v1.1` |
| A2 | 02/03 terminal | `terminalNote` enum + `'retire_timing_unknown'`; `termination` object (§4.4); R-02-2 restricted to user-initiated cancels; policy causes → `ended` with attribution; 07 closed table extended in the same change, older readers → `null` |
| A3 | 02 capacity | §4.9 order and semantics; `concurrency_limit` transient; slot release only at established termination; occupants projection |
| A4 | 04 | "policy retirement" paragraph (eligibility, deadlines, recheck, evidence); hud-run death binding of helpers; surface-close ordering and ownership proof; hint touch on terminal import; supervisor-death containment marked "pending Oracle Q10" |
| A5 | 05 delegate.json | optional `limits {maxActiveRuns, maxActiveRunsPerOwner}`, per-profile `retire {afterReportMs, reviewerAfterReportMs, idleMs, blockedWaitMs, maxRunMs}`, optional `waitCapMs`, `wake.recoveryMs`; version stays 1 (additive known keys; unknown keys still rejected) |
| A6 | 06 | `hints/<runId>.<seq>` as the sanctioned cross-process hint; cleanup owner; budgets: drainer ≤ 1 indexed read per active registration per `recoveryMs` (zero without delegations), waiter ≤ 1 per armed wait, adapter helper ≤ 1 per hud-mcp ≤ 2 s, hud-mcp lifecycle check every 30 s; P-06-1 counts waiters and adapter helpers; T-06-14 adds the slow-adapter concurrent measurement |
| A7 | 03 status | `advice`, `wake.state ('registered'|'degraded'|'unconfirmed'|'none')`, `capacity {active, limit, occupants}`, `termination`, `continuesFrom` candidate projection |
| A8 | 07 | `cache-observed` report output is local observation storage (counts/timestamps), never export material; `handoffPath` only under `--paths local` |
| A9 | 01 | wake registration binding fields reference `OwnerKey`/`contextGeneration`/`ProcessStamp`; generation change writes `wake.revoked` in the same transaction |

### 7.3 Probes (method → pass)

| Probe | Method | Pass |
|---|---|---|
| P-N1 Claude wake reliability | real 2.1.305 TUI in tmux; child = hud-run wrapping `sleep 20` + synthetic `delegate_report`; waiter armed with the Bash tool's **actual `run_in_background: true`** (not `&`); 10 idle, 5 mid-turn, 3 after `/clear`; record what the notification carries | idle: new turn ≤ 5 s in ≥ 9/10, one turn; mid-turn: delivered once after the turn; `/clear`: waiter line reports `stale`, skill ignores; notification content documented |
| P-N2 `-p` parent limit | `claude -p` parent, waiter `--timeout-ms` 25 min | `timedOut` line delivered and re-armed; no force-kill at 30 min |
| P-N3 Codex queue | direct binary, `CODEX_HOME` via environ, no `-c`; (a) idle wrapper TUI, (b) working TUI, (c) daemon started in a temp `CODEX_HOME`, (d) thread replaced then resumed | (a) turn ≤ 15 s; (b) after the turn; (c) guard error → `rejected`, and whether a daemon-queued row reaches the embedded TUI (record); (d) residual behaviour recorded |
| P-N4 Codex thread id | `_meta.sessionId` vs the id `codex queue` accepts | identical 5/5 |
| P-N5 pi extension | load `hud-wake.ts`; wake idle, streaming, rpc; `/new` with the same process; socket absent | idle → turn ≤ 2 s; streaming → after tools; rpc `follow_up` accepted; stale → `rejected`, no turn; absent → `rejected{no_endpoint}`; 10/10 |
| P-N6 retirement signals | idle Codex/Claude/pi TUIs under hud-run; ladder with 5 s grace; natural exit before the signal | exits before TERM + 2 s; rollout/transcript intact and resumable; `not_caused` recorded for the natural exit; close only when ownership proof holds |
| P-N7 death binding | `kill -9` the harness; close stdin; reparent under a subreaper; keep the stdio pipe open in a child of the harness | hud-mcp exits ≤ 2 s after detection in all cases (≤ 32 s worst case with inherited pipes); waiter exits `orphaned` ≤ 30 s; adapter child reaped; `lsof` clean |
| P-N8 cache report validity | synthetic fixtures with known hit/miss/unknown labels; one week of the user's local records | parsing and bucket statistics match the fixtures; the real report shows counts per bucket with no boundary claim |
| P-N9 baseline and failure tests | §4.10 | as stated |

## 8. Risks

(1) P-N1 reliability or notification content may differ from the observed case; then Claude parents keep the in-turn bounded wait plus `delegate_status` and the design loses its best path. (2) Codex pickup is a 10 s poll inside the TUI, idle-only and version-specific; long parent turns delay wakes. (3) Idle retirement depends on quiescence evidence; where it is unobservable, visible children live until `maxRunMs` (4 h) — visible in status, bounded, but not what the owner wants; after-report retirement does not depend on it. (4) Supervisor death remains a leak until Q10 (§4.7). (5) `wake.registered` stores a Codex thread id and a pi socket path: identifiers, not secrets; export keeps them out of non-local output. (6) Capacity counts `uncertain` runs; a burst of supervisor failures blocks new work until reconciled (intended, visible). (7) A wrong `auth` label flips the documented Claude TTL by 12×; the launcher records `unknown` rather than guessing. (8) The drainer's recovery timer is a periodic read in an otherwise idle process; it is bounded and only runs while delegations are active (§9).

## 9. Disagreements with the review and deliberate deviations

1. **hud-mcp death detection** uses stdin EOF plus a bounded 30 s `ProcessStamp` check, not pidfd or `PR_SET_PDEATHSIG` (§4.6). Reason: Node has no pidfd/prctl without native code; the death signal is thread-bound and cleared across fork, so it needs a harness-side wrapper and a per-harness spawning-thread guarantee. This is one of the options Pro listed; it is called out because it adds a periodic check to a process the contracts describe as idle-blocked.
2. **The drainer's recovery timer** (≤ 1 indexed read per 30 s per active registration, zero without delegations) is a bounded exception to P-06-3's "idle blocked" wording, inside the existing hud-mcp, not a daemon. Pro's recoverability requirement cannot be met without some bounded re-read; the budget is written into 06 (A6) rather than left implicit.
3. **No durable per-parent observation cursor.** Pro conditioned it on promising dedup across compaction; v2 does not promise that (wait stays zero-write, re-sync via `delegate_status`).
4. **After-report retirement does not require observed quiescence** (only idle retirement does), with unobservable pending-input treated as "proceed after the grace". Pro's eligibility list requires quiescence "if claiming idle retirement"; v2 reads that literally, because otherwise every visible child would live to `maxRunMs` whenever activity evidence is unavailable, which defeats the owner's requirement. The policy field `pendingInput:'unobservable'` makes the gap auditable.
5. **Codex stale-queue residual** cannot be fenced receiver-side (no extension point); v2 fences the sender (revocation before send) and validates ownership at `delegate_status`, and records the residual (§3.3) instead of claiming a receiver check.
6. **Surface close** keeps hud-run as the executor (Pro's order) but lists the pane-shell follow-up command as an equal alternative for B3b: a close that pre-empts its caller is awkward to test.
7. **`terminalNote` grows by one value** plus a structured `termination` object instead of several `retired_*` notes, keeping the 07 closed table small and letting B16 display cause, outcome and attribution separately.
8. A v1 correction the review did not catch: wrapper option C is withdrawn (`codex queue` rejects `--no-daemon`).

## 10. Changes from v1

| Pro item | v2 section |
|---|---|
| Ordered 1: ledger-recoverable delivery by an existing live process; offline/degraded documented | §3.1–3.4, D3 |
| Ordered 2: generation/incarnation-bound registrations, revocation, pi stale rejection before `triggerTurn` | §3.3, D7 |
| Ordered 3: verified eligibility; idle / blocked-wait / max-runtime deadlines | §4.2–4.3, D8 |
| Ordered 4: parent/helper death detection; supervisor-death gap; direct hud-run failure tests | §4.6, §4.7, §4.10 |
| Ordered 5: outcome / requested cause / observed termination / attribution separated; intent ≠ classification | §4.4, A2 |
| Ordered 6: Codex in-turn warming loop removed; idle queue delivery or event-responsive wait | §2.2 (`sleep` row), §5.3 step 3 |
| Ordered 7: handoff restricted to safe ownership boundaries; no implicit adoption; no automatic replacement of parents | §6, §5.3 step 2 |
| Ordered 8: cursor handling, coalescing, no `afterSeq: seq−1`, no duplicate-cost or three-wake claims | §3.4, §3.6, §3.7, D1 |
| Ordered 9: surface-close ordering, exclusive ownership, leave open when unsure | §4.8 |
| Ordered 10: replay-safe atomic capacity, uncertain retained, nested exhaustion | §4.9 |
| Ordered 11: cache reduced to configuration/provenance/uncertainty; no miss-gap TTL inference; no paid warming defaults | §5.2–5.4, D12 (owner decision 1) |
| Ordered 12: factual tables, P-N1 local status, real background invocation, crash windows, concurrent p95 | §2, §5.1, §7.3, §3.10 |
| Q1–Q9 rulings | Q1 §4.4/4.5; Q2 §4.9; Q3 §3.3; Q4 §2.2; Q5 §7.1 (B6 `waitCapMs`); Q6 §5.3; Q7 §6; Q8 §4.3; Q9 D14 |
| §2.4 waiter race/cleanup/compact output, real `run_in_background` test; §2.5 interrupted/attention wakes; §2.6 performance rules and compatibility rule | §3.5, §3.4 step 6, P-N1; §3.8, D4; §3.10, D15, A1 |
| §3.1–3.6 cache: separate provenance, no TTL from gaps, cache age, incremental cost model, Codex loop, MVP procedure | §5.1–5.3 (cost model deferred with warming; v1.1 preconditions in §7.1) |
| §4.3 waits cancelled on shutdown, helpers bound; §4.4 supervisor death | §4.1, §4.6; §4.7 (Oracle Q10) |
| §5 cuts (`--follow`/Monitor, pi retire, adaptive TTL, warming loops, exactly-one claims) and must-haves; §6 fact corrections and narrower evidence status for Codex internals | D1, D2, D7, D12; §3, §4, §6, §4.10; §5.1, §2.1–2.3 (version-labelled) |
| Owner decisions 1–2 | D12/§5.3; D11/§4.7 |

## 11. Items that still need a decision

Oracle (ARCH): Q10 supervisor-death containment (§4.7, options A/B; includes whether `setpriv --pdeathsig` or a cgroup scope is acceptable under 04 for headless and visible 甲); whether the bounded recovery timer and 30 s lifecycle check are accepted as explicit exceptions to P-06-3 (§9 items 1–2); the compatibility rule wording for new event kinds / notes across readers and export v1 (D15, A1/A2).

Owner: confirm the defaults in §4.3 and §4.9 (6/4 slots, 10 min/2 min/60 min/60 min/4 h) and `wake.recoveryMs = 30 s`; whether `hud cache report` is MVP (ORD) or v1.1; the after-report policy when pending input is unobservable (§9 item 4: proceed vs wait); surface close executor (hud-run final action vs pane-shell follow-up, §4.8) — or leave it to B3b; whether the `waitCapMs` override (Q5) is wanted at all in MVP; the Codex stale-queue residual (§3.3) as accepted behaviour.
