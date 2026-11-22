# Codex vs pi implementer: same-task comparison

Owner request (Jacob, 2026-11-09): run the same implementer task through the **pi-roles implementer flow** and the
**native Codex implementer flow**, then compare. Both use the same OpenAI model, so the comparison is about the
harness and its workflow, not the model. Usage numbers come from toktrack; this page records setup, behaviour and the
result. Synthetic or public information only.

## Setup (PIROLE-PR2)

Task: PIROLE slice 2, owned herdr orchestration (launch, prompt and stall recovery, helpers, reap). Plan:
[architect consult](reviews/2026-11-09-pirole-plan-architect.md) §3 B, C, E, F, I, J.

| | pi arm | Codex arm |
|---|---|---|
| Launch | `pi-dispatch implementer --split` (tab split left/right) | `codex` in its own tab (`codex-account2`) |
| Implementer | gpt-6.1-sol high | gpt-6.1-sol high, Fast off |
| Base / worktree | `856e576`, `pirole-pr2-pi` | `856e576`, `pirole-pr2-cdx` |
| Brief | same Goal, binding design, scope, checks and test plan (diffed: identical) | same |
| Context | cold | cold (not a resumed PR1 session) |
| Review | `call_reviewer` in the right pane, gpt-6.1-sol xhigh, fresh pi session per round | one native `spawn_agent` reviewer, gpt-6.1-sol xhigh, re-checks to the same reviewer via `followup_task` |
| Recon / workers | none built in; sonic for chores | native `explorer`/`worker` subagents (gpt-6.1-sol high), may run in parallel |
| Sonic | `call_sonic` tool plus the helper-pane skill ("keeps your context free": lookups, research, spelled-out edits, chores, running checks) | role-file text only: run `pi-dispatch sonic` from the shell for fully specified mechanical chores |
| Questions | `ask_orchestrator` tool, `qa/qN.md` | write `qa/qN.md`, push a line with `herdr agent prompt` |
| Repair rounds | no cap (AGENTS.md owner clarification) | no cap |

Known confounders: sonic is a first-class tool with a skill on pi but only role-file text on Codex, and Codex has
same-model explorer subagents that compete with it for lookups; the review mechanics differ by design (fresh pi
reviewer per round vs one warm Codex reviewer). Questions get identical answers on both sides.

The Codex arm of this run got the narrower sonic wording ("fully specified mechanical chores: bulk renames, fixture
boilerplate, docs tables, lookups"). After launch the Codex role file was aligned with pi's helper-pane skill
(sonic keeps your context free; lookups, research, spelled-out edits, chores, running checks); later runs use that.

## Timeline

| Time (UTC) | pi arm | Codex arm |
|---|---|---|
| 18:30 | launched | launched |
| 18:31 | | spawned one explorer subagent; noted CodeGraph has no index in the worktree, uses source search |
| 18:32 | q1: existing `job-store.withLock` steals locks by age/PID; proposes an internal `runtime.ts` with process-instance-aware locks and a trusted herdr endpoint `{socketPath, server}` → approved with conditions | |
| 18:33 | q2: needs exact herdr wire shapes for session/occupant/editor checks → read installed herdr help/source and own-tab read-only queries | |
| 18:37 | | q1: finite reaper needs A1's installed release-inventory loader, absent at base → option A: exported `runReaper` with injected trusted loader, CLI wiring deferred to A1/PR3 |
| 18:41 | | q2: herdr endpoint/session/editor/split shapes absent from codecs; its provisional synthetic shapes differ from live → same answer as pi q2, plus a pointer to the existing herdr transport for the endpoint (pi had found it itself) |
| 18:44 | | spawned its reviewer early; it reviewed in parallel while the implementation continued (5 rounds, warm) |
| 18:46 | | q3: its reviewer found an amendment I had appended to the shared design file after launch (sonic for every role) and flagged a real deadlock (reviewer holding the helper mutex waiting on nested sonic) → out of PR2 scope; amendment moved to a separate file so both arms see the briefed design |
| 19:14 | | done: own reviewer ACCEPT, report written |
| 19:18 | `call_reviewer` round 1 (fresh reviewer): changes-required, 2 major + 1 minor | |
| 19:23 | reviewer q3: may it run in-memory probes against temporary fixtures → approved with limits | |
| 19:48 | round 2 (fresh reviewer): accept | |
| 20:03 | done, report written | |

## Things to check at acceptance

- Asking: pi asks through a first-class tool that blocks until answered (1200 s, then the stated default); Codex
  asks through a shell command described in its role file and keeps working or ends its turn. At acceptance, list
  the design choices each arm made **without** asking that should have been asked, to see whether the weaker channel
  costs Codex anything.

## Result

**Pick: pi (owner, 2026-11-09).** Both arms' full gates rerun by the orchestrator on each worktree, sequentially and
with nothing else running: all green (unit 4116 pi / 4130 Codex, mjs 398, hud-mcp 218, WP0 1176/1176, format,
fixtures, diff-check). pi arm merged; the Codex arm is kept on branch `pirole-pr2-cdx` as a record.

| | pi arm | Codex arm |
|---|---|---|
| Open major defects at orchestrator acceptance | 0 | 1: helper launches skip the herdr integration preflight (design §D); its warm reviewer missed it over 5 rounds, found by cross-checking pi's round-1 finding |
| Review | fresh reviewer per round, after the implementation; round 1 caught 2 major + 1 minor, all fixed with regressions and negative controls | one warm reviewer, started mid-implementation, reviewed moving code |
| Cost (native records, exact) | **$3.49** (impl 131 requests $2.74; reviews 17 + 11 requests $0.75) | $4.76 (main 130, fake worker 16, reviewer 59 requests) |
| Wall-clock | 93 min | **44 min** |
| Design choices without asking | none found | lock primitive (SQLite exclusive transaction instead of `job-store.withLock`) |

**Where the time went.** Model time was about equal (pi implementer 45.5 min, Codex main ≤ 42 min, 131 vs 130
requests on the same model). The gap is waiting: pi's `call_reviewer` blocks the implementer (29.4 min over two
rounds, ~8.5 min of each spent rerunning the full suite), and pi ran every check in the foreground (~12 min), while
Codex ran builds and tests in background terminals, built the fake herdr in a parallel worker and reviewed in
parallel. Questions cost pi 0.5 min.

**Usage measurement.** toktrack matches the native records exactly only after a rescan (`toktrack daily --json`;
`session-trace` reads its cache) and full pagination (200-row pages). Codex's own `duration_ms` total exceeds its
wall-clock and is not model time; pi records `durationMs` per response and per tool result.

**Follow-up applied (Fishpref `ed0cf77`):** implementers log each check to `checks/<name>.log` with `exit=<code>`,
run long suites in the background and run the full checks only before the first review and before the report;
reviewers verify fresh logs and run focused (round 1) or regression (later rounds) tests, rerunning any missing,
failing or stale check. The orchestrator still reruns the full gate at acceptance. Candidates for PIROLE PR3:
non-blocking `call_sonic`, and starting the reviewer while the implementer writes the report.
