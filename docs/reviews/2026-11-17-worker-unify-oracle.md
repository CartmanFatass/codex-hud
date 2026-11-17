Recommendation: Unify HUD-managed work around one leaf-job input/report contract and one caller-scoped prompt store, retain the three existing execution drivers, and serve skills through MCP resources plus the Skills Extension with a six-tool-compatible fallback—not a Matt-specific loader or a new execution platform.

# One worker model and on-demand prompt delivery

## 1. Reasons and evidence boundary

This incorporates both follow-ups: **a skill is one case of “who receives which prompt, when,”** and **SEP-2640 is a candidate transport that adds no tools**. Paradigm B, the mechanics-only convention, main-session decisions, no worker commits/delegation, and milestone review are settled inputs, not questions reopened here.

### Evidence labels

- **Verified source:** current source inspected in this investigation. `H/` below means `/home/fires/projects/MyHUD/`; `P/` means `/home/fires/Fishpref/pi-roles/`; `U/` means `/home/fires/codex/MySkills/_upstream/mattpocock-skills/`.
- **Reported live / not independently verified:** the main session’s observations supplied in the brief, including Claude’s skill list with/without `--disable-slash-commands`, the live `frontend-imp` assignment, and the lack of current Codex CLI places.
- **Unverified:** client behavior, protocol/version claims or prior art not established from inspected source. These are explicitly identified below; proposed behavior is a design, not a claim of current implementation.

HUD was `fd9730a60771d5585c3a1c9cc51293fc83adf32d` when inspection began and `cec69c096174b9a298d75dd45baefd2927c7ff30` at the later check. The intervening diff named only `docs/handoff/STATE.md`. Fishpref was `1bbc616190a9391740a555bfa5b50a5551d0d083`; upstream Matt was `5863806dd4e15c63174bee4e7515a4256792ecfa`. The held ORACLE-SKILL worktree was not treated as landed code. No builds, tests, installs, client sessions, browser operations or worker launches were run. Only this report was written.

### The short answer

1. **Yes, central on-demand delivery is practical.** A local MCP can publish descriptors, then bodies/supporting files when requested. It does not need to install a method into every client’s discovery directory. A resource read delivers text; it does not itself execute a method or grant permission.
2. **Most of the common worker contract already exists:** `brief.md`, `report.md`, `STATUS.json`, `SESSION.txt`, `qa/qN.*`, a caller pane, and shared display rows. The remaining useful unification is input selection, actor rules, questions, and truthful capability reporting—not making every harness use the same supervisor.
3. **Two starting assumptions need correction.** Current HUD Pi dispatch does **not** use `managed.mjs`. Current HUD tab creation does **not** call `tabCreateArgs` or explicitly pass HUD job environment variables. These affect both isolation and the proposed caller filter.
4. **There is a third live worker form inside Pi:** helper workers spawned by `call_sonic`/`call_reviewer`. This is not dead history. It is a real inconsistency with the task’s settled leaf-worker rule.
5. **Native subagents should remain visible but outside HUD execution.** Using the native Agent tool is not the same thing as creating a HUD `frontend-imp` job. If the owner wants one execution contract for frontend work, choose the HUD role for that work; do not build a native-agent bridge just to hide the distinction.
6. **Keep six tools.** Serve ordinary resources and, after checking its actual schema, SEP-2640. Use `hud_roster` discovery plus resource/local-file reads as the portable fallback. MCP prompts are an optional user-invocation projection. A seventh “load skill” tool is not necessary for these three local coding clients.

The product already separates execution from display (`H/docs/ARCHITECTURE.md:11–39`), disallows an owned execution platform and local identity-proof system (`H/docs/spec.md:88–105`), and makes project registration the boundary for loading `.hud` configuration (`H/src/roles/roster.ts:378–449`). The recommendation preserves those boundaries.

## 2. A — Worker inventory

### A1. Live launch, input and skill paths

| Form | Launch and role instructions | Skill input today | Questions, result and lifecycle |
|---|---|---|---|
| **HUD Pi primary** | `hud_create` → `dispatchPi` → `pi-role --args-json <pi_role>` → herdr tab → `agent start --kind pi` → first prompt reads `brief.md`. The Pi extension loads role frontmatter/body from an owner override under `~/.pi/roles` or `P/roles`, and inserts the body into the role system-prompt section. | `piSkillArgs` resolves `place.skills ?? role.skills` to absolute directories or a registered project’s `.hud/skills`; missing/broken entries are skipped and recorded. It adds `--skill` and, for a registered project, `.hud/agents/<role>.md` as an appended system prompt. The launcher additionally contributes selected package resources and sometimes `helper-pane`. | Native `ask_orchestrator` writes QA files, uses the supplied notification command, and normally waits up to 1,200 seconds. The Pi dispatch extension judges a real `agent_settled` event, a changed/nonempty output file, pending tools/messages/questions and errors. Implementer-like runtime roles get model-cache-derived grace; other runtime roles close. HUD’s watcher/reaper handles tabs. |
| **Pi helper inside a primary** | `call_sonic` or `call_reviewer` → `P/bin/pi-role-call`; numbered brief/output and `.dispatch/<kind>-N/STATUS.json`; right-hand pane, possibly created on demand, or headless outside herdr. | Helper has its own role and launcher resources. It is not a new `hud_create` job and does not automatically inherit the primary’s `role_skills` list. | Tools return a bounded artifact excerpt/path to the parent. The helper uses the task’s QA directory; helper CLI owns bounded waiting/cleanup. Parent state includes `waiting_helper`. This is a second delegation mechanism, not merely a different renderer. |
| **HUD Claude CLI** | `dispatchCli` creates a herdr tab, starts `claude` with model/effort/bypass and extra role args, then prompts it to read `instructions/<instructions>.md` and `brief.md`. These are first-turn instructions, not Pi’s system-role section. | No role-skill injection in the inspected landed path. Normal Claude discovery is left enabled. The user-scoped HUD MCP is also registered for normal Claude processes. Main’s reported live test found approximately 45 skills; disabling slash commands removed the list. | `hud-ask.mjs` implements QA as a command. `hud-cli.mjs` observes herdr/process/report facts; `cli-judge.ts` determines lifecycle. Turn-trusted timing by default. Shared watcher/reaper. |
| **HUD Codex CLI** | Same CLI path, using Codex’s own config/account/session store and interactive shell startup. | No role-skill injection in landed code. Shared `${CODEX_HOME}/skills` discovery is a supplied live fact, not isolation. MCP env forwarding is explicitly restricted by the installer. No active Codex role place was reported. | Same QA, report, supervisor and reaper. Special startup handling waits out “phantom working”; 90-second startup budget. Turn-trusted timing by default. |
| **HUD Grok CLI** | Same CLI path; Grok-specific model/reasoning/bypass flags and trust dialog. | No landed per-role injection. Actual personal/plugin skill discovery and a per-run exclusion switch are **unverified**. | Same QA/report protocol; turn-trusted timing by default. |
| **HUD Antigravity CLI** | Same CLI path; its own model/effort/bypass flags and trust dialog. | No landed per-role injection. Its actual skill-discovery/exclusion behavior is **unverified**. | Same protocol; advisory screen status by default, because screen “done” is not a reliable turn boundary. |
| **HUD browser text task: ChatGPT/Gemini/AI Studio** | `dispatchBro` creates a tab and runs `hud-jev.mjs`. The wrapper calls external `jev-ask` key/send/wait or `jev-aistudio send`, passing a local prompt file to that external CLI. It does not load `instructions/*.md`. | Only text already in the task/brief. No role skill transport or MCP inside the remote browser model is established. A local path written in that text is not a file the remote model can read. | No in-task `hud-ask`, `hud_send` or continuation. External CLI saves the answer as `report.md`; wrapper writes `closed`/`failed`. A clarification must currently come back in the answer for main to handle with another job. Shared watcher/reaper handles the local wrapper/tab, not the remote service’s lifetime. |
| **HUD browser media task: Flow** | Same wrapper, `jev-flow send`, output directory `media/`; video credit confirmation only from an explicit `cost: N credits` statement in the brief. | A media prompt, not a workspace coding role or executable skill environment. | Wrapper writes a download-index report. No questions/continuation. Killing the local wrapper is not proven to cancel a remote generation or refund credits; that remains **unverified**. |
| **Claude/Codex native subagent of main** | Main invokes that client’s native agent mechanism. HUD does not launch it. Native role/custom-agent prompt and context behavior belong to the client. | Exact native inheritance/skill controls are **unverified** here. Do not infer them from the CLI-worker test. | Client owns questions, result return, stopping, reuse and cleanup. HUD reads transcript facts and renders cards. No HUD job directory, `hud_respond`, `hud_send` or `pi-role-reap` contract is established for these agents. |

Primary evidence:

- Pi dispatch: `H/packages/hud-mcp/src/thin-main.ts:311–480`; role lookup/body: `P/extensions/roles.ts:83–136,354–400`.
- Actual launcher: `P/bin/pi-role:27–31,101–126`. It uses `-ne` and normally `-ns`, **not `-np` on this route**. `managed.mjs` is selected only by `--runtime-context`, which HUD’s `dispatchPi` does not supply.
- Extra Pi resources: `P/extensions/bundle.ts:54–81` explicitly preserves selected package skills/prompts despite `-ns`/`-np`; `P/bin/pi-role:114–115` adds helper-pane for implementer/sonic role names. Thus “only the skills HUD passes” is too strong even though personal skill exclusion is the default.
- Helpers are actually enabled: `P/extensions/dispatch-policy.ts:41–50`; tool implementations: `P/extensions/dispatch.ts:189–244`; launch/round protocol: `P/bin/pi-role-call:89–180,193–204,256–265,319–412`.
- Pi settlement/grace: `P/extensions/dispatch.ts:294–347`; `P/extensions/dispatch-policy.ts:68–92`. Pi default grace is two thirds of the declared cache TTL, capped at 20 minutes, not the CLI’s fixed 600 seconds.
- CLI launch and first prompt: `H/packages/hud-mcp/src/thin-main.ts:611–704`; kind flags: `H/src/roles/cli-kinds.ts:19–51`; state-trust defaults: `H/packages/hud-mcp/harnesses.json:5–30`.
- Landed validation rejects skill arrays on CLI/browser places: `H/src/roles/roster.ts:145–158`. The approved but held ORACLE-SKILL requirement in `docs/spec.md:74–76` is not proof this branch implements it.
- Questions: `P/extensions/roles.ts:244–306`; `H/packages/hud-mcp/bin/hud-ask.mjs:35–134`.
- Browser launch: `H/packages/hud-mcp/src/thin-main.ts:483–511,968–976`; wrapper: `H/packages/hud-mcp/bin/hud-jev.mjs:19–47,79–125`.

### A2. What “facts-only” means in each live driver

**Pi:** the runtime knows that the agent settled and whether this turn wrote a changed report. Missing/empty/unchanged output or an aborted/error result produces failure. This is an authoritative runtime event, not an inference from a quiet terminal. Pi’s lifecycle is still keyed to runtime role names such as `implementer`/`architect`, rather than entirely to the logical HUD role’s `can_continue` (`P/extensions/dispatch-policy.ts:7–10,68–81`).

**CLI:** a new report is compared with the baseline in `turn.json`. A live worker is not failed merely because the screen is quiet, the report is absent or the supervisor died. Depending on state trust, a quiet changed report needs 2 or 10 seconds of stability. Background child processes matter before quitting. A dead/replaced process is authoritative; unavailable liveness is not. See `H/packages/hud-mcp/src/cli-judge.ts:13–47,106–169` and `bin/hud-cli.mjs:149–178,217–264`.

The approved quiet-decision exception remains distinct: a bounded external decision can choose wait, a fixed report prompt, a quota-backed failure or handoff to main. Below 0.8 confidence, on missing keys/errors, or without a quoted quota/rate-limit line, it hands off (`quiet-decision.ts:73–170`). The supervisor can ask again after a wait and caps its own attempts at three; the fixed report prompt is once per job (`hud-cli.mjs:225–250`). Do not “unify” this by killing Pi or browser workers on the same screen heuristic, or by inventing a universal model-based completion judge.

**Browser:** the wrapper has external process exit and result-file evidence, not agent-settled events. It currently checks report existence, not the Pi/CLI fresh-nonempty report invariant (`hud-jev.mjs:109–116`). Its final lines also directly prompt the main pane (`:119–125`), unlike the common job-event path. That direct completion prompt is an avoidable difference and conflicts with the no-typing completion direction in spec §2.1; route browser completion through the existing event readers instead.

**Reaping is already shared.** HUD’s watcher observes terminal jobs, retains failures for two hours, invokes external `pi-role-reap`, and removes closed job directories after one day on a later scan. It preserves legacy real Pi sessions before deletion (`H/packages/hud-mcp/bin/hud-watch.mjs:118–145,190–278`). The reaper protects the orchestrator, verifies recorded names/session or PID-start evidence, and refuses occupied/renamed tabs (`P/bin/pi-role-reap:42–46,48–162`). Do not replace it in this project.

### A3. Panel, bars and `hud watch`

- **All three HUD driver types** write the same job-family files. `jobRow` normalizes state/reason/report/question facts; `readThinJobs` makes cards. MCP reads use the same row function, and `hud watch` uses the lightweight `readThinJobRows` path. Evidence: `H/src/collectors/thin-jobs.ts:173–235,300–313,326–469`; `H/packages/hud-mcp/src/thin-main.ts:706–778,1154–1171`; `H/src/cli/watch.ts:1–4,26–58,185–211`.
- Display ownership is the **recorded dispatching pane**, not a claimed worker identity or security principal. Main’s `changes` are pane-filtered; `hud_read` is not a general access-control system. Panel visibility and watcher actionability have different presentation rules but share lifecycle facts.
- **Bars** consume thin-job facts too: Codex `H/src/index.ts:33,98`; Pi `H/src/harness/pi/segment.ts:2,38`. Native client events/transcripts supply native-agent notices. These are display integrations, not alternate launch paths.
- **Native subagents** are read separately. Claude metadata/JSONL supplies Agent type, description, nesting, growth and completion; see `H/src/collectors/claude-native-tree.ts:36–145`. Codex descendants come from the rollout tree (`H/docs/ARCHITECTURE.md:126–141`; `src/collectors/subagent-tree.ts`). Pi helpers are not a separate native tree in this implementation. `hud watch` reads HUD job rows, **not native-agent transcripts**, so a native Agent-tool result does not become a HUD watch settlement.
- Pi helpers are not independently watchable HUD jobs. Their pending state can affect the primary; legacy task readers understand `.dispatch` artifacts, and thin jobs read numbered review files. This is not equivalent to every helper receiving a separate `job.json`/MCP lifecycle.

### A4. Two prompt authorities, and differences without product value

The same logical role can change instruction semantics when it changes place:

- Pi implementer receives `P/roles/implementer.md`, including active helper tools and permission to use sonic; CLI receives `H/packages/hud-mcp/instructions/implementer.md`, which says not to start another role unless briefed. Compare `P/roles/implementer.md:30–36,47–63` with the HUD instruction file `:9–18`.
- Pi roles contain tool/read-only metadata and runtime-name lifecycle behavior. HUD CLI markdown contains only behavioral instructions; CLI bypass mode does **not** provide Pi’s read-only guard (`P/extensions/roles.ts:421–445`). A common prompt cannot erase that enforcement difference.
- Report wording has drifted: HUD `instructions/general.md:31` asks for the same report in the final turn, while generated briefs and other role texts prohibit repetition (`thin-main.ts:973–976`).
- Common QA files are good; separate prose describes their mechanics repeatedly. Both ordinary Pi and CLI QA currently fall back to the proposed default after 20 minutes. The managed Pi “wait until answered/aborted” path is not today’s HUD behavior.
- Pi role names control grace even when the logical role file says otherwise. CLI freezes `can_continue` in `job.json`, but `hud_send` also consults the *current* registry (`thin-main.ts:1083–1089`). A role edit should affect the next job, not change an existing job’s input contract mid-flight.

Model flags, native system-prompt access, real settled events versus terminal observation, cache-dependent grace, read-only tool enforcement and a remote browser’s lack of filesystem access are genuine harness differences. Duplicate method/role prose, unrequested helper delegation, inconsistent report instructions and accidental skill inheritance are not.

### A5. Legacy systems: dead execution versus live compatibility readers

The shipped entry is unequivocal: `H/packages/hud-mcp/bin/surface.mjs:6–8` selects only `thin-main.js`. New jobs use `roleRegistry`, not `routing.toml` or Oracle propose/converge slots (`thin-main.ts:779–807,929–1000`). Source searches across `src`, `packages/hud-mcp/src` and `bin` found the following in-repo production reachability:

| Area | Finding and deletion boundary |
|---|---|
| `src/roles/routing.ts`, `roles.ts`, `adapters.ts` | The old backend/preset/slot execution model is **not a live dispatcher**. `readRouting`, `loadRouting` and `parseRouting` have no production caller outside their own loader chain; `resolveRoster` is likewise uncalled. Fixed `oracle.propose`, `oracle.converge`, `jev` slots at `roles.ts:8–16` do not define today’s roster. However `selection.ts` still imports `RoutingError` and other old symbols, so this is not yet an independently deletable directory. Extract the few live identity/error helpers, then delete the old routing/slot/adapter machinery and tests that solely exercise it. |
| `src/roles/selection.ts` | `parseRosterRoot`, `formatRosterRoot`, and the root-key hash are **live display identity helpers**: `tree-page.ts:12–13`, `cli/panel.ts:10`, `integrations/panel/receipt.ts:9`, `external-association.ts:1–4`. `saveRosterSelection`, `loadRosterSelection`, `resolveRoster` have no in-repo production caller. Split identity out; remove selection persistence/routing, not the current panel’s root keys. |
| `src/roles/association.ts` | `parseAssociation` is **live** through `JobObservationCollector`; `completeNativeRef` is used by job-tree composition. `writeAssociation` has no production caller. Keep the reader only if retaining old job display; drop the dead writer. |
| `src/roles/job-receipt.ts`, `job-store.ts` | Old `loadReceipt`/receipt normalization and locking have no production call path. `writePrivate` is imported by the dead association writer; `readPrivateJson` is re-exported by job-store. These are dormant execution support, not the plain `job.json` path. Remove after cutting that dead writer/import chain. Do not delete user job directories. |
| `src/roles/pi-dispatch.ts`, `pi-dispatch-status.ts` | **Mixed.** `validDispatch`/`dispatchText` and `parseDispatchStatus`/`activeDispatchQuestion` are used by old job/task observation. `observeDispatch` and `waitDispatch` have no production caller found. Remove dormant control/wait functions; do not delete the parser while a live collector uses it. |
| `src/roles/herdr-run.ts` | **Mixed.** General herdr helpers/ID parsing remain used. `tabCreateArgs`, `agentStartArgs`, `promptArgs`, `waitArgs` have no production caller found. In particular, the `--env` loop in `tabCreateArgs:246–255` is **not evidence that today’s HUD worker tabs carry HUD env markers**. Actual creates are inline at `thin-main.ts:399–408,486–495,624–633`, without `--env`. |
| Legacy observation pipeline | **Reachable, not dead code.** `PanelJobPipeline` constructs and refreshes `JobObservationCollector` and `TaskObservationCollector` before thin jobs (`tree-page.ts:125–146,194–209`). The former scans `$HUD_HOME/assoc`, reads old `receipt.json`, and can read `jev-runtime` records (`job-observations.ts:264–274,467–506`). This observes historical formats; it does not make those executors live again. Removing these readers is a separate deliberate removal of old display compatibility. |
| `src/collectors/native-calls.ts` | Not the new Claude Agent transcript reader. It is a still-wired reader of `native-relations` and an old native-host socket (`:76–81,169–231`; `src/managed/host-ipc.ts:8–12,23–28,75–82`). No new thin-job launch uses it. Do not confuse it with `ClaudeNativeTree`, or claim every file with “native” is dead. Its historical display path can be pruned separately if the owner no longer wants it. |
| `P/bin/managed.mjs` | A distinct external Pi launcher for `--runtime-context` with profiles, hashes and session contracts. Not called by HUD’s current launch. It may have other Fishpref consumers: **those consumers are unverified**. Do not delete it from another repository merely because HUD does not use it. |

“Dead” above means no call from the inspected in-repo production entry paths, not a promise that no external script imports a file. No retained historical data needs migration or destruction to simplify the new worker contract.

## 3. B — One worker model

### B1. Options and costs

| Option | What it buys | Cost / limitation |
|---|---|---|
| **Smallest containment** | Central skill files, explicit per-job selection, main/worker filtering, and consistent launch notes; keep existing role texts and drivers. | Low runtime change. Fixes accidental HUD-skill discovery, but leaves two role authorities and Pi helper policy drift. Good first vertical slice, not a complete answer to unification. |
| **Recommended: one input contract, three drivers** | One HUD-owned role body and prompt-selection policy; existing file protocol; leaf Pi/CLI workers; browser capability boundary explicit. Keep native subagents outside execution. | Moderate, mostly launch preparation and one narrow Pi-roles integration change. Preserve its runtime/guard/reaper rather than porting them. No resident service or new ledger. |
| **Everything through Pi, or everything through a new common runtime** | Superficially one launcher and lifecycle. | All-Pi loses official CLI behavior/subscriptions and browser capabilities. A universal SDK/native/browser supervisor recreates the execution platform the spec rejects. Large maintenance and qualification cost; not recommended and outside scope. |

### B2. Small common contract

Keep current `job.json`/STATUS/SESSION/QA files. Add only resolved input information needed to explain what was delivered. This is a contract outline, **not a replacement persistent schema to implement verbatim**:

```text
Job input
  id, request_key, cwd, dispatching pane, logical role, frozen place
  brief path
  resolved role-instruction reference
  selected skill references (name, resolved directory, source/revision)
  project worker supplement, if applicable
  report path
  can_continue; question interface supported/unsupported

Driver facts
  native identifiers (Pi session or CLI agent session or browser invocation)
  current state + evidence/reason
  current-turn report evidence; question files; settlement/grace/end time
  recorded pane/tab/PID facts already needed by the reaper
```

Invariants:

1. **Main supplies the task and selects the actor.** No worker starts another role, commits, interviews the owner, or upgrades itself into a main session. Do not restore an exception by leaving “unless the brief asks” in a generic role footer when this task’s policy forbids it.
2. **Role ≠ place ≠ method.** Role defines stable responsibilities; place defines execution/model; a selected skill supplies optional method/reference. Changing a role’s place must not silently change its method or obligations.
3. **Each job has an explicit input set.** Freeze selected references, continuation permission and place at creation. A later role edit affects the next job. `hud_send` continues the same input contract; changing its skill set is a new job for now.
4. **Briefs are not parsed for magical skill instructions.** Main translates its intended methods into the structured per-job list. A prose mention of “spec” or “TDD” must not cause runtime inference or skill auto-selection.
5. **File output is the result contract.** A new nonempty report belongs to the current turn. Final chat is only `report written: <path>`. Report presence/read status is not acceptance. Main preserves useful results outside the expiring job directory when needed.
6. **Failure requires appropriate evidence.** Preserve Pi settled-event checks, CLI facts-only rules and the approved quiet-decision exception. Unknown remains unknown. Missing/invalid launch inputs refuse before opening a tab; after input submission, an ambiguous failure does not trigger a second launch.
7. **Cleanup stays external and bounded.** Existing watcher/reaper, session-store preservation and retention stay. The prompt mechanism creates no timers, processes or cleanup authority.
8. **Isolation is accurately scoped.** HUD controls its own prompt advertisements and delivery. It is not a filesystem sandbox. The owner must choose whether “exactly these skills” means HUD-managed methods or *every skill supplied by the host, plugins and user configuration*; the latter is not verified for all supported CLIs.

### B3. Per-form changes

**Pi primary**

- Resolve the role body from HUD’s canonical instruction file, not a separately maintained Fishpref body for HUD runs. Keep Pi-roles’ frontmatter/tool restrictions, runtime role identity, model defaults and read-only guard.
- The cleanest small external change is an optional explicit role-body input for HUD runs, plus a leaf/no-helper mode. This must replace the old role body, not append a contradictory second role. Implement in `P/bin/pi-role` and `P/extensions/roles.ts`; standalone Pi-roles behavior can remain unchanged.
- Leaf mode must suppress helper tool activation **and** helper-pane discovery/role footer wording (`P/extensions/dispatch-policy.ts`, `dispatch.ts`, `bundle.ts`/launcher). Merely telling the implementer “do not use the helper tools” leaves unnecessary affordances and competing instructions. Do not remove independent sonic/reviewer HUD roles; main can create those jobs.
- Pass the logical job’s `can_continue` into the Pi dispatch contract. The Pi extension may still calculate grace from cache TTL, but `can_continue:false` must mean no retained continuation session. This is a small explicit override to the current role-name lifecycle mapping, not a general lifecycle framework.
- Keep `--skill` for exactly the selected directories, and suppress ambient skills/package skill contributions for this HUD leaf mode. Package extensions may still provide their non-skill tools. Keep project context/AGENTS coding guidance; “skill isolation” does not mean erasing project rules.
- An existing alternative is generating a temporary role file and passing its absolute path through Pi’s current role loader (`roles.ts:96–105`). It can unify body text without a new body flag. It still needs leaf/resource and continuation semantics fixed; relying on the role filename to accidentally omit helper-pane is not a durable contract. Choose this alternative only if avoiding a body flag is materially simpler.

**CLI workers**

- All four consume the same canonical role body as Pi, via the first prompt/file path; only the concrete question/loading transport note differs.
- Move skill resolution out of `piSkillArgs` into shared launch preparation. First prompt names required root methods and their absolute entry paths, plus allowed conditional references. Do not paste every support file into it.
- For Claude, add `--disable-slash-commands` for HUD workers **only after the owner approves the narrow launch-policy exception and the lifecycle probe below passes**. Do not assume it leaves `/quit`, MCP access and explicit file reading unaffected merely because the skill listing disappeared.
- For Codex/Grok/Antigravity, remove HUD-managed main methods from shared native discovery directories. Do not invent an exclusion flag, change HOME/CODEX_HOME, rewrite their session stores or silently disable arbitrary user config. Advertise the remaining ambient-discovery limitation until qualified.
- Keep `cli-judge`, state-trust defaults, trust refusal, per-job supervisor and reaper. No second generic supervisor.

**Browser jobs**

- Treat them as **one-shot remote jobs**, not local coding workers. A common role/brief selection step can compose their outgoing text, but only information explicitly selected for transmission is sent.
- Initially continue requiring a self-contained browser brief. If a selected method/reference is needed remotely, main includes its relevant text and support excerpts, or the adapter composes an explicitly enumerated text input set. Never assume `Read /home/.../SKILL.md` reaches the remote model, nor automatically upload an entire skill directory or repository.
- Capabilities are honest: `questions: unsupported`, `continuation: false`, `local_files: false`. A question comes back as “needs clarification” in the result; main chooses another task. Do not synthesize a live `hud_respond` loop from browser prose.
- Make report validation nonempty/current-job, remove direct completion typing, retain local reaping. Remote cancellation remains the external runtime’s contract, not a new HUD guarantee.

**Native subagents and frontend overlap**

Keep native agents as **observed external work**. Their display card may share title/state/report-summary presentation with a HUD job, but it must not gain HUD controls or lifecycle guarantees without an actual HUD job.

The existing `instructions/frontend-implementer.md` is already a suitable HUD role body (`:3–15,19–30,45–53`). Main’s reported `frontend-imp` can use it. For work that should meet this common contract, recommend main dispatch that role instead of invoking native Agent for the same responsibility. Native Agent remains available for explicitly client-native work; no attempt to disable the owner’s tool or auto-import its transcripts as jobs. The behavioral/native-skill inheritance, possible cost difference and context advantage of Agent versus a fresh Claude CLI are **unverified**; model alias similarity does not prove equivalence.

### B4. Questions: transport already common; one policy choice remains

Reuse `qa/qN.md` and `qa/qN.answer.md`, answer-once semantics, `hud_respond`, and existing notifications. A Pi tool and a CLI command are reasonable adapters to the same file protocol. Do not make every worker require HUD MCP access just to ask a question.

Current ordinary Pi and CLI both say “proceed with your default” after 20 minutes. Managed Pi’s different indefinite/abort semantics do not justify importing its whole runtime. **Recommended owner policy:** an unanswered question requesting a main-session decision stays unanswered; work on independent authorized parts may continue, then report the blocked part. A default is a recommendation, not permission to cross scope or change a contract. If the owner retains bounded automatic defaults for reversible choices, document that same rule in both adapters. This is a behavioral decision in D, not a silent change under refactoring.

### B5. What to delete, and what not to delete

Delete duplicate HUD-runtime role prose once one canonical body is in force; helper affordances in HUD leaf runs; the duplicate `PI_ROLE_TOOLS` schema definition if it can become a shared data module; dormant old routing/writer/wait functions identified in A5; method residue in the convention as already decided; and HUD-owned client skill links after the replacement path works.

Do **not** delete Pi-roles, its guard/reaper, official CLI supervisors, native transcript collectors, native Agent itself, browser CLIs, unrelated personal skills, user role overrides, or historical job/session data. Retiring live legacy readers needs an explicit compatibility choice, not a “dead-code” label.

## 4. C — One general prompt-delivery mechanism

### C1. The model: descriptors, bodies, supporting material, recipients, triggers

The common unit is a **prompt reference**, not a Matt skill and not a workflow stage:

```text
Prompt descriptor
  id / kind                 skill, role, convention, or job brief
  short description
  intended recipient        main, worker, or both
  invocation class          automatic/job-bound, model-selectable, user-selected
  entry reference           local file and/or resource URI
  supporting-file base
  source / revision         provenance, not a vendor-version runtime gate
```

These fields can come from existing sources: skill frontmatter plus a small HUD catalog; role JSON/instruction files; the existing convention resolver; `job.json`/brief for a job. Do **not** convert all four into a new directory format or build a configurable prompt rules engine. Two operations are enough: **describe the prompts available to this context**, and **resolve/read an allowed reference**.

| Prompt case | Recipient and time | What is initially visible | What is loaded |
|---|---|---|---|
| Dispatch convention | Main; when learning/using HUD mechanics | `hud_roster`/bootstrap description | The effective replace-whole convention, as today. No method catalog or method recipe embedded in its text. |
| Role instructions | Assigned worker; before executing its first brief | Logical role and its short responsibility in roster/job inputs | Exactly one canonical role body, eagerly for that job. Native system section where supported; explicit first-turn file read otherwise. |
| Brief | Assigned worker; first turn and explicit follow-up | Job/title/report contract | The full task text. A fresh worker does not inherit main’s unstated reasoning or loaded skills. |
| Skill/method/reference | Allowed recipient; selected by model or user according to invocation class | Name, description and entry reference | Body when selected; support files only when referenced. No eager load of the library. |

One general mechanism does not imply one trigger or one prompt-authority level. MCP resources are data; a Pi role system section and a Claude first-turn read are not equivalent host primitives. The adapter states the intended precedence: host safety/project constraints; worker role boundaries; scoped brief; optional method. A method cannot grant delegation, commit or owner-contact authority.

### C2. Central storage, with no special Matt runtime

Use the release’s existing `integrations/skills/<name>/` as the effective central skill directories. “HUD owns the store” does not require copying it to every client or even duplicating it under `~/.hud`: installed HUD already points into a retained checkout/release (`H/docs/ARCHITECTURE.md:60–65`). Keep owner-selected project links under registered `.hud/skills`; absolute role paths remain an explicit local input.

A small generic catalog, for example `integrations/prompts/catalog.json`, describes executable/consult-only entries, audience, invocation and source. It is also the source for the MCP metadata projection. The display tab can retain its small `{name,en,zh}` projection and passive behavior; it need not become a runtime permissions or installation-state viewer.

Resolution for skills:

1. Explicit absolute directory supplied through a trusted role/setup input.
2. A bare name in a **registered** project’s `.hud/skills`.
3. A shipped effective skill directory.

Do not search every client’s skill directory to satisfy an unresolved worker input. That would reintroduce the ambiguity this mechanism is intended to remove. A same-named unpatched plugin skill is not a fallback. A broken project override should be reported, not silently replaced by an unrelated shipped definition. Keep the project-registration gate and origin visible.

Versioning for third-party material, including but not special-casing Matt:

- Retain complete selected original directories, license/credits and a source commit under a non-discovered source area, e.g. `integrations/prompt-sources/<source>/<revision>/`.
- Keep minimal reviewed collision patches beside them, or an equally explicit checked-in patch record; materialize the **effective** directory at packaging/development time. Runtime serves only effective directories.
- Keep HUD-native recipes such as `hud-build` separate from originals. Do not label them unchanged upstream skills.
- Deliberate refresh only: select an upstream revision, compare methods, reapply/review the few compatibility edits, check all references. No network update, automatic rebase, runtime vendor pin or upstream-following service.
- Only selected methods need effective editions now. An optional catalog row whose compatible edition is not prepared is **consult-only**, not a promise it is safe to execute raw.

This makes the same mechanism work for an owner-written design skill, a company method, a role file or Matt’s library. There is no `if (matt)` in dispatch or MCP.

### C3. MCP transport: six tools, resources, Skills Extension, optional prompts

**Recommended surface:**

1. Keep the six existing job tools. Extend `hud_roster`’s returned metadata with the prompt/skill catalog and loading instructions; this is discovery, not workflow selection.
2. Add `resources/list`, `resources/read` (and templates if useful) for allowed prompt files. Serve name/description/URI metadata without bodies; load file bytes only on a read. Resources are the shared transport for role references, convention, own-job brief and skill files.
3. Add SEP-2640 `skills/list`/`skills/get` as a **projection of the skill entries of that same catalog**, not a second store. Files are resources, with canonical identifiers such as the supplied example `skill://tdd/SKILL.md`. Follow the actual extension’s schemas, negotiation and invocation metadata after checking them; do not invent a protocol from a search summary.
4. Optionally expose `prompts/list`/`prompts/get` for **user-invoked** entries. They return the same selected body/load wrapper, not a new procedure. This is useful only in clients whose user prompt UI actually supports it.
5. Do not add one MCP tool per skill. That duplicates tool schemas, consumes context and bypasses the six-tool boundary. A generic seventh loader is an alternative only if an owner later prefers it to the fallback—not required here.

Current server supports only initialize/ping/tools; it advertises `capabilities: {tools:{}}` and instructs callers only to call roster before dispatch (`H/packages/hud-mcp/src/thin-main.ts:1192–1247`). Adding extension/resources/prompts is real implementation, not a configuration switch.

**Portable fallback:** catalog returned by `hud_roster` → read a resource using the client’s existing resource tool, or read the returned absolute entry path with its ordinary file tool. All three are local coding clients; this fallback needs no new HUD tool and no installed native method body. Use an ordinary `hud://...` catalog resource for fallback bootstrap if the client has special handling for `skill://`; the exact canonical skill file URI remains the extension’s URI. Do not assume an experimental native skill feature must be enabled just to make ordinary resources work.

### C4. Where discovery lives, and what “always visible” can honestly mean

Description placement is client-specific; source content/selection is not.

| Location | Suitable use | Limitation |
|---|---|---|
| Native client skill discovery | SEP-aware client discovers server skills; Pi may receive selected central paths through its resource hook | Requires verified client support. Global client skill directories would again leak into CLI workers. |
| MCP tool description | Put a compact allowed prompt index or catalog bootstrap on **existing `hud_roster`** | Descriptions are visible only when the host exposes that tool. Deferred-tool discovery is not guaranteed to show every description every turn. Never put bodies here. |
| MCP initialize instructions | Explain “discover → load → read support files” and the catalog resource | Whether a client inserts these into model context is **unverified**; not a sufficient sole channel. |
| `hud_roster` response | Names/descriptions, invocation class, canonical URI and local entry path | Proven HUD transport; persistent availability after compaction depends on the client. It is not literally an always-present system section. |
| First prompt / launch file | Worker gets only its assigned descriptors plus required root-method paths | Reliable explicit handoff, independent of native discovery. It is intentionally not the whole main catalog. |
| Pi extension prompt/resource hook | Publish names/descriptions from the same catalog in the Pi session, and provide explicit user invocation | HUD already has a Pi extension, but this integration is new; qualify it rather than assuming the current MCP proxy does it. |

For main sessions without native extension support, use the roster bootstrap in the existing tool description and initialization instructions, and require a catalog read before selecting a HUD method. If the owner insists that **every skill’s full short description must remain in every request without even that bootstrap**, a client-specific persistent prompt hook or confirmed direct tool exposure is necessary. Do not claim a once-read roster is equivalent. That stronger UX guarantee is a client qualification issue, not grounds to put method text back into the convention.

### C5. Caller filtering: feasible per stdio server, not a security identity system

A separate MCP server process can compute a fixed caller context when it starts:

```text
no HUD worker marker       -> main-session context
valid HUD_JOB_DIR marker   -> that job's worker context
present but invalid marker -> unavailable worker context, never silently main
```

The marker selects the persisted job input set. It is **not** accepted as an arbitrary `audience: main` argument to a tool or resource request. No model-supplied role string, MCP client name, cwd or `HUD_MCP_SURFACE=roles` proves that a caller is a main session.

For a worker context:

- `skills/list`, `skills/get`, `resources/list`, `resources/read`, prompts and any tool-description index all use the same allowlist.
- Main-only entries are absent from discovery **and refused on direct reads/gets**; knowing a URI must not bypass the filter.
- Expose only the assigned role, own brief, selected skills and their contained support files—not main’s convention or another job’s artifacts.
- Hide/refuse the six **orchestration** tools in ordinary leaf-worker sessions. Questions still use `ask_orchestrator`/`hud-ask`. This is a caller-specific subset of the same surface, not another job API. If the host retains cached definitions, the call handler must still refuse them.
- Fix the context for the connection. A retained worker session cannot broaden its input set because main edited a role or because a caller supplied another `cwd`.

**Required propagation work:** explicitly pass `HUD_JOB_DIR` and the effective HUD home into each new worker tab’s environment. Do not rely on the unused `tabCreateArgs`. Verify the variables survive herdr’s interactive shell, the coding CLI, and its stdio MCP spawn. Codex currently whitelists only herdr variables (`H/install.d/codex.sh:50–54`); add the needed HUD marker/home to that installer-managed forwarding list. Pi’s HUD proxy currently forwards its environment (`H/src/harness/pi/role-client.ts:21–25`), but Pi workers commonly use the separate MCP adapter, so test the actual worker route too.

Filter checks require no signatures, tokens, process ancestry proofs or new permission database under this threat model. They are **trusted local context routing**, preventing accidental affordances—not defense against a worker deliberately reading a known filesystem path or forging its environment. The spec explicitly excludes that adversarial model.

**Native subagent limitation:** an Agent-tool child may use the parent’s MCP connection or a client-generated connection with no HUD job marker. Its actual behavior is **unverified**, and MCP requests do not magically carry “main versus subagent” identity. Filtering per stdio process cannot distinguish two actors multiplexed by a host. This is another reason not to promise the managed-worker isolation contract for native Agent. If strict actor isolation is required for the frontend work, use a HUD-launched Claude CLI job.

### C6. Exactly which skills a job receives

Add an unambiguous new argument such as **`job_skills: string[]`** to `hud_create`. Do **not** change the existing boolean `skills` into an array: it currently means “include personal Pi skills” (`thin-main.ts:102–105`; mirrored in `src/harness/pi/role-client.ts:128–131`).

Recommended semantics:

- Role-level skills are role requirements, independent of place. The one-job list adds explicit methods/references from the brief. Deduplicate names after resolution. Do not let a fallback place drop a role requirement.
- Retain place-specific skill configuration only as a compatibility input during migration. Normalize common requirements onto the logical role; if a selected place cannot deliver them, report that fact instead of silently skipping them.
- `job_skills: []` means no additional methods; it does not remove a required role reference such as oracle’s codebase-design. If the owner wants replacement semantics later, that is a separate explicit API decision, not two meanings for an empty list.
- Main names dependencies explicitly for now. Example: a test-first job that might design an interface receives `job_skills: ["tdd", "codebase-design"]`. The TDD body is required at start; codebase-design can remain a conditional reference. A worker needing an unassigned method asks main; it does not use native discovery to find an uncontrolled substitute. No general dependency/workflow engine is necessary.
- Record requested, resolved and unavailable inputs. A required input that cannot be resolved/read should return `input_unavailable` before launch, not the current silent-skip-and-run behavior. Do not mark a harness quota-exhausted for a missing skill file.
- Record **selected/available**, not “the model followed it.” Passing `--skill`, returning a resource body or observing a file read is not proof of method compliance.

Delivery:

- **Pi:** native `--skill <effective directory>` makes only the selected methods discoverable; the brief explicitly requires the chosen root method. Leaf mode filters unwanted package skill contributions as well as personal discovery.
- **CLI:** first prompt/launch file says to read the canonical role, brief and required root skill entries; it lists allowed conditional references and base directories. It does not require a native Skill tool.
- **Browser:** only self-contained text/explicit support excerpts can be sent; unsupported selected inputs refuse or require main to prepare the brief. Never pretend browser jobs can consume filesystem-only methods.

The API’s old `skills:true` and arbitrary `pi_args` can intentionally reopen ambient discovery today. They cannot coexist with an unconditional “exactly these and no other host skills” promise. Under the recommended HUD-controlled scope, document them as ambient-resource opt-outs; under a strict isolation decision, deprecate/refuse them for HUD leaf jobs, including contradictory raw arguments. D makes that choice explicit.

### C7. Loading syntax, relative files and Matt’s original methods

The mechanism must preserve a directory, not extract one `SKILL.md` and lose its references.

- A resource result includes the canonical entry URI and support-file base; a local-file fallback includes the absolute directory. `tests.md` in TDD resolves under that skill, **not the worker cwd**. Scripts run only if the brief/method authorizes them, with the skill directory as their base; reading a script resource does not execute it.
- Resolve relative resource paths inside the selected skill root. Refuse escapes/unknown files. Trusted `.hud/skills` symlinks can resolve to an explicit root; do not ban all symlinks and break the existing setup design.
- Text resources preserve full content. If a file exceeds a response budget, return an explicit complete-file path or a supported continuation mechanism; never hand back silently truncated method text as though it were complete. Ordinary file reads can handle large local references without a new tool.
- `skills/get`/resource reads and user prompt invocation all resolve the **same effective definition**. No independently edited Claude, Codex and Pi copies.
- An upstream instruction such as “Call the Skill tool twice, for grilling and domain-modeling” (`U/skills/engineering/grill-with-docs/SKILL.md:7`) is a transport collision. Patch only that instruction to load those exact named dependencies through the current client’s HUD loader. On a verified native SEP client this may use its namespaced Skill trigger; elsewhere it is a resource/file read. Never invoke whichever same-named client plugin happens to win discovery.
- Preserve TDD’s conditional codebase-design reference and its own `tests.md`/`mocking.md` (`U/skills/engineering/tdd/SKILL.md:16,26`). Preserve codebase-design’s supporting directory. Patch only the orchestration/actor collision in Design It Twice; main owns independent jobs (`U/skills/engineering/codebase-design/DESIGN-IT-TWICE.md:11–29`).
- A user-only skill is not an implicit child call. The loader returns invocation metadata; models may suggest it but wait for the user’s choice. MCP prompts can express a user trigger, but a string argument `invoked_by=user` is not proof of a human gesture. Strong enforcement of human intent is outside this trusted-local design.
- Keep the decided substitutions: `implement` → `hud-delegate`, `implement-spec` → `hud-build`, review orchestration → milestone review. Do not alias a missing HUD review entry to Claude’s own `code-review`.

### C8. What leaves native skill directories

After the replacement delivery path is tried:

- Remove only **HUD-owned** method/delegation skill links from Claude/Codex user skill directories and the registered Pi HUD package’s skill resources. Today those lists are in `H/install.d/claude.sh:64–71`, `codex.sh:59–62`, `pi.sh:40–46`.
- Serve `hud-delegate`, `hud-setup`, `hud-handoff`, `hud-build`, planning methods and shared references from the same central prompt mechanism. Their loading trigger differs, not their storage ownership.
- Preserve the `/hud` display entry. Claude already uses a small command, Pi an extension command, and Codex currently uses a skill. If Codex cannot offer an equivalent command without a skill, keep that **mechanics-only UI shim** as an explicit exception, or replace it only after a supported prompt/command route is tried. It is not permission to reinstall the method library.
- A fallback can keep one tiny generic “load HUD prompt X” user command where a client requires it. It contains no method body, no catalog copy and no chaining logic. Native prompt support can later replace it.
- Keep the upstream plugin off as already decided. Do not remove built-in Claude skills, third-party plugins, foreign symlinks or owner-edited files. Installer migration must back up/leave conflicts, enumerate what it owns, and preserve uninstall symmetry.

This removes **HUD main-method discovery** from shared homes. It does not establish that all non-HUD personal skills are hidden from every official CLI. The Claude flag and Pi leaf resource policy can strengthen that; Codex/Grok/agy require qualification or a narrower promise.

### C9. Client capabilities and prior art

| Claim/capability | Evidence and status | Design consequence |
|---|---|---|
| SEP-2640 is Final since 2026-09-13; extension id `io.modelcontextprotocol/skills`; `skills/list`, `skills/get`, file resources | **Unverified protocol/version claim**, supplied as search summaries. Reference: https://github.com/modelcontextprotocol/ext-skills . Agent Skills format: https://agentskills.io/specification . The installed Claude binary contains the extension id and these method names, corroborating an implementation attempt, not the final spec/version claim. | Serve it after reading/checking the actual schema. Do not make first usable delivery depend on native support. Resources and the common resolver remain useful either way. |
| Claude Code 2.1.326 has a usable native flag | **Unverified, with contrary local caution.** The installed binary path resolves to that version. Embedded code at byte 315496284 declares `var lLa="io.modelcontextprotocol/skills";function E5t(){return!1}`. Other embedded code contains `skills/list` at byte 356114168 and `skills/get` at 356114295; the latter sends `{uri: ...}`. Another string says MCP skills are “turned off for now.” These are static bytes, not a runtime feature test; minified symbol names are not a public API. | Do not invent an environment flag or patch the binary. Confirm a supported enabling mechanism and a real list/get/read trace. Fallback must work on the installed build without it. |
| Claude names MCP skills `<server>:<name>` and supports the demo’s instructions/resource fallback | **Unverified client behavior**, supplied by main. Reference: https://github.com/sambhav/mcp-demo . | Probe both native naming and ordinary resource loading. Keep loading substitutions namespaced only after actual discovery, not hardcoded from a summary. |
| Codex 0.169.0 lacks official SEP support; issue #48000/fork prototype | **Unverified upstream/support claim**, supplied by main. Reference: https://github.com/openai/codex/issues/48000 . Binary resolves to the reported version and contains `skill://`/`skills/list` text, but also its own native/cloud skill protocols. Those strings do **not** prove MCP SEP support. | Treat resources/local file reads as the baseline. Do not mistake Codex’s own skills API for the MCP extension. |
| Pi 1.5.2 native SEP support | **Unverified; not found in inspected implementation text.** No `io.modelcontextprotocol/skills`, `SEP-2640`, `skills/list` or `skills/get` match was found in the installed coding-agent `dist/**/*.js`. Its MCP docs document tools/resources; no skill-extension support was established. | No dependency on native SEP. The current HUD Pi integration only proxies six `tools/call` operations (`H/src/harness/pi/role-client.ts:21–79,91–174`). Add resource/command adaptation or central-path native skill discovery deliberately. |
| Pi native skills and supporting-file behavior | **Installed documentation verified**, runtime not re-probed: installed `docs/skills.md` describes names/descriptions/paths at startup, body read on selection, `/skill:name`, relative support paths and first-name-wins collisions. Installed `docs/mcp.md` documents resource tools and that an extension registering `/mcp` can replace builtin MCP. | The actual active MCP implementation matters. Do not assume the worker’s `pi-mcp-adapter` has the same capabilities as Pi’s builtin MCP. |
| `intellectronica/skillz`: skill-as-MCP-tool shim | **Unverified prior art**, supplied by main. Reference: https://github.com/intellectronica/skillz . | Valid conceptual precedent for portable delivery, but per-skill tools are not the recommended HUD transport because of the six-tool boundary/context cost. |
| OpenSkills: central skill files, metadata in agent instructions, on-demand CLI reads | **Unverified prior art from prior knowledge**, not checked here. Reference: https://github.com/numman-ali/openskills . | Illustrates that discovery and body transport can be separate. Do not import its installer or overwrite project agent docs as part of this proposal. |

### C10. Exact cheap probes for main to run

These are **not run**. Use a scratch checkout/job directory, synthetic prompts and isolated `HOME`, `HUD_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`. Do not rebuild live `dist`, copy credentials into reports, or alter existing owner processes. Real authenticated sessions, when necessary, are an explicit main-session qualification step.

**P1 — transport fixture, no model calls.** After checking ext-skills’ schema, make a tiny stdio fixture exposing the six existing tool names, one skill `probe-model`, one user-only `probe-user`, and resource bodies with distinct sentinel strings. Its descriptors contain no body sentinels. Log only incoming method names and synthetic arguments. Exercise:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"resources/list"}
{"jsonrpc":"2.0","id":4,"method":"resources/read","params":{"uri":"skill://probe-model/SKILL.md"}}
{"jsonrpc":"2.0","id":5,"method":"skills/list","params":{}}
{"jsonrpc":"2.0","id":6,"method":"skills/get","params":{"uri":"<URI returned by skills/list>"}}
{"jsonrpc":"2.0","id":7,"method":"prompts/list"}
```

Use the extension’s documented initialize capability/version when testing its negotiated route; the base example is only a plain-MCP fallback test. Assert six tools, metadata before reads, exact resource bodies afterward, and no method execution. Register this fixture in **temporary** client configurations with each client’s normal MCP add command. No need to install a real skill library to learn the transport behavior.

**P2 — Claude discovery/trigger, one synthetic session.** On 2.1.326, inspect `claude --help` and the supported settings/schema documentation for an actual SEP enabling switch. Record its real name if present; do not guess one. Connect P1, inspect `/mcp` and slash completion, ask “List the names/descriptions of HUD probe methods without loading their bodies,” then invoke the advertised `probe-user` command and ask the model to load `probe-model`. The server trace must show whether Claude called `skills/list`/`skills/get`, `prompts/get`, or only tools/resources. Read a relative `refs/probe.md` sentinel too. Repeat without the feature switch if one exists. This distinguishes native extension support from a fallback that merely happened to work.

**P3 — Claude worker isolation and lifecycle.** In a throwaway HUD job, include `--disable-slash-commands`, assign one sentinel method by absolute path, and ask for its entry and one support file. Verify no unassigned main-method descriptions appear, MCP tools still work as intended, report writing works, and normal close/reap still succeeds—especially the existing `/quit` path. Include a main-only direct URI request and verify server refusal. The supplied live skill-list test covers only the first portion.

**P4 — Codex fallback and potential native support.** On 0.169.0, connect P1 in a temporary `CODEX_HOME`; inspect the MCP listing, slash/prompt completion and available resource tools. Ask for catalog metadata, entry body and support-file sentinel. Server trace must distinguish MCP `skills/list` from ordinary tools/resources; a string in Codex’s own skill listing is not sufficient. Run `codex features list`/`codex --help` and record any **supported** per-session discovery option. Do not enable an under-development feature globally or change profiles to manufacture a pass. If no prompt UI is offered, prove user natural-language selection plus resource/file loading and record that UX limitation.

**P5 — Pi’s real route.** First test the installed HUD Pi package’s current six proxies; they should not magically expose new resources. Then test the proposed resource/user-command adapter against P1. Separately qualify builtin MCP and the actually installed `pi-mcp-adapter` if workers use it. Use `PI_ROLE_DEBUG` in a synthetic role session to inspect only fixture skill names and active tools: one assigned method, no personal sentinel, no package helper-pane, no `call_sonic`/`call_reviewer`. Prove body/support reads and an explicit user-selected method. Do not infer native SEP from ordinary Pi `/skill:` support.

**P6 — environment inheritance, no model required initially.** Create a disposable herdr tab with explicit `--env HUD_JOB_DIR=<fixture job>` and `--env HUD_HOME=<fixture home>`. Run a tiny environment-printing process in that tab and an MCP fixture that prints only those two values to its diagnostic log. Check the shell → Claude/Codex/Pi MCP chain separately. Compare main and worker `skills/list`, `resources/list`, `tools/list`, then directly request a hidden URI. Test a malformed marker: it must not yield the main catalog. Close only the recorded disposable tab. A later native Agent probe can reveal whether it uses a distinct server or its parent’s connection; until then mark native caller isolation unsupported.

**P7 — official CLI and browser edges.** For Grok/agy, inspect supported help/options and run a single selected-path sentinel job; record ambient discovery rather than assuming Claude-like flags. For browser, send a synthetic self-contained brief with one inline reference sentinel; prove the returned report contains the requested result, no local file access is claimed, and completion arrives through `hud watch` without a typed completion prompt. Do not test paid Flow video merely to qualify prompt transport.

P1 and P6 establish the core design cheaply. P2–P5 determine native UX, not whether the central store is feasible. They should precede promises in documentation or removal of the last working user invocation path.

## 5. For the implementer — boundaries, files and proving tests

This is a proposed implementation map after the owner decisions, not authorization to edit during this request.

### Files and responsibilities

| Area | Changes |
|---|---|
| New small `src/prompts/` module(s) | Caller-scoped descriptor/read resolver; shared input selection and skill-directory resolution. It reads approved files and returns data. No job scheduling, model calls, installer writes or workflow decisions. Avoid a general registry framework: catalog + `describe(context)` + `read(ref, context)` is sufficient. |
| `integrations/prompts/catalog.json`, `integrations/skills/**`, source/patch records | Central descriptors and effective complete directories. Restore original selected methods plus collision patches under decided B. Invocation/audience/source metadata is generic. |
| `packages/hud-mcp/src/thin-main.ts` | Resolve inputs before dispatch, persist input references, add `job_skills`, explicit tab env marker, caller-scoped tool behavior, resource/extension/prompt handlers. Keep existing dispatch and retry semantics. Extract a small shared launch-input function rather than three independent skill loaders. |
| `src/roles/roster.ts`, `exhausted.ts`, `role-control.ts` | Logical-role skill requirements and accepted options, same resolver for inspection/dispatch, visible unavailable input. Keep current place/model selection, presets and quota behavior. Do not teach roster a method workflow. |
| `packages/hud-mcp/instructions/*.md` | One canonical worker-role text per responsibility. Add a sonic body if making that role portable; fix general’s duplicated-report instruction. Concrete question/load interface is supplied separately. |
| `P/bin/pi-role`, `P/extensions/{roles,dispatch,dispatch-policy,bundle}.ts` | Narrow HUD input/body/leaf-resource/continuation adaptation, keeping standalone external use compatible. No port of the runtime into HUD. Exact flag naming is an implementation detail; the semantics in B are not. |
| `packages/hud-mcp/bin/{hud-ask,hud-jev}.mjs` and Pi QA adapter | Common chosen unanswered-question policy; browser report/event cleanup. Preserve the CLI judge unless a specific contract change requires it. |
| `src/harness/pi/{role-client,package-entry}.ts` | Share tool schema rather than drift a copy; adapt resource reads and user-triggered loading for the current Pi package. Keep panel/footer independent. Do not add a second MCP connection solely for loading bodies if the existing client can carry the requests. |
| `install.d/{claude,codex,pi}.sh` | Caller-marker env forwarding, safe removal of owned native skill links after qualification, preserve UI invocation shim if needed. Backups and installer review apply. |
| `src/collectors/backup-skills.ts`, `src/render/skills-view.ts`, i18n/catalog assets | Already-decided “Optional skills” wording/static metadata projection only. No skill install controls, execution buttons or native-availability dashboard. |
| Legacy files in A5 | Prune dormant execution code after extracting live identity/parser pieces. Keep live compatibility readers unless their removal is explicitly selected. |
| Docs | Owner edits spec; update architecture, MCP README, setup/worker descriptions and applicable workflow routing after decisions. Do not leave old “only model/effort/bypass” or “all skills are Pi-only” promises when they cease to be true. |

### Resource/lifecycle bounds

- Descriptor reads happen at server/session startup or explicit catalog refresh, not panel/bar ticks. Cache a catalog by file signature. Resource bodies are read only on demand; one selected file per read, no directory-wide content injection.
- Worker preparation is proportional to the number of selected inputs, not the number of skills in every client home. No recursive home scanning or network fetch at dispatch.
- Keep one MCP subprocess per existing client binding and existing per-job runtime behavior. No prompt daemon, registry database, watchers per skill or background dependency fetcher.
- Freeze **selection and resolved origins** for a job. This proposal does not promise byte-for-byte snapshots of every support file across manual edits to an installed checkout. If the owner needs exact immutable prompt replay across updates, see Optional hardening; do not claim that recording a revision alone enforces it.
- Missing source/read errors stay explicit. Before dispatch: refuse required inputs without a tab or quota mark. During an active job: preserve the job/report/working tree, return an input error and let main decide; never auto-relaunch on another harness or swap in an upstream/plugin method.

### Tests that must exist

Extend existing behavioral suites where possible; no per-slice review loop or huge mock-only test program.

1. **One selection, multiple drivers:** synthetic role with a required reference plus per-job additions resolves to the same effective input set on Pi and CLI, including a fallback place and an actual registered-worktree cwd. Duplicate names deduplicate; unregistered `.hud` is ignored. Broken/missing required inputs refuse before herdr launch.
2. **No accidental methods:** Pi fixture has personal and package sentinel skills; only assigned methods are advertised in HUD leaf mode and helper tools/skill are absent. CLI first prompt names exactly the required root entries and allowed references. Record live qualification separately from argv-unit assertions.
3. **Per-caller read filtering:** main and worker initialize separately; list/get/resource/direct-URI paths agree. Worker cannot load main-only or another job’s material; malformed worker marker cannot receive main discovery; cached tool definitions do not bypass call-time refusal.
4. **Deferred loading and support paths:** discovery contains descriptions, not body sentinels; fetching a body works; relative support file resolves inside its skill root; path escape, unknown dependency and unavailable file return explicit errors. No fallback to a same-named installed plugin.
5. **Invocation semantics:** an explicit user method can load through the qualified prompt/command/fallback path; a model-selectable reference loads without launching a workflow. User-only transitions are not auto-run by the router. Native client behavior needs the cheap real probe, not only server tests.
6. **Common leaf contract:** canonical role body used on both local drivers; Pi read-only enforcement retained; continuation uses creation-time permission; a role edit does not alter an existing job. Selected skills do not authorize a commit, nested worker or owner interview. Static tests check delivered inputs; one small behavioral trial checks model compliance without claiming it is a security proof.
7. **Failure and notifications:** current-turn report versus stale/empty report; CLI quiet/blocked/live supervisor-loss remains open; Pi real settlement retains its authoritative contract; browser missing/empty report is explicit. Main’s MCP changes/watch and panel agree; browser no longer types a duplicate completion. Keep existing safe reap/session-retention tests.
8. **Installer migration:** old owned links removed only after replacement available; foreign links/directories and edited files remain; Codex marker forwarding survives registration; uninstall preserves unrelated config and history. Test in temporary homes only.
9. **Selected content/provenance:** effective directories include all referenced support files, upstream text plus collision patches produces them, and the decided substitutions are reachable without raw implement/code-review workflows. The optional catalog does not advertise an unprepared edition as executable.
10. **Pruning:** after identity helpers are extracted, no production imports of old routing/writer/wait machinery; current thin jobs and native Agent cards still render. If live old readers are removed by decision, test that deliberately rather than declaring their former behavior dead.

## 6. D — Owner decisions and exact spec clauses affected

No decision is requested again on paradigm B, original methods, optional display-only Skills tab, no method in the convention, main-owned execution or milestone review. Synchronize those already-settled decisions into the current text. The remaining choices are:

### D1. Central prompt transport, without adding tools

**Current:** `docs/spec.md:12–21` describes six job tools; `:69–78` describes native skill installation for Claude/Codex and not Pi.

**Recommended wording:** “HUD owns reusable prompt sources. Main sessions discover short descriptions and load bodies and supporting files on demand through the same local MCP. Skills use the MCP Skills Extension where supported and ordinary resources/local reads otherwise. The six orchestration tools remain six; no tool is added per skill. Role instructions, the convention and job briefs use the same source-resolution rules with their own recipients and load times.”

Options: **resources + extension + qualified fallback (recommend)**; resources/local fallback only until extension is qualified; or a seventh generic loader tool (simpler for some hosts, but changes the six-tool surface). Do not promise universal native Skill/slash behavior before the probes.

### D2. What “isolated skills” means

**Current:** `docs/spec.md:13` allows Pi personal-skill/raw-argument switches; `:68` promises official harness behavior unchanged.

Options:

- **HUD-managed discovery isolation (smallest, recommended initial promise):** no main-only HUD methods installed into worker-shared discovery; HUD MCP filters per job; only explicit HUD inputs are delivered. Non-HUD host/plugin skills may remain unless a verified per-run exclusion is used.
- **All-host skill exclusion:** every supported worker must have no ambient client/plugin/personal skills. Qualify Pi and Claude; Codex/Grok/agy cannot be called compliant yet. Refuse or withhold that execution mode on an unqualified harness rather than hide the limitation. Personal-skill/raw-arg opt-outs must be removed or explicitly outside the guarantee.

The second is a larger supported-profile decision, not something MCP filtering alone can accomplish. Neither choice provides filesystem secrecy or an adversarial sandbox.

### D3. Narrow official-CLI launch-policy exception

**Current:** `docs/spec.md:13` says CLI starts “with only its model, effort and permission-bypass flags”; `:68` says official harness behavior stays unchanged.

**Recommended wording:** “HUD may pass verified per-run discovery-exclusion flags and HUD job-context environment markers to its workers, without changing the client’s home, configuration, account or session store. Selected prompt paths are supplied in the first task input.”

Options: approve this narrow exception, starting with qualified Claude; or retain the current launch rule and accept only central-store isolation. Do not use a new temporary profile/home as an unspoken workaround.

### D4. One canonical role and explicit per-job methods

**Current:** `docs/spec.md:13–19,68,74–76` mixes role instructions, Pi-only project customization and place-specific skill delivery.

**Recommended wording:** “A logical role has one HUD instruction body and required references, independent of its ordered execution places. `hud_create` may add named methods/references for one job. HUD resolves and records these inputs before launch; unavailable required inputs refuse. A place that cannot deliver them is reported as unsupported. Continuation permission and selected inputs are fixed for that job.”

Options: unify canonical role bodies and generic per-job inputs now (recommend); or first ship containment with the two role authorities retained explicitly. Extending **project customization** to arbitrary CLI worker prompts is separable: keep that Pi-only gate for now unless the owner also chooses to broaden it. Generic shipped role/skill delivery need not silently authorize every project to replace official-CLI instructions.

### D5. Worker questions and leaf-only execution

**Current:** `docs/spec.md:14` permits another role “unless the brief asks”; QA timeout/default behavior is described in `packages/hud-mcp/README.md`, but not clearly as owner authorization in the spec.

Synchronize the already-settled leaf rule: workers do not start other roles. Main launches any sonic/reviewer/design work. For unanswered decisions, choose **bounded wait then unanswered/blocked report (recommend)**, or bounded reversible-default behavior with an explicit no-scope-expansion rule. Do not change this by accidentally switching to `managed.mjs`.

### D6. Native agents and frontend routing

**Current:** `docs/spec.md:40–44` requires native-agent display; `docs/delegation.md:66–70` assigns frontend work to a native Claude subagent.

**Recommended wording:** “Native subagents remain observed client work, outside HUD’s dispatch, question, skill-isolation and reap contract. Work requiring the common worker contract uses a HUD role; frontend work may use the HUD frontend role.”

Options: use HUD frontend for unified managed execution (recommend); or deliberately retain native Agent for some frontend work and show its different ownership. No need to remove native display. Wrapping native agents into HUD execution would be a different product decision and is not recommended.

### D7. Browser and historical-compatibility boundaries

**Current:** `docs/spec.md:13,18–21` promises browser work and common job observation; `:90–93` excludes an owned execution platform. M2 `:117` calls for old execution-stack deletion.

Clarify browser jobs as one-shot, explicitly supplied remote inputs with no local-files/question/continuation promise; retain external runtime ownership and no direct completion typing. Separately choose whether old assoc/native-host display readers can go. **Recommend remove dead execution now; keep live historical readers out of the critical delivery slice unless the owner explicitly wants that compatibility removed.** No deletion of owner data is implied.

Already-decided textual synchronization also affects `spec.md:63–67` (“Optional skills,” still display-only) and `:69–79` (original-plus-collision-patch editions and HUD execution substitutions). These are not new options.

## 7. E — Vertical slices and what the owner can try

| Order | Vertical slice | Owner-visible try and stop boundary |
|---|---|---|
| **0** | Qualify the transport/caller boundary using P1/P6 and a minimal Claude/Codex/Pi probe. Record supported triggers; no library migration yet. | See the same synthetic descriptor/body/support file in each main client; see a worker get a smaller catalog and a direct-read refusal. Stop native-SEP promises if the installed clients do not negotiate it. Fallback remains the plan. |
| **1** | Central prompt source + six-tool discovery/resource fallback, with one simple method and one HUD-native entry. Add the checked Skills Extension projection when schema/probe is ready. | From each main session, discover and load one method without installing its body in that client’s skill directory. A user-only entry is explicitly selected. Optional Skills tab wording remains passive. Keep old links until equivalent invocation is demonstrated. |
| **2** | One leaf-job input set on Pi and Claude CLI: shared resolver, `job_skills`, explicit context markers, canonical role body, Pi no-helper mode, qualified Claude discovery exclusion. | Dispatch the same tiny task on Pi and Claude. Both identify the same assigned reference/support file, ask main through their adapter, write one report and reap normally. A deliberately missing method refuses before launch. A main-only method is not offered to either worker. |
| **3** | Finish selected paradigm-B content and safely remove owned native method links; planning dependencies and worker references use the generic mechanism. | In one main context, choose grill-with-docs, then separately choose spec/tickets if wanted; dispatch a test-first leaf job with TDD and the shared design reference. Verify method continuity without automatic pipeline execution or a worker reviewer. No full-library rewrite. |
| **4** | Qualify the other official CLI drivers and the browser capability boundary; make creation-time continuation/QA/event behavior consistent. | Try a Grok/agy selected-path job; Codex only after its stated discovery scope is accepted/qualified. Try one browser text task with explicit inline material; watch its completion without pane typing. Unsupported capabilities fail clearly, not by creating a misleading job. Do not require a paid video test. |
| **5** | Consolidate/prune: shared Pi/MCP schemas, dormant routing/writer/wait deletion, remove duplicate HUD role authority, update frontend routing if selected. Historical-reader removal is its own explicit sub-slice. | Control plane switches a role’s place without changing its instructions/methods; Home still shows both managed jobs and native agents, clearly distinct. Old private data remains. Installer rerun/uninstall preserves unrelated skills/config/session history. |
| **Milestone** | One integrated review/owner installation try, plus installer/process-risk review where project rules require it. | A small real task from each main client, one question, one continuation, one missing-input failure and a normal cleanup. Review the actual shipped intent once at the milestone, not every method or ticket. |

Order is intentional: prove delivery and caller context before removing working discovery; prove one local path end to end before generalizing drivers; keep historical cleanup away from the first useful user experience. No slice requires a workflow engine, prompt-ranking model or new worker supervisor.

## Optional hardening

- **Immutable per-job copies of complete selected prompt directories.** Cost: copying/bounding scripts and assets, duplicate disk use and provenance bookkeeping; benefit: exact support-file bytes survive a manual update to an installed checkout during a job. Not necessary for initial discovery isolation; do not implement a snapshot service without that replay need.
- **Persistent per-client discovery hooks for a literal every-turn catalog.** Cost: client-specific integration and compaction/version qualification. Useful only if the ordinary native SEP/direct-description/roster bootstrap UX proves insufficient. Do not “solve” it by copying method bodies into the convention.

No adversarial authentication layer, dependency workflow engine, automatic upstream updater or universal native-agent bridge is recommended.

## Scope

**needs orchestrator** — the design/inventory is complete, but implementation changes the owner-approved CLI launch constraint, native installation/discovery promise, role-prompt ownership across HUD and external Pi-roles, possibly the supported isolation profiles and unanswered-question policy. The owner chooses D’s remaining options; the orchestrator scopes the slices. Paradigm B, original methods with collision-only patches, mechanics-only convention, leaf workers, main-session decisions and milestone review remain fixed.


---

# Addendum (forked session, job jceac13e0aaff45b8)

Recommendation: Choose (a) now—make HUD’s worker skill-input port consistent across harnesses, keep main-session discovery native, and defer central MCP skill delivery; if later wanted, use ordinary tools first, not SEP-2640/resources/flags.

# WORKER-UNIFY addendum: revised recommendation

Read-only follow-up against `691b31b9`. The runtime files inspected previously are unchanged; the spec now explicitly removes the tool-count limit (`docs/spec.md:12–13`, commit `2e8d300a`). No live clients, builds or tests were run. Client behavior not established from source remains **unverified**.

## 1. Route (a), with an explicit limitation

**I revise my recommendation to (a).** My original C made a general prompt-delivery architecture too prominent relative to the immediate need. “Skills, roles, conventions and briefs are prompts with different recipients and load times” is a useful mental model; it does not require one delivery subsystem for all of them.

The smallest useful boundary is:

- HUD accepts explicitly selected worker skill names/paths.
- One resolver turns them into complete skill directories.
- Pi receives `--skill`; CLI workers receive explicit entry paths in their first input.
- HUD records what was supplied and what could not be supplied.
- Main sessions retain their clients’ native discovery and user-invocation behavior.

HUD does not interpret the skill’s method, infer a workflow, resolve a task graph or decide what should run next. This matches “the MCP knows no particular role and no workflow” in `docs/spec.md:13`.

**What (a) retains:** original methods plus collision patches, complete supporting files, explicit worker assignment, and one authoritative edition of a skill. Native skill directories can link to the same effective source; choosing (a) does **not** require three separately maintained copies. Worker role/lifecycle unification can proceed independently of main-session skill distribution.

**What (a) gives up relative to central delivery:**

1. One server-controlled main-session catalog, available without native installation.
2. Server-side filtering of that catalog/body delivery by job.
3. A uniform loading interface independent of native skill support and naming conventions.

Most importantly, **(a) does not satisfy the earlier strong requirement that main-only skills be invisible to CLI workers**. Claude workers normally share the main session’s discovery locations; the earlier live observation was supplied by main, not independently repeated here. With no new exclusion flags, assigning a narrow list tells the worker what to use but does not hide the other skills. The same limitation applies wherever a CLI shares discovery with main. Pi’s existing exclusion helps, but selected package resources can still contribute skills, as the original inventory showed.

This must be an accepted trade-off, not an implementation detail concealed behind “exactly these skills.” Route (a) guarantees **explicit delivery**, not exclusive host discovery. If invisibility remains a must-have, (a) alone is insufficient. Central tools could hide centrally served entries, but still would not hide unrelated native/plugin skills or create a filesystem sandbox.

Nor should route (b), if revisited, become a mandatory workflow standard. Central distribution and standardizing how work is done are separate decisions; the fixed main-session/leaf-worker rules do not justify an automatic method pipeline.

## 2. Maintenance cost does change the recommendation

The native SEP route adds costs before delivering much that directory-based worker inputs cannot already provide: capability negotiation, feature availability, resource naming, user invocation, supporting-file behavior, and compatibility across multiple client implementations.

Qualification matters here: the previous investigation found an embedded Claude gate returning false and native extension code, not a verified public enabling flag. Codex’s lack of official support was supplied as an upstream search summary; Pi’s inspected code/docs established no native SEP path. **These do not prove every possible version/configuration lacks support**, but they are enough reason not to make the product depend on it.

I would not schedule native SEP integration now. Reconsider it when a supported client route demonstrably replaces custom code or native-installation friction becomes a recurring owner problem.

This objection is much weaker for **ordinary MCP tools**: all three HUD integrations already use those. Tools-only central delivery need not maintain three experimental skill protocols. It still brings catalog ownership, caller classification, migration and invocation UX costs, so it is a reasonable later option—not a prerequisite for fixing worker inputs.

## 3. The two missed messages supersede C3 and D1

**Yes, both change the answer.** The MVP restriction—plain tools, no SEP, resources or new flags—removes my proposed transport stack. The tool-count decision removes the reason to overload `hud_roster` or prefer resources merely to remain at six.

If the owner still wants a central-loading MVP rather than (a), use two ordinary read-only tools, for example:

- `hud_skills_list`: names, short descriptions, invocation class and source; no bodies.
- `hud_skill_read(name, file?)`: default `SKILL.md`, or a contained supporting file; return the text and its base directory/source.

One implementation serves every client. Do not add one tool per skill, automatic installation, dependency orchestration or a compulsory workflow. User-only methods are selected by an explicit user request; a generic tool does not automatically produce native slash commands or prove that a human authorized an invocation. Those UX limits must remain explicit.

The current Pi HUD package mirrors the server’s tool definitions and proxies `tools/call`, so new tools need registration there too (`src/harness/pi/role-client.ts:21–79,91–174`); that is ordinary integration work, not SEP maintenance.

Therefore:

- Original **C3’s resources/extension/prompts recommendation is withdrawn for the MVP**.
- Original **D1’s “preserve six tools” decision is obsolete**, already settled by the owner.
- Under **(a), neither new tool is needed in the first slice**. Keep the port small and add central discovery only for an observed need.

## 4. Pane lookup: useful association, not sufficient caller identity

### First correct which pane the record names

`job.json.herdr_pane` is the **dispatching main pane**, not the worker pane: it is assigned from the MCP server’s environment at `packages/hud-mcp/src/thin-main.ts:914–919`.

The worker is recorded as `SESSION.txt.LEFT`; `ORCH` is the dispatching pane (`:415–423` for Pi; `:639–647` for CLI). Matching the caller’s pane to `job.herdr_pane` would label a main session with jobs as a worker—the opposite of the intended classification.

A no-new-env implementation must match the caller pane to recorded **worker occupancy**: primarily `LEFT`, and actual helper-slot evidence when considering `RIGHT`. A reserved right pane alone does not prove a helper is running there.

### Is the corrected lookup sound?

**Yes for best-effort association in the ordinary separate-process case; no as a complete identity or permission boundary using pane IDs alone.** Existing files provide a useful candidate without injecting `HUD_JOB_DIR`. But these cases matter:

| Case | Failure of a simple lookup / necessary distinction |
|---|---|
| Worker finishes, pane is reused | Historical SESSION files remain after execution. “Any matching job” contaminates the new occupant. The current agent/session must match the recorded worker, not merely the pane. |
| Main starts in a former job pane | Same problem, including stale jobs still marked working. A fresh main’s MCP must not inherit worker restrictions just because an old file names its pane. |
| Job is terminal but worker still alive | `closed` is not necessarily process exit; failed jobs can retain a live worker/tab. Filtering only nonterminal jobs could expose main-only material to the original worker. Job state is not occupancy evidence. |
| Old worker MCP remains after closure or job retention | Recomputing “no active matching job → main” promotes the old worker server. Once that server is positively associated with a worker, do not promote it merely because STATUS changed or files disappeared. Keep worker/unknown until its client binding ends. |
| Native subagent shares main’s pane/connection | Pane lookup identifies the containing main session, not the actor making a tool call. Actual native-client MCP sharing is **unverified**, but the pane alone cannot distinguish actors that share it. |
| Missing/overridden env or ambiguous matches | Return unknown for a context-sensitive operation; do not claim positive main identity from missing evidence. Ordinary unbound use can have a documented default, but that is policy, not identity proof. |

A practical future filter would find a candidate from SESSION files, compare existing herdr/native-session or PID-start evidence, and retain a confirmed worker association for that **server/client lifetime**, not permanently for the pane. A new main process gets a fresh binding. This avoids a cryptographic identity system, but is more than the proposed one-field lookup. Treat it as trusted-local routing, never a sandbox.

With a tools-only surface, keep tool schemas stable and filter returned catalog/read data. Call-time classification does not reliably retract descriptions a client already cached at initialization.

### Pi’s MCP adapter

I inspected the installed adapter this time. Its stdio transport defaults to inheriting process environment (`~/.pi/agent/npm/node_modules/pi-mcp-adapter/server-manager.ts:1233–1242,2253–2272`). It also allows `inheritEnv:false` and explicit overrides. Its session-start path resets state and shuts down the prior runtime (`index.ts:1679–1720`), with shutdown cleanup at `:1849–1874`.

Thus inheriting `HERDR_PANE_ID` is supported by its **default source path**; “every HUD MCP always inherits the correct pane” is still too broad. The actual configured worker entry, any overrides, and real herdr/session handover are **unverified**. HTTP/shared servers would not acquire per-caller process environment this way either.

**For route (a), do not build caller classification in the first slice.** Explicit job inputs already identify their recipient at dispatch. Classification becomes necessary only if a later shared MCP catalog promises main/worker filtering. Then test live worker, terminal-but-alive worker, pane reuse/new main, and missing-env/native-subagent cases before making that promise.

## 5. For the implementer: smallest first vertical slice under (a)

**Finish the narrow ORACLE-SKILL delivery slice: the same codebase-design directory reaches oracle on Pi and Claude CLI.** The existing held work is recorded at `docs/handoff/STATE.md:151`; reuse its generic delivery work after checking it against the decided minimal content patches, rather than rebuilding it as a central prompt service.

Write/change:

1. A small shared resolver, e.g. `src/roles/skill-paths.ts`, extracted from `piSkillArgs` (`thin-main.ts:311–352`). Resolve explicit absolute directories; bare names use registered project `.hud/skills` first, then shipped effective skills. Preserve supporting files and the registration gate.
2. `src/roles/roster.ts`: accept/retain skill names on local CLI places as well as Pi. Landed code still rejects CLI skill lists (`:145–158`). No browser file-delivery promise.
3. `thin-main.ts`: Pi gets the resolved `--skill` paths; CLI’s first prompt names the corresponding `SKILL.md` paths and requires reading the assigned reference. Record resolved/unavailable inputs consistently. An unavailable required input must be reported explicitly, not replaced with a same-named native/plugin skill or claimed as loaded.
4. Ship the complete selected codebase-design edition and bind it to oracle’s local places. Do not change main-session installation, other role bodies, helpers, QA policy or lifecycle in this slice.

No new MCP tools, caller classification, environment injection, exclusion flags, generalized prompt registry or dependency engine. A `hud_create` per-job skill list can follow when an ad-hoc assignment actually needs it; do not repurpose today’s boolean `skills` option.

**Proof:** focused tests cover registered-project/shipped/absolute resolution and unavailable inputs; Pi and CLI receive the same directory; a relative support file remains reachable. Main then dispatches one tiny oracle question on each place, reads the reports and checks normal closure. This proves delivery, not exclusive discovery or model obedience.

**Owner can try:** switch oracle from Pi to Claude and ask the same design question using the same reference, while continuing to invoke main-session skills through the familiar native client mechanism.

## Optional hardening

None for the first slice. Caller filtering and native skill exclusion are separate functional requirements, not free hardening hidden inside a resolver.

## Scope

**needs orchestrator** — recommend (a) and explicitly accept its non-exclusive discovery limitation, or retain central tools-only delivery if invisibility is still required. The tool-count decision and the MVP’s no-SEP/resources/flags boundary are already settled; do not ask the owner to decide them again. This addendum supersedes the original report’s transport recommendation, not its verified inventory or the settled method/worker policies.
