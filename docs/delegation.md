# MyHUD workflow

Rewritten 2026-11-10 (owner). The old rule set (per-package reviews with up to three rounds, orchestrator-written
test plans, review tiers, a full gate after every merge) produced a narrow, defect-hunting loop that kept adding
guards and tests. The data is in `docs/reviews/2026-11-10-test-volume-audit.md`; the decision is in
`docs/handoff/STATE.md`. Earlier versions of this file are in git history.

**The boundary is `docs/spec.md`.** Only the owner decides what it says: an agent edits it only after telling the owner the change and the reason. Nothing the spec rules out is built, whatever an
agent proposes.

## The loop (per milestone)

1. **Grill.** Before a milestone, the orchestrator interviews the owner until the milestone's scope, non-goals and
   "done" are clear, and updates `docs/spec.md`. No code before this.
2. **Slice.** The orchestrator splits the milestone into small vertical slices: each runs end to end, can be shown
   working on its own, and fits one implementer session. The orchestrator owns the slice list, order and
   dependencies; the owner approves only milestone scope, value trade-offs, visible deletions and irreversible acts
   (owner, 2026-11-23; D-2026-11-23-03).
   Tickets only when the work needs several implementer sessions: too big for one, parallel on different files, or
   spread over days. Call `hud_tickets` without arguments for the slicing method adapted from Matt Pocock's, then
   use `op: add` to publish approved drafts into `.scratch/<slug>/issues/` (see `docs/agents/issue-tracker.md`).
   The Project tab tracks those tickets. Several small features one implementer can
   finish in one session are one slice with one brief and its acceptance list, no tickets (owner, 2026-11-12: "没有拆的
   必要"). Tickets and their land records are the only slice ledger for Project. Keep only the milestone, Now,
   Waiting for the owner, Next and short notes in STATE.md; do not add a slice row.
3. **Build.** One fresh implementer per slice, in parallel only where slices touch different files. No reviewer per
   slice. For ticketed work, call `hud_tickets({op: "ready"})` and pass the returned `ticket` and `path` to `hud_create`
   as `ticket` and `brief_file`. A live job claims the ticket; leave the file at `ready-for-agent` until `hud_land`
   records `done` (`Owner try: no` or omitted), or `ready-for-human` only for `Owner try: yes`. Do not make a claim
   commit. The implementer runs the main-path tests for what it changed, once, at the end. When a slice needs a lookup
   across several files first, pass `scout: "<question>"` on `hud_create` to attach a sonic dossier via `from_jobs`
   (prefixed with the unverified-facts reminder). Scout is for where/what/how-many questions; why/which/is-it-wrong
   questions (root cause, design, review) stay with the deciding model.
4. **Integrate.** The orchestrator reads each diff and tries the slice, then calls `hud_land({ job })` on the settled
   managed worktree (`isolation: "worktree"`). `hud_land` acquires the `main-checkout` lease, cherry-picks the job's
   commits into a detached checkout, runs the `.hud/project.json` `land` gate (one immediate rerun per red command; up
   to two source-worker repairs on conflict or persistent failure), folds the ticket landing record into the landed commit,
   fast-forwards the base branch, runs `after`, pushes when configured, and removes the integration and job worktrees
   and branch. One notice or MCP task reports the landed SHA or the failing step and tail; `hud_read({ job: "<flow>" })`
   inspects progress. A worker question goes to the main session and stops the flow.
5. **Review once, at the milestone.** One reviewer on the whole milestone diff (owner, 2026-11-17: no second
   reviewer and no model-family rule; supersedes 2026-11-11); it reports two axes separately:
   - **spec:** does it do what `docs/spec.md` asks, and does it do things nobody asked for (scope creep);
   - **simplicity and quality:** correctness defects, and what can be deleted (guards, options, abstractions, tests).

   The review brief states the **design intent**: one line per change on what it is for, which trade-offs were
   accepted on purpose and which behaviour is deliberate, so the reviewer judges against the intent instead of
   guessing it (owner, 2026-11-11). Findings below the blocking bar (races that need a coincidence, test-coverage
   suggestions, style) go in a separate optional list that does not change the verdict.

   One fresh implementer fixes the findings in one pass. Findings block only if a real user would hit them or the
   spec is violated.
   When the work runs as a workflow (ticket queue or a composed graph), steps 4–6 run inside it: one run covers the
   feature (or, in unattended mode, one selected `(project, Objective)` workset with normal `max_parallel`) for a
   baseline cost of **N + 2** sessions per N clean slices (N implementers + 1 milestone `reviewer` + 1 acceptance
   `lead`). Clean slices land automatically (in unattended runs, gated deterministically on no `docs/spec.md` diff and
   a settled `Removes:` declaration matching the ticket's `Approved removals:`, calling a temporary lead only on a
   declared ambiguity), an independent milestone `reviewer` step runs before acceptance (so the lead never waits on it),
   and the run ends with a one-decision project-lead acceptance session (role `lead`, Claude Code on `claude-opus-5-5`
   at thinking high with the HUD MCP tools, minus `hud_land`). The lead reads the run packet (reports, checks, live try
   instructions, and the milestone `reviewer` report), tries the result live where specified, judges findings, and
   declares `finish` (in unattended runs, recording durable acceptance per landed ticket), `repair` (adding repair
   tickets admitted by the same run, bounded to at most 2 repair rounds, then holding for the owner), or `escalate` —
   then the runner closes the lead session immediately through herdr. Non-blocking doubts or follow-ups go to `Todo:`
   lines stored on the run record (`hud_read({ job: <run> })` lists them; they never wake main). Worker `Assumed:`
   lines also go to the run todo (more than three, or one about scope, pauses the run without waking main); `Blockers:`
   owner matters pause without a wake; worker and reviewer questions start a temporary one-decision `lead` that answers
   (verified delivered) and closes. The orchestrator starts the run, receives only the one end notice (with the verdict
   and todo count) or an escalation under the run's configured escalation rule, and stays decoupled — runs keep going
   even if the dispatching main session closes (D-2026-11-25-07, D-2026-11-26-02).
6. **Accept.** The orchestrator accepts work after verification; there is no routine ticket-level owner acceptance.
   Ask the owner only for what they must judge themselves (milestone scope, a value trade-off, a visible deletion, an
   irreversible act, or behaviour only they can try) and record it as an owner request in STATE's
   `## Waiting for the owner`.

Extra review outside milestones only for: editing the owner's real config files, deleting data, killing processes,
and the installer.

## Briefs

Every brief states:

- the spec line it serves, and **what is out of scope** for this slice;
- a **size budget** (rough source lines, number of tests) and the stop rule: if the work will not fit, stop and
  report, do not expand;
- the main-path test(s) to add or extend: behaviour the owner would notice. No tests of internal details, no
  performance tests in the default suite, no real-process tests unless the slice is about processes;
- `no self-review` unless it is one of the risky cases above.

Design samples (owner, 2026-11-20): UI design starts with one self-contained HTML sample under `docs/design/<name>/`
(synthetic data, no outside fetches; terminal frames drawn on the real grid, every row exactly the panel's width, as
`docs/design/panel-v8/gen/` does). Pass its relative path as `preview` to `hud_create`, or have the worker name it in
`hud_report`. The worker (`frontend-imp`, no worktree) commits it. HUD copies it to `tmp/preview/<job>/` and opens it
in the owner's default browser on report (unless Open previews is off); the owner settles it and the build takes that
HTML as its template. One artifact, no screenshots, no separate preview after the
build: the owner tries the real panel. A plain feature slice with no design question goes straight to the build.
No claude.ai Artifacts.

## Questions

The implementer asks only when blocked, or when the choice changes what the owner sees or contradicts the spec.
Everything else it decides itself, choosing the simplest option, and notes in its report. The orchestrator's default
answer is the simplest option; anything beyond the spec goes to the owner.

Recurring questions become standing rules (survey 2026-11-22: 66 worker questions and 164 main follow-ups; 27 answers
just accepted the worker's default, and 25 follow-ups only restated a rule). When an answer would apply to other jobs,
add it to `.hud/brief.md` ("Decide these yourself") in the same turn, not only in the reply. An owner addendum to
running work goes into its ticket (What to build or Comments) first; the `hud_send` points to that line, so the next
job and the land read the same requirement.

## Roles

| Role | Runs on | Used for |
| --- | --- | --- |
| orchestrator | Claude Code (this session) | grilling, slicing, briefs, integration, every decision |
| implementer | role `imp` (skill `hud-delegate`) | one slice each |
| reviewer | role `reviewer`, one per review | milestone reviews and the risky cases above only |
| lead | role `lead` (`claude-opus-5-5` high, HUD MCP tools) | one-decision workflow acceptance and question hand-backs; closed through herdr after answering |
| sonic | role `sonic` | small chores and `scout` dossiers (where/what/how-many lookups); never test authoring, bug hunting, design, review or why/which/is-it-wrong questions (those stay with the deciding model) |
| oracle | role `oracle` | the strongest-model seat: high-level judgement that never changes the repository (scratch builds and measurements allowed) of any kind (design, root cause, verification, review verdicts, synthesis); advice only. Method skills are named by path in the brief |
| pro | role `pro` (`bro`) | a new product direction; research that needs outside sources (primary sources, each claim cited) |
| frontend-implementer | role `frontend-imp` | UI design and every user-facing UI build: panel, statusline, footers, rendered pages, design samples (`src/render/`) |
| Hermes | Windows, computer use | tests that need human-like interaction |

Each role runs where the owner's role files and the Control plane put it (`hud_roster` reports `runs_on`). `general` is the flexible seat: it takes `preset`, `on`, `model` or `thinking` for one job when the owner names a model (owner, 2026-11-22).

Codex tests use `codex2` (the free account), never the main `codex` account.

## Conventions

- Task scratch: `tmp/tasks/<slice>/` (git-ignored).
- One worktree per code imp (owner, 2026-11-12): the owner's statusline, pi footer and panel run from the main
  checkout's `dist/`, so an imp never builds there. Prefer `hud_create({ ..., isolation: "worktree" })`, which creates
  and tracks the linked checkout so `hud_land({ job })` can gate, record, fast-forward, push and clean it up. Manual
  `tmp/wt-new.sh <slice>` checkouts are still removed by the orchestrator after landing. Jobs that neither edit code
  nor build or test (docs, design samples, tickets, studies, read-only roles) get no worktree.
- Every test run uses a temporary HOME / HUD_HOME / CODEX_HOME / CLAUDE_CONFIG_DIR: `tmp/env.sh <command>`, run from
  inside the checkout or worktree it should act on.
- Synthetic data only in the repo (public). Never print or commit keys.
- The orchestrator commits; push at milestone boundaries.
