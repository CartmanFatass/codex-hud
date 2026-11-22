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
   working on its own, and fits one implementer session. The owner approves the list (size, order, dependencies).
   Tickets only when the work needs several implementer sessions: too big for one, parallel on different files, or
   spread over days. Call `hud_tickets` without arguments for the slicing method adapted from Matt Pocock's, then
   use `op: add` to publish approved drafts into `.scratch/<slug>/issues/` (see `docs/agents/issue-tracker.md`).
   The Project tab tracks those tickets. Several small features one implementer can
   finish in one session are one slice with one brief and its acceptance list, no tickets (owner, 2026-11-12: "没有拆的
   必要"). STATE.md's `## Slices` ledger keeps one line per work package either way.
3. **Build.** One fresh implementer per slice, in parallel only where slices touch different files. No reviewer per
   slice. The implementer runs the main-path tests for what it changed, once, at the end.
4. **Integrate.** The orchestrator reads each diff and tries the slice. Send sonic this integration brief:

   > Integrate `<ordered slice commit IDs>` onto `<base branch>`. Run every command through the main checkout's
   > `tmp/env.sh`. Create a fresh detached worktree at the base tip (`node_modules` is tracked; no link).
   > From the integration worktree, cherry-pick the commits in order. Run `npm run` for each script in order:
   > `build`, `build:test`, `test:mjs`, `test:mjs`, `test:unit`, `check:fixtures`. Stop at the first conflict or
   > failed step; never edit code. Report in at most 10 lines: picked cleanly or conflict files; pass/fail and
   > counts per step (mark later steps not run); failing test names and first error line; integration commit ID(s).

   The orchestrator decides whether to send a repair to an imp or fast-forward the base to the tested commit and
   push at the milestone boundary. Remove the integration worktree after that handoff; sonic never lands or pushes.
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
6. **Owner tries it.** The owner installs or runs the milestone. That is the acceptance.

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
`docs/design/panel-v8/gen/` does). The worker commits it and reports its path; the owner looks at it and settles
it; the build then takes that HTML as its template. One artifact, no screenshots, no separate preview after the
build: the owner tries the real panel. A plain feature slice with no design question goes straight to the build.
No claude.ai Artifacts.

## Questions

The implementer asks only when blocked, or when the choice changes what the owner sees or contradicts the spec.
Everything else it decides itself, choosing the simplest option, and notes in its report. The orchestrator's default
answer is the simplest option; anything beyond the spec goes to the owner.

## Roles and models

| Role | Runs on | Used for |
| --- | --- | --- |
| orchestrator | Claude Code (this session) | grilling, slicing, briefs, integration, every decision |
| implementer | role `imp` (skill `hud-delegate`) | one slice each |
| reviewer | role `reviewer`, one per review | milestone reviews and the risky cases above only |
| sonic | role `sonic` | small chores for any role, including running the step 4 gate; never test authoring, bug hunting or design |
| oracle | role `oracle` | the strongest-model seat: read-only high-level judgement of any kind (design, root cause, verification, review verdicts, synthesis); advice only. Method skills are named by path in the brief |
| pro | role `pro` (`bro`) | a new product direction; research that needs outside sources (primary sources, each claim cited) |
| frontend-implementer | role `frontend-imp` | UI design and frontend development |
| Hermes | Windows, computer use | tests that need human-like interaction |

Where each role runs (harness, model, thinking) is what `hud_roster` reports as `runs_on`: the owner's role files, switched in the Control plane. A dispatch passes no `preset`, `on`, `model` or `thinking` unless the owner asks for it in that request, and an owner's pick for one task does not carry over to the next (owner, 2026-11-20).

Codex tests use `codex2` (the free account), never the main `codex` account.

## Conventions

- Task scratch: `tmp/tasks/<slice>/` (git-ignored).
- One worktree per code imp (owner, 2026-11-12): the owner's statusline, pi footer and panel run from the main
  checkout's `dist/`, so an imp never builds there. `tmp/wt-new.sh <slice>` makes `../MyHUD-wt/<slice>` on branch
  `wt/<slice>` (`node_modules` is tracked, so no link); `hud_create` gets that `cwd`. The orchestrator commits in the worktree,
  hands the commit IDs and `universal-hud` to sonic for step 4, then removes the slice worktree after landing.
- Every test run uses a temporary HOME / HUD_HOME / CODEX_HOME / CLAUDE_CONFIG_DIR: `tmp/env.sh <command>`, run from
  inside the checkout or worktree it should act on.
- Synthetic data only in the repo (public). Never print or commit keys.
- The orchestrator commits; push at milestone boundaries.
