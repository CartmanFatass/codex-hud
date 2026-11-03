# Cloud workflow (Claude Code cloud, two-day run)

A small, Claude-only version of the universal-hud workflow for cloud sessions, where Herdr, Codex, pi and the shared
browser are not available. One orchestrator session runs one or two work packages; each package has one implementer
and one Oracle.

| Role | Who | Does |
|---|---|---|
| Orchestrator | the cloud session itself | reads the brief, launches the agents, verifies their claims, commits and pushes the package branch |
| Implementer (core) | Agent tool, `model: "opus"`, `effort: "high"`, `isolation: "worktree"` | implements a core or test brief, runs the checks, reports |
| Frontend implementer | Agent tool, `model: "sonnet"`, `effort: "xhigh"`, `isolation: "worktree"` | implements a rendering brief (`src/render/**`, visual baselines) |
| Oracle | Agent tool, `model: "opus"`, `effort: "max"`, fresh context each time | design forks inside the package, the final review, re-checks |

The brief's tier line names which implementer it takes. (Run 1, 2026-11-03, used Opus implementers and Fable max
Oracles; from run 2 the roles above apply.)

Run 1 is done: [`B12M`](B12M.md) on `cloud/b12m` and [`B10B-s2`](B10B-s2.md) on `cloud/b10b-s2`, both accepted, handoffs
in `handoff/`. Packages ready for run 2:

- [`B10B-s3`](B10B-s3.md): selection, navigation and the control bar for the delegation panel (frontend). Branches
  from `cloud/b10b-s2`.
- [`HYG1`](HYG1.md): a clean cloud test baseline (core, tests only). Branches from `universal-hud`.

They touch disjoint files and can run in parallel. B10D (the collector worker) is not a cloud package: it runs
elsewhere and owns `src/collectors/**` and the collector wiring in `src/tree-page.ts`.

## Loop per package

1. **Implement.** Launch the implementer with the implementer prompt below. It works in its own worktree on branch
   `cloud/<wp>`, created from the base the brief names (`universal-hud` unless stated).
2. **Design forks.** If the brief is silent or contradictory, the implementer stops and reports the question. The
   orchestrator launches one Oracle design consultation, which writes nothing and answers in text. The orchestrator
   saves the ruling to `docs/cloud/rulings/<wp>.md` and passes it to the implementer with SendMessage.
3. **Verify.** The orchestrator checks the report against the worktree (`git status`, `git diff --stat`, the brief's
   checks) before any review.
4. **Final review.** One Oracle review of the full diff. Findings go to the same implementer through SendMessage
   (its context stays warm).
5. **Re-check.** A fresh Oracle that is given the previous review and the fix diff. At most two fix rounds. After
   that, stop and record the open findings in the package's handoff.
6. **Hand back.**
   - The orchestrator commits on `cloud/<wp>`, adds `docs/cloud/handoff/<wp>.md` (report summary, Oracle verdict,
     check output, open items) and pushes the branch.
   - No merges into `universal-hud`. The owner's local orchestrator merges after its own acceptance.

Keep the whole run within about 10 agents. Performance gates on a cloud host are noisy: report the range over at least
three runs (and the GC share when the tail is GC), never a single best run. A failed check is reported, never worked around. One review per change:
no second reviewer on the same diff.

## Rules every agent keeps

- **Public repo.** Fixtures, docs and logs use synthetic data only: no real session text, ids, tokens, keys, or
  paths under a real home directory.
- **Isolation.** Tests use a temporary `HUD_HOME` and a temporary `HOME` (`env -u HUD_HOME HOME=$(mktemp -d)`), never
  real `~/.hud`, `~/.claude`, `~/.codex*` or `~/.pi`. Processes a test starts are owned and cleaned up by PID, never
  killed by name or pattern.
- **Ledger writers.** Only hud-mcp, hud-run and the reconciler write the ledger. The HUD is read-only apart from the
  observation store it publishes to as lease holder.
- **Contracts are the spec.** `docs/contracts/01–07` and `docs/design/hud-information-design.md` are binding. A gap
  is a question for the Oracle (in-package) or a handoff item (cross-package), never a silent choice.
- **Performance is acceptance.** Code on the HUD tick path reports p50/p95/p99/max, n and the command, measured
  against contract 06 P-06-7 as amended (「B10C 增补」) and design §6.
- **Runtime.** Node 22 ≥ 22.13 or Node 24 (`node:sqlite`). Run `npm ci` once if `tsc` or `prettier` is missing.
- **Git.**
  - Never stage `node_modules/` changes (`node_modules/.package-lock.json` in particular).
  - No force-push, no history rewrite, no commits to `main` or `universal-hud`.
  - Commit only after the Oracle accepted and the checks are green.

Check set (every package, with its own extra commands):

```bash
npm run build && npm run build:test && npm run build:hud-mcp
env -u NO_COLOR -u FORCE_COLOR -u HUD_HOME HOME=$(mktemp -d) npm test
npm run test:core
npm run test:visual
npm run test:hud-mcp
npm run format:check
npm run check:fixtures
git diff --check
```

Known flakes under load: `model-jobs.test.js` timing, `b6-wait-status` "idle wait zero writes", `b3h-heartbeat-busy`
fence loss, a hud-mcp B20 advice `ledger_busy`. Rerun a flaky suite once alone and report both runs.

## Prompts

### Orchestrator (paste into the cloud session)

```text
You are the orchestrator for a two-day cloud run on the universal-hud branch of this repo. Read docs/cloud/README.md
(workflow, rules, prompts), then CLAUDE.md and docs/ARCHITECTURE.md §8. Run the packages the README lists as ready in
parallel, each with one implementer (Agent tool, isolation "worktree", the implementer prompt from the README; model
"opus" effort "high" for core and test briefs, model "sonnet" effort "xhigh" for rendering briefs) and Oracles (Agent
tool, model "opus", effort "max", a fresh agent each time, the Oracle prompts from the README). Follow the loop in the README exactly: verify each report
yourself before review; one final Oracle review per package; fixes go back to the same implementer through
SendMessage; re-checks go to a fresh Oracle; at most two fix rounds. Subagents cannot write report files: when one
returns its report or review as text, save it yourself under docs/cloud/handoff/ or docs/cloud/rulings/. When a
package is accepted and green, commit it on its branch cloud/<wp> (end the message with the Co-Authored-By line),
add docs/cloud/handoff/<wp>.md, and push that branch. Do not merge into universal-hud or main. Keep going without
asking me unless a decision changes a contract, the design doc or another package's files; then stop that package and
write the question into its handoff file.
```

### Implementer (Agent tool, `isolation: "worktree"`; core: `model: "opus"`, `effort: "high"`; frontend: `model: "sonnet"`, `effort: "xhigh"`)

```text
You are the implementer of work package <WP> in this repo. In your worktree, create branch cloud/<wp> from
the base your brief names (universal-hud unless stated). Read docs/cloud/README.md (rules and check set), CLAUDE.md, docs/ARCHITECTURE.md §8, then your brief
docs/cloud/<WP>.md and everything it lists as binding. Implement exactly the brief within its owned files. You do
not decide design forks: if the spec is silent or contradictory on something you need, stop and return the question
(options, your default, why) instead of guessing. Each behaviour you add or fix gets a test that would fail without
it. Run the brief's checks and the README check set and quote their actual output. Do not commit. Return your report
as text: changed files, exported API, decisions, check output, performance numbers with commands, failure-mode test
names, open items.
```

### Oracle: design consultation (`model: "opus"`, `effort: "max"`)

```text
You are the Oracle for work package <WP> of this repo: a design consultation, read-only (edit nothing, spawn
nothing). Binding sources: docs/cloud/<WP>.md, the contracts and design sections it lists, docs/universal-hud-concept.md
§15 (decision log). The implementer asks: <question, options, default>. Read the relevant code in <worktree path>.
Give one decision, the reason in a few lines, what it changes in the brief's acceptance, and whether it touches a
contract, the design doc or another package (if so, say so plainly: the orchestrator must stop and hand it to the
owner). Return the ruling as text ready to paste into docs/cloud/rulings/<wp>.md.
```

### Oracle: final review (`model: "opus"`, `effort: "max"`)

```text
You are the single reviewer of work package <WP> in this repo: read-only (edit nothing, no git mutations, spawn
nothing). The change is the working tree of <worktree path> against universal-hud (git diff universal-hud plus
untracked files). Brief: docs/cloud/<WP>.md; the implementer's report: <path or pasted text>; rulings:
docs/cloud/rulings/<wp>.md if present. Check correctness against the binding contracts and design, the failure-mode
tests (each real, meaningful, failing without the fix), performance evidence (n, warm-up, nearest-rank, what is
measured), ownership (no edits outside the brief), public-repo hygiene (synthetic data only). Run the brief's checks.
Return findings as `file:line — defect — failure scenario — severity P0–P3 — suggested fix`, a "Verified" list, and a
verdict: accept or fix required.
```

### Oracle: re-check (`model: "opus"`, `effort: "max"`, fresh agent)

```text
You are the re-check reviewer for work package <WP>: read-only. Previous review: <pasted findings>. Fix report:
<pasted text>. Fix diff: the working tree of <worktree path> against <commit or description>. For each previous
finding, say fixed / partly fixed / not fixed, with evidence: the code and a test that fails without the fix.
Report regressions the fixes introduced as new findings in the same format. Do not re-review areas the first review
accepted unless a fix touches them. Verdict: accept or fix required.
```
