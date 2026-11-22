# PIROLE — owned pi role dispatch

## 1. Recommendation:

**Recommendation:** Replace the external pi-roles launch dependency with a release-pinned HUD worker extension and small in-process TypeScript launch/helper/reap modules, preserving the existing worker behavior and observation files while keeping ordinary-session integration, execution ownership, and display separate.

## 2. Reasons and evidence

Design inspection was read-only, against the checkout observed at `ff82d87`; this is not implementation or live acceptance. The checkout has a `.codegraph/` index despite the historical agent-guide note. No personal source is to be copied wholesale. The private reference paths below are inspection evidence, not runtime dependencies or public fixture content.

1. **The facade already owns the right outer transaction.** `src/roles/facade.ts:1069–1097,1177–1218` pins an existing request before resolving new routing, writes the receipt/index/association before launch, and serializes mutations. `openDispatch` persists `launch='sent'` before execution (`:821–852`). Retain these boundaries, rather than moving job creation into a pi tool or adding a controller service.
2. **The external transport is a small, replaceable seam.** `src/roles/pi-dispatch.ts:72–86,144–167` discovers and executes two PATH programs, with separate launch/reap deadlines and deliberate suppression of the second notification channel. The direct fallback still executes `pi-role --args-json` (`src/roles/facade.ts:204–206,724–741`). Neither is independence.
3. **Preserving the files avoids a UI rewrite.** SESSION validation requires eight keys and an empty ORCH (`src/roles/pi-dispatch.ts:108–141`). STATUS parsing binds task, slot, role, and output (`src/roles/pi-dispatch-status.ts:59–107`). Its observation logic distinguishes completion, continuation, historical unanswered questions, and unreadable evidence (`:157–238`). The collector uses those same parsers (`src/collectors/job-observations.ts:80–115`).
4. **The real worker contract is larger than launching pi.** The reference has final-settlement/output-change checks, generation-fenced idle grace, helper eligibility, warming admission, and clean one-shot autoclose (`Fishpref/pi-roles/extensions/dispatch.ts:103–157,169–226,291–340`; `extensions/dispatch-policy.ts:41–81`). Replacing it with an `agent_end` listener or “report exists” check would regress behavior.
5. **Helper execution belongs to the running implementer, not the parent MCP.** The reference reserves numbered artifacts under one task lock, executes one helper at a time, and validates both STATUS and output (`Fishpref/pi-roles/bin/pi-role-call:76–145,181–226`). The HUD must not start a reviewer from a verdict/completion observer. Concept §15 expressly keeps chaining in the main session (`docs/universal-hud-concept.md:765–793`).
6. **Autoclose needs one finite post-exit process, not a daemon.** The reference starts its reaper before a successful one-shot shuts down, then waits for that exact process to exit (`Fishpref/pi-roles/extensions/dispatch.ts:103–118`; `bin/pi-role-reap:148–167`). Closing the tab from the dying pi process cannot reliably finish and verify its own cleanup.
7. **No dependency on personal role resources does not mean replacing harness authentication.** The orchestrator clarified this explicitly below. Installed pi's native CLI supports explicit extension/skill/tool/model/session selection; `-ne` does not disable settings, auth, or base instruction files. See installed pi 1.5.0 `docs/cli.md`, “Resources” and “Models”, and `docs/configuration.md`, “Agent directory”.
8. **Herdr's pi integration is an execution dependency, not a personal optional extension.** With permission, I read the installed herdr-managed integration and ran only read-only help/status commands. `herdr integration status` reported pi `current (v9)`; its header identifies `HERDR_INTEGRATION_ID=pi` and version 9. It reports the exact session and state through `pane.report_agent_session` / `pane.report_agent`, with bounded socket attempts. This observation is not a launch smoke or a universal version gate.
9. **A2/A5 already settle ordinary-session ownership.** `docs/reviews/2026-11-09-r6a-plan-architect.md:123–134,202–224` specifies the epoch-fenced evidence channel, six proxies, one package entry, and status segment rather than a second footer. PIROLE should not create another MCP bridge or footer owner.
10. **Private writes and passive reads remain required.** `docs/ARCHITECTURE.md:807–850` requires pure rendering and private atomic state. Concept §15 independence (`docs/universal-hud-concept.md:919–942`) supersedes PATH dispatch. Contract 01's opening amendment retains native identity isolation; contracts 06/07 retain bounded observation, unknown-versus-zero, and material-egress boundaries, not the retired general ledger executor.

### Explicit rulings obtained during this consult

These are decisions, not unresolved alternatives:

- **q1 — preserve inherited worker behavior:** keep QA's 1,200-second wait and its “proceed with your proposed default” result on timeout, reviewer limit **3**, sonic limit **10**, one helper at a time, and bounded operations. Put these in named constants, not a new policy configuration surface. Do not silently remove them on the theory that the HUD is passive. This ruling specifically resolves the conflict with general project repair-count guidance for this imported worker contract; it does not cap the separate project implementation/re-review workflow.
- **q2 — routing and auth:** add a narrow optional `pi_helpers` routing table for internal helper model/effort, snapshot it at parent creation, and keep mixed public presets valid. Installed pi retains its normal auth/models home; no credential copying or HUD OAuth subsystem. HUD credentials are for HUD API calls, not pi provider authentication.
- **q3 — herdr integration:** resolve the pi integration from `herdr integration status`, require `current` and the herdr-managed ID/version header, record the version, and load it explicitly. Missing/outdated returns `herdr_pi_integration_missing` with the instruction `herdr integration install pi`; never install it automatically. Cache discovery per HUD process; do not do it on render. Do not copy or reimplement this integration.
- **q4 — native settings:** pin all relevant available argv controls, including `--no-approve`. Native retry, compaction, transport, cacheWarming, and base instructions remain pi behavior. No personal-settings rewrite or private settings-manager patch. The HUD's warming hooks retain the reference semantics, but cannot promise warming when pi disables it.

## 3. For the implementer

### A. Inventory: take the execution contract, not the personal toolkit

| Reference piece | HUD destination / disposition |
| --- | --- |
| `bin/pi-dispatch` | Port its behavior into `src/roles/pi-owned/launch.ts`: preflight, owned tab, implementer split, start, prompt once, evidence-based stall recovery. No public replacement binary is needed. |
| `bin/pi-role` | Replace argument construction with `src/roles/pi-owned/argv.ts`; no subprocess to build argv, role-name search, personal package discovery, or shell argument parsing. |
| `bin/managed.mjs` | Do not port the legacy runtime-context/runner/resume system. Reuse only the ideas of explicit immutable role/model/session inputs and effective-value validation. |
| `extensions/roles.ts` | HUD role loading, system-prompt role section, fixed tool selection, output authorization, and QA registration in `src/harness/pi/role-extension.ts`. No `/role` switching or arbitrary role-file lookup. |
| `extensions/dispatch.ts`, `dispatch-policy.ts` | Port lifecycle/helper/warming semantics into a small pi event adapter plus pi-free lifecycle functions. Remove ledger/rating calls, not lifecycle behavior. |
| `bin/pi-role-call` | `src/roles/pi-owned/helpers.ts`, called directly by the worker extension. Number allocation, wrappers, right pane, wait, cancellation, validation, bounded cleanup. No Bash/Python wrapper process. |
| `extensions/qa.ts` | `src/roles/pi-owned/qa.ts`: compatible question/answer files and inherited timeout behavior. No shell notify or orchestrator-pane push. |
| `extensions/interaction.ts` | Reuse the atomic-write principle through existing HUD private-file helpers. Do not add managed UUID requests/responses beside the existing QA protocol. |
| `bin/prompt-stall.mjs` | `src/roles/pi-owned/prompt.ts`, shared by primary and helper launches. |
| `bin/pi-role-reap` | `src/roles/pi-owned/reap.ts`, plus a narrow finite `reap-main.ts` entry for post-exit autoclose. No sweep service. |
| `extensions/guard.ts` | `src/roles/pi-owned/guard.ts`, public-safe implementation and tests of inherited read-only guard behavior. |
| Four role texts; helper-pane skill | HUD-owned resources under `integrations/pi/roles/` and `integrations/pi/skills/helper-pane/`. Only implementer, reviewer, sonic, architect. |
| `bundle.ts`, `bundle-registration.ts` | Do not port arbitrary package aggregation or collision policy. A fixed HUD worker entry and a separate explicit herdr entry need no general extension bundler. |
| Herdr state integration | External herdr-owned dependency discovered and explicitly loaded per q3. Not copied into the release. |
| Ledger, labels, ratings, `pi-run*`, stats, `rate_helper`, AB metadata, DeepSeek search extension | Leave out. The facade, waiter, and job collector do not need them. No personal ledger directories, model-rating calls, or private key discovery. |
| Personal MCP adapter, lens, TPS, p10k, copy UI, request-budget extension | Leave out of workers. Do not make missing personal resources a launch dependency. Public role instructions must not advertise unavailable tools. |
| Security variants, informer, headless/manual neighboring-pane mode, generic notify, `/role`, arbitrary role overrides | Not part of the facade's four pi-backed roles. Do not expand the public role enum or implement these convenience entrypoints. |

Keep the existing `src/roles/pi-dispatch.ts` **read-side codecs/types lightweight**. Move mutating implementation behind dynamic imports of `pi-owned/*`; `hud wait`, STATUS collection, and paint must not import the pi SDK, routing parser, helper launcher, or reaper merely to decode a receipt.

### B. Files, responsibility, and state layout

Suggested ownership, allowing adjacent tiny pure functions to share a file:

- `src/roles/pi-owned/contracts.ts`: owned receipt/launch contract codecs, resource identity, finite error codes, inherited constants.
- `argv.ts`: pure pi argv construction and role resource selection.
- `launch.ts`, `prompt.ts`, `helpers.ts`, `reap.ts`: asynchronous orchestration using the existing bounded `runHerdr` transport.
- `lifecycle.ts`, `qa.ts`, `guard.ts`: pi-free decisions/protocol functions.
- `src/harness/pi/role-extension.ts`: one installer of role tools and pi event handlers; actual pi context is supplied here, not faked by the facade.
- `integrations/pi/worker.ts`: thin shipped worker entry importing the built role extension through a release-relative path.
- `src/roles/pi-owned/reap-main.ts`: finite post-exit adapter to the same reap implementation, not another implementation.
- Extend existing `facade.ts`, `job-receipt.ts`, `pi-dispatch.ts`, `pi-dispatch-status.ts`, `job-wait.ts`, routing and tests only where the owned transport discriminator requires it.

Let `J = realpath($HUD_HOME/jobs/<job-id>)`, `R = the immutable release root`:

```text
J/
  receipt.json                 facade request/binding/outer lifecycle
  brief.md                     existing task wrapper, fixed primary input
  report.md                    primary's model-written artifact
  SESSION.txt                  compatible location projection
  STATUS.json                  primary extension's single-writer snapshot
  sessions/                    pi session files, primary and helpers
  qa/qN.md                     exclusive-create question
  qa/qN.answer.md               existing hud_respond delivery
  impl-notes.md                 implementer claims, not trusted verification
  sonic-q-N.md                  implementer-authored sub-request
  sonic_brief-N.md              generated helper wrapper
  review_brief-N.md             generated review/re-check wrapper
  sonic-N.md, review-N.md       model-written helper artifacts
  .dispatch/
    control.json               closing fence and generation; no heartbeat
    primary/
      contract.json            immutable per-slot launch inputs
      launch.json              launch intent/step acknowledgments
      owner.json               exact worker/process/session observation
    sonic-N/, review-N/
      contract.json, launch.json, owner.json, STATUS.json
    current.json               compatible helper_pending handoff
    cleanup.json               last bounded cleanup outcome/remaining evidence
```

All HUD-authored task/runtime files are private: directories 0700, files 0600, bounded regular-file reads, atomic temp+rename except exclusive-create reservations. Reuse HUD writers rather than the reference's plain `writeFileSync` SESSION writes. Do not put task state in the caller's repository `tmp/tasks`, infer task directories from cwd, or accept a model-selected output root. The worktree remains the worktree: authorized code changes are not HUD metadata and remain there. Temporary files created by this implementation belong under J, not a global pi-roles directory.

A sonic request may be an existing caller-authored file in the worktree; read it as input with a bound, snapshot the requested sub-brief under J, and generate the actual helper wrapper there. No output path in that request can redirect the helper artifact. The primary wrapper must likewise make J/report.md authoritative. Existing request text remains unchanged as task content, not executable shell.

**Separate writers:** facade writes receipt/index/association; launch module writes launch journals/SESSION; each pi instance writes only its own STATUS/owner record; reaper writes cleanup evidence, not another writer's STATUS. Before a worker exists, launch failure belongs in the launch journal. After a worker exists, cleanup failure does not overwrite a concurrent valid terminal STATUS. The read-side owned-transport projection combines these facts without pretending an ambiguous start is a failed model run.

### C. Receipt and launch contract

Keep `JobReceipt.schema=1` and the public six tool schemas. Change only the nested dispatch transport to a versioned union:

```ts
type PiDispatch = LegacyDispatchV1 | {
  contract_version: 2;
  transport: 'hud-owned';
  role: 'implementer' | 'sonic' | 'reviewer' | 'architect';
  launch: 'unsent' | 'sent' | 'acked';
  release: { id: string; root: string };
  contract_path: string; // exactly J/.dispatch/primary/contract.json
  continuation?: {
    message_key: string;
    previous_session_id: string;
    previous_settled_at: string;
  };
};
```

No `executable`/`reaper` pretending to be PATH discoveries in v2. Unknown nested versions refuse mutation. Legacy v1 remains readable. Validate release identity against the installed release inventory, not an arbitrary path from job content; a missing release is an actionable unavailable-owner result, never permission to use the new current release.

Each immutable slot contract contains: schema, job, slot, role, canonical J/cwd, exact brief/output/QA/session-directory paths, newly allocated session ID, release ID, role resource path/hash, resolved model/effort, an explicit launcher-authored `allowed_write_paths` list (the exact report for read-only roles), helper binding snapshot for a primary, and the validated herdr integration path/version. Merely naming `output_path` does not grant write permission; validate the separate authorization. Preserve the inherited QA/temp exceptions and document them as guard exceptions, not permission to edit the worktree. Fixed role eligibility and limits come from the pinned release, not model arguments. Store no keys or copied auth files. Session ID allocation before start makes the expected new session explicit; an existing matching session is a collision, not permission to resume it.

Launch journals retain intent/acknowledgment per side effect: tab create, split, agent start, prompt submit, and optional recovery Enter. Include random job-correlated tab label, bounded unique agent names, exact returned locators, intended session ID, and the launcher process instance. Do not use basename-derived names that collide between two tasks. Persist intent **before** each call. An intent without acknowledgment is uncertainty, not a retry queue.

Ownership uses the recorded herdr instance/endpoint identity, tab/pane, unique label/name, exact session path/ID, and worker process stamp where available. SESSION is a compatibility projection, not the sole new control authority. A bare PID, agent name, cwd, or `agent_session` from an unrelated pane never proves ownership.

### D. Exact worker argv and preflight

Do not launch a `pi-role` shell script. For each slot, use the existing herdr argv transport:

```text
herdr agent start <recorded-agent-name> --kind pi --pane <recorded-pane>
  --timeout 30000 --
  -ne -ns -np --no-themes --no-mcp --no-approve
  -e <R>/integrations/pi/worker.ts
  -e <validated-herdr-pi-integration-file>
  --hud-role-contract <J>/.dispatch/<slot>/contract.json
  --hud-role-file <R>/integrations/pi/roles/<role>.md
  --model <resolved-provider/model>
  --thinking <resolved-effort>
  --tools <exact-comma-separated-role-tools>
  --session-dir <J>/sessions
  --session-id <new-slot-session-id>
  --tui-mode regular
```

For implementers additionally pass:

```text
--skill <R>/integrations/pi/skills/helper-pane/SKILL.md
```

These are **array elements**, not a shell string. Spaces, Unicode, apostrophes and metacharacters in safe paths stay within their own argv elements; reject NUL/newlines where the SESSION/single-line prompt contract requires it. Do not carry over `launch.ts`'s restricted shell-token parser to structured argv. The worker extension registers the two `hud-role-*` flags. It cross-checks the explicit role file against the contract/release; it does not consult `~/.pi/roles`, `PI_ROLE_BUNDLE`, or arbitrary `--role-bundle` sources.

Tool lists:

- Implementer: `read,bash,edit,write,grep,find,ls,ask_orchestrator,call_sonic,call_reviewer`.
- Sonic: `read,bash,edit,write,grep,find,ls,ask_orchestrator`.
- Reviewer/architect: `read,bash,write,grep,find,ls,ask_orchestrator`.

The fixed facade currently grants no `--allow-review` capability to primary sonic; preserve that, and never grant a nested review to a sonic helper. Helper execution checks eligibility again even if tool activation is accidentally broadened. No `call_architect`, `rate_helper`, or six general HUD create tools in a role worker.

Preflight, before tab creation:

1. Validate private job paths, brief, release resources, routing snapshot and supported role; require actual model and effort values.
2. Locate the declared herdr/pi execution dependencies without installing/updating them. Discover `herdr integration status` once per launch-owning process, bound its output/time, parse the pi row, and validate managed header/version. Recheck file identity when using cached discovery. Do not hardcode the inspected home path or v9 as the only accepted version.
3. Preserve the current rejection of unsupported pi `env_profile` launches until their actual delivery through herdr has a separately proved contract. Running the local herdr CLI with an env value does not prove the target pane inherited it.
4. The launched extension validates its actual role, session ID/path, model and thinking level before allowing a provider turn; pi can fuzzy-match models or clamp effort. A mismatch is explicit failure, not a silently different model. Publish startup evidence before the launch is considered acknowledged. Extension-load failure must not permit an unguarded model run: the launcher submits no initial prompt until matching startup evidence exists.

No notify/orchestrator flags. SESSION ORCH stays empty, and the HUD role extension ignores personal `PI_ROLE_*` notify/role/QA overrides. **Do not remove the worker's actual HERDR_PANE_ID/socket environment:** the separately loaded herdr integration needs its own pane identity. Parent pane identity is not a worker notification address.

**Inherited harness behavior, deliberately retained:** pi auth/models, base `SYSTEM.md` / `APPEND_SYSTEM.md` and context instructions, native retry, compaction, provider transport/proxy settings, cacheWarming, and native cache-retention selection. Available argv controls override default model/effort/tools/session/resource selection. `--no-approve` prevents project `.pi` configuration/resources; normal project AGENTS/CLAUDE discovery remains. Do not claim a hermetic pi configuration or edit user settings to obtain one. Warming uses pi's events, never a second provider client.

### E. Launch, helpers, stall recovery, and resource lifetime

**Primary launch:** inside the existing key/job transaction discipline, pin release/routing, write brief/contracts, then persist dispatch intent. Create one unfocused tab with the recorded unique label:

```text
herdr tab create --cwd <cwd> --label <label> --no-focus
herdr pane split <left> --direction right --ratio 0.5 --cwd <cwd> --no-focus
```

The split is for implementers only. Record tab/left immediately, then right after its successful creation, atomically updating SESSION. Start pi with the argv above. Once its startup evidence matches, submit exactly one single-line prompt:

```text
herdr agent prompt <name> "Read <J>/brief.md and do exactly what it asks."
  --wait --until working --timeout 30000
```

**Stall recovery:** share one implementation for primary/helpers. Only the specific `agent_prompt_stalled` result is eligible. Re-read the just-started agent and verify recorded name, pane and session identity. Read only its exact task-local session file, never scan for the newest session. A matching persisted user message proves submission, so do nothing further. Otherwise require idle state and the complete original prompt in the detection editor (soft wraps allowed), persist an Enter intent, and send exactly one `pane send-keys <pane> Enter`. Wait once: up to 120 seconds for primary, 60 for a helper, clamped to the operation's remaining budget. A lost Enter acknowledgment is never another Enter. Unreadable/oversized evidence stays unknown; no resend or relaunch.

**Helpers:** `call_sonic({brief_path, thinking?:'low'|'high'})` and `call_reviewer({})` call the TypeScript helper module inside the primary pi process. No long-lived wrapper or MCP server is started. Reserve a numbered brief under the task helper mutex; max(existing numbered briefs/artifacts)+1 is the next round, including failed reservations. Keep the inherited 10 sonic / 3 review limits. Pin the helper binding from the parent's contract; explicit sonic thinking overrides that helper's snapshot default only. Record waiting_helper before side effects and `.dispatch/current.json` after reservation. Create a fresh pi session for every helper/re-check. Return at most 50 KiB/2,000 lines plus the full artifact path.

Use the task's recorded right pane, and verify it belongs to the task tab. If a previously recorded pane disappeared, create a new right split inside that same owned tab and record it. Do not adopt an arbitrary right neighbor. An unrelated occupant blocks the call; only a verified own idle helper can be retired and its empty pane reused. Helper success requires matching closed STATUS, changed nonempty artifact, and for review the exact first line `Verdict: accept` or `Verdict: changes-required`. Herdr idle/done alone never proves success.

**Concurrency and close:** distinguish the single-helper execution mutex from a short resource-mutation lock shared by launch/helper/reap. Do not hold the latter for a 90-minute model run. Closing writes a durable fence under the resource lock; each create/start/prompt step checks it under that same lock immediately before dispatch. An already-admitted bounded transport is accounted for before cleanup can claim completion. Never expire a lock merely because its timestamp is old; use the existing process-instance-aware lock discipline. A crashed helper reservation is inspect/cleanup-only, not a reason to take another helper slot. Parent shutdown cancels its in-flight helper operation and awaits bounded cleanup; a SIGKILL is recovered by explicit `hud_close`, not automatic restart.

**Budgets:** retain the outer launch ceiling of 300 seconds and reap ceiling of 180 seconds (`pi-dispatch.ts:15–16`). Use one monotonic deadline per operation, not a fresh full budget for each subcall. Ordinary metadata herdr calls get at most 15 seconds; readiness/prompt submission uses the documented 30-second wait within the remaining ceiling. Helper work ceilings remain 45 minutes sonic / 90 minutes reviewer, plus a separately bounded cleanup phase. Cancellation reaches in-flight transport immediately; dispose timers/listeners/pipes and stop only owned transport children. A killed CLI is not evidence its server-side action never happened.

**Crash matrix to implement:**

| Window | Required result |
| --- | --- |
| Intent persisted, no side effect dispatched | An explicit unsent step may execute once after valid admission; an already-sent ambiguous step may not. |
| Tab created, reply/journal/SESSION lost | Reconcile exact persisted label/instance and returned evidence if sufficient; otherwise launch_unknown/close_unresolved. Never create a replacement tab or close a guessed match. |
| Split created, reply lost | No second split; preserve unresolved ownership until the exact resource is corroborated. |
| Agent started, startup evidence/ack lost | No second start; use exact intended session and recorded pane/process evidence, or remain unknown. |
| Prompt/Enter sent, ack lost | Read-only reconciliation; never resubmit it. |
| Output written, no final settlement | Not DONE. |
| Terminal STATUS, pi still shutting down | Result may be DONE; cleanup is not yet confirmed. |
| Close races helper start or continuation | Closing fence wins future admissions; account for already-submitted work, no new launch after fence. |
| Parent MCP exits/restarts | Existing pi jobs continue; same-key lookup returns existing ownership, no new dispatch. |

### F. Lifecycle, QA, DONE and cleanup continuity

**STATUS remains version 1.** Keep the existing required fields and nullability: `task_dir`, `slot`, `role`, `session_id`, `model`, `thinking`, `output_path`, `output_written`, `state`, `helper_pending`, `settled_at`, `idle_deadline_at`, `ended_at`, `exit_reason`, `error`. Also retain useful producer fields `session_file`, `pid`, `started_at`, `updated_at`, `parent`, `effort_source`, and `warm` admission facts. Retain `helper_pending={kind,n,status_file}` and the current slot/output naming. Do not make ledger-only project/AB/statistics fields mandatory. Store stronger ownership separately so existing STATUS readers need no broad schema migration.

**SESSION remains compatible:** TASK, TAB, TAB_NAME, LEFT, RIGHT, ORCH, BASE, PRIMARY; TASK is basename(J), ORCH is empty. BASE is a bounded launch-time Git observation, falling back to the existing `HEAD` convention when unavailable. Never source SESSION. RIGHT updates remain readable by the old parser; preferably rewrite atomically rather than append. `RIGHT_SPLIT` is unnecessary for the new always-owned-tab topology; readers may continue ignoring it in legacy files.

**Settlement:** use `agent_settled`, not `agent_end`. At each new turn cancel the prior timer, increment generation, capture the output signature, and reset turn completion facts. After settlement defer one event-loop turn and recheck idle, pending messages, active helper, all QA calls, generation, and nonempty changed output. Aborted/final-error/missing or unchanged output fails. Never synthesize report.md from stdout or the final chat response.

One-shots close themselves after successful settlement. Implementers enter `idle_grace` for the selected model's declared cache TTL (unknown TTL = 0), publish DONE immediately when guarded settlement is ready, and exit at that fixed deadline. New work cancels the old deadline; model changes may shorten it, never extend it. Warming does not renew it. Clean shutdown during successful grace remains closed; external shutdown during work remains failed. Role/session replacement or tree navigation fences dispatch rather than resuming a checkpoint.

**Warming:** preserve the reference decision ordering: closing/failed/disabled or invalid/exhausted estimated budget → stop; helper pending → request warm; settled → stop; otherwise retain pi's action, still subject to the cap. USD 0.50 per pi session is the inherited estimated-admission cap, not a billing guarantee; failed admissions are not refunded. No background warmer, usage scanner, ledger, or automatic effort upgrade.

**QA:** retain question/options/default/context Markdown and `qN.answer.md`; one exclusive-create allocator across primary/helpers, accounting for answer-only slots and gaps. Bound IDs to the facade's supported q1–q9999 grammar and fail visibly at exhaustion rather than create an unanswerable question. Keep the 2-second abortable read cadence and 1,200-second wait. On timeout return the inherited instruction to proceed with the suggested default; do not fabricate an answer file. On cancellation return interruption, not the timeout/default result. `hud_respond` retains idempotency/conflict/stale-answer handling and `consumed:false` (`facade.ts:1488–1528`). Writing an answer is not proof the worker read or followed it.

The actual timeout/default tool result is recorded in pi's job-local session. A missing answer alone is **not** evidence of default adoption. q1 requires recording what occurred, not creating a new deadline/decision policy. Coordinate a bounded passive extractor for this exact tool-result fact with the R5-UX records owner; label it “timeout; default instructed” unless subsequent evidence proves an action. Do not invent a Home default countdown, fabricate a human answer, or expand P2/P3 rendering in this implementation.

**Wake path:** compatible STATUS observations remain the durable source of `DONE`, `FAILED`, `QUESTION`, `BLOCKED`; the existing caller-armed `hud wait` supplies native background delivery. Keep independent waiter cursors/watchers and continuation suppression. Do not push an additional `[role@task] DONE` prompt via ORCH/notify. Completion is not acceptance or merge. A helper finishes into the implementer's tool result, not a second parent wake.

**Continuation:** keep the same-key message journal and `previous_session_id/previous_settled_at` fence. Live implementer grace permits same-session continuation before expiry; a stale terminal snapshot must not satisfy its new wait. Expired/exited/failed slots return continuation_unavailable. Never spawn a replacement or reopen the session as an implicit resume. Preserve existing supported sends while a live turn is running, with no retry after ambiguity.

**Reap:** all explicit and automatic cleanup calls share one implementation. First establish the closing fence; then verify exact owned resources, request `/quit` where appropriate, and use one shared grace of at most 30 seconds for agents to detach. If a remaining recorded pi process requires SIGTERM, require its full process instance (start/boot identity), exact launch contract/session arguments, and matching ownership, not the reference's loose “argv contains task path” predicate. No process-name kills, process-group sweeps or SIGKILL of pi workloads. Unknown/reused process identity is unresolved, not permission to signal. Keep observations and signal delivery limits honest; PID inspection alone is not an atomic OS handle.

Before tab close, reread its identity/label, panes and agent inventory. Every occupant must be gone, the tab must still be the recorded task tab, and no caller/orchestrator or unrelated occupant may be affected. Missing resources are success only when ownership and all previously submitted operations are accounted for; empty inventory without a recorded create outcome is not proof of cleanup. Repeated close is idempotent. External-association records never grant reap authority.

**Autoclose:** only clean successful one-shot primary TUI jobs use it, matching the reference. Spawn the pinned release's finite reaper entry with Node, detached/no inherited pipes, job/expected release/process stamp; it waits at most 30 seconds for that exact primary to exit, then invokes normal reap within the remaining bounded cleanup budget. At most one attempt per primary; do not recurse or retry. Helpers do not close their parent's tab. Implementer and failed-primary tabs remain until explicit close for inspection; their agents still follow settlement/shutdown rules. Thus DONE and job-resource closure are intentionally separate. The existing keep-tab diagnostic escape may suppress the automatic attempt; it never grants ownership or skips explicit cleanup.

### G. HUD-owned role texts and routing

Author new public-safe texts from the inspected responsibilities, not by copying private environment paths, current task data, model telemetry, or personal tooling instructions. Preserve the role contract:

- Implementer implements the scoped brief, owns its sonic choices, executes the supplied tests, uses a fresh closing reviewer, and asks the main session about design forks.
- Reviewer independently checks the specified diff and tests, is read-only apart from its report, and emits the required verdict line.
- Architect is a read-only design adviser called by the main session, never by worker helper tools.
- Sonic does fully specified small work, not test authoring, bug diagnosis/measurement, or design judgment; no nested helpers.

Keep inherited no-commit/no-terminal-question and report obligations. The helper skill describes tool calls, J-local artifacts, single-helper execution and limits, not `pi-role-call` commands, private skills, or a hardcoded review model. For code navigation describe the tools actually available: normal read/grep/find, plus a repository's independently installed CodeGraph CLI if its instructions require it. No implicit installation or personal MCP import.

Put model/effort defaults in routing/default data, **not prose or role frontmatter that can override argv**. Defaults: imp `openai/gpt-6.1-sol/high`; reviewer `openai/gpt-6.1-sol/xhigh`; oracle's pi binding `openai/gpt-6-astra/high`; sonic `mistral/deepseek-v4-1-flash-1017/high`. Existing explicitly configured public backends still win; do not overwrite routing.toml or replace web oracle bindings.

Approved additive routing schema, keeping schema 1 backward readable by the new parser:

```toml
[pi_helpers.sonic]
model = "mistral/deepseek-v4-1-flash-1017"
effort = "high"

[pi_helpers.reviewer]
model = "openai/gpt-6.1-sol"
effort = "xhigh"
```

Only these two keys and optional model/effort fields; no executor, commands, paths, policy limits or credentials. Missing fields use the HUD defaults. Validate sonic effort against the inherited low/high tool contract; reviewer effort uses the existing pi effort vocabulary and actual startup capability check. `call_sonic`'s explicit thinking wins for that invocation. Snapshot the effective pair at parent creation; later routing edits affect only new parents. Public `reviewer=claude-opus` still means Claude for `hud_create(role='reviewer')`, not for imp's internal pi reviewer.

Version role texts, helper skill, constants, extension and codecs together in A1's immutable manifest. Contract records retain hashes for provenance. A running primary's later helper must load the same release even after activation changes. No role-resource override directory or personal role fallback is needed. Because old routing parsers reject unknown keys, document that rollback to an older executable requires restoring the corresponding routing configuration; do not silently strip the new table.

### H. A1/A2/A5 boundaries and removal

- **A1 owns packaging/activation:** inventory the worker entry, built transitive closure, four role resources, skill and finite reaper. No import outside the installed artifact or into a source checkout. Pi host modules stay peer/external dependencies supplied by pi; no vendored second SDK. Running jobs retain release pins; no release GC. Integration-header/version discovery is runtime dependency evidence, not release-owned bytes.
- **A2 owns ordinary-session authority:** its six tool proxies and fd3 evidence channel remain canonical. A task's dispatch contract is not proof of an ordinary main-session identity and cannot substitute for an A2 epoch. Share only existing evidence/path utilities where genuinely needed.
- **A5 owns ordinary pi package registration, `/hud`, panel lifecycle and status segment.** Ordinary `package/extensions/hud.ts` composes the A2/A5 installers. Explicit `worker.ts` composes only the role installer; `-ne` prevents the ordinary package loading again in a worker. Both use one implementation of shared helpers, but have mutually exclusive owners. Workers do not auto-open a HUD side panel, register six general role tools, or own a footer. The separately loaded herdr integration owns herdr state reporting only.
- **PIROLE cutover removes new-job PATH discovery and direct-pi fallback now.** Delete calls to `discoverDispatch` and `runCommand('pi-role',...)` from the active creation graph. Keep `recipe='pi-role'` as a routing compatibility spelling mapped to the owned adapter; renaming users' presets is unnecessary. Missing resources fail explicitly, never select the direct path.
- **Legacy records:** retain read codecs and observation fixtures. A new release does not execute a stored Fishpref reaper path, import private pi-roles, or adopt/relaunch an old direct-pi job. Return a finite legacy-owner handoff for mutations that require its old executor. Drain those jobs through the already-running owning release before switching active control; document this in A1 activation rehearsal. Read-only old history remains visible.
- **R6b owns physical retirement after drain:** obsolete generic direct launch helpers/adapters/tests, legacy host/bridge/dependency pruning, compatibility surface removal and release retirement. PIROLE must not remove unrelated Codex/Claude/Grok/Jev adapters. Old fake pi-dispatch/pi-role programs may remain solely for frozen compatibility tests until R6b; new positive tests must execute the owned code.

### I. Ordered independently mergeable packages

These are PIROLE slices, not replacements for A1/A2. Each receives its own implementation brief and fresh independent review; integration follows the active STATE gate, not an invented all-history gate. Respect the three-implementer project limit.

| Slice | Files and merge boundary | Dependencies / overlap |
| --- | --- | --- |
| **PR1 — Contracts, routing and public resources** | New `pi-owned/contracts.ts`, `argv.ts`, pure lifecycle/guard/QA pieces; four role texts and helper skill; narrow `routing.ts` extension, docs/examples and codec tests. Add v2 decoding without selecting it for production launch. | Can start alongside A1/A2 after interface agreement. Shared routing edits serial; no R5 UI overlap. |
| **PR2 — Owned herdr orchestration** | `launch.ts`, `prompt.ts`, `helpers.ts`, `reap.ts`, finite reaper entry; bounded transport cancellation support if required in `herdr-run.ts`; expanded fake herdr and process tests. Not selected by the facade yet. | After PR1; contract/path/lock seams fixed. No A2 caller or A5 UI ownership changes. |
| **PR3 — Pi worker extension** | `src/harness/pi/role-extension.ts`, `integrations/pi/worker.ts`, lifecycle/QA/helper wiring and real-loader tests. Invoke PR2 directly. | After PR1/PR2 interfaces; may develop against their fixed seams before merge. A1 owner serially inventories new artifact closure. |
| **PR4 — Facade cutover and compatibility** | `facade.ts`, lightweight `pi-dispatch.ts`, receipt/status/waiter decoder changes, applicable collector union handling, positive owned-path tests, legacy-owner refusal tests. Disable PATH/direct launch for new pi jobs. | After PR1–PR3 and artifact-loading tests. Coordinate A2's context seams; do not edit its resolver. Shared collector hunks serialize with R5 passive-record work. |
| **PR5 — Artifact rehearsal and acceptance kit** | A1 manifest/import-closure tests and isolated `tests/integration/pi-owned-*` probes/runbook; record real-client/owner checklist. Any passive timeout-result extractor is a separately assigned R5 records hunk using PR3's proven tool-result shape. | After PR4; A1/A5 integrated entry tests. Owner activation and R7 live scenarios remain separate gates. |

**R5-UX P2/P3 overlap:** no PIROLE edits to `src/tree-page.ts`, `src/render/*`, settings or i18n. Keep SESSION/STATUS/artifact names stable so current passive readers keep working. Any q1 timeout/default fact presentation is a handoff to P2/P3, not a new renderer inside dispatch. P3a's job-material authority remains the only route for job text into summaries; neither a role association nor a new session path grants model-egress permission. `external-association.ts` needs regression tests, not new cleanup authority.

### J. Test-plan headings and required evidence

**PR1 — Unit / real temporary files**

- Strict v1/v2 decoding, unknown version, wrong role/slot/output/release, private/symlink/oversized paths, output outside J, paths with spaces and shell metacharacters.
- Routing defaults, partial overrides, mixed public preset, invalid helper keys/efforts, pinned snapshot across routing changes.
- Role/skill text contract: no private paths, unavailable tool claims, personal resource lookup, model prose overriding routing, or unwanted ledger/search/rating dependency.
- Guard: edit blocked; exact report allowed; unauthorized writes/mutations denied; simple quoted `>` allowed; real redirect/complex-shell cases retain inherited conservative behavior. State explicitly that the shell guard is not a security sandbox.

**PR2 — Process tests with fakes**

Execute the real orchestration modules against a subprocess fake herdr, not a fake dispatcher that fabricates the final expected state. The fake must represent panes, occupants, exact sessions, delayed actions and lost replies.

- Assert receipt/index/association and each step intent exist when the fake receives a mutating request.
- Inject crash/lost response before and after tab/split/start/prompt/Enter; rerun same key and prove **zero duplicate side effects**.
- Reused tab ID/label/name/PID, changed process start/boot, foreign right-pane occupant, stale SESSION, unknown inventory, parent-tab protection, concurrent close/start, blocked helper and abort.
- Shared cleanup deadline rather than N times 30 seconds; partial cleanup remains unresolved; idempotent second close; autoclose races explicit close; reaper exits when primary never exits; no leaked transport children, pipes or timers.
- Real synthetic processes for PID/stamp/cancellation behavior; names and inventory JSON alone cannot prove OS lifecycle.

**PR3 — Pi event adapter and real loader**

- Use fake pi event/context objects for policy timing, but also load the actual shipped extension with a version-labelled installed pi loader in temporary homes, without provider requests.
- First startup evidence, actual model/effort mismatch, extension-load failure before prompt, role tool allowlists and execute-time eligibility.
- `agent_end` followed by retry is not completion; settled with queued work; multiple pending questions; missing/empty/unchanged output; aborted/error; early timer delivery; generation change; shorter model TTL; unknown TTL; grace continuation and shutdown.
- Warming cap estimates, helper-pending admission, exhausted/invalid estimates, no post-settle extension of lifetime, native warming disabled.
- QA competing writers/gaps/answer-only slots, stale/empty/oversized answers, answer-vs-timeout-vs-abort, fixed inherited timeout and helper call limits. Fake clocks avoid 20-minute tests. Tool-result recording must not assert a default was acted on merely because timeout instructed it.
- Helper wrapper/output precedence, fresh review session each round, valid/invalid verdict, reservation consumes the round on failure, no nested helpers, unchanged output is rejected.

**PR4 — Facade/waiter/collector regression**

- Existing same-key/changed-request conflict, identity isolation, routing changes, restart, independent waiters, no competing ORCH wake, question round trip with consumed:false, continuation's old-DONE suppression, explicit close.
- Put hostile/failing `pi-dispatch`, `pi-role`, `pi-role-reap` programs on PATH and prove they are never invoked for new jobs. Removing them must not change launch selection.
- Read legacy receipts; refuse new-release legacy mutation/relaunch; missing pinned release fails rather than selecting current.
- Feed actual extension-produced STATUS/SESSION/QA into `observeDispatch`, waiter and collector. Helpers remain inside one job; no fabricated native ref, external reap, or new material grant.
- Preserve the narrow wait import-graph/RSS regression; no execution module or pi SDK in file-only observation.

**PR5 — Artifact/process rehearsal**

Build a clean staged immutable release and run tests **from that artifact**, including relocation/path-with-spaces, deleted source checkout, activation change while an old primary launches a helper, no SDK duplication, no Fishpref imports, herdr integration missing/outdated/header mismatch, and a two-entry loader test proving exactly one HUD worker owner plus one herdr reporter. Discovery cache cannot mask a replaced hook file.

**Real herdr/pi smoke under temporary homes — opt-in, NOT_RUN until executed**

Use an isolated herdr instance/workspace and temporary HOME/HUD_HOME, synthetic repository and approved test credentials only for model-spending cases. Install/provision the herdr integration only inside that test home with explicit test authorization; no real-home mutation.

1. No-provider loader/help/startup probe: exact extension/role/skill/tool/model resolution, project `.pi` resources excluded, AGENTS/CLAUDE retained, no personal package dependency.
2. Primary imp creates one tab/two panes; calls sonic then a fresh reviewer in the right pane; helper errors and QA reach the main session correctly.
3. Caller-backgrounded wait returns DONE/FAILED from the real STATUS path, with no duplicate direct notify; QA answer and timeout/default cases are distinguishable.
4. Stall recovery positive/negative cases with exact session/editor evidence; no resend/start duplication.
5. Clean one-shot auto-exit/tab-close; implementer TTL/grace continuation; explicit close of active/failed task; repeated close leaves no owned agent or tab.
6. Kill launch transport/primary at representative crash windows, then reconcile/close without guessing or harming an unrelated decoy pane. Stop rather than widen cleanup authority when evidence is insufficient.
7. MCP exit and pi ordinary-session switch do not kill the delegated job; old release remains usable for its existing jobs after activation changes.

Do not use the owner's normal auth store in temporary-home tests. Native-loader/fake-provider/local-process evidence and real-provider evidence are separate categories, with actual command, host, versions, SHA, PASS/FAIL/SKIP/NOT_RUN recorded.

**Owner checks**

Review public-safe role/skill wording and inherited limits; preview any routing example adoption rather than overwrite existing routing; verify normal pi login still works; confirm herdr-managed integration preflight and no personal UI/package imports; verify one real cross-harness main → imp → sonic/reviewer → wake → close sequence; drain old R2b/direct jobs before switching their control owner. No installer, Fishpref edit, auth migration, default MCP-surface switch, or shared-browser action is authorized by this design.

**Cost and negative controls**

Measure cold create-to-ready separately from dispatch/wait duration. Report host, n, warm-up and p50/p95/p99/max over at least three runs, plus process tree/RSS, idle CPU, bytes written and cleanup latency. Expected topology is one pi per live slot, at most one helper per primary, bounded transient herdr commands, and at most one finite autoclose process per eligible primary. No shell/Python helper controller, new MCP per worker, resident reaper, warmer or heartbeat writer. STATUS writes only when semantic content changes; updated_at alone must not trigger writes. QA polls only while a question is outstanding; grace uses one deadline timer; ordinary reads write nothing.

Tests must go red when intent persistence is moved after a side effect, Enter is repeated, session/pane ownership checks are removed, unchanged output is accepted, agent_end replaces settlement, a close fence is bypassed, or an external PATH launcher is restored. Existing fake-dispatch PASS results do not substitute for these negative controls.

### K. Risks and deliberate cuts

- **Behavior versus independence:** preserve the explicitly decided worker policies, but remove personal convenience integrations. Do not sell this as identical prompts/tool inventories to the private bundle; public-safe roles name only shipped capabilities.
- **Herdr has no transaction with HUD files.** Pre-intent narrows loss windows and enables reconciliation; it cannot make a lost tab creation atomic. Unknown outcomes remain visible, potentially requiring operator inspection.
- **Native pi settings remain inherited by decision.** No claims of full configuration isolation or guaranteed provider warming. Capability mismatches fail explicitly; do not gate solely on a version string.
- **Review guard is a backstop, not a sandbox.** Shell/test execution can have effects beyond regex detection. Preserve role discipline and tested tool interception; do not claim hostile-code isolation.
- **Post-exit autoclose is finite best effort.** Failed/missing cleanup evidence remains close_unresolved; a successful model artifact must not be turned into an invented clean resource inventory.
- **Legacy control is deliberately not adopted.** New code cannot both promise never to execute Fishpref and transparently run its old pinned reaper. Drain/handoff is the honest boundary; R6b removes dead compatibility code later.
- **Passive QA history is incomplete.** Existing answer files do not prove consumption; absent answers do not prove defaults. Use actual recorded tool results for the new fact, under the R5 records owner's bounded parser, without changing worker behavior or UI policy here.
- **No scope expansion:** no standalone pi-roles CLI clone, generic role/plugin framework, arbitrary extension loader, headless fallback, statistics/labeling/rating system, automatic repair loop, new model provider client, or observation-triggered next role.

**Optional hardening:**

- Stronger OS-backed process-handle signaling or sandboxing could strengthen PID-race/read-only guarantees, but costs platform-specific code and a separate supported-capability contract. Not required to port the existing behavior; conservative refusal remains mandatory.
- A general manual sweep/retention command could reduce historical task clutter, but costs a new management surface and retention/ownership tests. Explicit per-job close and existing owner checkpoints are sufficient here; do not add a resident sweeper.

## 4. Scope:

**Scope: needs orchestrator** for cross-package scheduling and recording the four consult rulings, not a new product direction. The `pi_helpers` routing addition is explicitly approved; A1 must inventory the worker artifact, A2/A5 retain their exclusive ordinary-session ownership, and the R5-UX records owner must integrate any timeout/default tool-result fact without PIROLE editing its UI. Preserve the designated owner activation/live-validation gates and the R6b drain/removal boundary. The implementation described above is otherwise inside PIROLE.

---

# PIROLE decided design (orchestrator, 2026-11-09)

Base: `architect-1.md` (astra high), accepted. Consult rulings q1–q4 are decisions (inherited worker behaviour kept:
1200 s QA wait then "proceed with your default", reviewer ≤ 3 rounds, sonic ≤ 10 calls, one helper at a time;
`pi_helpers` routing table; pi keeps its own auth/models and native settings; herdr's own pi integration resolved
from `herdr integration status` and loaded explicitly, never copied).

Accepted: inventory (§A, personal toolkit left out), job-local state under `$HUD_HOME/jobs/<id>/` (§B), receipt
`pi_dispatch` v2 with v1 still readable (§C), exact argv as array elements and startup-evidence gate before the first
prompt (§D), launch/stall/helper/close rules and the crash matrix (§E), STATUS v1 / SESSION compatibility, settlement,
grace, warming, QA, wake and reap rules (§F), HUD-owned public-safe role texts with defaults in routing data (§G),
A1/A2/A5 ownership boundaries and cutover now with legacy drain (§H), slices PR1–PR5 (§I), test headings (§J).

Amendments:
- The timeout/default fact shown on Home is a passive extractor owned by the R5-UX records work (P3a), not PIROLE.
- Performance evidence stays (HUD priority), but PR2–PR4 report it only for the cold launch path and STATUS write
  count; the full p50/p95/p99 three-run table is required once, in PR5.

Order: PR1 when an implementer slot frees (A1/A2/P1 occupy three); PR2 → PR3 → PR4 → PR5 serially; PR5 joins A8's
artifact rehearsal. Cut: nothing else; optional hardening not taken.
