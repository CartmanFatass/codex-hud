Decision: adapt and adopt the owner’s candidate. Keep the five fixed roles, expose them through a small MCP interface, and let the main session follow a short skill that sequences the work. Use herdr to execute CLI agents and our own Jev implementation to execute browser jobs.

This changes my previous answer in two substantive ways: the role-facing MCP is now in scope, and completing the relevant owned-Jev integration is now in scope. WF1’s autonomous workflow engine remains deferred.

The candidate establishes a concrete benefit for the MCP: the main agent can request “an implementer” or “a convergence oracle,” receive a consistent job handle, and inspect or answer that job without knowing the current launch recipe. That is useful even when herdr already provides the underlying execution.

I checked the updated branch at 5a131b9, containing WF1 revision 3, native-hud v2.3, and JEV1 v6. The changes since the previous review are documentation changes; the implementation distinctions discussed below still apply. 
Reviewed commit

1. Role set and ownership

Keep exactly these five public roles:

Role	Stable responsibility	Important boundary
oracle	Produce a design proposal or converge proposals into a decision.	Has an explicit `phase: propose
imp	Implement a defined change against a brief and acceptance criteria.	Receives the working location and scope; the main session remains responsible for broader planning.
reviewer	Independently assess a specified change and report findings, acceptance, or blockers.	Its verdict is information for the main session. HUD does not interpret it as permission to launch another step.
sonic	Bounded, fast work: exploration, searches, information gathering, tests, and small patches.	“Fast” describes the intended work and selected backend. It does not imply that every test suite is short or that review is unnecessary.
jev	Our own browser automation and page judgments, implemented through src/jev; includes access to web oracles.	Remains a distinct browser capability. It does not become a generic information-gathering role.
Oracle needs two binding slots

The owner wants proposal and convergence to be independently assignable—for example, Fable or Argon proposing and Pro converging. Preserve one public oracle role, with two fixed slots:

oracle.propose
oracle.converge

Both slots may use the same backend, but they remain separate jobs and normally separate conversations. One hud_create(role="oracle") must not secretly launch two agents.

Separate Jev’s role, execution mechanism, and decision provider

These are different choices:

Choice	Example	Meaning
Cognitive role	oracle, phase converge	What work the result must accomplish
Execution mechanism	Jev	How the task reaches the selected web application
Web target	ChatGPT Pro or AI Studio	Where the oracle question is answered
Jev decision provider	TypeSafe or OpenAI Decisions API	What chooses browser actions and evaluates page-state statements

An oracle.converge binding to ChatGPT Pro launches one oracle job executed through Jev. It does not launch an oracle agent that subsequently delegates to a second Jev agent.

The explicit jev role remains available for direct browser work, including:

ask: submit a question to a supported web-oracle target and collect its answer;
browse: perform a specified browser goal;
judge: evaluate specified page-state statements without acting on the page.

Switching TypeSafe to OpenAI Decisions changes the browser decision backend. It does not change ChatGPT Pro into another oracle target.

Ownership under this scope
Component	Owns
Main session + skill	Choosing roles, sequencing steps, handing off artifacts, evaluating results, deciding repairs and authorized backend changes
HUD MCP	Resolving a role binding, creating one job through the selected executor, correlation records, normalized reads, supported input forwarding, and explicit cleanup requests
herdr	CLI harness launch, panes, prompts, waits, output access, and its existing process/cleanup behavior
Owned Jev runtime	Browser actions, page judgments, send/confirmation/recovery mechanics, browser-job records, and cleanup of its own resources
HUD TUI	Unified tree, status, requests, results, navigation, and retained summary features

The roles are task contracts. They do not create new OS permission boundaries or replace the harness’s own configuration.

2. Fixed workflows: the main session chains them

Adopt two classic multi-step recipes, plus direct single-role paths.

Recipe	Default sequence	Who advances it
Design	oracle.propose → oracle.converge → main session applies the decision	Main session
Build	imp → sonic for required checks when useful → reviewer → main session accepts or requests repairs	Main session
Small task	sonic → main session evaluates the result	Main session
Browser task	jev → main session consumes the result	Main session

The skill may skip proposal when a concrete proposal already exists. It may skip a separate Sonic invocation when the required checks have already been run and their evidence is available.

For a repair cycle, the main session sends the findings back to the existing implementer when that backend supports continuation, then commissions another review. The reviewer should receive the current change and criteria; a fresh reviewer conversation is the default.

HUD chains no steps in this release. It does not:

launch the reviewer when the implementer finishes;
turn a reviewer’s prose or verdict into an execution transition;
choose the next oracle;
decide whether another repair is warranted;
silently switch a backend after a failure.

This preserves the genuinely simple part of the candidate: stable roles and familiar recipes. Even a two-step autonomous chain would require an owner for durable transitions, interruption, recovery, and cancellation. Those are precisely the responsibilities specified by WF1. 
WF1 revision 3, execution and recovery contracts

WF1 remains deferred in full. The main session still wakes between stages. This is the explicit cost accepted to keep the service small.

3. Binding file and switching

Use one user-level TOML file:

纯文本
$HUD_HOME/routing.toml

It contains:

Named backend profiles.
Named presets binding the fixed role slots to those profiles.
The selected Jev decision profile for each preset.
A user default preset.

The routing portion should look like this. Names here are profile labels; their actual model IDs and launch parameters come from the owner’s installed configuration.

toml
schema = 1
default_preset = "daily"

[presets.daily]
jev_decisions = "typesafe-default"

[presets.daily.roles]
"oracle.propose" = "fable"
"oracle.converge" = "pro"
imp = "grok-build"
reviewer = "review-default"
sonic = "pi-fast"
jev = "jev-local"

[presets.pi-build]
jev_decisions = "typesafe-default"

[presets.pi-build.roles]
"oracle.propose" = "argon"
"oracle.converge" = "pro"
imp = "pi-imp"
reviewer = "review-default"
sonic = "pi-fast"
jev = "jev-local"

Backend profiles use structured fields:

Profile kind	Fields
herdr-backed CLI	executor = "herdr", harness, model, effort where supported, launch-recipe reference, environment/account-profile reference, and necessary structured arguments
Web oracle	executor = "jev", target profile such as ChatGPT Pro or AI Studio, and target model/mode settings
Direct Jev	executor = "jev" and its browser configuration reference
Jev decision profile	Provider typesafe or openai, provider model/configuration reference; credentials remain in the existing private credential configuration

The volatile choices—model, effort, account/profile selection—belong in data. The adapter or existing launch recipe owns the mechanics for translating those choices into the correct command. Do not duplicate model bindings inside the skill.

The selected Jev decision profile applies to Jev work in that preset, including web-backed oracle jobs. Each job records the actual decision provider separately from the web target.

Switching rules
The owner owns the binding file and persistent default. The main agent may edit them when instructed.
The main session may select an existing preset under the owner’s established routing instructions. An explicit owner selection remains pinned until changed.
Active selection is scoped to a stable main-session identity, including its source/home namespace—not a global active_preset, PID alone, or pane alone.
A selection or file change affects future jobs only.
A job keeps its resolved backend, model, environment profile, and Jev decision provider for its lifetime.
A retry of the same logical create request retains the original binding even if the preset has subsequently changed.
Allow an explicitly authorized one-job backend override referencing an existing profile. Record it in the job receipt.
Do not add project overlays, persistent role-override layers, automatic quota detection, or dynamic tool schemas.

Binding validation must reject incompatible substitutions. A web oracle cannot satisfy an implementer task requiring workspace edits merely because both appear in the roster.

4. Minimal MCP surface

Use six tools, retaining familiar names where that helps migration.

Tool	Contract
hud_roster	list, show, or select a preset. Returns compact role bindings and capabilities. Selection affects the current main session’s future jobs.
hud_create	Create one job for a fixed role. Accepts task/input, a required logical request key, optional oracle phase, working location, and explicitly selected preset/profile where authorized. Returns a stable job ID and the resolved binding.
hud_read	With a job ID: bounded status, pending requests, result, or transcript material. Without one: compact list of the caller’s jobs. May wait for a change up to a bounded wait_ms.
hud_send	Send a follow-up to an existing compatible job, using an idempotent message key. This is needed for implementer repair turns without discarding the existing conversation.
hud_respond	Answer one identified outstanding request through its supported backend channel.
hud_close	Request cleanup of one owned job and return the observed result. Repeated close is idempotent and preserves results.

The role enum is permanently the five names above. Preset and backend inventories are retrieved on demand. No schema mutation accompanies a switch.

There are no separate workflow_*, hud_flow, graph inspection, plan approval, native fork, or generic resume APIs in this release.

For direct Jev creation, use a tagged input for ask, browse, or judge. That avoids pretending a page judgment has the same input as a coding task.

The small amount of execution bookkeeping that remains necessary

A facade still launches work, so it needs more than an in-memory map.

Persist a small job receipt containing the authenticated parent identity, logical request key, role/phase, resolved binding and configuration revision, task fingerprint, working location, and executor identifiers.

The rules are:

Same key and same request: return the same job.
Same key with changed task parameters: return a conflict.
Write the dispatch intent before invoking herdr or Jev.
Serialize concurrent attempts for that same key.
If launch acknowledgment is lost, reconcile against the existing executor identity.
An unresolved launch returns launch_unknown; it does not trigger another launch.

This is a record for one dispatched job. It contains no graph, step counters, next-step policy, or workflow bundle.

Reads also need honest semantics. Herdr’s idle is not a reviewer acceptance. A submitted answer is not necessarily a consumed answer. TUI reads must not advance the main agent’s observation cursor or suppress its notification.

“Answer any role” needs one qualification

Adopt a uniform addressing and response interface, with explicit backend capabilities.

For the existing Pi question path, hud_respond can verify the outstanding qN.md, atomically write the corresponding answer file, and make repeated identical answers idempotent.

Other backends must expose their actual supported channels. A web oracle that has no mid-run callback cannot acquire one through API normalization. Native permission dialogs and browser login/approval screens may require an external handoff. In those cases:

show the request and where to handle it;
return a typed capability/handoff result;
do not send guessed terminal input;
do not restart the task or submit a new web question under the guise of answering.

The same tool names remain usable across roles, while the returned capabilities prevent the main agent from assuming an unsupported operation.

Waiting and waking

Reuse the proven parent-harness waiting path. hud_create returns the appropriate wait guidance; the skill arms the existing background waiter when necessary. A small hud wait --job … CLI may normalize herdr waits and Jev record waiting.

Do not create an independent agent wake broker alongside herdr. An MCP response completing is not itself evidence that a future main-session turn will start; each parent integration must verify its notification path.

5. Relationship to herdr and the owned Jev runtime
Herdr remains the CLI executor

For imp, reviewer, sonic, and CLI-backed oracle jobs, the MCP calls the owner’s existing herdr launch/prompt/read/wait/cleanup operations.

The facade adds:

role resolution;
one job handle;
exact backend attribution;
supported question forwarding;
automatic tree association.

It does not reimplement herdr’s terminal/process ownership through Codex app-server, Claude SDK, and Pi RPC.

Consequences are concrete:

If the TUI is closed, delegation continues.
If the parent MCP exits, herdr children continue.
If herdr is unavailable, CLI dispatch returns backend_unavailable.
There is no silent fallback to a second direct-launch architecture.
Direct herdr use remains supported; its tasks can be explicitly associated for observation.
Normal harness configuration and the owner’s existing Pi/pi-roles behavior remain intact.

Retain a small Pi parent shim if it is needed to call the same facade, plus the footer. Do not revive the proposed Pi child execution package or install a second ask_orchestrator.

Jev now earns a narrow runtime of its own

This supersedes my previous recommendation to defer the internal Jev runtime.

The owner explicitly wants src/jev as a first-class product capability. Finish that path using one on-demand Jev execution process per HUD home, started only for Jev work. It owns browser jobs and Agent instances and exits after its live work/resources are released and a short grace period.

That process must contain no CLI child launcher, role resolver, workflow graph, repair policy, or next-step selection. Its browser send/confirm/read/reconcile sequence is the mechanics of one requested job.

Keep JEV1’s useful guarantees: persisted send attempts, no automatic second Send after uncertainty, record-based recovery, bounded cleanup, idempotent close, and preservation of completed answers. Switching the decision provider affects new jobs; a provider failure does not silently switch a running job.

This requires an extraction. The current MCP still composes native and Jev tools through NativeHostClient; the host constructs NativeSessionHost with native profiles, and its Jev extension still uses PythonJevBridge. Simply removing native tools from the advertised list would leave the general host dependencies in place. 
MCP entry, 
host entry, 
Jev host

Two remaining Jev deliverables must be named explicitly:

Page judgments. The current DecisionProvider exposes decide(), while the designed judge() interface remains to be implemented. Complete it for both providers. 
Current interface
AI Studio. JEV1 §2.3 currently leaves AI Studio in the external driver, and J2’s provider keys cover ChatGPT and Gemini. AI Studio requires its own target adapter, identity namespace, extraction, and recovery fixtures. Port the actual owner driver; do not count Gemini consumer-chat support as satisfying it. 
JEV1 v6, 
current record types
6. What the skill says, and who maintains it

Maintain one short, versioned delegation skill in the repository, using the existing integrations/skills/hud-delegate/ location. Project maintainers update its role semantics alongside the MCP contract. The owner maintains local bindings and preferences.

Its operational guidance should be approximately this:

Inspect the active roster when delegation is useful. Use oracle for proposal or convergence, imp for implementation, reviewer for independent assessment, sonic for bounded lightweight work, and jev for browser work or page judgments.

For design work, request a proposal and then convergence when both are needed. For implementation, obtain the change, run any required independent checks, and request review. You own each handoff and the decision to accept or request repairs.

Give every job a clear brief, relevant artifacts, working location, and completion criteria. Use the returned backend and capability information. Arm the returned wait mechanism; read results when notified.

Answer identified questions with hud_respond. Use hud_send for a supported continuation, such as implementer repairs. Handle external human requests at their indicated location.

Keep request keys stable across retries. Inspect uncertain launches or sends; never create a replacement blindly. Close jobs through their owning backend when their resources are no longer needed.

Preset changes affect future jobs. Use an alternative backend only under the owner’s routing instructions, and preserve a handoff if work has already occurred.

The skill contains no hardcoded model IDs, browser selectors, fallback scheduler, or workflow language. Setup installs a stable skill/shim for each supported main harness; changing presets does not regenerate skill files.

7. Revised work packages

This queue replaces the previous O0–O6 queue.

Package	Deliverable	Acceptance
R0 — Scope and baseline	Apply the decision-log changes below. Preserve WP0, J1/J1b/J2, relevant fixtures/licenses, and retained HUD features. Remove WF1 executor work from the active queue.	One active implementation plan; bash tests/run-main.sh baseline recorded; no weakened main assertions or scenes.
R1 — Roles, bindings, and skill	Define the five roles, oracle phases, routing.toml, session-scoped selection, capability validation, and static skill. Import actual backend settings from installed recipes.	Switching a preset changes the next dispatch; existing jobs remain unchanged; two main sessions can select independently; incompatible role bindings fail clearly.
R2 — Herdr-backed MCP facade	Implement the six tools for CLI jobs, stable parent attribution, atomic job receipts, same-key serialization/reconciliation, supported question adapters, continuation, and explicit cleanup. Reuse existing launch recipes.	Pi/Grok and supported Codex/Claude recipes work through the common API; Pi questions round-trip; duplicate/ambiguous creates do not relaunch; missing herdr is reported honestly; no TUI is required.
R3 — Owned Jev runtime and judgments	Extract a lazy Jev-only runtime from reusable IPC/lifetime pieces. Connect src/jev, preserve J2 records/leases, and complete both judge() provider mappings. Map it into the same job API.	Direct browser and read-only judgment jobs work; TypeSafe/OpenAI are selectable; disconnect ends observation only; runtime cleanup is bounded; no CLI-launch modules load.
R4 — Web-oracle targets and recovery	Complete ChatGPT support and add a distinct AI Studio adapter from the existing owner driver. Complete wait/reconcile/result collection. Preserve cross-language compatibility while old and new writers coexist.	Prompt/attachment handling, target selection, send evidence, result extraction, crash windows, and same-key recovery pass for each target. Recovery never repeats Send. Both decision providers are checked.
R5 — Unified tree and retained summaries	Adapt the tree/collectors to one job per invocation, role/phase/backend attribution, pending requests, results, and external herdr tasks. Preserve non-Codex roots, Pi footer, generic materials, brief/dry-run, and production summary restoration.	One tree correctly shows CLI, native descendants, oracle-through-Jev, and direct Jev jobs; no duplicate “oracle + Jev” nodes; stale observation is honest; main visual behavior remains protected.
R6 — Installation and retirement	Install the small facade and skill/shims. Replace the general native execution path only after herdr and owned Jev paths pass. Drain existing live handles through their owning version. Remove unused direct-launch adapters, obsolete bridge wiring, and dependencies.	CLI-only use starts no detached HUD execution host; Jev starts only its narrow runtime; existing work is not killed or replayed during migration; old/new control paths do not compete.
R7 — End-to-end acceptance	Validate all three supported main harnesses, representative concrete bindings, both oracle phases, repair continuation, questions, provider switching, restart/recovery, cleanup, and WP0.	Actual results and limitations recorded. Fixture success does not substitute for real parent notification or browser-target checks.

After R1, R2 and R3 can proceed in parallel. R4 depends on R3; R5 can develop against their fixtures. R6 follows the replacement paths’ acceptance, and R7 closes delivery.

Jev package mapping: retain J1/J2; finish J1b judgments; implement J3a plus a new AI Studio package; retain J4; narrow J5 to the Jev-only runtime and common facade; retain J6/J7/J8/J9 as relevant. Gemini consumer-chat and Flow remain separate targets; neither is required to satisfy the newly specified ChatGPT Pro + AI Studio scope.

Native-v2 mapping: keep attribution, observation, tree, summaries, and necessary parent integration. Replace its execution interfaces with the role facade. Cancel its general agent host, process-group sweeps, agent idle/abandon timers, direct native dispatch adapters, and workflow fields. Keep useful herdr code during pruning.

WP0 remains necessary, including its documented qualification that several model-feature carriers currently use the B17 test double. Production summary restoration and the accepted <dir>/cache.json location remain active work. 
Main-feature gate documentation

8. Supersessions and exact decision-log edits
What changes from my previous answer
Previous ruling	Revised ruling
Observer-only HUD; no launch MCP	Superseded: keep a fixed-role MCP facade over herdr and owned Jev.
Routing exposed through CLI/data only	Superseded: hud_roster is the main agent’s on-demand lookup/selection interface; the owner can still edit the file directly.
Defer internal Jev J3/J4/J5 work	Superseded: complete the parts needed for owned browser jobs, ChatGPT Pro, AI Studio, and page judgments.
Do not build a Jev-only runtime	Superseded: a narrow, lazy Jev runtime is justified by this explicit product requirement.
Defer WF1 and keep main-driven chaining	Retained.
herdr owns CLI execution; no duplicate general host	Retained.
No automatic quota broker or transparent retry	Retained.
Preserve WP0, main features, summaries, footer, and useful Jev foundations	Retained.

At the reviewed head, the earlier observer-only decision-log text has not been appended to concept §15. Apply the following entry instead. If that earlier text exists in a local checkout, mark it superseded by this entry.

Exact §15 entry
Markdown
### 2026-11-07 Scope convergence: fixed roles, herdr execution, owned Jev

Adopt the owner's fixed-role candidate with main-session sequencing.
This supersedes the prior observer-only scope recommendation, including its
prohibition on a launch MCP and its deferral of the owned Jev runtime.
It does not reactivate WF1 or the general native agent execution host.

| Decision | Accepted scope |
| --- | --- |
| Public roles | Exactly oracle, imp, reviewer, sonic, and jev. Role meaning remains stable when bindings change. |
| Oracle | One role with explicit propose and converge phases, bound through oracle.propose and oracle.converge. Each invocation creates one job. |
| Jev | A first-class browser capability implemented through src/jev, supporting browser goals, web-oracle questions, and read-only page judgments. It is not a generic informer role. |
| Role versus executor | An oracle bound to a Jev web target is one oracle job executed by Jev. Do not create a second child for the transport. |
| Classic recipes | Design: oracle.propose → oracle.converge. Build: imp → required checks, optionally via sonic → reviewer. Small tasks use sonic; browser tasks use jev. |
| Chaining | The main session and its skill perform every handoff, evaluate results, and decide repair cycles. HUD does not launch a next role from completion or verdict evidence. |
| WF1 | Deferred in full. No workflow executor, workflow_plan/start, graph loader, execution bundle, automatic fix loop, or workflow-owned Jev job. |
| MCP purpose | Resolve a role, create one job through its executor, provide consistent observation and supported input/cleanup operations, and associate that job with the tree. |
| MCP surface | hud_roster, hud_create, hud_read, hud_send, hud_respond, hud_close. Schemas and the role enum are static. |
| CLI execution | herdr remains the executor for CLI harnesses. Reuse working launch/prompt/read/wait/cleanup recipes. No silent direct SDK/app-server/RPC fallback when herdr is unavailable. |
| Jev lifetime | One lazy Jev execution process per HUD home owns browser jobs/instances and exits after retained work/resources drain and a grace period. It contains no CLI launcher, role policy, workflow engine, or next-step selection. |
| Jev targets | ChatGPT Pro and AI Studio are required targets. AI Studio needs its own adapter and operation identity; Gemini consumer-chat support does not satisfy it. |
| Jev decisions | TypeSafe and OpenAI Decisions API are selectable for actions and page judgments. Target model and decision model are separate. Keep the existing TypeSafe default when both credentials exist and no explicit selection is made. |
| Binding data | One user-level $HUD_HOME/routing.toml contains backend profiles, named presets, role bindings, Jev decision profiles, and a default preset. No project overlays or persistent override layers in this release. |
| Switching | Owner-directed actions change persistent bindings/defaults. The main session may select a declared preset under existing routing instructions. Selection is scoped to stable main-session identity and affects future jobs only. |
| Job binding | Resolve once at creation and record actual role, phase, backend, model, environment profile, and Jev decision provider. Existing jobs and same-key retries retain that binding. |
| Retry contract | Persist a per-job dispatch receipt before side effects. Same key/same request returns the existing job; changed request conflicts. Ambiguous launch/send is reconciled and never blindly repeated. |
| Requests | hud_respond forwards a real outstanding request through a supported adapter. Unsupported native/browser interactions remain explicit external handoffs. A written/forwarded answer is not reported consumed without evidence. |
| Waiting | Reuse the main harness's proven background notification path and herdr/Jev waits. Reads have independent cursors; TUI reads do not consume parent notifications. Main-session wakes between recipe stages are accepted. |
| Cleanup | herdr owns CLI process cleanup; Jev owns its browser-job cleanup. HUD requests cleanup and reports observed outcomes. No general agent idle/abandon timers, process-group sweeps, or automatic restart service. |
| Jev recovery | Preserve send-attempt evidence, same-key behavior, read-only reconciliation after uncertainty, bounded cleanup, and idempotent close. Close does not undo a submitted question or erase an answer. |
| Skill | One short repository-maintained delegation skill defines role choice and recipe order. The owner maintains bindings. No hardcoded model inventory, browser selectors, or runtime-generated per-preset skills. |
| Tree and main features | Keep one root-independent tree, explicit association, native descendants, external herdr tasks, Jev jobs, summaries, brief/dry-run, Pi footer, and existing main behavior. Keep WP0 mandatory. |
| Exclusions | No general workflow engine, automatic quota broker, silent backend switching, dynamic tool schemas, or duplicate CLI execution supervisor. |

The current queue is R0 scope/baseline, R1 roles/bindings/skill,
R2 herdr facade, R3 Jev runtime/judgments, R4 web targets/recovery,
R5 tree/summaries, R6 installation/retirement, R7 end-to-end acceptance.
It replaces the earlier O0–O6 observer-only queue.

Keep J1/J1b/J2 foundations and tests. Complete the relevant remaining Jev work.
Extract Jev from the shared native host before removing that host's dependencies.
Existing live work is drained through its owning version; migration never
replays it or silently adopts its execution.

Preserve the accepted production summary restoration and <dir>/cache.json
response-cache location. New prompt-cache lifetime forecasts and scheduling
policies remain deferred.
Companion document changes
Document	Required edit
hud-workflows.md rev 3	Mark the executor deferred/reference only. Move W1–W6 out of the active queue. The classic recipes belong to the skill.
native-hud-v2.md v2.3	Replace active execution/tool/host sections with the role-facade contract. Make herdr the CLI executor. Preserve attribution, tree, materials, summaries, and relevant parent integration. Replace §7 with R0–R7.
jev-in-hud.md v6	Keep the owned-Jev work active. Add AI Studio explicitly. Complete judgments. Narrow the host to Jev. Replace owned_by: "workflow:<run>" and workflow wake routing with persisted invoking-session/job association. Keep idempotent close and send/recovery evidence.
STATE.md	Put R0–R7 at the top; remove instructions to implement either the canceled general host or the superseded observer-only retirement plan.
Skill, architecture, reference, installer docs	Describe the same five roles, six tools, main-driven recipes, herdr execution, and narrow Jev runtime. Preserve unrelated repository rules.

This is the boundary I would now freeze: HUD supplies a stable delegation interface and unified visibility; herdr runs CLI agents; Jev runs browser jobs; the main session decides what happens next.
