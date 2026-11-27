Recommendation: Use an optional, dependency-complete compatibility edition: preserve Matt’s names, methods, vocabulary and phase boundaries; patch concrete HUD/harness collisions; keep only genuinely different execution recipes HUD-native, with no methodology in the convention.

# Matt’s skills × HUD: paradigm recommendation

## 1. The answer in brief

**The owner’s proposed direction is substantially right: keep non-conflicting skills original, patch conflicting ones, and use them on demand.** The necessary qualification is that the unit of compatibility is not one `SKILL.md`. It is a skill **plus its dependencies, supporting files, invocation metadata, consumer and context boundary**.

“Deep adaptation” should mean getting those relationships right, not rewriting more of Matt’s prose or installing more process:

- The main session retains the owner’s reasoning through grilling → spec → tickets when that path is chosen. Those are not three fresh worker jobs.
- `grilling`, `domain-modeling` and `codebase-design` remain independently reachable shared sources, not paraphrases embedded in other skills or the convention.
- The selected method reaches the actual worker, including its referenced material. A worker does not inherit what the main session read.
- Requests to spawn, question the owner, commit, publish or review are assigned to the correct actor at the point where they occur, not contradicted by a generic warning elsewhere.
- User-invoked transitions remain the owner’s choices. A router suggests the next skill; it does not execute an entire pipeline.
- Unchosen methods remain uninstalled. No dependency on an uninstalled method is silently assumed to work.

**This depth is worth doing for the small set the owner actually uses. A complete HUD rewrite of the library is not.** The result should feel like Matt’s toolkit running on HUD, not a new development methodology that happens to borrow Matt’s terminology.

There are two unavoidable departures from upstream, which should be explicit rather than hidden behind “unchanged”:

1. Matt sometimes keeps a small implementation in the original conversational context. HUD delegates implementation. Preserve the planning conversation in the main session, then deliberately pay the loss from transferring the relevant reasoning to a worker.
2. Matt’s `implement` reviews each implementation; HUD reviews once per milestone. This is a change of policy, not merely a different spelling of a tool call.

Neither requires a workflow engine, automatic role chaining, new MCP tools, a skill permission framework or a convention that routes every request.

## 2. Evidence, current delivery and corrections to the earlier advice

### Evidence scope

Read-only inspection, no agents launched, no builds, installs, client sessions or live configuration probes. Only this report was intentionally written.

Source notation:

- `H/` = `~/projects/MyHUD/`.
- `U/` = `~/codex/MySkills/_upstream/mattpocock-skills/`, verified clean at **5863806dd4e15c63174bee4e7515a4256792ecfa**, version 1.3.2.
- `E/name` = `U/skills/engineering/name/SKILL.md`; `P/name` = the corresponding `productivity` file.
- `W/` = `~/projects/MyHUD-wt/ORACLE-SKILL/`, inspected only for its candidate `codebase-design` texts, not accepted as a completed runtime implementation.

HUD was `b6f39da0` when inspected. It advanced to `d02c67e3` during the investigation; the intervening diff changed only `docs/handoff/STATE.md`, recording SIDEBAR-ONE landed and ORACLE-SKILL held for this decision. I read all **39 upstream skill entries**, their supporting files/scripts, bucket READMEs, manifests and 38 existing `agents/openai.yaml` files; all current HUD skill assets; the requested installers, roles and instructions; relevant setup/dispatch source; both earlier reports; and the rejected/reverted commits. Source claims below are static observations, not live-client qualification.

### The binding boundary

`H/docs/spec.md:14–17` says the convention “carries only HUD’s dispatch mechanics” and method belongs in “skills that load on demand and may stay uninstalled.” `H/docs/spec.md:13–14` gives the main session the next-step decision and keeps workers neutral. `H/docs/delegation.md:22–38,78–85` fixes fresh implementers, milestone review and main-session commits. These supersede the historical cloud/per-package workflow.

The current §2.3 also explicitly specifies the existing curated ports, Claude/Codex-only main-session installation, and the in-flight oracle skill delivery (`H/docs/spec.md:69–79`). This report proposes a revised paradigm; it does **not** silently amend those owner decisions.

### What is installed is not what is loaded

| Surface | What the inspected implementation actually does | Consequence |
|---|---|---|
| Claude main / Claude CLI workers | `H/install.d/claude.sh:64–71` links `hud-delegate`, `hud-setup`, `hud-handoff`, `grill-with-docs`, `to-spec`, `to-tickets`, `hud-build` into `${CLAUDE_CONFIG_DIR:-~/.claude}/skills`. CLI dispatch uses the normal CLI environment (`thin-main.ts:657–665`). | These are **shared discovery locations**, not a main-only installation boundary. A worktree does not isolate user-global skills. |
| Codex main | `H/install.d/codex.sh:59–61` installs the same set plus `hud` into `${CODEX_HOME:-~/.codex}/skills`. | Installation is account/home-specific. Do not assume every Codex account receives the same skills. |
| Pi main | `H/install.d/pi.sh:40–46` puts only `hud-delegate` and `hud-setup` into its registered HUD package. | The planning/build collection and `hud-handoff` are not currently installed there by HUD. Pi’s lack of native subagents does not prevent using HUD jobs. |
| Pi worker setup | `src/cli/setup.ts:88–127,155–158,185–212` discovers directories; `:661–669` links selected paths under `.hud/skills`. `skillRecord` reads the name and `disable-model-invocation`, not a dependency graph or worker-safety contract. | Selecting `tdd` does not recursively select `codebase-design`. “Model-invocable” does not mean “appropriate for this role.” |
| Pi worker launch | `thin-main.ts:311–352` resolves each explicitly listed skill, passes `--skill <directory>`, and records `role_skills`/`skipped_skills`. Bare names require a registered project today; absolute paths work directly. Missing links are skipped. | Passing a directory establishes availability, not proof the worker read or followed its body. A required method must also be named in the brief. |
| CLI worker role skills | Inspected `roster.ts:157–158` rejects `skills` on CLI/bro places; the oracle work is intended to change that. | Do not describe proposed CLI path delivery or shipped-name fallback as already landed. Nor does path delivery remove globally discovered skills. |

Pi’s installed documentation (`…/pi-coding-agent/docs/skills.md`, “Understand how skills load” and “Write portable frontmatter”) states that names/descriptions/paths are advertised, bodies are read when selected, manual skills use `/skill:name`, and name collisions keep the first discovered skill with a warning. That is documentation evidence, not a live duplicate-name probe. Pi does not need a fictional native `Skill` tool: its documented loading mechanism is reading the file.

### Upstream distribution is a choice, not a requirement to install everything

- `U/.claude-plugin/plugin.json:23–51` ships **27 promoted skills**: 20 engineering and seven productivity. Sixteen are user-invoked, eleven model-invoked.
- Another eight are beta and four are frozen misc tools; deprecated is empty. They are not in the plugin. The beta `chief-of-staff` entry exists although its bucket README omits it; beta `software-factory` lacks the Codex metadata file. The tree and manifest are more reliable than assuming every README is exhaustive.
- `U/README.md`, Installation, offers auto-updating Claude and Codex plugins **or** editable copies through skills.sh; it says “Pick one per agent, because installing both gives you every skill twice.” Pi is on the selective/manual-copy route.
- `U/.agents/install-block.md` specifically warns that indiscriminate repo installers can include misc and beta skills. `scripts/link-skills.sh:4–6` calls itself an unsupported maintainer script; it includes beta skills and can replace existing directories. It is not a suitable HUD installer.
- The `.claude-plugin` manifest is also the documented Codex distribution source. The older “Codex plugin deferred” ADR is explicitly superseded by its 2026-10-07 update. Do not repeat the obsolete conclusion.

Keep the upstream plugin off, as already decided. This does **not** require every selected file to become a rewritten HUD port. Original, complete skill directories can be distributed selectively without subscribing to the whole plugin.

### Corrections to the earlier research

1. **“Only four skills conflict; the other 23 work unchanged” is false.** Beyond implement/review/research, `grilling` dispatches (`P/grilling:28`), architecture survey dispatches (`E/improve-codebase-architecture:27`), Design It Twice dispatches 3+ agents (`codebase-design/DESIGN-IT-TWICE.md:21`), `prototype` commits (`E/prototype:26`), `wizard` conditionally commits (`E/wizard:44`), and wayfinder creates a nested research arrangement and pushes branches (`E/wayfinder:77,115`). There are also worker/HITL collisions. These are conditional collisions, not reasons to discard their methods.
2. **The prior proposal to put method routing in the convention is now expressly rejected.** Moving it into a project convention would repeat the same error, not fix it.
3. **Prior “handoff is obsolete / setup is not installed” findings are historical.** The current `hud-handoff` uses the six tools; current installers include setup and handoff for Claude/Codex. I did not inspect the owner’s live install state, so neither current availability nor absence there is established.
4. **`to-spec` has not literally lost its conversational source in the current file.** `H/integrations/skills/to-spec/SKILL.md:9` says “Synthesize what has already been discussed … Do NOT re-interview.” The rejected convention mis-positioned it; the missing composition/context guidance makes that failure easy to repeat. Preserve that source, rather than replacing it with a generic “write a spec from the repository” job.
5. **Do not force a local tracker to suit the panel.** GitHub plus a one-way `.scratch` mirror is now an explicit product decision (`H/docs/spec.md:79–84`). The earlier no-mirror/local-only recommendation is superseded.
6. **The earlier architect’s selective approach was sound, but several proposed edits changed Matt’s method rather than adapting HUD mechanics.** Weakening the diagnostic phase gate, narrowing the grilling frontier, changing the spec template and deleting vocabulary dependencies are substantive choices. They should not be presented as necessary consequences of HUD.

## 3. Upstream’s structure and the compatibility decision for every skill

### 3.1 The relationship graph

`→` below means an operative load/call; `⇢` means a user-selected next phase, not an automatic invocation.

```text
grill-me ────────────────────→ grilling
                                      └─ fresh fact-finding agent when needed
grill-with-docs ─────────────→ grilling + domain-modeling
        ⇢ to-spec ⇢ to-tickets ⇢ implement OR implement-spec
                                  │              │
                                  → tdd          → fresh implementers → tdd
                                  → code-review  → one integration code-review

triage ─────────────────────→ grilling + domain-modeling, when needed
        ⇢ agent-ready work ⇢ implement

wayfinder ──────────────────→ grilling + domain-modeling
          ├─────────────────→ prototype
          ├─ research agent → research → background research agent
          └─ Notes may name other skills
        ⇢ to-spec ⇢ to-tickets    (map decisions are not implementation tickets)

improve-codebase-architecture → codebase-design
          ├─ fresh survey agent
          ├─────────────────→ grilling + domain-modeling
          └─────────────────→ codebase-design/DESIGN-IT-TWICE → 3+ fresh agents

tdd ────────────────────────→ codebase-design, only when interface shape is in question
retro ──────────────────────→ writing-for-agents
writing-for-agents ─────────→ own SKILL-MECHANICS.md, when writing a skill

ask-matt: human-facing map of these choices; does not execute user-only skills.
setup-matt-pocock-skills: creates tracker/label/domain configuration, not workers.
pr, wizard, handoff, teach, to-questionnaire, wait-what: separate tools, not required stages.
```

Evidence: the two seven-line grilling wrappers; `E/implement:11–15`; `E/implement-spec:25–38`; `E/triage:76`; `E/wayfinder:77–80,111–125`; `E/improve-codebase-architecture:13,27,64–71`; `E/tdd:26`; `E/retro:11`.

The wayfinder research chain really is nested in the pinned text. Do not preserve the nesting mechanically when substituting HUD calls: **the main session dispatches one research job, whose brief contains the research discipline; that worker does not invoke the spawning `research` skill again.**

### 3.2 Context windows and vocabulary are contracts

**Planning continuity.** `E/ask-matt:38`: “Keep steps 1–3 in **one unbroken context window** (don’t compact or clear until after `/to-tickets`).” That protects the reasoning behind the conversation, spec and slicing. It does not require every task to have all three artifacts. `E/to-tickets:17` explicitly accepts conversation context or a supplied spec/issue; `E/to-spec:7` synthesizes prior discussion, not necessarily a conversation that used the named grilling skill.

**Fresh execution.** Tickets are each sized for “a single fresh context window” (`E/to-tickets:33`). Implement-spec says “Start every subagent with a fresh context window” (`:15`). Research, review, grilling investigation and architecture investigation say the same. This maps naturally to fresh HUD jobs, not parent-context forks or one forever-growing imp session.

**Other boundaries.** Prototype detours travel to another directory/session and return findings to the original idea thread (`E/ask-matt:20–23`). Retro runs against the session being examined, or its log after clearing (`:38`). Wayfinder permits at most one non-research ticket per session (`E/wayfinder:105`). Writing fragments/beats/shape pass a material file, not an implied shared context.

**Compaction is a trade-off, not a commandment.** `ask-matt/PHASE-BOUNDARIES.md:19–40` orders Continue → Clear if irrelevant → Handoff if portable → AFK subagent → Compact. It says Continue preserves the primary source, while summaries are lossy (`:42–51`). `E/ask-matt:40` permits compaction at a boundary if the working context is becoming too large. Its approximate 150k “smart zone” is upstream advice, not a portable HUD limit. Translate clear/compact into actual client capabilities; do not invent common slash commands or force context resets during grilling.

**Two vocabulary layers.** Domain-modeling is active domain-language work, including glossary/ADR writes, not merely reading `GLOSSARY.md` (`E/domain-modeling:8,60–74`). Codebase-design is the shared architecture vocabulary and reference (`E/codebase-design:8–28`; `E/tdd:26`). Neither belongs as copied definitions in the convention. A read-only oracle can consume the project glossary and codebase-design without being authorized to run active domain-modeling or implement a deepening proposal.

**Invocation is distinct from phase.** `U/.agents/invocation.md:5–11` pairs Claude’s `disable-model-invocation: true` with Codex’s `policy.allow_implicit_invocation: false`. A user-only skill cannot be invoked by another skill; the router only recommends it. All promoted directories carry the matching Codex metadata. The HUD copies currently contain **zero** `agents/openai.yaml` files. That is a packaging gap against upstream’s declared cross-client contract; whether a particular installed Codex version compensates from other metadata is unverified.

### 3.3 Per-skill map and recommendation

These decisions describe recommended paradigm B (§4), not permission to install everything now.

- **Original**: retain the original method and its complete directory. No substantive HUD rewrite.
- **Patch**: preserve the name and method, changing the cited collision, including loading syntax when needed.
- **Replace**: use an existing HUD-native entry because responsibility/policy genuinely differs.
- **Optional**: leave uninstalled unless selected. “Available for main” is not a promise of invisibility to a Claude CLI worker sharing its skill directory.
- **Loading patch**: where upstream says `Call the Skill tool`, preserve the named dependency and its invocation class; use the client’s supported mechanism, or read its selected `SKILL.md` if no Skill tool exists. Do not turn a user-only dependency into an implicit call. This is packaging/transport, not a rewritten discipline.

#### Planning, routing and shared references

| Skill / upstream invocation | Relationship and exact collision | Main-session disposition | Worker disposition |
|---|---|---|---|
| **ask-matt — user** | Router, not a dispatcher. `:26–30` recommends `/implement`, per-ticket review and same-window small implementation; `:38–40` owns planning continuity; `PHASE-BOUNDARIES.md:36` recommends a subagent. These execution recommendations do not match HUD as written. | **Patch; useful opt-in entry.** Preserve the map and phase reasoning. Map a scoped build to `hud-delegate`, multi-ticket execution to `hud-build`, and review to main-dispatched reviewer jobs. Identify optional/uninstalled entries rather than implying universal availability. It suggests user-only skills, never fires them. | Leave out. A worker receives a job, not the owner’s method-selection router. |
| **grill-with-docs — user** | `:7`: “Call the Skill tool twice, for ‘grilling’ and ‘domain-modeling’.” Composition itself is compatible; the transport and both dependencies must exist. | **Patch loading only.** Restore two separately named dependencies, loaded in the same main conversation. | Leave out; no owner interview in a worker. |
| **grill-me — user** | `P/grill-me:7`: “Call the Skill tool with ‘grilling’.” Stateless wrapper, not a redundant copy of the interview. | **Patch loading only; optional.** Preserve its no-docs choice. | Leave out. |
| **grilling — model/user** | `P/grilling:28`: “dispatch a sub-agent with a fresh context window”; decisions wait for the user. This is not a pure, agent-free conversation primitive. | **Patch dispatch at :28.** Facts come from a fresh suitable HUD role; the main continues independent frontier questions and waits only on dependent ones. Retain rounds, frontier and owner confirmation at :30. Do not silently weaken the interview to a few generic questions. | Leave out. A worker can identify a missing decision and ask its orchestrator; that is not running grilling with the owner. |
| **domain-modeling — model/user** | `:60–62`: “When a term is resolved, update `GLOSSARY.md` right there.” Compatible with a main session doing the interview; incompatible with a read-only advisor or an unrelated implementer. No agent spawning. | **Original**, including `ADR-FORMAT.md` and `GLOSSARY-FORMAT.md`, as an independent skill. Main owns confirmed domain changes. | Do not assign the active skill to oracle/reviewer/ordinary imp. They read existing glossary/ADRs and report proposed changes. |
| **to-spec — user** | `:7`: “Do NOT interview … synthesize what you already know”; :17 still asks for seam confirmation. No spawn/commit collision. `:9` requires tracker configuration. Its “LONG”/“extremely extensive” stories (:33–41) are a method/taste choice, not a HUD incompatibility. | **Original preferred**, with project tracker mechanics in `docs/agents/issue-tracker.md`. Preserve its conversational input, seam checkpoint and template. If the owner wants the current shorter template, identify that as an intentional method fork, not a compatibility fix. Never automatically invent absent decisions. | Leave out. A fresh imp cannot synthesize a conversation it never received. |
| **to-tickets — user** | Consumes context or a fetched full issue/comments (:17); sizes slices to fresh contexts (:29–40); quizzes owner (:43–56); publishes approved tickets (:58–66). No spawn/commit collision. | **Original preferred.** Keep the full wide-refactor exception, including a shared integration branch when batches cannot land green individually (:40). Project tracker docs own sync/mirror particulars. Use only when the owner selects ticketing; do not force it onto a one-session job. | Leave out. Main owns slicing, approval and tracker writes. |
| **setup-matt-pocock-skills — user** | Separate project-method setup, not HUD runtime setup. `:81–90` prefers editing `CLAUDE.md` when both guides exist; a three-client installation cannot assume that supplies the other clients’ discovery pointer. `:51` can initialize/add a remote. | **Patch the guide-pointer selection**, preserving existing guides and obtaining approval for changes; optionally install/run once when method config is absent. Keep upstream’s tracker choice and lazy domain docs. Do not replace it with `hud setup`, which has a different job. | Leave out. No worker modifies project-wide method/tracker configuration by discovering a skill. |
| **triage — user** | Calls grilling/domain-modeling at :76; verification says “check it out, run the relevant tests” (:74); :78–86 posts, closes and writes rejection records. These are legitimate main-owned actions, not a worker role definition. | **Patch loading and verification delegation; optional.** Main interviews and applies tracker outcomes; bounded reproduction/diff verification goes to a HUD worker when execution is needed. Keep category/state meanings and maintainer choice. | Leave out as a whole workflow; an explicitly briefed worker can verify one claim and report. |
| **wayfinder — user** | Decision map, not build tickets. `:77` has a subagent invoke the spawning research skill; `:115` repeats that and says “Push the branch”; `:124` dynamically loads Notes skills. | **Patch those dispatch/branch operations and loading; optional, not starter.** Main claims, dispatches one leaf research job, archives/commits/pushes permitted assets, records resolutions. Preserve HITL, fog, one-decision-session rule and the eventual collapse through to-spec. Notes cannot implicitly invoke user-only skills. | Leave out. Workers answer one research/prototype/task brief; they do not operate or close the map. |
| **codebase-design — model/user** | Reference body is compatible. Its last pointer (:114) says “spin up parallel sub-agents”; `DESIGN-IT-TWICE.md:17–23` tells the reader to show the user and spawn 3+. `DEEPENING.md:33–37` discusses deleting/replacing tests, not authority to execute it. | **Patch only the alternatives orchestration/applicability, keep the full vocabulary.** Independent designs are main-dispatched HUD jobs when requested. Do not rewrite “module/interface/seam” to taste or duplicate the definitions. | **Patched shared reference for oracle**, as approved on every place; available to imp when TDD/interface work needs it. An advisor recommends, never spawns or deletes tests. See §6 for the in-flight version. |
| **improve-codebase-architecture — user** | Loads codebase-design (:13), spawns survey agent (:27), writes/opens HTML (:39–41), then loads grilling/domain-modeling and optional independent design (:64–71). | **Patch dispatch/loading; optional.** Survey in a suitable HUD job, candidate presentation and owner selection in main, interview retained there. Keep it a survey, not automatic refactoring or a scheduled duty. | Leave out as a whole skill. Oracle can produce survey findings for main; it does not open an owner-facing app or start a grilling session. |

#### Implementation, diagnosis, research and review

| Skill / upstream invocation | Relationship and exact collision | Main-session disposition | Worker disposition |
|---|---|---|---|
| **implement — user** | `:11` loads TDD; :13 requires full suite; :15 invokes code-review; :17 says “Commit your work to the current branch.” Its actor and per-ticket close-out conflict with HUD. | **Replace with existing `hud-delegate` + a scoped imp brief.** Do not invent a second simple-build macro merely to preserve this name. Router records the substitution. | Do not install upstream implement. Worker uses its role, brief and selected leaf method. |
| **implement-spec — user** | Fresh implementers/TDD (:29–32), but they “reset” and merge; :34 creates a merger subagent; :38 fixes “all issues” from review. | **Replace with `hud-build`.** Keep graph/frontier, independent contexts, worktrees and pointers; main alone integrates/commits and schedules the milestone review. This is a genuine HUD-owned recipe, not an original skill with just tool names replaced. | Leave out. No worker owns the frontier or integration. |
| **tdd — model/user** | `:22–24` requires user-confirmed seams; :26 loads codebase-design; :38 puts refactoring at review. It does **not** itself contain an imperative call to code-review: that final mention is a reference. | Keep as a **worker method**, not a main-session implementation command. A main request for TDD is dispatched with seams/acceptance. No separate full TDD rewrite for main. | **Patch :22–26 and :38.** Brief carries owner-confirmed seams; missing authority goes to orchestrator, not terminal/user interrogation. Restore the conditional codebase-design dependency. Retain original tests/mocking files, red-before-green and one-slice loop. Main owns later review. The brief authorizes local red/green runs; end-of-task checks are not a prohibition on feedback during TDD. |
| **diagnosing-bugs — model/user** | Asks user at :16, :55, :98; `:35`/`:64` use a terminal HITL script; :33 suggests `git bisect run`; :22 says “Refuse to give up”; :138 puts cause in commit/PR. These cross worker interaction/Git/environment/budget boundaries. | Dispatch diagnosis with this method and the permitted reproduction environment; main obtains missing access or owner observations. Do not turn diagnosis into a prerequisite for every small bug fix. | **Patch those specific actor/environment operations.** Preserve the six phases and falsifiable red feedback gate, including “cannot reproduce” as an honest outcome. No terminal HITL loop, production probe or moving HEAD by default; ask orchestrator/report the gap. State cause in report for main’s commit. Do not weaken the method merely to make a blocked worker claim completion. |
| **research — model/user** | `:6`: “Spin up a **background agent** … fresh context window”; :10–12 contain the valuable primary-source/citation/output contract. | **Patch :6; optional.** Main dispatches one suitable HUD role through hud-delegate with :10–12 as its leaf assignment, continues other work, then preserves the useful result outside the expiring job directory. No fixed role/model hidden in this skill. | Do not give the spawning entry to the research worker. Give the research requirements and requested artifact in its brief. |
| **code-review — model/user** | `:11,58–74` creates one fresh agent per axis; :21 hardcodes committed `base...HEAD`; :78 says do not merge/rerank. HUD’s project review instead uses two different model families, each reporting both axes, once at the milestone (`H/docs/delegation.md:26–38`). | **Replace the orchestrating entry with existing HUD milestone-review dispatch**, not another always-installed review skill. Pin actual scope/base; include dirty/untracked work if that is the target. Reuse useful source-finding/smell guidance as optional review reference, with smells still heuristics (:38–41), never a new blocking gate. Router points to this substitution. | Reviewer uses its existing role and brief. Do not load upstream code-review to “help review”: it asks the reviewer to create more reviewers. |
| **prototype — model/user** | Builds runnable code using LOGIC/UI references; `:26`: “Fold any validated decision into the real code … commit it to a throwaway branch.” Supporting LOGIC :67–69 and UI :101–108 also discuss capture/promotion. | **Patch ownership; optional.** Main states the design question, dispatches the scoped prototype, obtains owner reaction, records the answer and owns capture/integration. A prototype is not an approved production implementation. | Give a builder the selected LOGIC/UI recipe and scoped prototype brief. Patch capture instructions to return artifacts/verdict, with main committing and a separate approved production step. Not an automatic oracle coding assignment. |
| **wizard — model/user** | User scope checkpoint at :22; `:44` says “commit it and link it”; reads environment/CI config and creates a script capable of writing credentials. Importantly, :43 already says “Don’t run it end-to-end yourself.” | **Patch execution/commit ownership; optional.** Main agrees stages and safe inputs, commissions the script, presents it for owner execution. Retain upstream’s no-agent end-to-end run rule. | A specifically assigned builder may author/static-check it against supplied/redacted config; no credential discovery, owner prompts, live execution or commit by default. Not a default imp skill. |

#### Independent communication and writing tools

| Skill / upstream invocation | Relationship and exact collision | Main-session disposition | Worker disposition |
|---|---|---|---|
| **retro — user** | Loads writing-for-agents (:11), inspects current/specified session (:13), presents candidates (:24). “All work goes through … implementation and review” (:31) is not an instruction to launch a reviewer per ticket. | **Patch loading only; optional.** Keep original retrospective method, run against the actual worker session/log where relevant, and treat outputs as proposals. No automatic installation of proposed hooks/rules; no convention edits that violate mechanics-only. | Leave out by default. A specifically briefed retrospective advisor can analyze provided evidence, without changing its own environment. |
| **pr — model/user** | PR-body format, evidence and merge danger. `:6` says “Use this template for writing the PR body”; it does not itself order a PR publication or spawn. | **Original; optional.** Main writes/publishes as authorized. Keep CREDITS and upstream attribution. | Original reference only if a brief specifically asks for draft PR text. Not permission to publish or commit. |
| **handoff — user** | `P/handoff:8–16` writes a portable file, references artifacts and redacts. `:10` tells the next agent to “call the Skill tool” for suggested skills, which can wrongly imply automatic invocation of user-only skills. | **Patch that suggestion distinction; optional generic handoff.** Keep portable/no-duplication intent. For continuing actual HUD work, recommend `hud-handoff`, with the actor correction in §6. Neither is a mandatory phase separator. | Only a scoped report/continuation artifact if requested; never a worker-created successor/main session. |
| **teach — user** | Stateful teaching workspace and human learning interaction, `P/teach:8–20`. No HUD orchestration collision when used for its intended purpose. It is not a skill for ordinary code workers. | **Original; optional in a teaching workspace.** Do not put its lesson/assets machinery into the coding workflow. | Leave out. |
| **to-questionnaire — user** | Interviews the sender about recipient and knowledge gap, then writes a questionnaire (`P/to-questionnaire:8–17`). No agent/commit collision. | **Original; optional.** This is not another generic grilling wrapper. | Leave out as a dialogue skill; drafting from a fully specified brief is a separate task. |
| **wait-what — user** | `P/wait-what:7` asks for ASD-STE100 English and glossary vocabulary. That is an explicit style choice, not a HUD incompatibility. | **Original; optional.** Change language only if the owner wants that separate adaptation. | Leave out; it repairs the owner/main conversation. |
| **writing-for-agents — model/user** | Owns context pointers, progressive disclosure and skill mechanics. `:76–78` requires a single source of truth. No dispatch or Git collision. | **Original**, optional and a dependency of retro. Use while authoring skills, not as prose to paste into every session. | Original when a document/skill-writing job needs it; not loaded into every role. |

#### All non-promoted skills

These are outside the proposed HUD starter set. “Leave out” means no HUD installation or eager rewrite, not destruction of the upstream copy.

| Skill / invocation | Relationship/collision evidence | Disposition for main / workers |
|---|---|---|
| **chief-of-staff — user, beta** | `:20–24` makes all work background subagents; :53–54 reads user-only retro/spec/tickets/implement-spec as procedures, contrary to the promoted invocation rule. Its `../retro/...`-style pointers assume a flattened installation and do not match the bucketed source tree. `:58–78` makes environmental improvement a standing duty. | **Leave out / leave out.** It is a different always-on operating style, not a missing HUD feature. |
| **claude-handoff — user, beta** | `:8` launches `claude --bg` and assigns lifecycle to `claude agents`. | **Replace with explicit HUD delegation or owner-started main handoff / leave out.** Do not add a second worker launcher. |
| **loop-me — user, beta** | `:8` uses grilling discipline for workflow specs; :28 requires an implementer to have no remaining question. It writes/deletes workflow specs, not executable HUD flows. | **Leave out of HUD / leave out.** Can be a separate optional original personal method if later requested; it must not generate an automatic HUD engine. |
| **setup-ts-deep-modules — user, beta** | Loads codebase-design (:11), installs dependency-cruiser (:49–53), creates a “committed” example (:69), and changes checks/project layout. | **Leave out / leave out.** A dedicated, explicitly approved TS-governance task could reuse it later with commit ownership patched. Not an automatic consequence of adopting vocabulary. |
| **software-factory — user, beta** | `:7` describes remote infrastructure; :19 says a run triggers more runs and “never waits for a human.” The supporting task examples implement automatic chains. | **Leave out / leave out.** A vocabulary/design reference for another product, not HUD’s runtime model. |
| **writing-fragments — user, beta** | `:9–15` is exploratory interview → raw material file; no literal Skill-tool dependency. No intrinsic HUD collision in a writing session. | **Leave out of HUD**, original personal opt-in if wanted / no ordinary workers. |
| **writing-beats — user, beta** | `:9–19` consumes raw material, asks reader prerequisites, then writes one chosen beat at a time. “Commit to a path” is prose, not a Git operation. | Same: **leave out of HUD**, original personal opt-in / no ordinary workers. |
| **writing-shape — user, beta** | `:9–13,21–26` consumes a read-only material file and shapes a separate article with the human. No orchestration collision. | Same: **leave out of HUD**, original personal opt-in / no ordinary workers. |
| **git-guardrails-claude-code — model/user, misc** | `:24–26,40–81` installs project/global Claude hooks. Its bundled string-pattern script is not cross-client worker isolation and does not ban all commits/merges. | **Leave out / leave out.** Owner config protection is a separate task, not an integration prerequisite. |
| **migrate-to-shoehorn — model/user, misc** | `:20–24` installs a package; :105–118 asks requirements and migrates tests. | **Leave out / leave out.** Reuse only in a dedicated authorized migration, not by automatic worker discovery. |
| **scaffold-exercises — model/user, misc** | `:8`: “then commit with `git commit`”; assumes Matt’s course tooling. | **Leave out / leave out.** Unrelated product, explicit Git conflict. |
| **setup-pre-commit — model/user, misc** | Installs dependencies/hooks; `:83`: “Stage all changed/created files and commit.” | **Leave out / leave out.** Do not impose new quality gates or stage unrelated work through skill integration. |

## 4. Three viable paradigms

These are alternatives, not a plan to build all three. Cost estimates are relative work-package shapes, not measured schedules.

### A. Smallest: original directories, colliding lines patched, same names

**Shape.** Select a few complete upstream directories, leave everything else original/off, and make local edits only at collision sites. Even `implement`/`implement-spec` retain their names but execute through HUD after being patched.

- **Installed where:** owner-selected main collection in Claude/Codex and, if approved, Pi; selected worker-safe directories via `.hud/skills`/role paths. No full plugin. Workers do not receive main workflows intentionally, although global Claude discovery is shared.
- **Names/references:** best upstream familiarity; all names stay. Restore independent vocabulary skills and include every actual dependency. Support files and Codex metadata travel with the directory.
- **Updates:** no auto-update onto edited files. Keep upstream commit/source attribution and a small local-difference record; deliberately compare to a later upstream version when the owner requests a refresh.
- **Day to day:** familiar commands, no new default flow, a clear request can still go straight to an imp.
- **Risks:** same name can hide a materially changed contract. An “implement” that no longer implements in the current session or reviews/commits per ticket is more than a line-patched original. Shared main/worker variants can accumulate actor conditionals.
- **Build cost:** lowest: one text/packaging slice for the selected set plus loader/behavior qualification. It is a credible pilot, not a strawman. Cost grows if “only a few patches” becomes an excuse to patch all 39 immediately.

### B. Recommended: preserve Matt’s method library; replace only different execution responsibilities

**Shape.** A small compatibility edition, preserving names for grilling/planning/references and ordinary tools. `implement` is covered by `hud-delegate`; `implement-spec` is explicitly `hud-build`; upstream code-review orchestration is covered by the established milestone-review dispatch. A patched, optional `ask-matt` explains these substitutions and keeps the original phase map.

- **Installed where:** optional planning set for all three main clients; leaf methods selected per worker role; generic HUD mechanics remain in their own existing skills. Source files that are merely available in the repository do not all become discoverable skills.
- **Names/references:** unchanged for retained methods. Only real execution substitutions get HUD names; fix every affected router/reference, including TDD’s review reference. No parallel `hud-grilling` and `grilling`, no two definitions of deep modules, no pretend installed skills.
- **Updates:** originals may be replaced by a deliberately selected upstream snapshot; compatibility edits are re-applied/reconsidered only for selected skills. HUD-native recipes remain owned, with no upstream-tracking commitment. Preserve MIT copyright/license and supplementary credits. No automatic rebase service or runtime vendor-version gate.
- **Day to day:** the owner may ask for grilling and later choose spec/tickets, or skip all of that. Main stays with the owner; investigation/build jobs return evidence. The library is a menu, not a compulsory checklist. A method used rarely can be explicitly read by path instead of installed.
- **Risks:** the router must honestly name the substitutions and optional availability. This deliberately does not preserve every upstream execution tactic. Shared Claude discovery still needs truthful role scoping; it is not a security sandbox.
- **Build cost:** low-to-moderate: one coherent text/asset repair slice, a small installer/parity slice if approved, and applicable checks for the already-planned role delivery. Most necessary runtime machinery already exists. No new workflow runtime or skill-management panel.

**Why B over A:** it keeps the owner’s “mostly original, on demand” approach while admitting that Git ownership, worker execution and review policy are genuine replacements. It also preserves the useful, already-created hud-build instead of inventing another same-purpose name.

### C. Full HUD-native method suite

**Shape.** Rewrite/rename the library as HUD planning, build, research, design and review skills with a uniformly owned method and common artifact rules.

- **Installed where:** curated HUD suite across main clients; separate worker leaf suite. Still on demand; putting it into the convention would violate the fixed boundary even under this option.
- **Names/references:** every renamed edge/router must be rewritten. The owner learns a new vocabulary of commands; original tutorials no longer map directly.
- **Updates:** no tracking upstream; selected ideas may be manually ported. HUD owns every instruction, reference, template and client metadata file.
- **Day to day:** potentially a more uniform HUD experience, but Matt becomes inspiration rather than a library the owner can use as designed.
- **Risks:** method drift, duplicated vocabulary, more maintenance, more opportunities to introduce process shackles. Improving one workflow can become a cross-suite policy change.
- **Build cost:** several text/design slices and a much larger behavioral qualification matrix. Not justified by this single-owner product or the observed failures.

**Do not choose C unless the owner explicitly wants a new development-method product.** “Use the whole original plugin and add a top-level ‘obey HUD’ warning” is not a fourth satisfactory option: it leaves known contradictory reachable instructions and shared-worker discovery unresolved.

## 5. What B means concretely

### A small, opt-in installation, not a mandatory bundle

Recommended initial **main-session selection**, only after the owner accepts it:

- `ask-matt`, `grill-with-docs`, separate `grilling`, separate `domain-modeling`, `to-spec`, `to-tickets`.
- `codebase-design`, already approved for main and oracle, as the one shared design source.
- Existing `hud-delegate` and `hud-setup` remain mechanics. `hud-build` is available only for a chosen multi-ticket build; `hud-handoff` for a real continuation need.
- `setup-matt-pocock-skills` is a separate optional one-time method configuration tool, needed only if the relevant project configuration is absent. Existing good configuration is not replaced or re-asked.
- Other rows marked optional are **not installed in the starter selection**. Their recommended patch is work to do when that skill is selected, not a backlog requiring immediate completion.

Recommended **worker selection**:

- **Imp:** patched `tdd` when the brief selects test-first work; `codebase-design` reachable as its conditional dependency. Patched `diagnosing-bugs` for diagnosis jobs. Availability does not require every implementation to run both methods.
- **Oracle:** shared patched codebase-design as approved, with no new authority from its references. No active domain-modeling, grilling, research dispatcher or architecture-survey workflow.
- **Reviewer:** its existing two-axis role and brief; optionally relevant reference material, not the upstream review dispatcher.
- **Sonic:** none of these execution/design disciplines by default; do not convert it into the diagnosis/design role.
- **General/other builders:** only the leaf references actually needed for that brief. Research requirements are briefed directly; prototype LOGIC/UI and writing-for-agents can be provided by path.

**Do not create separate same-named original and worker-patched skills in overlapping search paths.** One selected effective definition per name, one complete directory, one source location. Link that location into the consumers that need it. A worker variant not intended for main discovery can remain available only by role path; main’s router can explain how to request a job using it.

### Cross-client delivery is part of compatibility

For main sessions, use the existing client integration locations: Claude’s configured skills directory; the selected Codex home’s skills directory with the Codex metadata; Pi’s registered package/selected skill resources. Native invocation syntax may differ; the underlying chosen definition and dependency graph should not.

For workers, retain `hud setup` and `.hud/skills` for Pi. The in-flight CLI work can supply explicit absolute skill paths without rewriting a CLI’s home/profile. The brief should identify the method’s required leaf references, not tell a worker to repeat the main’s orchestration skill.

A registered main checkout does not by itself prove a newly created worktree resolves bare project skills. Query the actual job cwd and check effective paths; a stable explicit skill path is an existing alternative. A skipped required skill is a visible input gap, not evidence that the method was applied. No new automatic dependency resolver is necessary: for this small set, a documented selection list and dependency check suffice.

### Shared Claude skill discovery: an honest limit

Claude CLI workers share the main session’s user skill directory. User-only metadata can prevent implicit invocation; it does not make a file unreadable. Model-invoked main methods such as domain-modeling can still be discoverable to a worker.

For this trusted single-owner product, the small compatible solution is **consumer scope plus non-conflicting assigned methods**, not a new account sandbox:

- Roles stay leaf workers. Main-only skills are not assignments merely because they appear in discovery.
- A worker’s brief names its approved method; methods that really execute there have actor-specific collisions patched.
- Role instructions retain no owner interview, no unrequested spawning, no commits and scoped writes. A need for a main-only procedure becomes a report/question to main.
- Do not weaken read-only oracle/reviewer restrictions to make a vocabulary skill work.

This is instruction-level compatibility, the same sort of boundary HUD already uses. It is **not** a claim that a patched skill enforces filesystem/tool permissions. If the owner requires main skills to be physically invisible to CLI workers, that is a separate harness-isolation decision requiring verified session-scoped controls; do not guess a flag or change CLI configs under this task.

### Keep useful context, not just short briefs

The worker needs the decided behavior, scope, seam, acceptance and the relevant reasons, plus pointers to durable evidence. Do not dump the entire grilling transcript into every worker; equally, do not reduce a complex decision to a ticket title and assume its rationale survived.

Reports settle execution, not acceptance. Main verifies results, records durable decisions/important evidence in the tracker or repository, and only then advances work. HUD’s approximately one-day closed-job retention means a report path alone is not a durable research note (`H/packages/hud-mcp/README.md`, Jobs and watcher).

The context trade is deliberate: a fresh worker cannot possess the main’s verbatim reasoning unless it is supplied. No skill wording can both enforce fresh HUD workers and preserve upstream’s same-window small implementation literally.

## 6. Existing assets: keep, repair, or retire

The current files were diffed against their pinned originals, including bundled references. These are not all mere line edits; some already changed the underlying method substantially.

| Current asset | Observed difference | Recommended disposition |
|---|---|---|
| `integrations/skills/grill-with-docs/` | Wrapper now points to private `grilling.md` and `domain-modeling.md`. Their frontmatter/independent discovery disappeared. Interview frontier was narrowed; domain text was rewritten. ADR template differs only by attribution; glossary template mainly changes example link formatting. | Restore independently named `grilling` and `domain-modeling` directories, with original supporting formats. Keep the wrapper thin and its dependencies loaded together. Retain the HUD dispatch patch in grilling, not a second interview method. No need for copied private definitions. |
| `integrations/skills/to-spec/` | Retains synthesis instruction, but rewrites template, adds Decided/Assumed/Open and a blanket readiness gate, plus GitHub sub-issue/mirror/dispatch mechanics (`:13–23,39–51`). | Restore original synthesis/template by default, subject to owner’s choice about deliberate method changes. Move the mirror mechanics to the project tracker reference; spec creation should not carry ticket creation and HUD dispatch recipes. Do not say its conversational source is currently absent. |
| `integrations/skills/to-tickets/` | Adds HUD dispatch/tracker ownership and mirror operations; abbreviates upstream’s expand–contract exception and drops its non-green-batch integration case. | Restore slicing/approval/full exception. Keep only necessary project-format particulars in the tracker reference; dispatch belongs in hud-build/delegate. Preserve current one-way-mirror ownership, not two writers. |
| `integrations/skills/tdd/` | tests.md and mocking.md are byte-identical. The main text removes user confirmation appropriately but also **deletes the codebase-design dependency**, and prohibits unnamed skill use (`:24,37`). | Keep worker seam/Git/check ownership patches. Restore the conditional vocabulary dependency and ensure it is part of the allowed selection. Do not ban the very reference the method needs. Retain Matt’s actual red→green semantics, not the README’s looser red-green-refactor marketing description. |
| `integrations/skills/diagnosing-bugs/` | Rewrites/shortens most of the 138-line original, removes terminal HITL/bisect and some evidence details, permits more preliminary theorizing, and changes no-seam handling. | Keep the worker/environment/interaction corrections. Rebuild the minimal diff from upstream instead of treating every shortening as required compatibility. Keep the strict feedback discipline unless the owner explicitly chooses a different diagnostic method. Missing reproduction is a valid blocked report. |
| `integrations/skills/hud-build/` | Correctly takes ownership of worktrees, commits and integration after dc0eb1d6. `:43` currently describes “a reviewer job,” whereas MyHUD policy specifies two families. | **Keep**, but finish it as an optional HUD-native execution recipe. It must dispatch the selected leaf methods/dependencies, preserve reasons, and follow the applicable milestone review policy; in MyHUD that is two independent reviewers, both axes, not two agents per axis or one accidental reviewer. It should not infer readiness merely from an unread report or duplicate the tracker’s configuration. |
| `hud-delegate`, `hud-setup`, `hud`, `hud-handoff` | These are HUD-native, not Matt ports. Current handoff is no longer on the deleted API. However `hud-handoff:43–45` labels a `hud_create` role job a “Main-session successor.” | Keep native mechanics. Fix the handoff actor distinction: an owner-opened new main session can take over orchestration; a HUD role job is a scoped worker, not a promoted main session. Keep generic portable handoff and HUD continuation needs distinguishable, without making either mandatory. |
| Invocation metadata | No current `integrations/skills/**/agents/openai.yaml`, unlike promoted upstream directories. | Carry correct paired metadata for user-only methods, including hud-build if offered as user-only. Do not rely solely on a frontmatter convention from another client. |

**Do not revive the reverted convention.** dc0eb1d6 already removed the worker-commit instruction and the reference to a replaceable convention Review section. Those are fixed facts, not reasons to delete the useful whole recipe. Remaining problems are dependency/actor/phase consistency and completion of its policy contract.

### The in-flight codebase-design work

The candidate in `W/integrations/skills/codebase-design/` is close to the right shape:

- The vocabulary body is retained, not paraphrased; `DEEPENING.md` is unchanged.
- Its last pointer and `DESIGN-IT-TWICE.md` remove worker spawning and refer independent jobs to main. That is necessary.
- But `DESIGN-IT-TWICE.md` now defaults to **one advisor producing 3+ designs itself**, with independent fresh-context designs an optional later choice. This is **not equivalent** to upstream’s independent-agent comparison. It may be a useful cheap alternative, but should not be passed off as preserving Design It Twice unchanged.

**Recommendation:** keep the generic role-skill/path-delivery work and the single shared vocabulary. Re-scope the alternatives reference so its two modes are explicit: an advisor can sketch requested alternatives within its brief; an independent Design It Twice exercise is organized by the main session using separately constrained fresh oracle jobs. Do not have every oracle automatically produce three designs, and do not default to the “maximum flexibility” lens unless the actual question asks for that trade-off.

The approved requirement that every oracle place receives codebase-design can remain. **Loading a reference is not starting an architecture redesign.** Do not expand that decision into automatic loading of the whole Matt library or an always-run design ritual. Preserve source-role restrictions even if a referenced design suggests code/test deletions.

This is advice on the candidate text and capability boundary, not acceptance of the in-flight resolver/CLI implementation, which needs its own applicable checks.

### The Skills tab

Keep it passive and readable. It is useful as the human’s memory of optional methods; it need not become a plugin manager, dependency viewer, installation-status dashboard or workflow launcher.

- Keep name plus complete localized one-line description, wrapping at the existing narrow width.
- Remove `codebase-design` from the **backup/not-bundled list** when it becomes a shipped/adopted reference, as the spec already requires no adopted entries there.
- Do not claim every backup can simply be executed raw. Several currently listed backups (`wayfinder`, `prototype`, architecture survey, wizard) have the collisions above.
- Prefer wording such as **“Optional skills — ask the main session about one”** and a source note distinguishing original source from a HUD-compatible edition. If a compatible version is not yet prepared, the main reads upstream as reference and explains the needed adaptation; it does not silently execute the conflicting steps.
- No dynamic per-client installed/not-installed claim: current `BackupSkill` is only `{name,en,zh}` (`H/src/collectors/backup-skills.ts:3–9`), and `skillsRows` simply renders a catalog (`src/render/skills-view.ts:80–94`). Keep that small contract unless the owner specifically changes it.

Changing “read upstream text” to “use the matching compatible entry” revises the current Skills-tab promise in `docs/spec.md:63–67`, so it needs the owner’s approval. If the owner keeps the old wording, the conservative interpretation is **read for consultation, not authorization to run it unmodified**.

## 7. What belongs in the convention

Only HUD mechanics:

- roster/cwd and effective role/place lookup;
- create/send/read/respond/close behavior, stable retry keys and continuation limits;
- report delivery/unread versus acceptance;
- how this client receives questions and completion events;
- normal cleanup ownership and what an early close does;
- main-session ownership of handoffs/next-step decisions, with workers reporting rather than chaining.

No idea→ship map, skill catalog, vocabulary, TDD rule, prototype rule, ticketing threshold, review-method rubric, retro requirement or “always use Matt” sentence. Not even a short mandatory routing paragraph.

**There is still method residue in the reverted default.** `H/packages/hud-mcp/hud-convention.md:2–4,8–10` contains size-budget/slice rules, check cadence and review policy. Under the strict owner rule, move those to the appropriate brief/role, opt-in build recipe or project workflow document. The existing project milestone-review rule remains binding in `docs/delegation.md`; removing its duplication from the convention does not change that rule.

Project tracker semantics belong in `docs/agents/issue-tracker.md`; vocabulary in its skills; build policy in the opted-in recipe/project workflow; worker authority in roles and briefs. A replaceable convention is not a reliable location for a skill’s dependency or method policy.

## 8. For the implementer, after the owner chooses

Stay at the selected-skill boundary. No full-library rewrite, no new MCP workflow state.

### Files/responsibilities

1. **`integrations/skills/`**: restore selected complete directories and paired metadata; preserve original shared reference content; make a minimal, attributable compatibility diff at the sites in §3. Keep hud-build native. A short provenance/dependency note beside this collection is enough; no runtime manifest engine is required.
2. **`install.d/{claude,codex,pi}.sh`**: deliver only the owner-approved selection to the intended clients, keep one definition per name, and remove only owned entries. Pi parity is a proposed spec change, not silently authorized by this report. Check install/uninstall symmetry: the inspected Claude uninstall list omits its newly installed hud-handoff/hud-build links (`claude.sh:104–111`).
3. **`hud-setup` and the in-flight role delivery**: keep generic skill-path transport and explicit missing/skip reporting. Do not teach the MCP Matt’s graph. Required dependencies must be selected/briefed deliberately; CLI fallback must not lose the worker’s method silently.
4. **`packages/hud-mcp/hud-convention.md`**: mechanics only. **`instructions/*.md`**: stable role boundaries, not a skill-method anthology.
5. **Project tracker references**: single writer, parent/sub-issue and mirror/sync operations where applicable. Do not require GitHub or local tracking universally.
6. **`backup-skills.json` / tab wording**: only the approved static catalog correction. No install or execution buttons.
7. **Owner-owned `docs/spec.md`**: orchestrator records the owner’s decision before changing the promised set/clients/catalog semantics. This report itself changes none of them.

### Required acceptance scenarios, not a large new test program

Use temporary homes/config roots and synthetic repositories. No live builds in the owner’s main checkout. A static check is not a claim about model behavior.

- **Selection and dependency closure:** selected planning wrapper reaches one grilling and one domain-modeling definition; TDD reaches the same codebase-design as oracle; all relative references and scripts actually exist; user-only metadata is paired. No stale references to implement/code-review when those entries are intentionally absent.
- **User agency/context:** a simple clear request goes straight to a brief; a chosen grilling session does not automatically proceed to spec/build. A user-chosen to-spec/to-tickets consumes the same agreed reasoning. Missing reasoning/configuration or an absent optional skill is reported, not invented.
- **Leaf behavior:** a TDD/diagnostic imp reports rather than commits or starts review; an oracle uses design vocabulary without spawning, writing glossary or making three designs unasked. Required seam decisions escalate to main; ordinary local choices do not trigger a fresh owner interview.
- **Fresh independent alternatives/review:** main starts fresh jobs with explicit pointers; a reviewer does not start two more reviewers; milestone review follows the selected project policy. Repeated local red/green tests are distinct from repeated full-suite gates.
- **Delivery/failure:** actual worker cwd, Pi and CLI fallback, missing dependency/link, and a duplicate-name situation. Do not assert effective loading from a symlink or `role_skills` record alone. Preserve changes/report on an input gap; do not substitute an unpatched copy silently.
- **Continuity:** important findings survive by durable artifact pointers; a fresh main handoff does not promote a neutral worker or assume another pane automatically receives the original session’s events. Existing HUD lifecycle/retention semantics remain unchanged.

For behavioral qualification, the owner can try one small planning→delegated-build example in each of Claude, Codex and Pi, with a narrow failure/clarification case. Evaluate whether important decisions survive and whether workers stay leaf workers, not how many skills were invoked. Do not add a per-slice reviewer loop to validate a proposal whose purpose is to avoid one.

### Unverified items

- Real Claude/Codex duplicate-name precedence, namespace resolution and invocation behavior for these copied directories.
- Actual Codex treatment of the current HUD files without `agents/openai.yaml`.
- Whether every intended main-client/worker fallback loads the selected directory in the owner’s current install.
- Effectiveness/availability of any session-scoped CLI skill isolation flag; none is assumed or recommended as already proven.
- Model compliance with patched prose. A metadata/installer test cannot prove that a worker will never violate an instruction.

## 9. Owner decisions

1. **Which integration paradigm?**
   - **A:** same names everywhere, minimal local patches, including patched execution macros.
   - **B — recommended:** original/compatible methods, with explicit HUD-native execution substitutions and an optional router.
   - **C:** a fully HUD-owned method suite, no promise to preserve Matt’s design.

2. **Should the selected optional main-session collection work on all three clients?**
   - **Yes — recommended:** same chosen sources and invocation semantics on Claude, Codex and Pi; leave unchosen skills uninstalled.
   - Keep today’s Claude/Codex installation only, with Pi using explicitly supplied files case by case.
   This changes the current “not pi” sentence, not HUD’s dispatch model.

3. **For existing non-mechanical rewrites, preserve Matt’s discipline or intentionally keep HUD’s altered method?**
   - **Preserve original method — recommended:** especially to-spec’s synthesis/template, full slicing exception and diagnostic feedback gate; patch only actor, environment, loading and policy collisions.
   - Keep the shorter/relaxed current variants, explicitly documented as owned method forks.
   Neither answer puts the method in the convention.

4. **What should the Skills tab promise?**
   - **Optional methods with a compatible-source/consult-first meaning — recommended**, still static and display-only.
   - Keep “upstream backups” literally; the main may inspect them, but must not imply raw execution is HUD-compatible.

A further question is needed **only if requested**: must main-only skills be invisible to CLI workers, rather than discoverable but inapplicable? Hard isolation would be a separate harness/product change. The recommended plan does not smuggle that into skill editing.

## Optional hardening

None required for this paradigm decision. A generic dependency resolver, automatic upstream rebasing, permission sandbox, dynamic Skills management UI and automatic report archiver would each add code and maintenance without being necessary for the selected-skill approach. Do not build them pre-emptively.

## Scope

**needs orchestrator** — the read-only investigation and recommendation are complete, but adopting the recommended paradigm changes the owner-approved skill set, proposed Pi main parity and possibly catalog wording. The owner decides; the orchestrator then scopes implementation. The six-tool boundary, main-session decisions, neutral workers, no worker commits, milestone review and mechanics-only convention remain unchanged.
