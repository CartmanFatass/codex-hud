# B1: real MCP call-source evidence

Date: 2026-11-01 (local probe date). **Claude Code 2.1.305's default direct stdio
profile cannot establish root-call identity synchronously from its public
transcript in these runs; it must refuse.** Codex CLI 0.166.0 supplies distinguishable
root/native-thread metadata before execution, combined with exact source/header
and physical-process evidence. Native children must be rejected, even on their
own MCP instance. No shared positive scheduling, claim handshake or distributed
context authorization is implemented by B1. No contract was changed.

Versions: Claude Code 2.1.305 (model alias `haiku`, observed Haiku 5.5, low effort),
Codex CLI 0.166.0 (`gpt-6.1-sol`, low), Node v24.22.1, Linux/WSL2. Existing A3/A8
version limits still apply. No vendor daemon was started or stopped; the measured
servers' actual parent chains are direct to the run's harness process. This does
not establish all daemon configurations or future harness stamping rules.

## Method and retained evidence

Ignored raw evidence and run scripts are in
[`tmp/tasks/B1/`](../../tmp/tasks/B1/). All projects/HUD_HOME directories were
new temporary directories. MCP configuration was command-line-only. No user
configuration, credential, session transcript, or cache was edited. Only probe-owned
sessions were inspected. MCP observations retained allowlisted fields and exact
call IDs; public examples below are synthetic replacements.

Commands used (full argv in each evidence directory's `command.json`):

```sh
python3 tmp/tasks/B1/run-source-probe.py claude <case> '<synthetic prompt>'
python3 tmp/tasks/B1/run-source-probe.py codex <case> '<synthetic prompt>'
python3 tmp/tasks/B1/tui-switch.py claude
python3 tmp/tasks/B1/tui-switch.py codex
python3 tmp/tasks/B1/run-dual.py claude
python3 tmp/tasks/B1/run-dual.py codex
python3 tmp/tasks/B1/run-skeleton.py claude
python3 tmp/tasks/B1/run-skeleton.py codex -v2
```

The scripts live in the **main checkout's** ignored task directory, while the
implementation and tests live in the B1 worktree. Claude used `-p --model haiku
--effort low --mcp-config <temporary.json> --strict-mcp-config`; Codex used
`exec --skip-git-repo-check -m gpt-6.1-sol -c model_reasoning_effort="low"` with
`-c mcp_servers.<probe>.*`. Probe-only replacement of the MCP server table was
used to reduce unrelated servers; it is absent from product code. Installed
plugin servers/hooks can still load; unrelated failures are not source evidence.
The TUI driver used owned PTYs, `/clear` or `/new`, and a deliberately delayed
3-second synthetic tool response to keep an old call in flight.

The observation server snapshots exact candidate files at tool entry and after
reply. Each read is bounded to 256 KiB; Claude considers the precise root file and
at most 32 native-child files from that probe session, not arbitrary sessions.
The optional wait experiment samples before replying at 10/25/45/100/500 ms.
The product is stricter: one 64 KiB root tail, no retry; Codex reads only the exact
rollout header, with bounded filename lookup. It never scans a complete
transcript on each call.

There were **9 Claude invocations and 8 Codex invocations**, below the 25-per-harness
cap. Three TUI attempts per harness include initial setup/submission failures;
only `*-tui-switch-v3` proves the switch scenario. First root/child runs exposed a
probe bug: pseudo-files report size zero, so the initial `/proc` helper read no
bytes; `*-root-child-v2` corrects that and supplies the physical evidence. A
16 KiB initial Codex header read also truncated the 22.5 KiB header; subsequent
reads use a bounded larger header. Neither failed helper is counted as positive
physical/header evidence. The first skeleton Codex run exposed UTC/local-date
lookup mismatch; `skeleton-codex-v2` verifies the fixed day +/-1 locator.

## Four A9 condition cases, by harness

| Harness / condition | Observed behavior and evidence | Identity result / limits |
| --- | --- | --- |
| Claude: root + native child on one MCP | `evidence/cc-root-child-v2/mcp.jsonl`: root-before/native-child/root-after share one MCP PID and verified harness PID/start. Metadata contains only `claudecode/toolUseId` and progress token. All 3 exact IDs absent at handler entry; later child record has `agentId` and `isSidechain:true`. The earlier run repeats the 3-call timing observation but has the `/proc` bug noted above. | Refuse missing root provenance. Native call never inherits root env/session/claim. A native record, when visible, must be treated as a child rather than a root switch. |
| Claude: late / duplicate / missing records | Same runs: missing-at-entry records appeared later, commonly by the +100 ms after-response sample (one by +700 ms). `wait-cc-root-child/mcp.jsonl`: 2/3 call records visible by 10 ms **before response**, third absent at 45 ms and visible by 100 ms. Hook run makes one child record visible at entry, but both root records are still absent. | Refuse missing/late records on that call. No evidence that response causes flushing. Permanent absence and duplicated exact assistant tool-use records are fault-injected in `tests/hud-mcp/skeleton.test.ts`; no natural duplicate or permanently missing transcript was observed. Tool result mentioning the ID is not a second call record. |
| Claude: same process switches with old call in flight | `claude-tui-switch-v3/{mcp.jsonl,stages.json,terminal}`: interrupt delayed old call, execute `/clear`, then call again. Harness PID/start **and MCP PID** persist; the live sessions registry/root transcript changes from synthetic session A to B. Old handler's delayed snapshots use the new registry and cannot find its old exact ID there. | Default refuses both calls without a qualified source. Never retain A just because the MCP PID is unchanged. Closing old scope/context/alias and rejecting already selected old work at commit are B2/B5 transactions, not demonstrated by the diagnostic probe. |
| Claude: old/new MCP instances connected together | `dual-claude/mcp.jsonl`: two configured stdio instances coexist under the same verified harness PID/start; both tools are called. Old-instance call is absent at entry; second call happens to have a public record at entry. | Neither is an authorized binding in B1; absent source refuses, observed source remains unsupported until ARCH accepts a profile. This proves concurrent connections, not B5's simultaneous binding transaction. |
| Codex: root + native child | `codex-root-child-v2/mcp.jsonl`: root and native child run under the **same harness PID/start**, with **different MCP PIDs**. Native metadata retains root `sessionId` but changes `threadId` and turn `thread_id`, adds `parent_thread_id`, `subagent_kind`, `thread_source:subagent`. Root's next call retains its original server and root IDs. The first run repeats metadata/topology with the initial helper limitation. | Root source can be resolved using the accepted version-limited combination. Reject native call; never project root `sessionId` into child authority. This configuration does not share a single MCP server between root and native child. Shared-positive dispatch remains unsupported; injected shared/missing metadata tests refuse. |
| Codex: late / duplicate / missing records | The exact `callId` is present in MCP metadata before execution, but no matching public call record was visible at entry; completed-item records appear later. Header is independently available before the call. `skeleton-codex-v2/trace.jsonl` reaches `not_implemented` after source/header/process resolution. | Late public call records are not needed for this narrowly tested metadata/header path. Missing/conflicting metadata, header or source refuse. Duplicate exact header paths and conflicting IDs are injected in package tests; no natural duplicate harness record was observed. No metadata-alone authorization is claimed. |
| Codex: same process switches with old call in flight | `codex-tui-switch-v3/{mcp.jsonl,stages.json,terminal}`: `/new` keeps harness PID/start, replaces MCP instance, changes session/thread IDs. A new MCP starts ~0.7 s after the old delayed call entered, before the old handler's 3-second response. `/new` timing is UI-dependent: the v2 attempt was rejected while work was still active; v3 succeeds after interruption. | Fresh metadata distinguishes new source. Old/new instances cannot coordinate generation from their local caches; B2/B5 must atomically invalidate old context and recheck in-flight operations. B1 has no executable body or bound context to which an old result could apply. |
| Codex: old/new instances connected together | The TUI overlap above plus `dual-codex/mcp.jsonl`: two configured instances share one harness and live concurrently; both receive distinct exact callIds. | Physical CallerIds differ; this does not itself change logical owner or generation. B1 source resolution is diagnostic and all bodies are stubs. Actual concurrent binding/idempotency/old-context authorization must be tested with B2/B5, not inferred from two successful connections. |

Synthetic metadata excerpt, deliberately replacing all real IDs:

```json
{
  "root": {"sessionId":"synthetic-root", "threadId":"synthetic-root",
    "x-codex-turn-metadata":{"session_id":"synthetic-root", "thread_id":"synthetic-root", "thread_source":"user"}},
  "nativeChild": {"sessionId":"synthetic-root", "threadId":"synthetic-child",
    "x-codex-turn-metadata":{"session_id":"synthetic-root", "thread_id":"synthetic-child",
      "parent_thread_id":"synthetic-root", "thread_source":"subagent", "subagent_kind":"thread_spawn"}}
}
```

## Options for ARCH — none selected or enabled

The official [Claude hooks reference](https://code.claude.com/docs/en/hooks#pretooluse)
describes synchronous PreToolUse input and agent fields. Its
[common input fields](https://code.claude.com/docs/en/hooks#common-input-fields)
warn that transcript writes may lag hook execution. The
[CLI reference](https://code.claude.com/docs/en/cli-reference) and local `claude
--help` expose no flush-before-MCP-call switch found in this investigation.
Absence from those references is not proof that no private implementation option
exists. Installed binary internals were not treated as a supported API.

| Candidate | What it could prove / measured evidence | Cost against 50 ms and unresolved boundary |
| --- | --- | --- |
| Claude synchronous PreToolUse record keyed by exact tool_use_id | `cc-hook-root-child/hooks.jsonl`: 3/3 records written before MCP entry by 10/10/11 ms. All carry session_id/tool_use_id; native child additionally carries agent_id/agent_type. **transcript_path is root even for child**, so it cannot distinguish them. | Offline Node hook subprocess p95 **61.43 ms**, max 63.58 ms over 200 synthetic invocations (`hook-performance.json`), including process launch/read/write/exit but excluding harness scheduling. MCP handler starts after hook, so a lookup can be fast while total tool latency still increases. Need private atomic exact-ID records, missing/duplicate refusal, supported root-vs-child fields, generation/currentness, hook failure policy and performance acceptance. No hook port is installed in product. |
| Claude env claim per session / dedicated physical instance | A3 and B1 show inherited env and verified sessions pid/start. | Low lookup cost, but root and native child share env and the same MCP; `/clear` keeps MCP alive. A claim and per-session label do not prove the individual logical call. Insufficient alone. A verified root-isolation profile would need new evidence/ARCH approval. |
| Claude bounded delayed exact transcript lookup | Wait experiment proves asynchronous records can appear while the handler still holds the response; 2/3 visible at 10 ms, 1/3 needs >45 ms (visible by100). | A 45 ms cap leaves almost no room within 50 ms for other work and refused 1/3 in this sample. 100/500 ms waits exceed the gate. Sampling is not a 200-call latency distribution and proves no universal flush deadline. Missing/ambiguous/oversized/rotated records still refuse; no full scan or background poller. |
| Claude caller-supplied session/claim/prompt | Demonstrates possession only. | Cannot identify root before execution. Not an identity replacement; refused. |
| Codex version-limited root metadata + verified process/source + exact header | Current root IDs agree across transport/turn fields; header and physical process cross-check. Native thread metadata is distinguishable before execution even if the root sessionId remains unchanged. | Header reads are bounded; standalone skeleton performance below. B2/B5 still need current-generation commit checks, launch evidence and binding/owner rules. Not a standalone authorization token; not accepted for unknown versions or unverified daemon/shared transport. |
| Codex native thread metadata / per-thread MCP | Child's threadId/turn thread_id can locate its own native thread rather than root. Separate physical instance alone proves nothing about root authority. | MVP answer is reject child calls and keep root generation intact. Positive native-thread/shared dispatch would expand scope and requires ARCH plus capability evidence. No projection or new supported profile was chosen. |
| Codex exact public call record or hook path | Existing public call records arrive late in these runs. | A future exact source index/hook would need its own versioned provenance, duplicate/missing policy, session-switch/currentness and measured budget. Not implemented or silently substituted for the accepted combination. |

These options go to ARCH. The default remains fail-closed, with no redesigned
identity mechanism or capability-matrix upgrade.

## Skeleton acceptance and performance

`evidence/skeleton-claude/trace.jsonl` and
`evidence/skeleton-codex-v2/trace.jsonl` contain real initialize/tools-list/call
exchanges. Both list all seven tools; `registry/*.json` in those directories
contains A4 Caller fields with MCP/parent start ticks checked against `/proc`.
Claude returns `identity_source_missing`; Codex's qualified root reaches the
typed `not_implemented` stub. No operation or claim consumption occurs.

```sh
npm run test:hud-mcp
node tests/hud-mcp/benchmark.mjs
```

Initial measured process benchmark (`evidence/performance.json`): 30 cold starts,
cold p95 **86.59 ms**, max **120.87 ms**; 200 calls/method, tools/list p95
**0.396 ms**, fail-closed whoami p95 **0.362 ms**. It includes physical registration
but uses no selected profile; it does not measure full future B2/B5 authorization,
claim consumption, ledger contention, launch, report or wait bodies. The harness
latency experiments and hook subprocess cost are separate measurements and are
not hidden inside these fast stub numbers.

Runtime declarations: the bar remains Node >=18; hud-mcp and its future SQLite
ledger entry require Node 22.x >=22.13 or Node >=24 (23 unsupported), enforced in package engines/bootstrap and
explained in the [package README](../../packages/hud-mcp/README.md).
