1. Decision table
Function	Decision	What HUD should do	Why this is the right boundary given herdr and skills
Dispatch and child launch	Main agent + herdr + delegation skills own it. Drop HUD’s competing dispatcher.	Record and display an externally launched child’s identity, parent, role, backend, and location.	The owner already launches Pi, Grok, Codex, and Claude with the required arguments and environments. A second launcher adds integration and recovery work without establishing a missing user capability.
Topology, chaining, and review loops	Main agent + workflow recipes in skills own it. Defer autonomous execution.	Display task and step labels supplied by those recipes.	Skills can describe proposer → converger and implementer → reviewer loops. They do not eliminate the main-session wake between steps; accept that cost for this release. HUD should not interpret edges, consume verdicts, or advance a chain.
Role → backend routing and presets	User-owned data + a preset-aware skill own the policy.	Ship a small, synchronous lookup/selection CLI and display the selection.	This addresses a real gap: changing routing currently requires editing notes. It needs a data source and convenient selection, not a dispatch broker.
Unified visual tree / TUI	HUD owns it. This is the central deliverable.	Combine the selected root, its native descendants, explicitly associated herdr children, and Jev jobs; show status, attention, results, and navigation.	The attachment identifies this as missing today. It improves the owner’s daily workflow without replacing its execution machinery.
Child requests and answers	Existing harness channels + herdr/skills own delivery and answers.	Show pending questions and their source; open the existing pane or question artifact.	Pi already has ask_orchestrator and answer files. Preserve that path. The attachment does not establish equivalent structured callbacks for every harness, so do not claim uniformity or build hud_respond to manufacture it.
Lifecycle and cleanup	herdr + the harness + the launch skill own child processes.	Show observed execution and freshness states. Manage only HUD’s own UI/collector resources.	The working /quit and tab-close recipes cover ordinary cleanup. They do not prove every descendant/crash guarantee proposed for the host. Those stronger guarantees are removed from HUD’s current commitment.
Jev execution and recovery	Existing jev-ask / jev-aistudio skills and their driver own it. Defer the new HUD ask runtime.	Observe their actual operation records and results, with explicit parent association.	Web-oracle execution already exists. Replacing its transport and driver is a separate migration; it is not required to put those jobs in the tree.
Completed Jev J1/J1b/J2 foundations	Keep the code, assets, attribution, schemas, and tests.	Reuse suitable record types/parsing in a read-only collector.	These are useful completed components. Keeping them does not require finishing the proposed host integration.
Automatic quota broker, circuit breakers, and transparent retries	Drop from this release.	Display a known failure or an explicit routing change.	The main agent can select an already-authorized alternative using the skill. Automatic health detection, TTLs, queues, and retries introduce another execution policy service.
Existing HUD features and WP0	Keep. WP0 remains the pruning gate.	Preserve bar, panel, summaries, brief/dry-run, installation, existing herdr integration, and retained visual behavior.	Scope reduction must remove duplicated branch machinery without damaging the HUD the owner already uses.

Verdict: ship an observer HUD, with routing exposed through data and skills. Defer WF1 in full and cancel the new HUD-owned agent execution architecture.

The comparison that matters is the owner’s working herdr + skills + Jev setup. Argon’s argument was based on a substantially weaker baseline. Its claim that only HUD can launch these backends is contradicted by the supplied herdr facts. Its numerical claim that the design is “about 30%” over-scoped has no supporting measurement. 
Owner attachment, especially “Facts Argon did not have”

I reviewed universal-hud at b013bf0e4e39c54b4e4a740794f60e508c3f21ae. The herdr commands and daily workflows are accepted here as owner-supplied operational facts; I did not execute them on the owner’s machine.

What this means for WF1 and native-hud-v2

WF1 is deferred as a whole. Do not shrink it to a sequential pipeline plus a bounded review loop.

Even that smaller executor still owns dispatch, interruption, recovery, cancellation, request handling, verdict consumption, and duplicate prevention. Removing graph constructs does not remove those responsibilities. WF1 revision 2 makes those responsibilities particularly clear in its durable execution and recovery contracts. 
WF1 §§3–7

Keep the document as a deferred design. Remove workflow_plan, workflow_start, execution bundles, host-driven transitions, and workflow-owned children from the active implementation queue. Move useful recipes into skills. Defer the new prompt-cache forecasts too; preserve existing measured usage displays and the separate summary-response cache.

There are real concessions:

One wake per whole chain is postponed. Herdr’s background wait avoids repeated polling wakes for one child; it does not advance the next stage.
Uniform cross-harness questions and answers are postponed. Support the channels that actually exist.
HUD’s proposed stronger process-containment and crash-recovery guarantees are withdrawn.
Automatic quota failover is postponed.
Symmetric use from Claude, Codex, and Pi must be verified through their skill/command paths. The attachment demonstrates the owner’s Claude-led workflow, not complete parity from all three main harnesses.

These are reasonable concessions for a release whose priorities are lightweight operation, responsiveness, clear visualization, and reduced friction.

For native-hud-v2, retain the root-independent tree, transcript readers, ordinary-session observation, generic summary materials, Pi footer, and main-feature preservation. Cancel the proposed hud_create execution surface, singleton agent host, unified child request broker, wake broker, host-owned agent cleanup, and mandatory HUD Pi dispatch package. 
Native design §§1–7 and Appendix B

The migration must distinguish proposed APIs from implemented ones. At the reviewed commit, the default MCP exposes NativeManagedTools and generic JevTools through NativeHostClient. The host registers both Jev and wake extensions, and the Jev extension still defaults to PythonJevBridge. Consequently, deleting the shared host immediately would break those existing entrypoints. Retire them deliberately after their live work has drained; do not build a new Jev-only host merely to preserve that interface. 
MCP composition, 
host entry, 
Jev host

For Jev specifically:

Existing work	Disposition
J1, implemented J1b, J2	Keep reusable code, assets, licensing, record compatibility, and tests.
J3a/J3b, J4	Defer the new sending, waiting, reconciliation, and page-judgment implementation.
J5a/J5b	Defer the new job manager, jev_ask* tools, host integration, credentials-import flow, and HUD-owned wakes.
J6	Keep, rewritten to observe jobs produced by the existing skills/driver.
J7/J7b	Remove as HUD prerequisites. Independently needed fixes belong to the existing driver’s maintenance.
J8	Keep relevant documentation, attribution, and skill guidance. Remove promises of immediate CLI retirement.
J9	Replace the proposed MCP matrix with observation checks against existing job records and ordinary skill-driven jobs.

J1/J2 being present does not mean the new ask driver is complete: the reviewed source tree lacks the proposed send/wait/reconcile modules and judge.ts; the current decision-provider interface exposes decide(). 
Jev source, 
decision interface, 
JEV1 §6

Rosters, presets, and switching

Use one user-level TOML file, one preset-aware skill, and a small CLI. There is no new MCP tool.

The canonical file is $HUD_HOME/routing.toml, normally ~/.hud/routing.toml.

Data	Contents
Backend profiles	Stable backend ID; existing skill/recipe reference; actual model/effort and account/environment-profile selectors where applicable; CLI versus web-oracle interaction mode. No credentials.
Presets	A short description and explicit role → backend bindings.
Recipe references	Names of skill recipes such as propose/converge or implement/review. No executable workflow graphs.
User default	The preset used when a main session has no selection.
Session selection	Stored separately, keyed by stable root session identity, including its source/home namespace.

Create the owner’s useful choices: design-fable, design-argon, build-grok, and build-pi. Populate backend definitions from the actual installed recipes and current routing. Do not infer a harness from the name “Fable” or import Argon’s speculative model IDs and flags.

Add these new helper commands:

纯文本
hud roster list
hud roster show --root <root-id> [--preset <name>] [--role <role>] --json
hud roster use <name> --root <root-id>

The helper validates data and prints the selected slice. It does not launch, wait, queue, answer, retry, or advance tasks. Existing delegation skills read that result and use their established herdr recipes.

Switching authority:

The owner can switch through the CLI or by telling the main agent.
The main agent can choose a declared preset under the owner’s existing task-routing instructions. An explicit owner selection remains pinned until changed.
Only an owner-directed action changes the persistent user default.
An explicitly authorized one-off backend choice is allowed without editing a preset.
A switch affects future dispatches only. Existing children retain their actual backend and the preset used at launch.

Do not implement global mutable role overlays or automatic project-file shadowing in this release. A single global active_preset would make simultaneous main sessions interfere.

A quota failure may lead the main agent to select an authorized alternative. That is a new dispatch decision, with an explicit handoff when work has already occurred. An ambiguous launch or Jev send must never trigger a blind retry. A web oracle also cannot silently replace a coding role that requires workspace writes or interactive questions.

A TUI preset selector is unnecessary for this release: display the selected preset and provide the CLI/skill path. Keep all inactive rosters out of the normal prompt and tool schema; make no numerical cache-saving claim without measurements.

2. Revised, ordered work packages
O0 — Freeze the reduced scope and preserve the baseline

Apply the decision-log and status edits in section 3. Stop assigning WF1 executor work, native-v2 agent-host work, and the unbuilt Jev host migration.

Keep WP0 complete. Run bash tests/run-main.sh before pruning and record the result. Preserve the existing assertion and scene mappings; move protected assertions before deleting mixed files.

The manifest currently covers 155 test paths and 240 kept scenes, with no changed-test or removed-scene entries. It includes existing herdr behavior. Its documentation also identifies eleven summary-related carriers using a B17 test double, so passing this gate alone does not establish that production summaries are restored. 
Manifest, 
gate explanation

Acceptance: one active scope/queue; WP0 retained without weakening; existing failures, if any, recorded separately from new regressions.

O1 — Establish the external observation contract

Inspect the actual installed herdr commands and the owner’s delegation/Jev skills. Capture synthetic fixtures for launch identity, status, questions, results, and cleanup.

Define a small association record containing:

Root native identity, including source/home namespace.
External identity: herdr instance + agent/launch identity, or Jev state-directory namespace + operation key.
Native child reference when established.
Role, actual backend, preset-at-launch, and task label.
Existing pane/tab, question, report, and result references.

An association records where an existing task belongs. It grants no execution authority and contains no workflow state.

Add hud observe link --file <record.json>. It writes an idempotent association after the existing launcher has returned the external identity. Registration failure must not cause relaunch. Parentage must not be inferred from a shared cwd, timing, or model name.

For sources without a reliable native transcript reference, retain an external node with unavailable metrics. In particular, Grok must be visible without first requiring a complete Grok transcript adapter: the current historical registry explicitly accepts only Codex, Claude, and Pi references. 
Current registry

Acceptance: fixtures establish each identifier and its provenance; repeated registration produces one association; ambiguous identity stays unresolved.

O2 — Implement read-only collectors and association merging

Extract reusable identity/file-reading utilities into an observation module. Add collectors for associated herdr children and external Jev operation records.

Use atomic per-association files under $HUD_HOME/observed-links/<root-key>/. Keep execution truth in herdr, native evidence, and the Jev driver’s records. HUD may cache projections, but must not write execution status back into those sources.

Merge native and external observations only when an explicit same-source identity proves they describe the same child. Preserve these distinctions:

idle does not establish task completion.
A missing pane does not establish successful completion.
An unavailable source produces stale/unknown observation.
HUD shutdown does not make a herdr child lost.
Restarting HUD never launches, resumes, answers, retries, or sends anything.

Collect external data asynchronously within the existing HUD processes, with bounded refreshes and caching. Rendering must not launch herdr commands or read entire transcripts per frame.

Acceptance: duplicate-source merging, reused pane IDs, separate account homes, missing sources, late native identity, HUD restart, and registration-after-launch failure all behave correctly. No collector imports a host launcher or browser action path.

O3 — Deliver the unified tree, retained summaries, and footer

Adapt the retained portions of native-v2 WP6/WP7/WP9/WP10:

Show the selected Codex, Claude, or Pi root and its explicitly associated children.
Show native descendants where evidence exists.
Include herdr children and Jev jobs in the same tree.
Show role, actual backend/model, observed activity, freshness, pending question, and result location.
Preserve existing collapse, selection, counts, navigation, notices, and visual behavior.
Keep Pi’s footer as observation; retain the owner’s existing Pi launch and ask_orchestrator recipes.

Open actions navigate to an existing pane or artifact. They do not create or resume a session. Jev display must distinguish the oracle target/model from the decision model used by its browser driver.

Retain the useful generic summary-material work. Restore production SmallModel coverage and the accepted <dir>/cache.json response-cache location. Keep brief/dry-run parity and existing material/privacy limits. Do not equate synthetic test-double coverage with production restoration. 
Native design §4, 
WP0’s B17 qualification

Acceptance: one root, a Pi implementer, a Grok task, a native descendant, and a Jev job render correctly together. Question completion updates through the existing answer path. Retained visual/performance gates pass; missing metrics remain explicitly unavailable.

O4 — Extract routing into data and update the existing skills

Implement routing.toml and the three roster commands specified above. Migrate current routing from notes into that data source, then remove duplicated backend bindings from the operational skill prose.

Update the existing delegation skills to:

Read the selected preset and required role.
Execute the established herdr or Jev recipe.
Register the returned external identity for observation.
Use the existing wait/read/question/cleanup path.

Install one static preset-aware skill per supported harness as part of explicit setup. Do not generate a new skill for every preset or rewrite harness configuration whenever the selection changes.

Acceptance: switching build-grok → build-pi changes the next implementer dispatch without editing notes, changing MCP schemas, or relabeling a running child. Two roots can select different presets. An incompatible oracle/coding-role binding is rejected rather than rewriting the task.

O5 — Retire duplicated execution services and simplify packaging

Move new work to the established herdr/Jev skill paths first. Stop recommending or registering the combined HUD execution MCP for new sessions.

For already-live legacy work, retain the old installed version’s read/answer/recovery/close capabilities until those handles are finished or explicitly disposed of through their existing owner-controlled path. A browser job may still be in flight after a local process exits; process absence alone is not a drain condition. Do not migrate, replay, or silently adopt these jobs.

Then remove the obsolete default dispatcher, host-launch wiring, Python bridge, registrations, and branch-only dependencies/tests. Keep J1/J1b/J2 and their tests independently buildable.

Narrow the previous deletion rules. Native-v2 WP1/WP2b must not ban or delete everything named herdr: existing main behavior includes herdr completion, health, wrapper, and context integration. Remove historical ledger/supervisor coupling while preserving or extracting useful observation/navigation code. The existing main bridge only observes its launcher’s pane, so extending child visibility remains real work. 
Main bridge, 
main-feature manifest

Acceptance: the target installation needs no agent-launch MCP or resident dispatch host. Main features and external task execution still work. No permanent compatibility dispatcher remains.

O6 — Validate the actual owner workflow and close delivery

Replace the old HUD-controlled 3 × 2 dispatch matrix with checks of the retained integration:

Check	Required result
Claude, Codex, and Pi as main session	Each can discover/select the roster and invoke the supported external recipes.
Pi implementer and Grok Build	Correct parent, backend, task, pane, activity, and result in the tree.
Pi question/answer	Existing question file and notification path work; HUD reflects the answer without becoming its broker.
Jev job	Existing key, send/recovery status, attention, and result appear correctly; observation never resends.
Preset switch during active work	Existing children unchanged; subsequent dispatch follows the new selection.
Close/restart HUD	Children and web jobs continue; reopening reconstructs the view without execution.
herdr/source interruption and pane reuse	Honest stale/unknown state; no invented completion or wrong association.
Existing cleanup	Skill/harness cleanup works; observed limitations are recorded accurately.
Regression	WP0, relevant Jev tests, retained visual tests, and applicable main integration/performance checks pass.

Use fixtures for failure states and ordinary existing jobs for observation checks. New paid web sends are unnecessary merely to validate a renderer.

Reopen autonomous chaining only when repeated real workflows show that the remaining main-session handoffs are a material cost the owner wants to eliminate. That is a future scope decision, not an unfinished dependency of this release.

3. Exact documentation edits
A. Append this subsection at the end of concept §15, before §16

The following is the exact proposed decision-log text:

Markdown
### 2026-11-07 Scope convergence: herdr/skills execute; HUD observes

This entry supersedes conflicting execution-scope decisions in the earlier
2026-11-07 product reset, native HUD v2.1/v2.2 decisions, and WF1 decisions.
Earlier entries remain historical. The priorities remain lightweight operation,
fast display, clear visualisation, and less delegation friction.

The implementation baseline is the owner's existing herdr delegation and Jev
skills. herdr already provides cross-harness launch, prompt, read, background
wait, and ordinary cleanup. Pi already has ask_orchestrator and answer files.
HUD's immediate added value is unified observation and convenient routing data.

| Decision | Current scope |
| --- | --- |
| Product boundary | HUD owns observation, explicit task/session association, presentation, and retained model-summary features. The main agent and skills own routing and orchestration; herdr and the harnesses own CLI child execution. |
| Cross-harness dispatch | Use the existing herdr delegation recipes. Do not implement hud_create or a second HUD dispatch service. Retire the implemented managed_* execution surface through the migration below. |
| Main harnesses | Retain Codex, Claude, and Pi as supported roots. Each main harness must be able to discover presets and invoke supported external recipes; verify this through skills/commands rather than a HUD dispatch matrix. |
| Topology | The main agent advances skill-defined handoffs and review loops. HUD may display task/step labels but does not interpret edges, consume verdicts, or advance work. |
| WF1 | Deferred in full. No workflow_plan/start executor, frozen execution bundles, host-owned transitions, or workflow-owned children in this release. F1–F6 and the prior F7 review decision belong to the deferred design. |
| Wake behavior | Existing harness/herdr/skill wait paths deliver results and questions. One main-session wake per stage is accepted. HUD adds no competing agent wake broker. |
| Questions and answers | Existing harness channels and skill conventions remain authoritative. HUD displays questions and their locations. No hud_respond broker or HUD-owned one-hour/two-hour request timers. |
| Lifecycle | herdr, harnesses, and launch skills own child cleanup. HUD does not kill, resume, or relaunch external children. Missing observation is not proof of completion or failure. |
| Tree | One root-independent tree combines the selected root, evidenced native descendants, explicitly associated herdr children, and Jev jobs. Unrelated sessions remain excluded. Unsupported metrics remain unavailable. |
| Association | Store stable root and external identities with source/home namespaces and optional native references. Never infer parentage from cwd or timing. Registration is idempotent and does not authorize execution. Registration failure never causes relaunch. |
| Presets | One user-level $HUD_HOME/routing.toml defines backend profiles, role bindings, and recipe references. A small CLI exposes selected data on demand; skills perform dispatch. No dynamic MCP schemas, project shadowing, runtime role overlays, or workflow graph loader. |
| Preset selection | Selection is scoped to a stable main-session identity. The owner or the main agent acting under existing routing instructions may select a declared preset; an explicit owner selection stays pinned. Only owner-directed action changes the persistent default. Authorized one-off backend choices are allowed. |
| Preset changes | Affect future dispatches only. Each child retains its actual backend and preset-at-launch. No live child migration or relabeling. |
| Quota behavior | No automatic quota broker or transparent retry. The main agent may select an authorized alternative, with explicit handoff when work has occurred. Ambiguous launch/send outcomes are reconciled, never blindly repeated. |
| Jev execution | Existing jev-ask/jev-aistudio skills and their driver remain the operational path. HUD reads their actual job records and results without mutating send state. |
| Jev implementation | Keep completed J1/J1b/J2 code, assets, attribution, schemas, and tests. Defer the new J3/J4/J5 ask/runtime migration. Adapt J6 to external job observation. Do not retire the working Jev CLI as part of this release. |
| Pi | Preserve ordinary observation and the footer. Preserve the owner's existing Pi/pi-roles launch and question recipes. The HUD parent dispatch package and mandatory HUD-specific -ne/-ns/-e launch composition are no longer product requirements. |
| Main features | Keep bar, panel, brief, dry-run, summaries, installer, and existing main herdr behavior. WP0 remains mandatory through pruning. |
| Summaries and caches | Keep the generic public-material work and production summary restoration. Preserve the accepted <dir>/cache.json response-cache location. Defer new prompt-cache lifetime forecasts and scheduler/reuse rules; existing measured usage remains. |
| Runtime footprint | No new resident agent host, workflow worker, per-child HUD runner, or observation daemon. Use the existing HUD processes and bounded read-only collectors. |
| Installation | Keep the main installer. Make observation integration and static skill installation explicit. Agent-launch MCP registration is not required for the target product. |
| Validation | Replace the HUD dispatch matrix with external-launch → association → display → question/result → existing cleanup checks, root-harness coverage, restart/failure cases, and retained main-feature gates. |

Migration: route new work through herdr and existing Jev skills first. Keep the
previous installed runtime only to finish, inspect, answer, recover, and close
its already-live work through that version. Do not replay or automatically adopt
those jobs. A local process exiting does not establish that a web job is finished.
After external observation is accepted and legacy live handles are drained,
remove obsolete default dispatch/host/bridge entrypoints and registrations.

Pruning is dependency-based. Remove historical ledger, claims, run-supervisor,
and managed-delegation coupling from live observation paths. Do not blanket-delete
herdr observation/navigation code or weaken WP0 to make deletion pass.

The ordered implementation queue is O0 scope/baseline, O1 external contract,
O2 collectors/association, O3 tree/summaries/footer, O4 presets/skills,
O5 execution-service retirement, O6 owner-workflow acceptance.

Autonomous chaining may be reconsidered after real usage demonstrates that
per-stage main-session handoffs justify a separate execution service. It is not
a dependency of this release.
B. Mark the earlier §15 decisions as superseded where applicable

Immediately below each of these existing headings:

2026-11-07 本地对齐：产品定义重置（Jacob）
2026-11-07 设计定稿：native HUD v2.1 与 Jev 内化（Jacob）
2026-11-07 工作流（Jacob）

Insert this exact note:

Markdown
> Scope status: the later “2026-11-07 Scope convergence: herdr/skills execute;
> HUD observes” entry supersedes conflicting execution, host, workflow,
> request/wake, and installation requirements here. Retained main features,
> non-interference, observation, and explicitly preserved Jev work still apply.

Do not erase the historical decisions or claim the prior reviews were never accepted. Their implementation priority and active scope have changed.

C. Make the companion documents and queue consistent
Document	Exact disposition/edit
docs/design/hud-workflows.md	Add the deferred banner below. Move W1–W6 out of the active queue. Leave the design body intact as historical/deferred material; do not spend another revision making an unneeded executor ready to build.
docs/design/native-hud-v2.md	Add the scope banner below. Replace §7’s active queue with O0–O6. Keep WP0; retain extraction/material work from WP1; replace WP2a with observation associations; narrow WP2b; make WP2c retirement; cancel agent WP3–WP5; adapt WP6/WP7; shrink WP8 to observation/footer; retain WP9/WP10; rewrite WP11/WP12 for the reduced installation and validation.
docs/design/jev-in-hud.md	Mark J1/J1b/J2 retained, J3–J5 deferred, J6 changed to external observation, J7 no longer a HUD prerequisite, and J8/J9 narrowed as specified above. Remove active promises that the CLI will be retired or that the new jev_ask* runtime is already available.
docs/handoff/STATE.md	Put O0–O6 at the top as the current queue. Replace the “Next” instruction to implement identity/host/dispatch architecture. Preserve earlier validation results as historical evidence.
docs/ARCHITECTURE.md, docs/reference.md, docs/delegation.md, AGENTS.md, CLAUDE.md	Update the current product description and entrypoint instructions to observer HUD + external execution. Remove instructions to begin canceled host/WF1 packages. Preserve unrelated repository rules.
tests/main-features.md and manifest	Keep WP0’s scope and retained assertions. Update B17 exceptions only when production summary behavior is actually restored. Add new observation coverage separately.

Exact WF1 banner:

Markdown
> Status: DEFERRED — superseded for the current release by concept §15,
> “2026-11-07 Scope convergence: herdr/skills execute; HUD observes”.
> This document remains a reviewed design reference. Its executor, MCP tools,
> frozen bundles, recovery machinery, and cache forecasts are not active work.
> The main agent currently advances workflow recipes through existing skills.

Exact native-v2 banner:

Markdown
> Status: PARTIALLY SUPERSEDED — concept §15's 2026-11-07 scope-convergence
> decision cancels HUD-owned agent dispatch, the proposed singleton agent host,
> unified child requests, agent wakes, and lifecycle ownership.
> Retain root-independent observation/display, transcript readers, main features,
> generic summary materials, Pi observation/footer, and WP0.
> The active implementation queue is O0–O6; prior execution packages are not
> implementation instructions.
