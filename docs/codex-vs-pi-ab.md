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
| 18:46 | | q3: its reviewer found an amendment I had appended to the shared design file after launch (sonic for every role) and flagged a real deadlock (reviewer holding the helper mutex waiting on nested sonic) → out of PR2 scope; amendment moved to a separate file so both arms see the briefed design |

## Things to check at acceptance

- Asking: pi asks through a first-class tool that blocks until answered (1200 s, then the stated default); Codex
  asks through a shell command described in its role file and keeps working or ends its turn. At acceptance, list
  the design choices each arm made **without** asking that should have been asked, to see whether the weaker channel
  costs Codex anything.

## Result

Pending.
