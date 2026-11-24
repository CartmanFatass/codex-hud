# HUD product spec

Only the owner decides what this page says. An agent may edit it only after telling the owner the change and why.
It is the boundary for briefs and reviews and overrides older designs and decisions. (17.01, 10.02)

`DD.NN` refers to `D-2026-11-DD-NN` in [the decisions log](decisions-log.md); `(new)` marks a pivot clause.
Moving protocol detail to [reference.md](reference.md) does not retire the capability.

## 1. What it is

One HUD for Claude Code, Codex, pi and Antigravity, for one owner on one Linux/WSL machine inside herdr. (10.02, 22.12)

MyHUD is an operational workbench: it answers *what should happen now*. With the panel closed, the owner sees
current load. With it open, they can tell what each project is trying to achieve, what has changed and what needs
their judgement. The orchestrator runs the workers; the owner manages objectives and value, not workers. Neither
reading a worker conversation nor installing an analytics tool is a prerequisite. (new)

Two sibling projects stay separate. **toktrack** is the analytical workbench (history, model and workflow
efficiency, before/after comparisons); HUD records the facts it reads (§2.3) and builds no insight pages.
**Personal Standards** (external repos and skills) holds knowledge and preferences; HUD owns none of it. (new)

Display rule, replacing “cards win” (22.14): the owner's objectives, results and open requests come before
execution detail; when space runs out, execution detail is not shown. (new)

## 2. What it must do

### 2.1 Execute work independently of the display

- One local MCP across supported main sessions: roster, create, read, peek, send, respond, close, wait or receive
  tasks, lease, manage tickets, land, and serve the supported statusline. Thin adapters use herdr, installed role
  runners, CLIs and the shared `bro` browser. Interactive workers have tabs; headless workers do not. (10.01, 14.01, 17.02, 21.07, 22.04)
- Ask for a role, not a vendor. The owner controls ordered places, model, effort, presets and enabled harnesses.
  Check trust and capabilities before launch; skip unavailable places, respect quota resets and report the actual
  choice or failure. Only `general` takes one-job `on`/`preset`/`model`/`thinking` or borrows role instructions.
  Keep browser roles `pro` and `flow` optional, off by default. (13.01, 14.01, 18.01, 20.01, 21.04, 22.22, 22.29)
- Keep `imp` fixed/even/auto placement, machine-wide role caps, optional overflow to `general` on the imp chain,
  oldest-first queue and cancellation. Keep retry/repair placement rules. Auto routing and Sonic thinking have
  separate Decision API controls and fallbacks. New harness work prioritizes Claude Code, pi and Antigravity;
  keep supported Codex and Grok Build paths. (21.05, 22.22, 22.30)
- Pass standing briefs, context files, prior reports or a scout dossier without relaying file bodies through main.
  Workers may start and collect one-shot headless Sonic queries, not other roles; Sonic cannot ask, continue or
  start children. `oracle` advises without changing tracked files or owner state. Keep named exclusive leases for shared resources. (17.06, 18.03, 21.07, 21.10, 22.19, 23.02)
- Worker questions, reports and progress work without a panel. Questions reach main immediately; an answer is written
  once and resumes a waiting headless turn. Keep negotiated MCP tasks, mod-owned wake, native client delivery and
  watch/`changes` fallbacks without duplicate wakes. Owner actions reach the responsible session too. A completion
  notice is not a read. `hud_read` returns a digest or the full report; signature-bound summary, files and checks
  need no display model. Keep idempotent create/send and batch tools. (14.03, 18.06, 21.06, 21.08, 22.01, 22.09, 22.15, 22.25)
- Successful completion requires a matching current-turn report receipt and a finished turn, or native pi settlement
  with a fresh report. Open questions or uncollected children block closure. Silence or a display label cannot fail
  a live worker; the bounded quiet-job rule needs quoted quota evidence to declare failure. Hand uncertainty to main.
  Close even if the report is unread; reap only proven descendants and the worker. An intentional stop stays a stop.
  Within the resume window reuse the verified native session; otherwise use the repair path. (14.02, 17.08, 18.05, 19.01, 21.06, 22.22)
- Keep clean managed worktrees and report-bound checks. A project's fast code-worker checks can refuse a report
  once for a fix or an explicit skip reason. `hud_land` integrates settled work through the project's
  gate, landing record, fast-forward, configured after-steps and optional push. A train shares a gate, not receipts;
  conflicts land separately, a red train falls back to individual lands. Preserve dirty or unintegrated work.
  Checks are evidence, not owner acceptance. (18.03, 21.08, 22.19, 22.26)
- Keep `hud_tickets`, dependencies, acceptance criteria and ready work. Main may authorize a fixed scouted dispatch,
  ticket batch or land flow; hand back at the first judgement point or after two failed repairs. No other automatic
  role chaining. Job access stays project-scoped, with same-project orphan adoption. (17.07, 20.03, 21.09, 22.19, 22.26)

Detail: [reference — CLI and MCP](reference.md#universal-cli-and-mcp) and [Claude Code mod](reference.md#claude-code-mod)
for tool contracts, role defaults, launches, wake, checks, trains, repairs and cleanup; ARCHITECTURE §4.5 for job collection.

### 2.2 What the owner sees

**Statusline.** Keep the compact client line, `line` and `p10k`, pi's editor ribbon and other extensions' statuses,
the `codexH` bar and supported native statuslines. (11.04, 12.01, 17.09, 22.12, 22.27)

- Distinguish **this session** (model, effort, context, project/branch, available quota and reset, output tokens/s or
  client-specific usage) from **this machine** (local CPU utilization, RAM used/total, running and queued HUD jobs).
  Label WSL guest readings as WSL. No Windows host probe or swap gauge is required. (new)
- Within this owner's `$HUD_HOME`, count each started, unsettled job once, including those waiting for main.
  Queued means not yet started; native transcript threads are not extra jobs. The owner count means *open owner requests*, not workers asking
  main. Real client permission prompts remain visible as such. Drop optional fields, including rate, to fit. (new)
- Sample outside paint. No sleep, project scan, model call or resident service to draw a line. Omit or qualify
  stale/partial readings; an absent watcher is not proof of zero. (new)

**Home.** `/hud` opens the same standalone herdr sidebar across clients; delegation stays installed when closed.
Keep keyboard and mouse navigation, Settings and Help. (11.04, 17.09, 19.03, 20.10)

- Show explicit owner requests first, then **all registered projects**, not just the current pane or recent visits.
  Show declared stance (e.g. active, paused, maintenance), current goal, recent result, owner priority and update
  time where known. Keep idle and unavailable projects identifiable. Bound or page detail, not membership. Opening
  a project is navigation, not a grant to operate its workers. (new)
- Attention means **someone has asked this owner to do something**. Say what, why now, which project/Objective,
  whether anyone actually waits, and where to look. A result or research opportunity belongs here only with such
  a request. No request kinds. Order: requests work waits on first, then owner priority, then oldest open; no
  model ranking. Home, Project, band and badge show the
  same requests within their stated scopes. (new)
- Main handles ordinary questions, failures, blockers and completions. Escalate lack of authority, a preference,
  a result to try or a risk main cannot resolve. The owner can answer in the responsible main session; recording the
  resolution there clears it everywhere. Reading, landing or a dependency clearing is not an owner decision. (new)

**Project.** An **Objective** is a named outcome with a stable ID within a registered project. A ticketless study
with no jobs or results yet is valid. The orchestrator maintains one short project-owned record of intent under
`.hud/`. Required per Objective: ID, title (what and why) and state `active`, `paused` or `done`. Optional:
latest result, evidence links, next step, linked ticket features. Blocked is derived from an open request work
waits on, not stored. No compulsory phase sequence. Use a fraction only with a named, meaningful denominator, such
as a linked feature's acceptance items. File syntax: D-2026-11-23-04. (new)

- Record each fact once. Link the spec for scope; tickets and landings for execution; reports, artifacts, commits or
  tests for results. Don't copy job state into an Objective. Keep explicitly flagged `STATE` waiting items without
  duplicating requests on tickets. Where no Objective record exists, show available STATE Now/Next as handoff
  notes, not fabricated goals. File update time is not result time. (new)
- A waiting item explicitly marked `(waits on …)` still clears when all its named tickets are done or dropped.
  (18.07, 20.05, 22.27) That is not an owner intervention. (new)
- For ordinary work main sets `Owner try: no`, verifies and accepts. Ask the owner about a named outcome, not its
  number of landed tickets. Keep explicit **Accept all** in ticket diagnostics and its command for pending tries;
  read legacy accept/flag records. Bulk ticket marks do not accept Objectives. (new)

**Off the main path:**

- A Jobs action opens one plain list; Enter opens Inspector. Keep original state, model/effort, reports, checks,
  process and worktree facts, headless output, progress, Sonic children and observed native subagents. Keep focus,
  answer-once, retry/land intent and confirmed stop; no panel briefing or dispatch. Project diagnostics keep ticket details, Changes/working tree and docs. `hud board`
  still exports an offline static project board; its “Needs you” uses the same rule as the panel. (new)
- Control keeps role chains and presets, harness switches, quotas, today's usage/dispatch health, local model
  discovery/picker and configuration files. Disabling a place must not rewrite the role file. (14.04, 17.04, 20.01, 20.02)
- Move EXP's optional native-line tracking, subscription proxy and calibrated API grants into resource settings.
  Experiments default off: no collection/refresh, no lost balances. No vendor billing sync or request blocking. (new)
- No display-side model calls. Panel, bars, notices and exports show observed facts and worker-declared summaries;
  the orchestrator writes Objectives and owner requests in the owner's panel language. The Decision API stays only
  on the execution side, each with its own switch: the quiet-job choice, Sonic thinking and imp `auto` routing.
  (14.02, 21.05, 22.22, new)

### 2.3 Evidence beyond the current run

- Keep joinable live job/STATUS, flow receipts and monthly job archive rows, including native session IDs and land
  repair causes. Preserve observed role/model/effort, lineage, ticket/package, times, checks, usage and reasons;
  no full brief, report or transcript in the archive. (22.16, 23.01)
- For associated work, link the ticket to the project-scoped Objective ID and stamp ID and title at attribution time
  into job and archive facts. Keep the link through retries, repairs and child work; don't guess from a title or
  package. Unattributed and older jobs stay unattributed. (new)
- On a recorded Objective creation or material change, even with **no job**, expose ID, title, change kind, time and
  the new state when declared. A revised goal is not a phase transition. For an explicit request record its ID and
  scope, opened and resolved/withdrawn times, who acted and whether work waited on the owner. These are receipts of
  recording the change, not another editable board. One decision counts once, not once per linked ticket. No second
  manual entry, panel observer or Git timestamp needed; unrecorded edits have no measured history. (new)
- After the resume window, prune clean jobs' raw stdout/stderr; failed/stopped jobs keep them until directory
  expiry. Protect the only native copy (headless pi: at least seven days). (22.16, 23.01) Save observed facts before
  pruning their last source. If the archive write fails, keep the source for the next sweep; an unknown field is
  not a reason to retain every log. Save deliberately selected research/incident evidence as an owner-controlled
  artifact outside auto-clean paths. No wait for a consumer acknowledgement. (new)
- Toktrack reads HUD facts; it doesn't write them or schedule agents. Its own native parsers and prices supply
  historical token/cost analysis. It may read a registered project's Objective record read-only, as it already
  reads ticket files, so ticketless Objectives are visible; HUD also stamps Objective ID and title into job and
  archive facts. No shared code. A live Objective or request can link an existing local analysis report;
  no Insights page or automatic import. Keep `hud stats` and `hud day` frozen, usable without toktrack. Remove
  either only after verifying its CLI use is covered and getting separate owner approval. (new)

Detail: [reference.md](reference.md#universal-cli-and-mcp) for retention, record fields and commands;
[ARCHITECTURE](ARCHITECTURE.md) §§4, 5, 7 for collectors, outbound inputs and private state.

### 2.4 Install, register and configure

One `./install` with chosen extensions and one `hud uninstall`; use official client registration where available.
Keep the optional Claude mod and reversible Antigravity integration. (13.04, 22.12)

`hud setup` detects, applies or removes registration. Load project roles, worker-only pi customizations and standing
briefs only for registered roots; cloning grants no trust. `hud trust` separately adds the owner's chosen directory
to supported CLI trust lists after backup. (13.01, 13.02, 20.08, 21.10)

Ship `hud-delegate`, `hud-setup` and `hud-handoff`. Leave optional skills uninstalled, outside setup and workers'
default context; main may read one on request or name its path in a brief. `hud tickets sync` alone writes the
one-way GitHub Issues mirror via `gh`; no polling GitHub or contacting it from the panel. (17.14, 17.15, 20.03)

## 3. What it does not do

- No new harness, general supervisor, workflow engine, ledger database or resident server. Local adapters and the
  on-demand watcher suffice. No native Windows, multi-user identity, cross-machine control or npm publishing. (10.01, 10.03, 14.02, 22.10)
- No transactional installer, vendor pins or upstream tracking for HUD-owned bars. Back up edited client files. (10.01, 10.03)
- Not a replacement for Git, issues or project docs. No inferred attention score, human activity surveillance, ROI
  or “intelligence” ranking. Historical comparisons belong in toktrack or a requested study. Teaching, preferences
  and reusable standards live in external skills/repos, under owner control. (new)

## 4. Threat model and quality bar

Trust the owner and local tools. Guard against irreversible data/config loss and commands from untrusted repos.
Otherwise use the simplest thing that works. Done means installable and usable, not just green tests. (10.04)

Keep panel and bars at least as fast as what they replace. Start the watcher on demand; exit when not needed.
Owner attention is scarce: justify detail by what it lets the owner skip. Only ask the owner to try behaviour they
must interact with to judge. (11.03, 10.04, 22.28)

Keep [ARCHITECTURE §8](ARCHITECTURE.md#8-rules-every-change-keeps): pure exact-column frames; sanitize external
text once; EN/ZH panel, English bar, accessible icon/text and no-colour modes. Drop optional fields before cutting.
Bound local reads, disclose incomplete coverage, never invent a zero or clean state. No fetch or repo-provided Git
commands/filters for status. No I/O or lifecycle change in paint.

Keep state private and atomic. Bound any new HUD-home store by count or age; do not purge existing archives,
config, keys or unrelated work. Document new outbound
inputs in ARCHITECTURE §5 and the reference; never send private reasoning. Sonic thinking, imp routing and
quiet-job decisions keep separate switches. Use synthetic data and temporary
homes for tests. Detail: ARCHITECTURE §8.

## 5. Milestones

0.2.0 is the baseline. Agree the boundary and deletions first. M1 and M2 can proceed independently against shared
job facts. Settle Objective and event semantics before building M3. No implied M4–M6. (new)

- **M1, take workers off the owner's desk.** Current-project Home: explicit Waiting, STATE Now/Next, one scoped load
  line where known. Keep Project details for now, but apply the request rule to its Inbox, notices, band and export.
  **Try:** a routine worker question reaches main but not “Needs you”; a separately flagged decision is visible and
  the worker's original question/report is still findable in Jobs → Inspector. (new)
- **M2, see load without the panel.** Local CPU/RAM and machine-wide running/queued counts. Don't claim a global
  owner count before the request source covers it. **Try:** with jobs in two projects and another queued, close the
  panel: both bars show the same HUD load, labelled OS scope and their respective quotas where known; starting the
  queued job changes the counts. (new)
- **M3, manage outcomes across projects.** Portfolio Home, Objective Project and request receipts, independent of
  tickets and toktrack. **Try:** from one session find a paused project and a ticketless research result in another;
  open its evidence, answer its escalated decision and see it clear without opening a worker conversation. (new)

## 6. How work is done

Grill → Slice → Build → Integrate → Review → Accept. Briefs name the spec clause, non-goals, size budget and stop
rule. Review once per milestone and before owner install, not per package; keep extra review for real config, deletion
of data, killing processes and the installer. Detail: [delegation.md](delegation.md). (10.05)

The owner approves milestone scope and success criteria, each visible deletion **before its slice**, product/value
and cross-project trade-offs, personal standards, and high-risk or irreversible acts unless already authorized. Main
chooses ordinary slices, dependencies and order; verifies, integrates and accepts ordinary work. Workers decide
implementation within the brief. Ask Oracle to investigate separately from designing a solution when the problem is
unclear. Escalate only judgements or results that need the owner. This replaces ordinary slice-list approval. (new)

## Removed by this spec

Owner approval checklist; the owner approved all items on 2026-11-23 (D-2026-11-23-03). A moved entry loses its old placement, not its underlying facts. No item authorizes
purging owner data. (new)

- [x] Session-local worker cards as Home, card filter, inline expansion and on-card actions; use Jobs/Inspector.
- [x] Home's package/brief-title lanes. Keep package attribution in receipts.
- [x] Home's native-subagent lanes/cards. Keep the observed tree in diagnostics.
- [x] Card auto-open/fold/hide, expiry settings, finished-job reveal and folded queued/read rows.
- [x] Worker stage animations and activity sparklines; keep observed progress messages and timestamps.
- [x] “Cards win,” the spare-row board, latest accepted slices, “done today” footer and Home tasks/tickets setting.
- [x] Split list/preview layout, sizing/focus controls and layout selector. Ignore saved Split preference; keep Control's model picker.
- [x] AI names and current-work/third lines for jobs and native agents, keyword colouring and sentence-interval control.
- [x] AI finished-result/failure sentences, including generated fallback or translation for worker summaries.
- [x] Model-judged outcome/confidence. Keep declared verdicts, observed state and historical values.
- [x] Model looping warnings; do not remove execution-side quiet-job handling.
- [x] Automatic question categories and review-severity tallies.
- [x] Generated Inspector decision titles/rewrites and automatic translation of ordinary questions, ticket titles, route reasons and landed rows.
- [x] Translation of owner requests and waiting items, and the Settings display-model controls (Model text master, model choice, call cap). Execution-side Decision API switches stay.
- [x] Routine worker completions/notices as owner alerts. Orchestrator delivery stays.
- [x] Worker questions, blocked tickets and exhausted roles as automatic owner Inbox items, including questions under “Needs you” in the static export.
- [x] The bar's per-role worker icon counts, individual HUD job reminders and `!asking` as owner load. Real native permission prompts stay.
- [x] Ticket Inbox with Running/last-accepted rows as Project's landing page; keep the underlying ticket and worktree diagnostics.
- [x] Ticket-count percentages as **project** progress; ticket denominators still mean something in ticket detail.
- [x] Routine owner approval of slice lists, order and dependencies.
- [x] Routine ticket-level human acceptance and the default Project/Claude band “N to try / Accept all” prompt. Keep explicit diagnostic Accept all, `/try`, `hud act try` and old records.
- [x] Standalone Changes entry. Merge its Git/worktree facts into project diagnostics.
- [x] Standalone EXP tab. Move controls without deleting ledgers or disabling configured features.
