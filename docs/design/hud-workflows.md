# HUD workflows: fixed and ad-hoc topologies of custom agents, run by the host

Design decision document WF1, revision 1 (2026-11-07, design oracle), companion to `native-hud-v2.md` (v2.2) and
`jev-in-hud.md` (JEV1 v4). It answers the owner's request of 2026-11-07: a main session (Claude Code, Codex or Pi)
starts a named workflow once; the HUD host runs a fixed topology of custom agents (implementer → reviewer and/or
tester → fix loop → done), advances between steps itself and wakes the main session only at the end or when
something needs it. Two additions arrived during drafting and are decided here too: workflows designable on the spot
(§4) and a prompt-cache warmth estimate for every child (§8). v2.2 and JEV1 stand; §8.5 lists the exact additions to
v2.2 types for folding into `native-hud-v2.md` later. Examples are synthetic; paths are relative to `~/.hud` or the repo.

The thesis in four lines:

1. **A workflow is a declared graph, not a program.** Steps, edges, verdict tokens, round caps, parallel groups and
   bounded fan-out are data the host validates before anything runs; the plan the owner confirms is exactly the plan
   that executes, resume is a position in the graph, and the TUI draws it without running it (§2, §4).
2. **Workflow agents are ordinary depth-one children of the main session.** The host creates them through the same
   `hud_create` path, with the same child mode, records, requests, idle policy and close ladder (§5, §7). Nothing
   nests: the engine is a sibling-launcher, never a child that launches children.
3. **A step ends with a file, not a tool.** The agent writes `verdict.json` in its step directory; the host reads it
   on `turn_done`. No HUD tool enters a child; the owner's `report.md` / `review.md` practice becomes the contract (§3).
4. **Fewer wakes by construction.** Child-level wakes are suppressed inside a run; the run wakes the parent on its
   own terminal and blocking events only (§6). A typical implement → review → fix → re-review run wakes once.

## 0. Fixed inputs, restated as constraints

| Fixed input (concept §15, v2.2, JEV1) | What it pins here |
|---|---|
| One level of MCP delegation; children get no HUD tools | workflow children carry `HUD_CHILD`; `workflow_*` tools are parent-only; a child cannot start a run (§7) |
| Non-interference: children run on the user's own harness configuration | agent definitions carry no permission, tool or MCP settings for Codex/Claude; the role reaches the agent as the first prompt and a file, never as a system-prompt flag or `-c` (§1) |
| Pi is the customisable exception | Pi agents name a pi-roles role; the host passes `--role`, `--allow-write <step dir>` and the owner's extra args (§1) |
| Child requests are answered by the main session through `hud_respond`; 1 h re-wake, 2 h abandon | the default request policy; a workflow may opt a step into `default`/`fail` (§6) |
| Lightweight, fast, few processes, clear visualisation; bounded lifecycles; one tree, no grouping by backend | no script sandbox process in v1 (§4); one record per run read through the owner's stamp, the run a node under the root with its agents as children (§9); every spawned thing has a deadline and a ladder (§5) |

## 1. Custom agents: definitions

**Format.** Markdown with a flat YAML-subset frontmatter (scalars and one-line JSON arrays; a ≤ 40-line reader, no
YAML dependency), body = the role prompt. The same shape as Claude Code's `.claude/agents/*.md` and the owner's
pi-roles `roles/*.md`, so the mental model and the files transfer. HUD never reads or writes a harness's own agent
directories.

```md
---
name: reviewer                  # [a-z0-9][a-z0-9-]{0,31}; the step's child is named after the step, not the agent
harness: codex                  # codex | claude | pi
model: gpt-6.1-sol              # → hud_create.model; absent = the harness's configured default
effort: high                    # → hud_create.effort
pi_role: reviewer               # pi only: pi-roles role name; model/effort above override it (--model/--thinking)
pi_args: ["-e", "<roles package path>"]   # pi only; appended to hud_create.options.args; `~` expanded
writes: step                    # step (default; pi: --allow-write <step dir>/*) | tree (may edit the working tree)
description: Independent read-only review of a diff against a brief.
---
You review a change for an orchestrator… (role text; the trailer the host appends names the brief, report and verdict paths)
```

Rejected keys: anything that selects tools, permission modes, MCP servers or system prompts for Codex/Claude
(`invalid_definition{non_interference}`); `cwd` (a run parameter, §2). `writes: tree` is documentation for the plan
and the role text; it is enforced only on Pi (the pi-roles guard). Codex/Claude children write whatever the user's
permission mode lets them write, as in any delegation.

**Location and precedence.** User: `~/.hud/agents/<name>.md`, `~/.hud/workflows/<name>.toml`. Project: `<git root of
cwd>/.hud/agents/`, `/.hud/workflows/` (committable, synthetic). Project shadows user by name; the plan names the
source of every definition; a definition that fails validation is listed with its error and cannot start. **How a
Codex or Claude agent gets its role:** the host copies the body to `<run>/<step>/role.md` and sends turn 1 as `<step
prompt>` + a fixed trailer ("Your role: `<role.md>`. Brief: `<brief>`. Write your report to `<report.md>` and end by
writing `<verdict.json>`"). One prompt, no flags. A Pi agent gets the role through `--role` and the same trailer.

## 2. Workflows: definitions

**Format: TOML** (`@iarna/toml` is already a dependency; comments, dotted keys and inline tables read well as a
graph). Inline definitions (§4) use the same schema as JSON; the normalised form stored on a run record is JSON.

```toml
name = "impl-review"
[params]
brief = { kind = "file", required = true }     # copied into <run>/brief.md; {brief} resolves to the copy
check = { kind = "string", default = "npm test" }
start = "implement"

[steps.implement]
agent = "implementer"                       # a §1 definition; child = fresh unless `reuse` is set
prompt = "Read {brief} and do exactly what it asks in {cwd}. Base commit {base}."
on.done = "check"
on.failed = "end:failed"

[steps.check]                               # a host-run command: the cheapest "tester"
run = "{check}"                             # sh -c in {cwd}, captured env, own process group, ≤ 20m default
on.pass = "review"
on.fail = { to = "fix", max = 2, else = "end:needs_owner" }

[steps.review]
agent = "reviewer"                          # a fresh child every round: one review per change, fresh eyes
prompt = "Review the uncommitted diff in {cwd} against {brief} (base {base}). Implementer report: {report:implement}."
verdicts = ["accept", "reject"]             # verdict.json required; any other token → failed{unknown_verdict}
on.accept = "end:done"
on.reject = { to = "fix", max = 2, else = "end:needs_owner" }

[steps.fix]
agent = "implementer"
reuse = "implement"                         # same child as step `implement` (warm context); reuse_if = "always" | "warm" (§8)
prompt = "Address every finding in {report:review}. Round {round}."
on.done = "check"
on.failed = "end:failed"
```

| Element | Rule |
|---|---|
| step kinds | `agent` (one child, one turn per instance), `run` (host command → `pass`/`fail` by exit code, stdout lines available as `{lines:<step>}`), `jev` (`jev = { provider, label, prompt_file }` → `answered` / `incomplete` / `needs_human`; answer file `{answer:<step>}`), `parallel = ["a","b"]` with `join = "all" \| "any"` and `accept_when = ["accept","pass","done"]` (default) |
| edges | `on.<token> = "<step>" \| "end:<outcome>"`, or `{ to, max, else }`; `max` counts traversals of that edge in the run (≤ 5); `on.failed`, `on.lost`, `on.timeout` optional, default `end:failed`; `end:needs_owner` is the "ask the owner" outcome |
| verdicts | `verdicts = [...]` requires `verdict.json`; absent → `done` on `turn_done{completed}`, `failed` otherwise |
| budget | `[budget] max_turns` (hud_create + hud_send across the run; default 24, cap 48), `step_deadline` (default 2h), `run_deadline` (default 8h) |
| fan-out | `foreach = "{lines:<step>}"` on an `agent` step runs one child per item (`max_items` ≤ 16, default 8; `concurrency` ≤ `workflows.maxParallel`); item in `{item}`; the step's verdict is `accept` iff every item's verdict is in `accept_when`, else `reject`; per-item artefacts under `<step>-<n>/<i>/` |
| reuse | `reuse = "<step>"` sends the instance as a new turn to that step's child (resumed through `hud_create{resume}` if idle-closed); `reuse_if` per §8.3 |
| placeholders | `{cwd} {base} {run} {step} {round} {item} {brief} {<param>} {report:<step>} {verdict:<step>} {answer:<step>} {lines:<step>}`; a `:<step>` reference resolves to the newest instance; unresolved → `invalid_definition`; values are file paths or short strings, never file contents |
| validation (static) | unknown step/agent/param; unreachable step; edge token not in `verdicts`; `max` without `else` on a cycle; `reuse` of a non-agent step or across harnesses; `parallel` member with `reuse`; a cycle without a `max` somewhere on it; `foreach` inside `parallel`; budget over caps; non-interference keys |

The validator also derives the **plan**: steps in topological order with cycles marked, agents with harness·model·
effort, an upper bound on agent turns (sum over edges of `max`+1, capped by `max_turns`) and on children, the commands
`run` steps will execute, and which definitions come from the project. The plan is what the owner confirms.

## 3. Step outcomes and artefacts

**Run directory** `~/.hud/workflows/<ownerKey>/<runId>/` (0700; the record is `<runId>.json` beside it): `brief.md`
(copy), `definition.json` (normalised), `<step>[-<n>]/{prompt.md, role.md, report.md, verdict.json, output.txt}`.
Artefacts live outside the working tree so a reviewer's `git diff` is never polluted and a run can be inspected later.

**Verdict file** `<step dir>/verdict.json`: `{ "verdict": "<token>", "summary": "<≤ 600>", "details"?: <≤ 8 KiB>,
"question"?: { "text", "options"?: [...], "default"?: "…" } }`. On `turn_done{completed}` the host reads it: token →
edge; missing while required → **one** nudge turn (`hud_send`: "Finish by writing <path>") → still missing →
`failed{no_verdict}`; `verdict: "question"` → a request (§6) answered by `hud_send` of the answer text, the step
continues. `turn_done{failed | interrupted}` → `failed{child_failed}`; `lost` → `on.lost`. A `run` step's outcome is
its exit code; `output.txt` keeps head+tail ≤ 64 KiB. Why a file and not a tool: children have no HUD tool table (v2.2
§1.4, decided), a tool would reopen that boundary for one call, and the file is also the artefact the next step reads.
Rejected: parsing the final message for `VERDICT:` lines (fragile across three harnesses' final-message shaping).

## 4. Ad-hoc workflows: designed on the spot

The owner describes a flow in words; the main session (any harness) produces something the host runs. Three
mechanisms were evaluated against prior art (§11):

| | (a) sandboxed script (Claude Code `Workflow`, ZCode `CreateWorkflow`) | (b) declarative graph generated on the fly | (c) graph + small expression hooks |
|---|---|---|---|
| what the owner confirms | metadata the script *declares* (name, phases); the real topology is known only at run time unless a TS compiler + analyser derives it (ZCode: ≈ 25k lines) | the exact graph; plan derived by the validator for free | same as (b) |
| safety | needs a curated `vm` realm in a child process, banned non-determinism, a wire protocol, stall detection, memory caps (ZCode `child-source.ts`) | no code runs; bounds are structural (`max`, `max_items`, budgets) | expressions need a parser and an evaluator; bounds still structural |
| resume after host restart | journal + replay of the settle order; requires byte-identical, deterministic scripts (ZCode `ScriptHashMismatch`, Claude's `Date.now` ban) | position in the graph + counters + artefacts on disk | same as (b) |
| expressiveness | any computation between steps: dynamic fan-out, computed prompts, loops on data | fixed topologies, bounded loops, `foreach` over a produced list, parallel/join | adds `when = "round < 3 && verdict == 'reject'"`-style routing |
| TUI | nodes appear as the script runs | the whole graph before it runs; current position | same as (b) |
| cost in this host | ≈ 1.2k lines (cell bootstrap, NDJSON bridge, journal, bans, tests) + one `node` process per run | ≈ 1.1k lines, no process | (b) + ≈ 300 lines |

**Decision: (b), with structured conditions standing in for expressions** — the edge table (`on.<token>`,
`{to,max,else}`, `join`, `accept_when`, `foreach`) *is* the expression language, so nothing is parsed or evaluated at
run time and every bound is visible in the plan. The main session writes the TOML/JSON (an LLM writes a 30-line graph
reliably, and validation errors come back as `L:C message` lines for a retry, as ZCode does for scripts). Where a flow
needs real computation between steps, the main session runs the computation itself and starts the next run: it is
awake at those moments anyway. A script step kind (`script = "…"`, ZCode-style cell) is **deferred (W6)** and only if
real runs hit the expressiveness wall; §11 pins what to port so it can be added without changing the model. The
engine's state is `{ step instance, edge counters, turn count, artefacts }`, rewritten on every transition; no clock or
randomness enters routing, the only external inputs are verdict tokens and exit codes, which are on disk, and a
restarted host never redoes a completed instance (§5).

**Lifecycle of an ad-hoc run.** `workflow_plan{ definition | workflow, params, cwd }` validates, writes a run record in
state `proposed` (the TUI shows the planned graph under the root, dim) and returns `{ run, plan, toml }`; the main
session shows the plan to the owner through its own UI and, on the owner's yes, calls `workflow_start{ run,
confirmed: true }`. `confirmed` carries the same wording as JEV1's `confirm_resend`: it may come only from the user's
explicit decision. Named **user-level** definitions start in one call (`workflow_start{ workflow, params, cwd }`): the
owner wrote them. **Project-level** and **inline** definitions always go through `plan` (a project file may come from a
public clone; Grok Build gates project hooks on folder trust for the same reason). `workflows.confirm =
"project+inline" (default) | "always" | "never"`. A `proposed` run not started within 1 h is deleted.

**Saving.** `hud workflow save <run> <name> [--project]` writes `definition.json` back as TOML into the user or project
directory; `hud workflow list|show <name>` complete the CLI. Saving is the owner's decision, so it is a CLI, not a tool.

## 5. Execution in the host

**Run record** `~/.hud/workflows/<ownerKey>/<runId>.json` (0600, covered by the owner's stamp like Jev job files):

```ts
export interface WorkflowRun {
  run: string; owner: Owner; createdBy: string;            // 'w-3f2a9c'; the attachment that planned/started it
  name: string; source: 'user' | 'project' | 'inline'; definition: WorkflowDefinition;   // normalised; immutable per run
  params: Record<string, string>; cwd: string; base: { sha: string; branch: string | null; dirty: boolean } | null;
  state: 'proposed' | 'running' | 'blocked' | 'done' | 'failed' | 'needs_owner' | 'cancelled' | 'interrupted';
  outcome: string | null;                                   // the `end:<outcome>` reached, or the failure code
  current: Array<{ step: string; n: number; child: string | null; startedAt: number; deadlineAt: number }>;  // > 1 only in parallel/foreach
  steps: Array<{ step: string; n: number; child: string | null; startedAt: number; endedAt: number | null;
                 result: string | null /* token, pass/fail, done, failed{code} */; summary: string /* ≤ 300 */ }>;
  edges: Record<string, number>; turns: number; children: string[];   // 'review.reject' → 2; every child the run created
  requests: Array<{ child: string; requestId: string; policy: 'wake' | 'default' | 'fail'; since: number }>;
  hostGeneration: string; seq: number; createdAt: number; lastEventAt: number; endedAt?: number; wake: WakeBinding;
}
```

**State machine.** `proposed → running` (start) → `blocked` while a request waits for the main session (§6) → back to
`running` → terminal `done | failed | needs_owner | cancelled`. `interrupted` is set at host boot for a run whose
`hostGeneration` is not the live host's and that was `running`/`blocked`: its live children are `lost` and swept by the
v2.2 crash sweep; `workflow_start{ run }` on an `interrupted` run restarts **the current step instances only**: a child
with a recorded `nativeRef` is resumed (`hud_create{resume}`) and re-prompted with "the host was interrupted; continue
the step", otherwise a fresh child runs the instance; completed instances keep their results.

**Children.** Each `agent` instance is a `hud_create` under the main session's owner with `name = "<step>"`
(`"<step>#<n>"` on later rounds), `model`/`effort` from the definition, the captured environment of the attachment that
started the run, cwd = the run's cwd, and two extra record fields `createdBy: 'workflow:<run>'` and `workflow: { run,
step, n }`. While the run is live, `hud_send`, `hud_cancel`, `hud_close` and `hud_create{resume}` on such a child answer
`workflow_owned{run}`; `hud_read`, `hud_wait` and `hud_respond` work as usual. A child stays open while any step
reachable from the current position names it in `reuse`; otherwise the host closes it through the ladder when its
instance ends; all children are closed at run end. The 30-min quiescent idle close remains a backstop: a `reuse` of an
idle-closed child resumes its native session (v2.2 §6.1.4 keeps it resumable).

**Limits (`config.json workflows`).** `maxRuns` 2 live per owner (`limit_exceeded`); `maxParallel` 4 children at once
per run; children count toward v2.2's `maxChildren` (8 per owner, 24 per host) and a plan that could exceed them is
refused at `plan`; `max_turns` default 24, cap 48; `stepDeadlineMs` 2 h (the child is interrupted with `hud_cancel`
semantics → `failed{timeout}` → `on.timeout`); `run` steps 20 min default, 2 h cap; `runDeadlineMs` 8 h →
`failed{run_timeout}`. v2.2's "no turn deadline by default" stays for interactive delegation; a workflow runs
unattended, so it has one (fork F5, §13). **Cancellation.** `workflow_cancel{run}`: `hud_cancel` on running children,
the close ladder on all, state `cancelled`, artefacts kept, no wake (the caller asked); a `proposed` run is deleted.

**Isolation (decided: caller-managed).** `cwd` is a parameter; the host records `base = git rev-parse HEAD`, the
branch and whether the tree was dirty, and never runs `git worktree add/remove`. The skill's recipe: `git worktree add
<path> -b hud/<name>` then `workflow_start{cwd: <path>}`; merging and removing are the main session's decisions at the
end, when it is awake anyway (the owner's rule "commit WIP before removing worktrees" is a judgement HUD must not make).
Host-managed worktrees (`isolation = "worktree"` as in Claude's `Workflow` and Grok Build) are reserved behind the same
key (fork F4, §13). Run directories are kept; `workflows.keepRuns` (20 per owner) prunes terminal runs oldest-first.

| Thing (extends v2.2 §6.1.1) | Started by | Retained by | Ends when |
|---|---|---|---|
| workflow run (an async task in the host, no process) | `workflow_start` | a retained handle while `running`/`blocked` | terminal state; `interrupted` at host boot |
| workflow child | the engine, via the ordinary child path | as any child | instance end and no reachable `reuse`; run end; idle/abandon policies; the ladder on every path |
| `run` step command | the engine; `sh -c`, `detached: true`, own group, stdio captured | — | exit; deadline → SIGTERM group 5 s → SIGKILL; swept by group like children. A Jev step is a `jev_ask` under the owner with JEV1's own rules |

## 6. Requests, who answers, and when the main session wakes

Every child request (approval, question, Pi `ask_orchestrator`, verdict-file `question`, Jev `needs_human`) reaches
the engine first. Per step, `requests = "wake" | "default" | "fail"`:

| Policy | Behaviour |
|---|---|
| `wake` (default, the v2.2 decision) | the run goes `blocked`; one wake line to the main session; it answers with `hud_respond` (the engine answers a verdict-file question by `hud_send`); v2.2's `request_stale` (1 h) and `abandoned` (2 h) apply and end the step as `failed{abandoned}` |
| `default` | if the request carries a default (verdict-file `question.default`; Pi `ask_orchestrator{default}`, an additive parameter the HUD Pi package gains in child mode, §8.5), the engine answers it at once and records `{question, default}` on the step; otherwise `wake` |
| `fail` | the request is withdrawn through the harness's cancel path and the instance ends `failed{asked}` → `on.failed` |

Approvals (`exec_approval`, `patch_approval`, `tool_permission`) always follow `wake`: the engine never grants
permissions. A designated *agent* answerer (another child that answers questions) is rejected for v1: another process
and context per question, unverified answer quality, and the owner's practice shows 0–2 questions per task, which
`default` absorbs when the brief states defaults; revisit after W5's real runs.

**Wake-worthy run events** (`WorkflowEvent{type:'workflow', run, kind, step?, result?}` in the same ring as child
events): `done`, `failed`, `needs_owner`, `interrupted`, `blocked` (one per request), plus the child's own
`request_stale` and `closed{abandoned}`. **Suppressed** for children with `workflow != null`: `turn_done`, `exit`,
`error`, `lost`, `closed` (they become step results). `step_done` is published for `hud_wait` but never wakes. Line:
`[hud] workflow impl-review (w-3f2a) done · accept after 2 rounds · 48m · workflow_status{run:"w-3f2a"}` (today's
herdr practice wakes the orchestrator 4–6 times per task; the §2 example wakes once).

## 7. The one-level rule and non-interference

Workflow children are the main session's depth-one children: `HUD_CHILD` set, empty tool table, direct calls refused,
active-child index guarding the host. `workflow_*` tools are in the parent table only. A child cannot start, plan or
cancel a run. A workflow agent's native subagents (Codex `spawn_agent`, Claude Agent tool) are untouched and shown
read-only under its node. HUD does not install hooks, personas or agent files into any harness. One consequence for
authors: a Codex implementer that spawns its own native reviewer plus a workflow `review` step is two reviews of one
change; the role text should tell it not to (the owner's "one review per change"), and the plan shows both.

## 8. Prompt-cache warmth of a child

### 8.1 Evidence the host has

| Harness | Provider | Usage evidence per turn | Invalidation evidence | TTL source |
|---|---|---|---|---|
| Codex | `openai` by default (`cache.providerByHarness` overrides) | `turn/completed` usage: `input_tokens`, `cached_input_tokens`, `output_tokens` (the shape the native reader already parses from rollouts, `src/harness/codex/index.ts`); WP4 extracts it into `turn_done.usage` | a compaction notification if the pinned app-server emits one (probe P6), else the context meter dropping by > 30 % between turns | `cache.ttlMs.openai` |
| Claude | `anthropic` | SDK `result.usage`: `cache_read_input_tokens`, `cache_creation_input_tokens`, `input_tokens` | `compact_boundary` system message (the reader keys on it, `src/harness/claude/reader.ts`) | `cache.ttlMs.anthropic` |
| Pi | `<provider>/<model>` prefix of the model id (`mistral/…`, `openai/…`, `anthropic/…`, `deepseek/…`, `zai/…`) | `message_end` usage `cacheRead`, `cacheWrite`, `input` (already projected in `src/harness/pi/projection.ts`) | a compaction event on the rpc stream if pi emits one (P6), else the meter drop | `cache.ttlMs.<provider>` |

`lastRequestAt` = the time of the last model request the host can see: `outcome.endedAt` after a turn, else the latest
`message`/`tool` event during one (every tool result is followed by a request). TTLs are sliding on every provider that
documents them, so the last request is the right base.

### 8.2 Estimate

```ts
export interface CacheEstimate {
  state: 'warm' | 'expiring' | 'expired' | 'cold' | 'unknown';
  provider: string | null; ttlMs: number | null;
  lastRequestAt: number | null; expiresAt: number | null;      // lastRequestAt + ttlMs
  lastHit: { cachedTokens: number; inputTokens: number; ratio: number } | null;   // from the last turn's usage
  basis: Array<'ttl' | 'usage' | 'compaction' | 'no_turn' | 'no_ttl'>;
}
```

`cold` until the first `turn_done` and after a compaction (`basis: compaction`); `unknown` when the provider has no
TTL (`basis: no_ttl`) and no usage; otherwise by clock: `expired` past `expiresAt`, `expiring` within
`max(cache.expiringMs 60 s, 20 % of ttl)`, else `warm`. `lastHit` is evidence shown beside the estimate, not an input
to it (a low ratio after a `warm` estimate tells the owner the TTL is wrong; the Inspector says so). Computed by the
host on each record write and by the TUI at render time from `lastRequestAt`/`ttlMs` (so `expiring → expired` ticks
without a write). **Config (`config.json cache`), defaults stated as unverified:** `ttlMs: { openai: 300000,
anthropic: 300000, deepseek: null, mistral: null, zai: null, default: null }` — OpenAI documents 5–10 min of inactivity
(up to 1 h off-peak), Anthropic 5 min (1 h with the extended TTL); the others are not documented to the author's
knowledge and stay `unknown` until the owner sets them; `byModel: {}` (exact model id → ms, wins over provider);
`providerByHarness: { codex: 'openai', claude: 'anthropic' }`; `expiringMs: 60000`; `unknownAs: 'warm' | 'cold'`
(default `warm`: a fresh child costs 7–15 s of startup and the step's context; the owner sets a TTL for strict providers).

### 8.3 Use in a workflow

`reuse_if = "always"` (default) | `"warm"`: reuse when the estimate is `warm` or `expiring`, start a fresh child of
the same agent when `expired` or `cold`, and treat `unknown` per `cache.unknownAs`. The step instance records
`reuse: 'reused' | 'fresh:cache_expired' | 'fresh:cache_cold' | 'fresh:unknown'`. The main session gets the same
estimate on `hud_read{what:'status'}` and `hud_list` and applies the same rule by hand for ordinary delegation.

### 8.4 TUI

A card setting **Cache** (Settings → Cards → Cache, default off) adds a badge after `model·effort`: `♨ 4m` (warm,
time left; U+2668), `♨ <1m` in the warning colour (expiring), `♨ cold` muted (expired/cold); hidden when `unknown` or
the setting is off. Compact rows show the glyph and time only; the Inspector shows one line always: `cache: warm · 4m
left · last turn 92 % cached · openai 5m TTL (config)`. Bar and statusline show nothing. The information-design doc
owns the final glyph and placement; this is the proposal.

### 8.5 Exact additions v2.2 needs (to fold into `native-hud-v2.md`)

| Where | Addition |
|---|---|
| §2.8 `ChildRecord` | `cache?: CacheEstimate`; `usage` gains `cachedInputTokens?`, `cacheWriteTokens?`; `createdBy` may be `'workflow:<run>'`; `workflow?: { run: string; step: string; n: number }` |
| §2.8 `ChildEvent` | `turn_done.usage` carries the two cache fields; new `{ type: 'compaction' }`; new `{ type: 'workflow'; run; kind; step?; result? }` |
| §2.2 `SubagentTreeNode` | `cache?: CacheEstimate` (fifth additive field); `workflow?: { run; step; n }` |
| §1.5 `config.json` | `cache: {…}` (§8.2), `workflows: { maxRuns, maxParallel, stepDeadlineMs, runDeadlineMs, keepRuns, confirm }` |
| §3.1 / §3.3 | the HUD Pi package's child `ask_orchestrator` gains `default?: string`; `HudRequest` Pi kinds gain `default?` |
| §5.1 | wake list gains the §6 workflow events; children with `workflow != null` are excluded from child-level wakes |
| §7.2 | probe **P6**: whether the pinned app-server, SDK stream and pi rpc emit compaction events and per-turn usage with cache fields (3 trials each, shapes recorded) |
| Appendix B | `hud_create` returns `cache: { state: 'cold' }`; `hud_read{what:'context'}` includes the cache fields; mutations on a workflow-owned child → `workflow_owned`; the five `workflow_*` tools (§10); `hud_list` gains `workflows: WorkflowRunSummary[]` |

## 9. TUI

One node per run under the root, its agents as children (they are the child records, nested by `workflow.run`),
their native subagents below (depth 3; the information-design depth cap is 4). No separate pane, no grouping.

```
├─ ▸ ⟳ impl-review · review#2 · round 2/2 · 4 turns · 48m          (status from run.state; glyph proposal ⟳)
│  ├─ ✓ π implement      flash·max   12m  "4 files, tests green"
│  ├─ ✓ ⌬ review         sol·high     4m  reject · 2 findings
│  ├─ ✓ π fix            flash·max    3m  ♨ 3m   (reused: implement)
│  └─ ▸ ⌬ review#2       sol·high     1m
│     └─ native subagent …
```

| Surface | What |
|---|---|
| run node line | status marker from `state` (`proposed` → dim marker with the word *planned*; `running` ▸; `blocked` ⚑ with the request line; `needs_owner`/`failed`/`interrupted` ✗ kept until put away by hand; `done` ✓ and the linger), `⟳`, name, current step(s), `round i/max` when on a counted edge, turn count, clock |
| run node stages | `steps[]` → `stages[]`: one per instance with its result token (`reject · 2 findings`), so the Timeline shows the path taken; `run` steps appear as stages with `pass`/`fail` and the command head |
| step child nodes | the ordinary child card/row; `name` = step; `(reused: implement)` under the name when `reuse` applied; the `♨` badge (§8.4) when the setting is on |
| Inspector (run) | the plan as an indented list with the current position marked, edge counters, budget used/limit, deadlines, `base` sha and dirty flag, the run directory path under `▾ More`, and the fixed note "read-only: the host drives this run; `workflow_cancel` stops it" |
| bar / statusline / Pi footer | existing `agentCounts` include the run node and its children; the attention badge ranks `blocked` with pending approvals; completion notices key on the run's terminal event, not on each child's turn |
| `proposed` runs | drawn from the record's plan before any child exists, so the owner sees the graph being confirmed; deleted on cancel or after 1 h |

## 10. Tool surface (parent table only; empty in a child)

| Tool | Arguments | Returns | Notes |
|---|---|---|---|
| `workflow_list` | `{ what?: 'definitions' \| 'runs' }` | definitions `{ name, source, description, params, valid, error? }[]`, runs `WorkflowRunSummary[]` (≤ 50) | read-only; from files and records; never starts a host |
| `workflow_plan` | `{ workflow?: string, definition?: object, params?: Record<string,string>, cwd: string }` | `{ run, plan, toml, warnings[] }` or `invalid_definition{ errors: 'L:C message'[] }` | validates; writes a `proposed` record; starts the host if needed |
| `workflow_start` | `{ workflow?, params?, cwd? } \| { run, confirmed?: true }` | `{ run, seq, wake }` | one-call start for user-level named definitions; `run` form starts a `proposed` run (`confirmed:true` required for project/inline per `workflows.confirm`) or restarts an `interrupted` one; `confirmation_required`, `limit_exceeded`, `run_not_found` |
| `workflow_status` | `{ run }` | the `WorkflowRun` with heads trimmed (≤ 4 KiB) | passive |
| `workflow_cancel` | `{ run }` | `{ ok, children: closeResult[] }` | §5 |
| CLI | `hud workflow list \| show <name> \| save <run> <name> [--project]` | — | owner-facing; `save` serialises `definition.json` to TOML |

New error codes: `invalid_definition`, `confirmation_required`, `workflow_owned`, `run_not_found`. `hud_list` gains
`workflows: WorkflowRunSummary[]` (`{ run, name, state, current, turns, startedAt, endedAt? }`).

## 11. Prior art and what is taken from it

Read on 2026-11-07 from shallow clones (Apache-2.0 both; read only, nothing run or built).

| Source | What it does | Adopt | Do not adopt (and why) |
|---|---|---|---|
| **Claude Code `Workflow` tool** (the authoring reference) | JS script with `meta` literal for the permission dialog, `agent()/parallel()/pipeline()/phase()`, journal-cached resume, `Date.now`/`Math.random` banned, caps 16 concurrent / 1000 agents, `isolation:'worktree'`, custom `agentType` | the approval-before-run idea with a declared plan; caps as structural bounds; "same inputs → cached result" as our "completed instances are never redone" | the script runtime (needs a sandbox and deterministic authoring discipline; §4) |
| **ZCode dynamic workflows** (`apps/zcode-cli/packages/dynamic-workflow{,-runtime}`, ≈ 25k lines of TypeScript excluding tests and UI; `docs/dynamic-workflow*.md`) | TypeScript scripts typechecked against a facade `.d.ts`; a static analyser derives site/causality/control-flow graphs for a confirmation window (Allow / Always / Deny / Refine); the script runs in a separate `node` child (`--max-old-space-size=256`) inside a `vm.createContext` realm exposing five host functions, with `Date.now`, argless `new Date()`, `Math.random` throwing and `import()` failing; NDJSON wire protocol; journal rows per site instance; resume by replay gated on a byte-identical script hash, only `stopped` runs resume; `escalate` → `ResolveWorkflowQuestion` with no timeout; two concurrency bounds (per-run `maxConcurrency` + a shared adaptive governor per provider key); saved `<name>.dwf.ts` in project/global dirs and a hub page | the confirmation step with a timeline the owner sees **before** running (ours comes from the validator, theirs from a compiler); "a subagent asked again keeps its context; `agent()` in a loop makes a fresh one" = our `reuse`; `escalate` = our request path; per-run bound; diagnostics as `L:C message` lines the model resubmits against; **if W6 (script step) is ever built**: port the curated-realm pattern of `dynamic-workflow-runtime/src/child-source.ts` (the bootstrap: five host functions, frozen args, the three bans, `import()` without a callback) and the shape of `tests/security.test.ts` — ≈ 150 lines, with the Apache-2.0 header kept, the file and commit named in `THIRD_PARTY_NOTICES.md` (JEV1 §4.9 creates it) and the attribution lines of ZCode's `NOTICE.md` reproduced as the licence's §4(d) asks | the compiler/analyser (TypeScript as a runtime dependency, graph projection, holes, channels: heavier than the whole HUD host); journal replay with settle-order gating (our graph has explicit positions); the adaptive provider governor (HUD makes no model requests; the harnesses do). Note: we found no code that launches Claude Code, Codex, Gemini CLI or OpenCode as workers — what exists is Claude Code session import (`packages/services/src/session/claude-native/*`), Codex `config.toml` read/write (`providers/codexConfigToml.ts`) and MCP-directory compatibility (`desktop/src/main/mcpUserDirectory/*`), plus an ACP SDK dependency not examined further; so it is not prior art for cross-harness children |
| **Grok Build** (`crates/codegen/xai-grok-pager/docs/user-guide/{16-subagents,10-hooks}.md`, `xai-tool-types/src/task.rs`, `xai-grok-hooks`) | `spawn_subagent`/`task` with `subagent_type` (agent `.md` files with Claude-compatible frontmatter), `isolation: none \| worktree`, `resume_from` a completed subagent, `cwd`, `model`; personas (TOML overlays with `inputs`/`outputs` contracts, `model`, `reasoning_effort`, `default_isolation`); Claude-compatible hooks with `Stop`/`SubagentStop` decision control (block the stop until a condition holds; 8 continuations; 600 s gate timeout); project hooks gated on folder trust | the **inputs/outputs contract** idea → our placeholders and step directories make the artefact flow explicit; `resume_from` only for completed children = our `reuse` on a quiescent child; the "keep working until the check passes" gate as a **host-run `run` step routing back to the implementer** instead of a hook in the child (non-interference); folder trust → project/inline definitions need confirmation | hooks or personas injected into the user's harness (non-interference); Rust code (nothing to reuse) |

## 12. Work packages, order and tests

Nothing here touches WP0–WP2. W1 is pure and can run in parallel from WP2a on; the engine needs WP3 (lifecycle), WP4
(normalisation, requests) and WP5 (wake); the TUI piece follows WP7. Sizes as in v2.2 (S ≤ half a day, M ≤ 2 days);
Grok 4.7 high for core, pi for tests, frontend-implementer for W4, an Opus subagent reviews each package.

| WP | Content | Acceptance (node --test unless stated) | Size / who |
|---|---|---|---|
| **W1** definitions | `src/workflows/{frontmatter,agent-def,workflow-def,validate,plan,placeholders}.ts`; TOML and JSON in, normalised JSON out; the plan | every rule of the §2 validation table has a failing fixture and an `L:C` message; precedence project > user; the §2 example validates and its plan bounds turns at 9; `pi_*` on a codex agent and tool/permission keys → `invalid_definition{non_interference}`; placeholder resolution incl. the newest-instance rule | S / Grok (tests pi); from WP2a |
| **W2** engine | `src/managed/workflow-engine.ts`, run records under the stamp, child ownership (`workflow_owned`), `reuse` with resume-on-idle-closed, `run` steps with the ladder, `foreach`/`parallel`/`join`, counters, budgets, deadlines, cancel, `interrupted` + restart, wake suppression and `WorkflowEvent`, request policies, verdict read + nudge, Jev step | fake adapters + fake clock + fake process table: the §2 example runs accept-first-round, reject→fix→accept, reject×3 → `needs_owner`; `no_verdict` after one nudge; child `lost` mid-step → `on.lost`; `turn_done` of a workflow child does not wake, `done` does once; `default` answers a verdict-file question, `wake` blocks and `request_stale` still fires; `fail` withdraws; step deadline interrupts with `failed{timeout}`; `run` step killed by group at its deadline; host restart → `interrupted`, restart redoes only the current instance; `maxRuns`/`maxParallel`/`maxChildren` refusals; `reuse_if:"warm"` with an `expired` estimate starts fresh and records why; cancel closes every child via the ladder | M / Grok (tests pi); after WP5 |
| **W3** tools, CLI, skill | the five tools in `hud-tools.ts` (shared by hud-mcp and the Pi package), the `confirmed` rule, `hud_list.workflows`, `hud workflow save/list/show`, Pi child `ask_orchestrator{default}`, `integrations/skills/hud-delegate/SKILL.md` section (worktree recipe, plan → confirm → start, when to prefer a workflow over `hud_create`) | plan of an inline definition writes `proposed` and starts nothing; `start` without `confirmed` on project/inline → `confirmation_required`; user-level one-call start; `save` round-trips TOML → JSON → TOML byte-stable on the fixture; child mode exposes no `workflow_*` tool | S / Grok + pi |
| **C1** cache estimate | WP4: usage extraction per adapter incl. cache fields and compaction events (after P6); `CacheEstimate` on the record; config; TUI badge + Inspector line (with W4) | fixtures per harness → `lastHit`; clock-driven state transitions incl. render-time `expiring → expired`; compaction → `cold`; unknown provider → `unknown`; `byModel` beats provider | S / Grok (tests pi); inside WP4/WP6 |
| **W4** TUI | `ChildrenCollector` nests by `workflow.run`, run node mapping (§9), stages, Inspector sections, `proposed` rendering, attention/notice keying, i18n | visual tests 32/40/48/56, EN/ZH; a `blocked` run shows `⚑` and the request line; a `proposed` run draws the plan; exactly one filesystem call per quiet tick still holds | S / frontend-implementer (design: §9 + the information-design doc); after WP7 |
| **W5** real-client row (in WP12) | the §2 example with a pi implementer and a Codex (`codex2`, `gpt-6-luna` medium) reviewer from each of the three parents; one `default`-answered question; one host kill mid-review and restart | the parent is woken exactly once per run (plus the question when `wake`); every child group gone within `closeTimeoutMs` after `done`; `workflow_status` matches the records; restart redoes only the interrupted instance | S / owner + pi (scripts) |

Order: W1 (from WP2a) → W2 → W3 → (W4 after WP7) → W5 with WP12; C1 rides WP4 (extraction) and WP6/WP7 (display).
W6 (script step, §4/§11) is not scheduled; it is a separate decision after W5.

## 13. Decisions

Decided here: Markdown + frontmatter agents and TOML workflows (§1–§2); verdict files (§3); declarative graphs with
structured conditions for both predefined and ad-hoc runs, plan → confirm → start, CLI save (§4); caller-managed
isolation, child reuse with warm-cache gating, bounded everything (§5, §8); request policies with `wake` as default
(§6); one run node with step children (§9); five tools (§10); W1–W5 placement (§12).

The owner accepted every recommendation below on 2026-11-07; no forks remain open.

| Fork | Options | Decided (owner, 2026-11-07) |
|---|---|---|
| **F1** workflow file format | TOML (dependency present, comments, readable graphs) vs JSON only (no parser surface; matches `config.json`) | TOML on disk, JSON inline (both accepted by one loader) |
| **F2** ad-hoc mechanism | (b) graph now, script step deferred (W6) vs (a) script runtime now (ZCode-style cell, ≈ +1.2k lines, a process per run, determinism discipline) | (b) now; decide W6 after W5's real runs |
| **F3** default request policy inside a run | `wake` (v2.2's decision, every question costs a wake) vs `default` (fewer wakes, the agent's stated default is taken silently) | `wake` as default; the §2 example sets `default` on the reviewer step only; approvals always wake |
| **F4** isolation | caller-managed worktree (host records `base`, never runs git) vs host-managed `isolation = "worktree"` (one line less for the caller; the host owns git state and removal) | caller-managed in v1; key reserved |
| **F5** step deadline default | 2 h per agent instance (unattended runs end) vs none (consistent with v2.2's interactive default) | 2 h, configurable; `on.timeout` edge available |
| **F6** confirmation scope | project + inline need `plan` → `confirmed` (default) vs always vs never | default as stated; `workflows.confirm` in config |
