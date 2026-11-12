# MyHUD workflow

Rewritten 2026-11-10 (owner). The old rule set (per-package reviews with up to three rounds, orchestrator-written
test plans, review tiers, a full gate after every merge) produced a narrow, defect-hunting loop that kept adding
guards and tests. The data is in `docs/reviews/2026-11-10-test-volume-audit.md`; the decision is in
`docs/handoff/STATE.md`. Earlier versions of this file are in git history.

**The boundary is `docs/spec.md`.** Only the owner changes it. Nothing the spec rules out is built, whatever an
agent proposes.

## The loop (per milestone)

1. **Grill.** Before a milestone, the orchestrator interviews the owner until the milestone's scope, non-goals and
   "done" are clear, and updates `docs/spec.md`. No code before this.
2. **Slice.** The orchestrator splits the milestone into small vertical slices: each runs end to end, can be shown
   working on its own, and fits one implementer session. The owner approves the list (size, order, dependencies).
3. **Build.** One fresh implementer per slice, in parallel only where slices touch different files. No reviewer per
   slice. The implementer runs the main-path tests for what it changed, once, at the end.
4. **Integrate.** The orchestrator reads each diff, tries the slice, and merges it into the milestone branch. No
   full gate per slice; one full test run at the end of the milestone.
5. **Review once, at the milestone.** Two reviewers from different model families, in parallel, on the same brief
   and the whole milestone diff (owner, 2026-11-11: fewer reviews, better ones); each reports two axes separately:
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

## Questions

The implementer asks only when blocked, or when the choice changes what the owner sees or contradicts the spec.
Everything else it decides itself, choosing the simplest option, and notes in its report. The orchestrator's default
answer is the simplest option; anything beyond the spec goes to the owner.

## Roles and models

| Role | Runs on | Used for |
| --- | --- | --- |
| orchestrator | Claude Code (this session) | grilling, slicing, briefs, integration, every decision |
| implementer | pi, `openai/gpt-6.1-sol` high (skill `herdr-delegate`) | one slice each |
| reviewer | pi, two in parallel: `openai/gpt-6.1-sol` xhigh and `mistral/deepseek-v4-1-flash-1017` max (`hud_create` model override). Chosen after a three-way trial on M3 (owner, 2026-11-11) | milestone reviews and the risky cases above only |
| sonic | pi, DeepSeek V4.1 Flash | small chores for any role; never tests, bug hunting or design |
| architect | pi, `openai/gpt-6-astra` high | only a structural question the orchestrator cannot settle; advice only |
| Argon / ChatGPT Pro | `jev-ask` | only a new product direction |
| frontend-implementer | Claude subagent (sonnet) | rendering work with a settled design |
| Hermes | Windows, computer use | tests that need human-like interaction |

Codex tests use `codex2` (free account, `gpt-6-luna` medium), never the main `codex` account.

## Conventions

- Task scratch: `tmp/tasks/<slice>/` (git-ignored).
- One worktree per code imp (owner, 2026-11-12): the owner's statusline, pi footer and panel run from the main
  checkout's `dist/`, so an imp never builds there. `tmp/wt-new.sh <slice>` makes `../MyHUD-wt/<slice>` on branch
  `wt/<slice>` with `node_modules` symlinked; `hud_create` gets that `cwd`. The orchestrator commits in the worktree,
  cherry-picks onto `universal-hud`, runs the full suite in the main checkout, then removes the worktree.
- Every test run uses a temporary HOME / HUD_HOME / CODEX_HOME / CLAUDE_CONFIG_DIR: `tmp/env.sh <command>`, run from
  inside the checkout or worktree it should act on.
- Synthetic data only in the repo (public). Never print or commit keys.
- The orchestrator commits; push at milestone boundaries.
