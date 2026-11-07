# HUD workflows: fixed and ad-hoc topologies of custom agents, run by the host

Design decision document WF1, revision 2 (2026-11-07, design oracle; revision 1 was reviewed by Pro, verdict REWORK;
all eight required changes are applied, §14). Companion to `native-hud-v2.md` (v2.2) and `jev-in-hud.md` (JEV1 v4),
both of which stand (§8.4 lists the additions to v2.2 types). The owner's request of 2026-11-07: a main session
(Claude Code, Codex or Pi) starts a named workflow once; the HUD host runs a fixed topology of custom agents
(implementer → reviewer and/or tester → fix loop → done), advances between steps itself and wakes the main session
only at the end or when something needs it. Also decided: workflows designed on the spot (§4) and a prompt-cache
estimate for every child (§8). The owner's decisions F1–F6 (concept §15, 2026-11-07 entry) are unchanged. Examples
are synthetic; paths are relative to `~/.hud` or the repo.

The thesis in four lines:

1. **A workflow is a declared graph, not a program.** Steps, edges, verdict tokens, round caps, parallel groups and
   bounded fan-out are data the host validates before anything runs; the owner confirms a frozen bundle and exactly
   that bundle executes (§2, §4). Resume is a position in the graph plus the decisions already persisted (§5).
2. **Workflow agents are ordinary depth-one children of the main session**, created through `hud_create` with the same
   records, requests, idle policy and close ladder (§5, §7). Nothing nests: the engine is a sibling-launcher.
3. **Every agent step ends with a verdict file**, read by the host on `turn_done`; no HUD tool enters a child (§3).
4. **Fewer wakes by construction.** Child-level wakes are consumed by the run; a healthy run produces one logical
   completion notification plus an intervention notice whenever something needs the owner (§6).

## 0. Fixed inputs, restated as constraints

| Fixed input (concept §15, v2.2, JEV1) | What it pins here |
|---|---|
| One level of MCP delegation; children get no HUD tools | workflow children carry `HUD_CHILD`; `workflow_*` tools are parent-only; a child cannot start a run (§7) |
| Non-interference: children run on the user's own harness configuration | agent definitions carry no permission, tool or MCP settings for Codex/Claude; the role reaches the agent as the first prompt and a file (§1) |
| Pi is the customisable exception | Pi agents name a pi-roles role; the host passes `--role`, `--allow-write <run>/<child>/*` and the owner's extra args (§1) |
| Child requests are answered by the main session; 1 h re-wake, 2 h abandon | the default request policy; a step may opt into `default`/`fail`; approvals always wake (§6) |
| Lightweight, fast, few processes, clear visualisation; bounded lifecycles; one tree | no script process (§4); one run record under the owner's stamp; the run is a node under the root with its children (§9); every instance has an absolute deadline and a ladder (§5) |

## 1. Custom agents: definitions

**Format.** Markdown with a flat YAML-subset frontmatter (scalars and one-line JSON arrays; a ≤ 40-line reader, no
YAML dependency), body = the role prompt: the shape of Claude Code's `.claude/agents/*.md` and the owner's pi-roles
`roles/*.md`. HUD never reads or writes a harness's own agent directories.

```md
---
name: reviewer                  # [a-z0-9][a-z0-9-]{0,31}
harness: codex                  # codex | claude | pi
model: gpt-6.1-sol              # → hud_create.model; absent = the harness's configured default
effort: high                    # → hud_create.effort
pi_role: reviewer               # pi only: pi-roles role name; model/effort above override it (--model/--thinking)
pi_args: ["-e", "<roles package path>"]   # pi only; appended to hud_create.options.args; `~` expanded
writes: step                    # step (default; pi: --allow-write <run>/<child>/*) | tree (may edit the working tree)
description: Independent read-only review of a diff against a brief.
---
You review a change for an orchestrator… (role text; the host's trailer names the brief, report and verdict paths)
```

Rejected keys: anything selecting tools, permission modes, MCP servers or system prompts for Codex/Claude
(`invalid_definition{non_interference}`); `cwd` (a run parameter). `writes: tree` is documentation for the plan and
the role text, enforced only on Pi (the pi-roles guard); Codex/Claude children write whatever the user's permission
mode allows. **Location and precedence.** User: `~/.hud/agents/<name>.md`, `~/.hud/workflows/<name>.toml`. Project:
`<git root of cwd>/.hud/agents/`, `/.hud/workflows/` (committable, synthetic); project shadows user by name.
**Resolution happens once, at `plan`:** every agent the graph names is read, validated and copied into the run's
bundle (`<run>/agents/<name>.md` + `{ source, path, sha256, harness, model, effort, pi_role, pi_args, writes }`);
children launch from the bundle, never from the directories, so a file edited after confirmation or between rounds
changes nothing in a live run; a definition that fails validation is listed with its error and the plan cannot start.
**Role delivery:** turn 1 is `<step prompt>` + a fixed trailer ("Your role: `<run>/agents/<name>.md`. Brief: `<brief>`.
Write your report to `<instance dir>/report.md` and end by writing `<instance dir>/verdict.json`"); one prompt, no
flags; a Pi agent gets the role through `--role` and the same trailer.

## 2. Workflows: definitions

**Format: TOML** on disk (`@iarna/toml` is already a dependency), JSON inline (§4), one loader (F1). The normalised
form stored in the bundle is JSON. The example below is the W1 acceptance fixture (§12).

```toml
name = "impl-review"
start = "implement"                          # root key: it must precede the first table header
[params]
brief = { kind = "file", required = true }   # copied into <run>/brief.md at plan; {brief} resolves to the copy
check = { kind = "argv", default = ["npm", "test"] }
[budget]
max_turns = 24                               # hard cap on hud_create + hud_send in the run; nudges and answers count
[steps.implement]
agent = "implementer"                        # fresh child; verdicts default to ["done"]
prompt = "Read {brief} and do exactly what it asks in {cwd}. Base commit {base}."
on.done = "check"
[steps.check]                                # host-run command, argv form, no shell
run = "{check}"
on.pass = "review"
on.fail = { to = "fix-test", max = 2, else = "end:needs_owner" }
[steps.fix-test]
agent = "implementer"
reuse = "implement"                          # the same child and conversation (§5); identical resolved agent required
prompt = "The check failed; its output is in {output:check}. Fix it. Round {round}."
on.done = "check"
[steps.review]
agent = "reviewer"                           # a fresh child every round: one review per change, fresh eyes
prompt = "Review the uncommitted diff in {cwd} against {brief} (base {base}). Implementer report: {report:implement}."
verdicts = ["accept", "reject"]
requests = "default"                         # F3: a reviewer question that states a default is answered silently
on.accept = "end:done"
on.reject = { to = "fix-review", max = 2, else = "end:needs_owner" }
[steps.fix-review]
agent = "implementer"
reuse = "implement"
prompt = "Address every finding in {report:review}. Round {round}."
on.done = "check"
```

| Element | Rule |
|---|---|
| step kinds | `agent` (one child turn per instance; `verdicts` default `["done"]`), `run` (host command → `pass`/`fail` by exit code), `jev` (`{ provider, prompt_file }` → §5.4; **disabled until W2c**: `invalid_definition{unsupported}`), `parallel = ["a","b"]` (§2.1), `foreach` on an `agent` step (§2.1) |
| edges | `on.<token> = "<step>" \| "end:<outcome>"` or a counted edge `{ to, max (≤ 5), else = "end:<outcome>" }`; `max` counts traversals of that edge in the run; `else` **must be terminal**. `on.failed`, `on.timeout`, `on.lost` default `end:failed`; `end:needs_owner` is the "ask the owner" outcome |
| total routing | every token in `verdicts` needs an `on.<token>`; `run` needs `on.pass` and `on.fail`; `parallel`/`foreach` need `on.accept` and `on.reject`, `foreach` also `on.empty`; a result with no edge cannot occur at run time |
| loop bound | delete every counted edge from the graph: **the remainder must be acyclic**. Every cycle then passes a counted edge, each fires ≤ `max` times and exits to a terminal `else`, so the run terminates. Revision 1 accepted `{ to = "b", max = 1, else = "b" }`; this rule rejects it, in linear time, without cycle enumeration |
| budget | `[budget] max_turns` (default 24, cap 48) counts every `hud_create` and `hud_send` of the run: first prompts, nudges, question answers, continuations after recovery. Exhaustion → the run ends `needs_owner{budget}`, nothing more is dispatched. `step_deadline` 2 h (F5), `run_deadline` 8 h |
| reuse | `reuse = "<step>"`: the instance is a new turn to that step's child, the continuation of the same conversation; valid only when both steps resolve to the **identical** bundled agent (same `sha256`, harness, model, effort, pi args, writes) → else `invalid_definition{reuse_mismatch}`; an idle-closed child is resumed (`hud_create{resume}`). Not allowed on or into `parallel` members or `foreach` steps. Cache estimates (§8) are advisory: the author chooses `reuse` or a fresh step |
| placeholders | `{cwd} {base} {run} {step} {round} {item} {brief} {<param>} {report:<s>} {verdict:<s>} {output:<s>} {lines:<s>} {index:<s>} {answer:<s>}`; `:<s>` = the newest instance of `s`, and `s` must lie on every path from `start` to the step (`invalid_definition{unbound_reference}`: revision 1's single `fix` read `{report:review}` after a test failure that preceded any review); values are paths or short strings, never file contents; in `run` steps they are **arguments or env values, never shell text** (§3) |
| validation (static) | unknown step/agent/param; unreachable step; edge token not in `verdicts`; reserved token (`question failed timeout lost empty`) in `verdicts`; non-total routing; the loop rule; `reuse` rules; §2.1 rules; `jev` before W2c; budgets over caps; non-interference keys; a plan that could exceed `maxChildren`/`maxParallel` |

The validator derives the **plan** the owner confirms: steps in topological order with counted edges marked, each
agent with source · harness · model · effort and body hash, every command verbatim (shell ones flagged), params and
their bound files, `cwd` and `base`, the agent instances on the bounded paths (the example: 8), the hard budget (24; a
nudge or answer per instance is possible, so the plan shows the hard cap, not a tight bound) and the project sources.

### 2.1 Composition contract (deliberately small)

| Construct | WF1 rule |
|---|---|
| `parallel` members | leaf `agent` or `run` steps only; no `reuse`, no `foreach`, no nesting, no own `on.*`, no incoming edges from elsewhere; results return to the container |
| `join` | `all` only (`any` → `unsupported`: implementer → reviewer/tester does not need it, and it adds completion-order state) |
| container tokens | `accept` iff every member token ∈ `accept_when` (default `["accept","pass","done"]`), else `reject`; a member `failed`/`timeout`/`lost` → stop intent on the group, the other members are cancelled and **settled** (ladder complete) before the container settles `failed{member}` → its `on.failed` |
| `foreach` | `foreach = "{lines:<s>}"`, `max_items` ≤ 16 (default 8), `concurrency` ≤ `maxParallel`; the **manifest** (trimmed, non-empty, de-duplicated lines in order) is persisted on the instance before any dispatch; 0 items → `empty`; more than `max_items` → `failed{too_many_items}` (never a silent partial review); members are instances `<step>-<n>/<i>` with `{item}`; container token and failure rule as above; `{index:<s>}` = a host-written `index.json` `[{ item, verdict, summary, report }]` so the next step addresses the collection |
| not in WF1 | `foreach` of a subgraph, nested fan-out, quorum/best-of joins, reducing structured per-item results. The first expected wall is "for each discovered package: implement → test → review": when the item set is known the main session writes the expanded graph, when it is discovered the run stops at the boundary; use cases are collected before W6 or subgraph composition is decided |

## 3. Step outcomes and artefacts

**Run directory** `~/.hud/workflows/<ownerKey>/<runId>/` (0700; the record is `<runId>.json` beside it): the copied
`kind = "file"` params (`brief.md`), `bundle.json` (normalised graph, params, agents, commands, provenance),
`agents/<name>.md`, and one directory per instance: `<child>/<step>-<n>/` for agent instances (a per-child subtree, so
a reused Pi child's launch-time `--allow-write <run>/<child>/*` covers every instance it ever runs), `host/<step>-<n>/`
for `run` and `jev` instances; contents `prompt.md`, `report.md`, `verdict.json`, `question-<k>.json`, `output.txt`,
`items.json`, `index.json`, `answer.md`. Artefacts live outside the working tree: a reviewer's `git diff` stays clean.

**Verdict protocol (every agent step).** The host creates the instance directory empty and names the verdict path in
the trailer, so no stale file can be read. On `turn_done{completed}` `verdict.json` must be a JSON object ≤ 16 KiB
with `verdict` ∈ the step's tokens or `question`, `summary` ≤ 600, optional `details` ≤ 8 KiB, optional `question:
{ text ≤ 2 KiB, options?: ≤ 8 × 200, default? }`. Missing, unreadable, partial, oversized or unknown token → **one**
nudge (`nudgeUsed` persisted before the `hud_send` "Finish by writing <path>"; one turn of budget; the deadline does not
move) → then `failed{no_verdict | bad_verdict}` → `on.failed`. `verdict: "question"` → the host **moves** the file to
`question-<k>.json` (consumed: an unchanged file cannot ask twice), raises a `workflow_question` request on the child
record (§6) and, on the answer, sends exactly one continuation ("Answer: … Then finish by writing <path>"); ≤ 3
questions per instance, then `failed{too_many_questions}`. `turn_done{failed | interrupted}` → `failed{child_failed}`
unless a persisted cause wins (§5.1); `lost` → `on.lost`. A valid verdict proves protocol compliance; tester and
reviewer steps establish whether the work is right. A file, not a tool, because children have no HUD tool table (v2.2
§1.4) and the file is the artefact the next step reads; parsing the final message for `VERDICT:` lines is rejected
(fragile across three harnesses). Revision 1 let a step without `verdicts` end `done` on any completed turn, so an
implementer finishing with "Which interface should I keep?" (v2.2 §3.3's Codex fallback) advanced to review while
`hud_send` on its child was refused; that path is gone.

**`run` steps.** `run = ["cmd", "arg", …]` (argv, no shell; `{…}` placeholders expand to whole arguments) or `shell =
"…"` (explicit `sh -c`, **no substitution inside the string**: data arrives through `args = [...]` / `env = { NAME =
"{brief}" }`). cwd = the run's cwd, env = the captured environment plus bindings, `detached`, own process group, stdio
captured; `timeout` default 20 min, cap 2 h → SIGTERM group, 5 s, SIGKILL; `idempotent = true` declares that the
command may be replayed on recovery (§5.3). Outcome = exit code (`pass`/`fail`); `output.txt` keeps head + tail
≤ 64 KiB and ends with the exit line; `{lines:<s>}` = the last ≤ 256 stdout lines. The plan prints every command
verbatim and flags `shell` ones: "no code runs" (§4) describes the graph interpreter, not the commands the owner
authorises.

## 4. Ad-hoc workflows: designed on the spot

The owner describes a flow in words; the main session (any harness) produces something the host runs. Weighed against
prior art (§11): (a) a sandboxed script (Claude Code `Workflow`, ZCode `CreateWorkflow`): any computation between
steps, but the topology is known only at run time unless a compiler + analyser derives it (ZCode ≈ 25k lines), plus a
curated `vm` realm in a child process, determinism bans and a replay journal — ≈ 1.2k lines and a `node` process per
run; (b) a declarative graph written on the fly: the exact graph and commands confirmed, structural bounds, resume =
position + persisted decisions + artefacts — ≈ 1.1k lines, no process; (c) (b) plus expression hooks: a parser and an
evaluator for little gain. **Decision (F2): (b), with structured conditions standing in for expressions** — the edge
table *is* the expression language; nothing is parsed or evaluated at run time and every bound is visible in the plan.
The main session writes the TOML/JSON (validation errors return as `L:C message` lines for a retry, as ZCode does);
where a flow needs real computation between steps it runs it and starts the next run — it is awake then anyway. A
script step kind is **deferred (W6)**, decided after W5's real runs; §11 pins what to port. Routing inputs are verdict
tokens, exit codes and persisted decisions (join results, manifests, counters), all on disk; no clock or randomness
enters routing, and a restarted host never redoes a settled instance (§5.3).

**Lifecycle of a run.** `workflow_plan{ definition | workflow, params, cwd }` validates, resolves and **freezes the
bundle** (§1, §3), writes a run record in state `proposed` (the TUI shows the planned graph, dim) and returns `{ run,
plan, toml, warnings }`. The main session shows the plan to the owner and, on the owner's yes, calls `workflow_start{
run, confirmed: true }`; `confirmed` carries JEV1's `confirm_resend` wording: it may come only from the user's
explicit decision. **F6 applies transitively:** confirmation is required when **any** executable definition in the
bundle — the workflow or an agent it resolves — is project-sourced or inline (a project file may come from a public
clone; Grok Build gates project hooks on folder trust for the same reason). A user-level workflow whose agents all
resolve to user files starts in one call (`workflow_start{ workflow, params, cwd }`); one that resolves a project agent
answers `confirmation_required{ sources }` and goes through `plan` (fork F7, §13). `workflows.confirm =
"project+inline" (default) | "always" | "never"`. A `proposed` run not started within 1 h is deleted; a second `start`
of one `proposed` run answers `already_started`. **Saving** is the owner's decision, so it is a CLI: `hud workflow save
<run> <name> [--project]` writes the bundle's graph back as TOML; `hud workflow list|show <name>` complete it.

## 5. Execution in the host

### 5.1 Durable instances, serialised transitions

```ts
export interface StepInstance {                      // one per execution: the unit of dispatch, settlement and recovery
  id: string; step: string; n: number;               // '<step>-<n>', foreach members '<step>-<n>/<i>'
  kind: 'agent' | 'run' | 'jev' | 'parallel' | 'foreach'; group: string | null;
  item?: { index: number; value: string }; items?: string[];           // foreach member value / container manifest
  work: { kind: 'child'; child: string; turn: number | null }          // tagged work reference, written before dispatch
      | { kind: 'process'; pgid: number; startedAt: number }           // pid + start time: no pid-reuse kills
      | { kind: 'jev'; key: string; label: string } | null;
  phase: 'waiting' | 'dispatched' | 'nudged' | 'asking' | 'settled';
  dispatchedAt: number | null; deadlineAt: number | null;              // absolute, set once at dispatch, never moved
  nudgeUsed: boolean; questions: number; turns: number; cause: 'timeout' | 'cancel' | null;   // cause persists first
  result: { token: string; summary: string } | null;                   // written exactly once (settlement)
  effects: 'none' | 'uncertain' | 'settled'; join?: { decided: string };   // recovery boundary (§5.3); container decision
}
export interface WorkflowRun {
  run: string; owner: Owner; createdBy: string; name: string; bundle: WorkflowBundle;   // bundle frozen at plan
  cwd: string; base: { sha: string; branch: string | null; dirty: boolean } | null;
  state: 'proposed' | 'running' | 'blocked' | 'done' | 'failed' | 'needs_owner' | 'cancelled' | 'interrupted';
  outcome: string | null; stop: { intent: 'cancel' | 'run_timeout'; at: number } | null;   // intent persists first
  instances: StepInstance[]; edges: Record<string, number>; turns: number;           // 'review.reject' → 2
  children: Array<{ child: string; agent: string; instances: string[]; active: boolean }>;  // one entry per child
  requests: Array<{ requestId: string; child: string; instance: string; kind: string; policy: string; since: number }>;
  startedAt: number | null; deadlineAt: number | null; hostGeneration: string; seq: number;   // deadlines absolute
  createdAt: number; lastEventAt: number; endedAt?: number; wake: WakeBinding;
}
```

Each run has one in-memory queue: the engine takes one event at a time, computes the transition, rewrites the record
(atomic rename, under the owner's stamp like Jev job files) and only then performs side effects. An event for a
`settled` instance, or whose work reference does not match the instance's (a late `turn_done` of an earlier turn, the
exit of a replaced process group), is logged `late` and dropped; `result` is written once. **Stop intent first:**
`workflow_cancel` and the run deadline write `stop` before any `hud_cancel`, a step deadline writes `cause: 'timeout'`
before the interrupt; with `stop` set nothing is dispatched, no edge is followed and later outcomes settle `cancelled`;
with `cause` set the `turn_done{interrupted}` settles `failed{timeout}` → `on.timeout`, never `child_failed`. Cleanup is
complete when every work reference is released (child closed through the ladder, process group gone, Jev observation
closed); only then `state` becomes `cancelled` / `failed{run_timeout}`. **States:** `proposed → running` → `blocked`
while an intervention request waits (§6) → `running` when all are settled → terminal `done | failed | needs_owner |
cancelled`; `interrupted` at host boot (§5.3). Inside `running`/`blocked` every path is defined: total routing leaves
no result without an edge; a failed dispatch (`hud_create` error, spawn error, admission timeout) settles
`failed{dispatch}` → `on.failed`; a partial group follows §2.1; non-agent work recovers per §5.3.

### 5.2 Children, admission, limits, isolation

Each `agent` instance without `reuse` is a `hud_create` under the main session's owner: `name` = the agent name (the
step is the child's action line, §9), `model`/`effort`/`options.args` from the bundle, the captured environment of the
attachment that started (or resumed) the run, cwd = the run's cwd; `createdBy` stays the attachment id (v2.2 §2.8) and
the record gains `workflow: { run, agent, active: true }`. While `active`, `hud_send`, `hud_cancel`, `hud_close` and
`hud_create{resume}` on the child answer `workflow_owned{run}`; `hud_read`, `hud_wait` and `hud_respond` work as usual.
A child stays open while a reachable step reuses it; otherwise the ladder closes it when its instance settles; all
children are closed at run end and `active` becomes false, so a child the owner resumes by hand later is an ordinary
child again (its wakes return). The 30-min quiescent idle close remains a backstop; `reuse` of an idle-closed child
resumes its native session. v2.2 §6.1.1's lifecycle table gains: the run (an async task, no process; retained while
`running`/`blocked`), the workflow child (as any child; closed on settle-without-reuse, run end, idle/abandon, always
through the ladder), the `run` command (own group; exit or deadline → SIGTERM 5 s → SIGKILL; swept by pgid + start
time like children) and the `jev` step (JEV1's rules; `jev_ask_close` on cancel).

**Admission at dispatch, not at plan.** Plan-time checks reject impossible plans; capacity is reserved when an
instance is dispatched, by the host's single admission function shared with ordinary `hud_create` (one process, so the
check is synchronous): live children per owner/host (`maxChildren` 8/24, retained reusable children included), children
still starting (`startTimeoutMs` reservations), `maxParallel` 4 per run counting children **and** command process
groups, and Jev's own `liveLimit`/`queueLimit`. On shortage the instance waits (`phase: 'waiting'`, visible in the TUI)
up to `admissionWaitMs` (10 min) → `failed{capacity}` → `on.failed`; a run whose own quiescent reusable child holds the
last slot closes it through the ladder (resumable) instead of waiting on itself. `maxRuns` 2 live per owner.
**Deadlines are absolute:** `deadlineAt` at dispatch (`stepDeadlineMs` 2 h, F5; `run` steps 20 min), the run's at
start (`runDeadlineMs` 8 h); questions, nudges, waiting and restarts never move them. **Cancellation:**
`workflow_cancel{run}` → `stop` → `hud_cancel` on running children, the ladder on all, process groups killed, Jev
closed (§5.4) → `cancelled`; artefacts kept, no wake (the caller asked); a `proposed` run is deleted. **Isolation (F4,
caller-managed):** `cwd` is a parameter; the host records `base`, branch and dirtiness and never runs `git worktree
add/remove`; the skill's recipe is `git worktree add <path> -b hud/<name>` then `workflow_start{cwd: <path>}`;
merging/removal are the main session's decisions at the end (the owner's "commit WIP before removing worktrees" is a
judgement HUD must not make); `isolation = "worktree"` is reserved. Run directories are kept; `workflows.keepRuns` (20
per owner) prunes terminal runs oldest-first.

### 5.3 Recovery and the side-effect boundary

At host boot a `running`/`blocked` run with a foreign `hostGeneration` becomes `interrupted`; its live children are
`lost` and swept by the v2.2 crash sweep. `workflow_start{ run }` on an `interrupted` run recaptures the environment
from the **resuming** attachment (v2.2 §6.2 persists none; the recorded native `source` is kept) and treats each
unsettled instance by evidence. **Guarantee:** a settled instance is never dispatched again; an instance with uncertain
effects is reconciled before anything continues or is replayed.

| Unsettled instance | Evidence | Action |
|---|---|---|
| agent, valid `verdict.json` | the turn finished before the record was written | settle from the file; route normally |
| agent, no verdict, `nativeRef` recorded | effects uncertain (a commit or external action may have landed; v2.2 §6.1: resume restores history, not pending state) | resume (`hud_create{resume}`) and send one continuation: "the host was interrupted; first state what you already did, then finish by writing <path>" — one turn of budget, same `deadlineAt` (past → `failed{timeout}`) |
| agent, no verdict, no `nativeRef` | nothing to continue | `failed{lost}` → `on.lost` |
| `run`, exit line in `output.txt` | the host writes it last | settle from it |
| `run`, no exit, `idempotent = true` | declared safe | replay in a fresh instance directory |
| `run`, no exit, not idempotent | effects uncertain | the run ends `needs_owner{uncertain_command}` naming the instance; `workflow_start{ run, replay: ["<id>"] }` is the owner's explicit decision to run it again |
| `jev` | JEV1 record by key | JEV1 `resume`: wait or reconcile, never a resend (§5.4) |
| `parallel`/`foreach` container | member instances | members individually; a persisted `join.decided` is final |

Settled results, counters and the budget are kept; `interrupted` is reported once (§6).

### 5.4 Jev steps (W2c, after J4 / J5a / J5b)

A `jev` step is a `jev_ask` under the owner with JEV1's rules plus five of its own. (1) **Identity before dispatch:**
`label = "<run>-<step>-<n>"` (a slug ≤ 64, within JEV1 M1) is persisted on the instance first, so the JEV1 key
(provider + label + prompt digest) is distinct per instance and stable across recovery: two instances never attach to
one operation and no stale answer is read. (2) **Key persisted** (`work.kind: 'jev'`); recovery goes through JEV1's
`resume` (wait/reconcile) and a generic restart never becomes an unconfirmed resend. (3) **Every JEV1 state mapped:**
`answered`, `incomplete` → tokens; `needs_human` → blocks the run; `sent`/`awaiting`/`reconciling`/`uncertain` →
still running; `not_submitted`, `pre_send_failed`, `wait_failed`, `timed_out`, `abandoned`, `interrupted` →
`failed{<state>}` → `on.failed`; `dry_run_ok` cannot occur. (4) **`needs_human` is a handoff, not a question:**
`blocked{dialog}` with JEV1's reason (login, challenge, quota, connector approval); `hud_respond` cannot answer it and
the run resumes when the job leaves `needs_human`. (5) **Wakes and cancel:** the job is workflow-owned, so JEV1's own
wakes (§4.8) are consumed by the run like child wakes (§6); cancel uses `jev_ask_close` (observation ladder, sent-tab
rules; a send is never undone). Asks of JEV1 (for its editor; not edited here): a `jev_ask` owner flag (`owned_by:
'workflow:<run>'`) routing the job's wakes to the run, and `jev_ask_close` idempotent on a terminal job.

## 6. Requests, who answers, and when the main session wakes

Every request raised in a run — harness approvals (`exec_approval`, `patch_approval`, `tool_permission`), harness
questions (Codex `requestUserInput`, Claude `AskUserQuestion`/elicitation, Pi `ask_orchestrator` dialogs), verdict-file
questions (§3), Jev `needs_human` and unknown shapes (`other`) — follows **one ordering**: (1) record it on the child
record and the run; (2) precedence: approvals and `other` always require intervention (the engine never grants
permissions and never guesses at an unknown dialog), otherwise the step's policy applies; (3) only if intervention is
required does the run go `blocked` and emit one run-level `blocked` notification; (4) the raw child event stays
readable through `hud_wait`/`hud_read` and never wakes on its own. Per step, `requests = "wake" | "default" | "fail"`:

| Policy | Behaviour |
|---|---|
| `wake` (default, F3) | `blocked`; the main session answers with `hud_respond`. A verdict-file question is a `workflow_question` request the **engine** resolves (`NativeSessionHost.respond` knows only native pending requests, `src/managed/host.ts:251-262`), dispatching exactly one continuation; a second `hud_respond` → `request_not_pending`. v2.2's `request_stale` (1 h) re-emits `blocked`; `abandoned` (2 h) settles the instance `failed{abandoned}` → `on.failed` |
| `default` | a verdict-file question with `default`, or an `ask_orchestrator` call with `default`, is answered at once and `{question, default}` recorded on the instance; without a default → `wake` |
| `fail` | the request is withdrawn through the harness's cancel path; the instance settles `failed{asked}` → `on.failed` |

**Pi `default` carrier.** The dialog cannot carry it (`ctx.ui.select/input` take title, options/placeholder, signal),
but the `ask_orchestrator` tool call with its arguments precedes the `extension_ui_request` in the child's rpc stream,
and `rpc-adapter.ts:96-127` relays the whole dialog record: the engine pairs the dialog with the preceding call of the
same child whose `question` equals the title and whose options match, and takes the default from the call; an
unpaired dialog is an arbitrary extension dialog, `kind:'other'`, and always wakes. Probe **P7** (3 trials) confirms
the rpc stream exposes tool arguments in child mode; until it passes, `default` on a Pi step behaves as `wake`. The HUD
Pi package's child-mode tool gains `default?: string` (additive).

**Blockers and events.** The run leaves `blocked` only when all blockers are settled; an answer after `stop` is
recorded and dispatches nothing. `WorkflowEvent{ type:'workflow', run, kind, step?, instance?, result? }` shares the
ring with child events; wake-worthy: `done`, `failed`, `needs_owner`, `interrupted`, `blocked`; `step_done` is
published for `hud_wait` and never wakes. For a child with `workflow.active`, **every** child-level wake-worthy event
of v2.2 §5.1 (`turn_done`, `request`, `request_stale`, `closed{abandoned}`, `exit`, `error`, `lost`) is consumed by the
engine and becomes a step result or a run event; a workflow-owned Jev job's wakes likewise. Line: `[hud] workflow
impl-review (w-3f2a) done · accept after 2 rounds · 48m · workflow_status{run:"w-3f2a"}`. **Guarantee:** one logical
completion notification per healthy run plus one `blocked` per intervention (v2.2 §5.2's single retry may repeat the
idempotent line). **Long runs under a Claude parent:** `workflow_start` returns a `wake.command` whose `--timeout-ms` is
the run's remaining deadline + 5 min (`hud wait` accepts it, `src/cli/run-wait.ts:63`), so the 2 h 05 default waiter
adds no re-arm turns to an 8 h run; if the parent's background-task cap is lower, the plan's `warnings` disclose the
extra re-arms. A designated *agent* answerer is rejected for v1 (another process and context per question, unverified
answers; the owner's practice shows 0–2 questions per task, which `default` absorbs).

## 7. The one-level rule and non-interference

Workflow children are the main session's depth-one children: `HUD_CHILD` set, empty tool table, direct calls refused,
active-child index guarding the host. `workflow_*` tools are in the parent table only; a child cannot start, plan or
cancel a run. A workflow agent's native subagents (Codex `spawn_agent`, Claude Agent tool) are untouched and shown
read-only under its node when they exist (the plan does not promise them). HUD installs no hooks, personas or agent
files into any harness. For authors: a Codex implementer that spawns its own native reviewer plus a workflow `review`
step is two reviews of one change; the role text should tell it not to (the owner's "one review per change").

## 8. Prompt-cache estimate of a child (advisory)

### 8.1 Evidence the host has (corrected)

| Harness | Provider | Usage evidence | Compaction | P6 establishes |
|---|---|---|---|---|
| Codex | `cache.providerByHarness.codex` (default `openai`) | the rollout reader parses `event_msg/token_count` with **cumulative** `total_token_usage{ input_tokens, cached_input_tokens, … }` (`src/harness/codex/index.ts:303-315`); the managed adapter forwards `turn/completed` raw (`managed-adapter.ts:310-318`), which proves nothing about a per-turn usage field | none observed | the live shape (`thread/tokenUsage/updated` vs `turn/completed`, per Pro's reading of the app-server docs) and its scope |
| Claude | `anthropic` | the transcript reader sums `cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens` per message id (`src/harness/claude/reader.ts:395-417`) | `compact_boundary` | the SDK `result.usage` scope (request vs turn) |
| Pi | the stream's own `provider` field (`src/harness/pi/projection.ts:139-140`), **not** a prefix of the model id | assistant-message `usage{ input, cacheRead, cacheWrite }` as separate categories (`projection.ts:168-186`) | `compaction` row | the live `message_end` shape |

**Normalisation:** `totalInputTokens` = `input_tokens` for OpenAI (it already includes the cached part) and `input +
cacheRead + cacheWrite` for Anthropic and Pi; `cachedReadTokens`, `cacheWriteTokens`; `scope: 'request' | 'turn' |
'cumulative'` is recorded with every sample and a ratio is shown only for `request`/`turn` samples. **Timing:**
`lastRequestAt` is the start of the last model request when the host observes it (a `turn_started`/message event
preceding the result), else the turn's end, labelled an estimate: a four-minute response leaves about one minute of a
five-minute lifetime. A tool event does not prove that a model request followed; only observed requests count.

### 8.2 Estimate and config

```ts
export interface CacheEstimate {
  observed: { at: number; totalInputTokens: number; cachedReadTokens: number; cacheWriteTokens: number;
              scope: 'request' | 'turn' | 'cumulative' } | null;                 // last sample; shown whenever present
  forecast: { state: 'warm' | 'expiring' | 'expired' | 'unknown'; provider: string | null; ttlMs: number | null;
              basis: 'documented' | 'observed' | 'configured' | null; lastRequestAt: number | null;
              lastRequestAtIs: 'request_start' | 'turn_end_estimate' | null; expiresAt: number | null };
}
```

`forecast.state` is `unknown` whenever `ttlMs` is `null` **regardless of observed hits**, before the first observed
request, after a compaction event (the prefix changed; the next sample tells) and on `hud_create{resume}` (a resumed
session may well be warm). Otherwise by clock: `expired` past `expiresAt`, `expiring` within `max(cache.expiringMs
60 s, 20 % of ttl)`, else `warm`. The context meter is not a compaction signal (a 30 % drop proves nothing); a low hit
ratio after a `warm` forecast is shown as evidence, not interpreted. Computed on each record write and by the TUI at
render time. **Config (`config.json cache`):** `ttl: { anthropic: { ms: 300000, basis: 'documented', note: '5 min
default; the 1 h extended TTL is not detectable' }, openai: null, deepseek: null, mistral: null, zai: null }`: `openai`
stays `null` because the Codex subscription route's retention is undocumented (Pro cites the current API guide for a
30-minute minimum on GPT-5.6+ and a 12-hour Responses option; not verified here, and API documentation does not
establish the subscription route); the owner sets values with `basis: 'observed' | 'configured'`; `byModel: {}` (exact
model id wins); `providerByHarness: { codex: 'openai', claude: 'anthropic' }`; `expiringMs`.

### 8.3 Use and TUI

Advisory everywhere (the owner's decision: the child reports the estimate, the caller decides reuse or fresh). In a
workflow the author writes `reuse` or a fresh step; the plan shows a reusable child's estimate at `plan` time and each
reused instance records it; the main session sees the same estimate on `hud_read{what:'status'}` and `hud_list`.
Revision 1's `reuse_if = "warm"` is withdrawn: it turned "continue this conversation" into "start another one" on an
estimate without a self-contained handoff, and provider cache expiry does not erase native history; a fresh-fallback
feature would need an explicit handoff prompt and both alternatives in the plan. **TUI:** a card setting **Cache**
(Settings → Cards → Cache, default off) adds a badge after `model·effort` when the forecast is known: `♨ 4m` (warm,
time left; U+2668), `♨ <1m` in the warning colour (expiring), `♨ ×` muted (expired); nothing for `unknown`. Compact
rows show glyph and time only; the Inspector always shows one line: `cache: last turn 92 % read (24k/26k) · forecast
warm 4m (anthropic 5m, documented; from request start)` or `… · forecast unknown (openai: no TTL configured)`. Bar and
statusline show nothing. The information-design doc owns glyph and placement.

### 8.4 Exact additions v2.2 needs (to fold into `native-hud-v2.md`)

| Where | Addition |
|---|---|
| §2.8 `ChildRecord` / `ChildEvent` | `cache?: CacheEstimate`; `usage` gains `cachedReadTokens?`, `cacheWriteTokens?`, `scope?`; `workflow?: { run; agent; active }` (`createdBy` unchanged); `turn_done.usage` carries the cache fields; new `{ type: 'compaction' }` and `{ type: 'workflow'; run; kind; step?; instance?; result? }`; `HudRequest.kind` gains `'workflow_question'` (engine-resolved) |
| §2.2 `SubagentTreeNode`; §1.5 `config.json` | `cache?: CacheEstimate`, `workflow?: { run; agent; active }`; `cache: {…}` (§8.2), `workflows: { maxRuns, maxParallel, stepDeadlineMs, runDeadlineMs, admissionWaitMs, keepRuns, confirm }` |
| §3.3 / §5.1 / §6.1 | Pi child `ask_orchestrator` gains `default?` and the pairing rule (§6); run-level wake events, children with `workflow.active` and workflow-owned Jev jobs excluded from child-level wakes, the run-aware `--timeout-ms` (§6); admission at dispatch shared by `hud_create` and the engine (§5.2) |
| §7.2 | probe **P6** (usage and compaction shapes per harness, 3 trials each, scopes recorded) and **P7** (Pi tool arguments visible in the child rpc stream) |
| Appendix B | `hud_create` returns `cache` with `forecast.state: 'unknown'`; `hud_read{what:'context'}` includes the cache fields; mutations on an active workflow child → `workflow_owned`; `hud_respond` on a `workflow_question`; the five `workflow_*` tools (§10); `hud_list` gains `workflows: WorkflowRunSummary[]` |

## 9. TUI

One node per run under the root; **one row per child** (the child record, nested by `workflow.run`), native subagents
below when they exist (depth 3; the information-design cap is 4). Step-instance history lives in the run node's
stages, not in extra rows. No separate pane, no grouping by backend; the run node is not counted as an agent.

```
├─ ▸ ⟳ impl-review · review (round 2/2) · 5/24 turns · 48m         (status from run.state; glyph proposal ⟳)
│  ├─ ✓ π implementer    flash·max   15m  fix-review done · "4 files, tests green"   ♨ 3m
│  ├─ ✓ ⌬ reviewer       sol·high     4m  review: reject · 2 findings
│  └─ ▸ ⌬ reviewer       sol·high     1m  review#2
```

| Surface | What |
|---|---|
| run node line | marker from `state` (`proposed` dim *planned*; `running` ▸; `blocked` ⚑ with the request line; a `waiting` instance shows the capacity wait; `needs_owner`/`failed`/`interrupted` ✗ kept until put away by hand; `done` ✓ and the linger), `⟳`, name, current step(s) with `round i/max` on a counted edge, turns used / hard cap, clock |
| run node stages | `instances[]` → `stages[]`, one per instance with its token (`reject · 2 findings`), `run` steps with `pass`/`fail` and the command head, `foreach` members collapsed under their container |
| child rows | the ordinary child card/row; `name` = agent; the action line names the current or last step instance; the `♨` badge (§8.3) when the setting is on |
| Inspector (run) | the plan as an indented list with the position marked, edge counters, budget used/cap, absolute deadlines, `base` sha and dirty flag, the bundle's sources, the run directory under `▾ More`, and "read-only: the host drives this run; `workflow_cancel` stops it" |
| bar / statusline / Pi footer; `proposed` runs | `agentCounts` include the children only; the attention badge ranks `blocked` with pending approvals; completion notices key on the run's terminal event; a `proposed` run is drawn from the bundle before any child exists and deleted on cancel or after 1 h |

## 10. Tool surface (parent table only; empty in a child)

| Tool | Arguments | Returns | Notes |
|---|---|---|---|
| `workflow_list` | `{ what?: 'definitions' \| 'runs' }` | definitions `{ name, source, description, params, valid, error? }[]`, runs `WorkflowRunSummary[]` (≤ 50) | read-only; never starts a host |
| `workflow_plan` | `{ workflow?: string, definition?: object, params?, cwd: string }` | `{ run, plan, toml, warnings[] }` or `invalid_definition{ errors: 'L:C message'[] }` | validates, resolves, freezes the bundle, writes a `proposed` record; starts the host if needed |
| `workflow_start` | `{ workflow?, params?, cwd? } \| { run, confirmed?: true, replay?: string[] }` | `{ run, seq, wake }` | one-call start when nothing in the bundle is project/inline (F6); `run` form starts a `proposed` run or resumes an `interrupted` one; `confirmation_required{sources}`, `already_started`, `limit_exceeded`, `run_not_found` |
| `workflow_status` | `{ run }` | the `WorkflowRun` with heads trimmed (≤ 4 KiB) | passive |
| `workflow_cancel` | `{ run }` | `{ ok, children: closeResult[] }` | §5.2 |
| CLI | `hud workflow list \| show <name> \| save <run> <name> [--project]` | — | owner-facing |

New error codes: `invalid_definition`, `confirmation_required`, `already_started`, `workflow_owned`, `run_not_found`.
`hud_list` gains `workflows: WorkflowRunSummary[]` (`{ run, name, state, current, turns, startedAt, endedAt? }`).

## 11. Prior art and what is taken from it

Read on 2026-11-07 from shallow clones (Apache-2.0 both; read only, nothing run or built).

| Source | What it does | Adopt | Do not adopt (and why) |
|---|---|---|---|
| **Claude Code `Workflow` tool** | JS script with a `meta` literal for the permission dialog, `agent()/parallel()/pipeline()/phase()`, journal-cached resume, `Date.now`/`Math.random` banned, caps 16 concurrent / 1000 agents, `isolation:'worktree'` | approval before run against a declared plan; caps as structural bounds; "same inputs → cached result" as our settled-instance rule | the script runtime (sandbox and determinism discipline; §4) |
| **ZCode dynamic workflows** (`apps/zcode-cli/packages/dynamic-workflow{,-runtime}`, ≈ 25k lines excl. tests/UI) | TypeScript scripts typechecked against a facade `.d.ts`; a static analyser derives graphs for a confirmation window; the script runs in a separate `node` child inside a `vm.createContext` realm with five host functions and banned non-determinism; NDJSON protocol; journal rows per site; resume gated on a byte-identical script hash; `escalate` → a question with no timeout; per-run + shared adaptive concurrency | the confirmation step with a timeline the owner sees **before** running (ours from the validator); "a subagent asked again keeps its context" = our `reuse`; `escalate` = our request path; `L:C` diagnostics the model resubmits against; **if W6 is ever built**: port the curated-realm pattern of `dynamic-workflow-runtime/src/child-source.ts` and the shape of `tests/security.test.ts` (≈ 150 lines, Apache-2.0 header kept, file and commit named in `THIRD_PARTY_NOTICES.md`, ZCode's `NOTICE.md` attribution reproduced per §4(d)) | the compiler/analyser (heavier than the whole host); journal replay with settle-order gating; the provider governor (HUD makes no model requests). No code there launches Claude Code, Codex, Gemini CLI or OpenCode as workers, so it is not prior art for cross-harness children |
| **Grok Build** (`xai-grok-pager/docs/user-guide/{16-subagents,10-hooks}.md`, `xai-tool-types/src/task.rs`, `xai-grok-hooks`) | `spawn_subagent`/`task` with agent `.md` files, `isolation: none \| worktree`, `resume_from` a completed subagent; personas with `inputs`/`outputs` contracts; Claude-compatible hooks with `Stop` gates; project hooks gated on folder trust | the inputs/outputs contract → our placeholders and instance directories; `resume_from` only for completed children = our `reuse`; the "keep working until the check passes" gate as a host-run `run` step routing back; folder trust → F6 and its transitive form | hooks or personas injected into the user's harness (non-interference); Rust code |

## 12. Work packages, order and tests

Nothing here touches WP0–WP2. Sizes as in v2.2 (S ≤ half a day, M ≤ 2 days); Grok 4.7 high for core, pi for tests,
frontend-implementer for W4, an Opus subagent reviews each package. W2 is split so each increment is reviewable.

| WP | Content | Acceptance (node --test unless stated) | Size / who · when |
|---|---|---|---|
| **W1** definitions | `src/workflows/{frontmatter,agent-def,workflow-def,resolve,validate,plan,placeholders}.ts`; TOML and JSON in, bundle out | the §2 example is the **acceptance fixture**: it parses with root `start`, validates, binds `{output:check}` and `{report:review}` on every path, reports 8 agent instances and the hard cap 24; a failing fixture and an `L:C` message per rule of §2/§2.1 incl. `{ to="b", max=1, else="b" }`, `join="any"`, nested `parallel`, `reuse` of a mismatched agent, a verdict with no edge, unbound `{report:…}`; project shadows user and the bundle records both sources; a file edited after `plan` changes nothing; `save` round-trips TOML → JSON → TOML byte-stable | S / Grok (tests pi) · from WP2a |
| **W1b** contracts | `StepInstance`, `WorkflowRun`, `workflow_question`, `workflow.active` ownership, the admission function signature — agreed with WP2a's record contract and WP4's normalisation | types + fixtures; `hud_create` and the engine call one admission function | S / Grok · with WP2a/WP4 |
| **W2a** serial engine | `src/managed/workflow-engine.ts`: serialised transitions, settlement, stop intent, absolute deadlines, verdict protocol + nudge + questions + synthetic responder, `run` steps (argv/shell, bindings, groups), counters, budget, `reuse` with resume-on-idle-closed, request policies incl. Pi pairing (behind P7), wake consumption and `WorkflowEvent`, cancel, `interrupted` + the recovery table | fake adapters + fake clock + fake process table: the fixture runs accept-first-round, test-fail→fix→accept, reject×3 → `needs_owner`; **boundary tests**: crash before dispatch / after turn end before record write / after settlement before successor; cancel racing a completing turn (no new dispatch, one settlement); timeout cause wins over `child_failed`; late and duplicate `turn_done`; duplicate `start` of one `proposed` run → `already_started`; missing, malformed, oversized, repeated-question verdicts; nudge exhaustion across restart; every approval kind under `wake`/`default`/`fail`; two blockers and a late answer after cancel; budget exhaustion → `needs_owner{budget}`; non-idempotent command interrupted → `needs_owner{uncertain_command}`, `replay` reruns it; idempotent → replayed; process group killed at deadline; capacity shortage waits then fails; a run's idle reusable child is closed to admit; `turn_done` of an active child never wakes, `done` wakes once | M / Grok (tests pi) · after WP3–WP5 |
| **W2b** parallel/foreach | `parallel` + `join:all`, `foreach` manifest, `index.json`, group stop intent | partial completion recovery (one member settled, one not); empty and oversized manifests; member failure cancels and settles siblings before the container routes; concurrency vs `maxParallel` with command groups | S / Grok (tests pi) · after W2a |
| **W2c** Jev step | the §5.4 adapter | fake Jev host: same key across restart with no second send; every JEV1 state mapped; `needs_human` blocks and `hud_respond` is refused; Jev wake consumed, run wakes once; cancel closes observation | S / Grok · after J4, J5a, J5b |
| **W3** tools, CLI, skill | the five tools in `hud-tools.ts`, F6 transitive, `hud_list.workflows`, `hud workflow save/list/show`, Pi child `ask_orchestrator{default}`, `hud-delegate/SKILL.md` section (worktree recipe, plan → confirm → start, when a workflow beats `hud_create`) | plan writes `proposed` and starts nothing; `start` of a user workflow resolving a project agent → `confirmation_required{sources}`; all-user one-call start; child mode exposes no `workflow_*` tool | S / Grok + pi · after W2a |
| **C1** cache | P6, usage extraction per adapter with `scope`, normalisation, `CacheEstimate`, config with `basis`, badge + Inspector line (with W4) | fixtures per harness → `observed` with the right denominator; `ttl: null` with known hits → `unknown`; compaction → `unknown`; resume → `unknown`; `expiring → expired` at render time; `byModel` beats provider; a 4-minute response does not refresh age at completion | S / Grok (tests pi) · after P6, independent of W2 |
| **W4** TUI | `ChildrenCollector` nests by `workflow.run`, run node and stages (§9), one row per child, Inspector sections, `proposed`/`waiting` rendering, attention/notice keying, i18n | visual tests 32/40/48/56, EN/ZH; a reused child is one row; quiet **and** changed ticks measured with a run record present (one filesystem call per quiet tick still holds) | S / frontend-implementer · after WP7 |
| **W5** real clients (in WP12) | the fixture with a pi implementer and a Codex (`codex2`, `gpt-6-luna` medium) reviewer from each of the three parents, plus one Claude workflow child; one `default`-answered question; one host kill mid-review and restart | one completion notification per run (plus `blocked` when asked); every child group gone within `closeTimeoutMs` after `done`; `workflow_status` matches the records; restart continues only the interrupted instance | S / owner + pi · with WP12 |

Order: W1 (from WP2a) → W1b (with WP2a/WP4) → W2a (after WP5) → W2b → W3 → (W4 after WP7) → W5 with WP12; W2c after
J4/J5a/J5b; C1 after P6. W6 (script step) is not scheduled; it is a separate decision after W5.

## 13. Decisions

Owner, 2026-11-07, unchanged: **F1** TOML on disk, JSON inline, one loader · **F2** declarative graph now, script step
deferred to W6 and decided after W5's real runs · **F3** `wake` default, per-step `default`, approvals always wake (the
example sets `default` on the reviewer) · **F4** caller-managed worktree, the host records `base` and never runs git,
`isolation = "worktree"` reserved · **F5** 2 h per agent instance, configurable, `on.timeout` edge · **F6** project +
inline need `plan` → `confirmed` by default, `workflows.confirm` in config.

Decided in revision 2 (design, no owner fork): durable instances with tagged work references, serialised transitions,
single settlement, persisted stop intent and causes, absolute deadlines, the recovery table (§5); the frozen bundle
(§1, §4); the composition contract, `join:all` only, total routing, the counted-edge loop rule (§2); verdicts required
for every agent step, the question protocol and the engine-resolved responder (§3, §6); Jev steps gated on W2c with the
five rules (§5.4); `reuse` = continuation with identical resolved agent, cache advisory, `reuse_if` withdrawn (§8.3);
one wake ordering and dispatch-time admission (§6, §5.2); one row per child (§9); W2 split (§12).

**F7 (new): project agents inside user workflows.** (a) F6 transitive as written: a user-level workflow that resolves
a project agent needs `plan` → `confirmed` in that repo (one extra call, zero new config); (b) user-level workflows
resolve user agents only (one-call start kept, but a repo cannot customise a role for the owner's own workflows); (c) a
per-repo trust entry in `config.json` restoring the one-call start after one confirmation. **Recommendation: (a) now**,
(c) only if the extra confirmation grates in real use; the doc proceeds with (a).

## 14. Review response (Pro, revision 1 → 2)

Each finding was checked against the cited lines before the change; all eight hold, and §13 lists what changed.
Evidence: P1-1, P1-3, P1-4, P1-6, P2-2, P2-4 and the example defects are visible in the revision-1 text (`start` under
`[params]`, optional verdicts with `hud_send` refused, `request` absent from the suppression list, two rows for one
reused child, a counted edge with a non-terminal `else`, `reuse_if`); `src/managed/host.ts:257` throws
`native_request_not_pending` for anything outside the native pending map, hence the engine-resolved request (§6); v2.2
§6.2 (`native-hud-v2.md:964`) persists no environment, hence recapture on resume; JEV1 §4.5 derives the key from
provider, label and prompt digest and §4.8 wakes on every terminal state, hence the per-instance label and wake
consumption of §5.4. P2-1 code points confirmed (`codex/index.ts:303-315` cumulative `token_count`;
`managed-adapter.ts:310-318` raw `turn/completed`; `pi/projection.ts:139-140` separate provider); one nuance: revision
1's Pi field names `input/cacheRead/cacheWrite` do stand (`projection.ts:168-186`), only the provider derivation and
the shared denominator were wrong. Pro's two documentation claims (Anthropic lifetime from request start; OpenAI
30-minute default on GPT-5.6+) could not be verified here (no browser) and are adopted conservatively, so nothing
depends on them. Two findings are answered differently from Pro's proposal: the Pi `default` need not cross the
dialog — the tool call's arguments are in the rpc stream and `rpc-adapter.ts:96-127` relays the full record, so
pairing gives provenance and the default (P7 gates it); and the Claude waiter needs no new capability
(`src/cli/run-wait.ts:63` accepts `--timeout-ms`). Adopted in a stronger shape: terminal `else` became the
counted-edge DAG rule, which also answers the SCC objection; capacity shortage waits (`admissionWaitMs`) then fails.
