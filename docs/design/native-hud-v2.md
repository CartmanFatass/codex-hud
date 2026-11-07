# Native HUD v2: identity, display, Pi package, summaries, wake, lifecycle, migration

Design decision document for DES1 (2026-11-07), branch `universal-hud` at `e533c44`. It answers the seven
questions of the brief inside the owner's fixed inputs (`docs/universal-hud-concept.md` §15, entry
"2026-11-07 本地对齐：产品定义重置"). Paths are repo-relative; `file:line` refers to the tree at `e533c44`.
The keep/delete inventory the brief cites is git-ignored; the numbers and hot spots this document relies on are
reproduced in Appendix A. Every example (ids, paths, names) is synthetic.

The thesis in four lines:

1. **Identity is data the harness hands us, not a proof we extract.** Codex says which thread calls in `_meta`;
   Claude writes its live session id in a per-pid registry file; the Pi extension *is* the session. Per-call
   verification (`/proc` ancestry, hook records, fd-3 tickets, rollout headers) goes away.
2. **An MCP child is an agent in the tree the panel already draws.** Children of any harness are projected into
   `SubagentTreeNode` (`src/types.ts:451`), so cards, timeline, agent log, bar counts, notifications, briefs,
   progress notes, digests and names work unchanged. `src/render/delegation/*` and the link view model are deleted.
3. **One host per user, with a clock.** The host starts only on `create`, never on a read, and exits by itself when
   nothing is retained; idle children are closed on a timer; every process HUD starts is bound to a parent stdio.
4. **Pi attaches in-process.** The HUD Pi package registers the same tool table through `pi.registerTool` and talks
   to the host directly; no hud-mcp subprocess, no fd-3 channel. In a child it turns `ask_orchestrator` into Pi's
   own `extension_ui_request`, which the host already relays to the parent.

---

## 0. Fixed inputs, restated as constraints on the design

| Fixed input | What it pins in this document |
|---|---|
| Any of Claude Code / Codex / Pi is the main session; symmetric roles | §1 one identity rule per harness, same tool table and the same child projection for all three (§2) |
| MCP is the one interface (create, send, read, resume, close, wake) and the TUI's data source | Appendix B tool table; the TUI reads the host and the child records, nothing else (§2.3) |
| Non-interference: connect and observe; children keep the harness's own configuration; HUD only passes the user's environment through | §6.2 environment capture; no `-c`, no settings file, no MCP config override for children (§1.4 chooses refusal over config changes) |
| Pi exception: `pi -ne -ns -e <HUD Pi package> [-e pi-roles]`; the package gives channel, wake, footer, events | §3 |
| Depth one; children's native subagents unrestricted, shown read-only | §1.4 child mode; §2.3 rows "native subagent of a child" |
| Display scope: the root (any harness), its MCP children, their native subagents; nothing else | §2.2 owner-scoped collection |
| Keep all `origin/main` features; delete the historical stack | §7 work packages, Appendix A |
| Lightweight, fast, clear; performance first-class; one install + one registration per harness; bounded lifecycles | §1.5, §2.6, §6.1 |

---

## 1. Identity and attachment

### 1.1 Today, in the code

- Every tool call resolves the caller again: `packages/hud-mcp/src/server.ts:131`
  `const resolution = await this.source.resolve(params._meta, definition.name);`, and
  `SessionRefResolver.resolve` (`packages/hud-mcp/src/resolvers.ts:157-364`) rechecks ancestry and process start
  stamps (161-178, 349-353), denies a harness whose argv contains `app-server|daemon` (177-178), compares
  `/proc/<pid>/exe` with a configured path (203), reads Claude's registry (204-217), consumes a hook record
  (220-227), locates the Codex rollout and parses its header (290-299), and refuses a Codex turn whose
  `turn_trigger` is not `exec` on an `exec` source (302) — the cause of F2 in
  `docs/cloud/handoff/local-real-client-results-20261107.md:31-34`.
- Attachment needs three files per harness: `delegate.json` profiles with `callSource` kinds
  (`packages/hud-mcp/src/config.ts:144-189`), `native.json` child profiles (`src/managed/host-config.ts:59-71`), and
  for Claude a PreToolUse hook (`packages/hud-mcp/src/hook/record.ts:251-274` writes the settings matcher,
  `hook/command.ts:71-110` runs it), plus `HUD_HOME`, `HUD_MCP_PROFILE` and `HUD_CLAUDE_HOOK_CONFIG` in the
  registration (`scripts/local-validation/claude.sh`, `codex.sh`, `setup-home.mjs:193-259`).
- Pi's parent side spawns hud-mcp with a private fd 3 and sends per-call evidence frames with tickets
  (`src/harness/pi/delegation-channel.ts:41-50,189-208`; `packages/hud-mcp/src/pi-channel.ts:65-75,107-132,153-203`).
- The wake target is re-registered on every call (`packages/hud-mcp/src/main.ts:60-90`), reading
  `/proc/<pid>/exe` of the Codex ancestor each time (`main.ts:75`).

### 1.2 Decision

Identity is **declared once per MCP process and refreshed from a cheap local source**, never verified:

- **Owner key** = `(harness, sessionId)`; `ownerKey = sha256(harness + '\0' + sessionId)[:16]`. The `sourceId`
  (hash of `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / Pi session dir, `src/managed/relations.ts:19-22`) leaves the key:
  session ids are UUIDs, unique across homes, and the owner's two Codex accounts never collide on them.
- The MCP process learns *which harness* it serves from the first call's `_meta` shape (or from its parent
  process name as a hint) and *which session* from the per-harness source below. Nothing is re-derived per call
  except the Codex thread id, which Codex already puts on every call.
- A **call id** (Codex `callId`, Claude `claudecode/toolUseId`, Pi `callId`) is recorded on the child record for
  display and dedupe only.

### 1.3 The source of truth per harness

| Parent harness | Session identity | Where it comes from | Refresh | Notes |
|---|---|---|---|---|
| Codex | `x-codex-turn-metadata.session_id` (root thread) and `.thread_id` (calling thread), with `_meta.sessionId`/`threadId` as fallback (`resolvers.ts:270-281` shows both carriers) | every `tools/call` `_meta` | per call, zero cost | A native subagent of the root (`thread_id != session_id`, `parent_thread_id` set) is **accepted and attributed to the root session**; the calling thread is kept as `caller.threadId`. `turn_trigger` is ignored (F2 fixed). `thread_source` is ignored. |
| Claude Code | `<CLAUDE_CONFIG_DIR>/sessions/<claude pid>.json` `.sessionId` — the registry Claude keeps current (today both the hook, `hook/command.ts:90-101`, and the resolver, `resolvers.ts:204-217`, already require it to match the live session) | the MCP's parent `claude` pid (ppid walk ≤ 8, `packages/hud-mcp/src/process.ts:95-121`, kept) and `CLAUDE_CONFIG_DIR` from the MCP's own env (Claude passes its environment to stdio servers) else `~/.claude` | re-read on each call, cached by mtime (one `stat`) so `/clear` and `/resume` inside one process are followed | No PreToolUse hook. `claudecode/toolUseId` is the call id. Claude native subagents (Agent tool) share the process and are attributed to the root. |
| Pi | `ctx.sessionManager.getSessionId()` inside the HUD Pi package, which calls the host in-process (§3) | the extension itself; `session_start` / `session_before_switch` / fork / tree events re-bind | event-driven | No hud-mcp process, no fd 3, no tickets. |

Resume and multiple sessions: Codex `codex resume <id>` keeps the thread id, Claude `--resume` keeps the session
id, Pi resume keeps the session header id (`src/harness/pi/delegation-context.ts:158-231` reads it today) — the
owner key is stable across resume, so the parent lists its children again (the "same parent resumes, lists,
reads" row of the results table). Two TUIs of one harness are two MCP processes (or two extension instances) with
different owner keys; one host serves both (§6.1). A fork is a new session with no children; it may adopt a
*closed* child with `hud_create{resume}` (§1.9), never a live one of another owner (`child_busy`).

### 1.4 Child mode (depth one) without touching the child's configuration

A child Codex or Claude starts with the user's configuration, which includes the `hud` MCP registration (F3 counted
8 MCP servers per Codex child). Instead of disabling it through configuration, the same `hud-mcp` binary detects
that it runs inside a HUD child and refuses to delegate:

- The host sets `HUD_CHILD=<childId>` and `HUD_CHILD_OF=<ownerKey>` in every child's environment. Pi children
  never load hud-mcp at all (`-ne`); Claude forwards its environment to stdio MCP servers, so the marker arrives.
- Codex filters the environment it gives MCP servers (F3), so the marker may not arrive there. The uniform
  fallback, used whenever the marker is absent, is one lookup of the caller's own session id (Codex: `_meta`
  `session_id`; Claude: the registry of §1.3) against `~/.hud/children/*/*.json` (`nativeRef.threadId` /
  `nativeRef.sessionId`), cached for the process lifetime after the first hit. A hit means "I am a HUD child".
- In child mode `tools/list` still returns the table (Codex sends no `_meta` on `tools/list`), but every call answers
  `{error:'depth_limit', message:'This session is a HUD child; ask the orchestrator instead.'}` in ≤ 1 ms, and
  `hud_create`/`jev_open` never start a host. The child's native subagents (Codex `spawn_agent`, Claude Agent tool)
  are untouched.

Rejected: passing a per-thread config override (Codex `thread/start.config`, Claude SDK `mcpServers` +
`strictMcpConfig`) to drop the `hud` server. The Claude form drops *all* user servers (violates non-interference);
the Codex form is version-dependent and still leaves Claude different. The refusal path is uniform and costs one
file lookup. Open question 3 in §8 keeps the override as a possible later refinement for Codex only.

### 1.5 What the user configures (one install, one registration per harness)

- `./install.sh` builds `dist/` **and** `packages/hud-mcp/dist/` (today it runs only `npm run build`, inventory H17),
  links the Pi package into `~/.pi/bundles/hud` (the owner's existing pattern for pi-roles) and prints:
  - Codex: `codex mcp add hud -- node <checkout>/packages/hud-mcp/bin/hud-mcp.mjs` (or the `[mcp_servers.hud]`
    table for `config.toml`), once per `CODEX_HOME` in use. No `env` block.
  - Claude: `claude mcp add --scope user hud -- node <checkout>/packages/hud-mcp/bin/hud-mcp.mjs`.
  - Pi: nothing beyond the link (pi loads `~/.pi/bundles/*` / `~/.pi/agent/extensions`); for a Pi started with
    `-ne`, `-e ~/.pi/bundles/hud`.
- `HUD_HOME` defaults to `~/.hud` (0700). Tests set it explicitly; users never do.
- `~/.hud/config.json` is optional and small: `{ "idleCloseMs", "graceExitMs", "jev": { "python" }, "codex": {
  "executable" }, "claude": { "executable" }, "pi": { "executable" } }`. Nothing in it changes a child's behaviour;
  it only says where HUD finds programs and how long it keeps idle processes.

### 1.6 Fate of today's pieces

| Piece | v2 |
|---|---|
| `delegate.json` (`config.ts:144-189`), `HUD_MCP_PROFILE` (`main.ts:24-26`) | deleted; harness inferred from the call |
| `native.json` (`host-config.ts:59-71`), `nativeProfiles` env merge (`host-config.ts:72-120`) | deleted; children launch with the harness defaults on the captured PATH; per-create options come from the orchestrator (Appendix B) |
| Claude PreToolUse hook (`packages/hud-mcp/src/hook/*`, `bin/hud-claude-hook.mjs`, `HUD_CLAUDE_HOOK_CONFIG`, `claude.settings.json`) | deleted; replaced by the registry read in §1.3 |
| `/proc` evidence (`process.ts:22-40` reads `stat`, `cmdline`, `environ`, `ns/pid`; `pi-host.ts:12-35`; `hook/process.ts:66-116`) | no longer identity evidence. `/proc/<pid>/environ` of the harness ancestor stays as the **environment source** on Linux (§6.2); `findHarness` stays to find that ancestor |
| Pi fd-3 channel (`delegation-channel.ts`, `delegation-context.ts`, `pi-channel.ts`, `pi-host.ts`) | deleted (§3) |
| `MemoryCallerRegistry`/`FileCallerRegistry`/`registerCaller` (`registry.ts:25-146`) | deleted |
| `wake_register` on every call (`main.ts:60-90`, `host-wake.ts:158-205` methods) | replaced by a wake target computed at `hud_create` and stored on the child record (§5) |
| `identity_unverified`, `stale_context`, `unsupported` resolutions (`resolvers.ts:18-27`) | the only refusal classes left: `depth_limit`, `child_busy`, `host_unavailable`, `invalid_arguments` |

### 1.7 Security posture (single-user local tool)

Still defended: (a) other local users — `HUD_HOME` 0700, socket 0600, child records 0600, `writePrivateFile`
pattern as on main (`docs/ARCHITECTURE.md` §5.1); (b) accidental cross-session action — every host request carries
the owner key and the host only lists/acts on that owner's children (a *scoping* rule); (c) terminal injection —
wake and notice text is control-stripped (`src/notify.ts` already does this; `src/managed/wake-message.ts` keeps
the 512-byte cap); (d) nothing leaves the machine unless the model features are on (§4).

Deliberately dropped: proving that the calling process is the session it claims (ancestry, procStart, exe path,
rollout header digest, hook tombstones, fd ownership, fingerprints). A same-uid process can already read every
file and signal every process; the checks defended a boundary that does not exist and cost a process spawn per
Claude call and ~300 lines per harness.

### 1.8 Rejected alternatives

- *Keep per-call verification but fix F2.* Removes one line (`resolvers.ts:302`) and keeps the hook, fd 3, three
  config files and the `/proc` rechecks. It does not meet "one install + one registration", and the hook is a
  spawn per call.
- *Bind once at `initialize` with a secret in `mcp_servers.hud.env`.* Needs per-harness env in the registration,
  breaks for Codex's shared-process case (several threads per MCP process), and adds a credential to a tool with no
  adversary.
- *A per-owner host as today (`host-ipc.ts:27-30`, one socket per `ownerKey[0:32]`).* See §6.1.

### 1.9 Interfaces

```ts
// packages/hud-mcp/src/identity.ts (replaces resolvers.ts, registry.ts, hook/*, pi-channel.ts, pi-host.ts)
export interface Owner { harness: 'codex' | 'claude' | 'pi'; sessionId: string }
export interface Caller { owner: Owner; callId: string | null; threadId: string | null }
export interface IdentitySource { caller(meta: unknown, toolName: string): Caller | { error: 'depth_limit' } }
export function codexCaller(meta: unknown): Caller;                       // _meta carriers, no I/O
export function claudeCaller(reader: RegistryReader, meta: unknown): Caller; // registry read, mtime-cached
export function ownerKey(owner: Owner): string;                           // sha256(harness\0sessionId).slice(0,16)
```

The host's request envelope becomes `{ owner: Owner, method, params, env?: Record<string,string> }`
(`env` only on `hud_create`/`jev_open`, §6.2). `src/managed/relations.ts` `DirectRelation` (11-18) is replaced by the
child record of §2.8.

---

## 2. Display model

### 2.1 Today

The bar and panel draw children through `NativeCallCollector` (`src/collectors/native-calls.ts:63-310`), which
asks the host for `list` + `wait` per owner with a 40 ms budget (165-169) and *merges* the result into a
`DelegationViewModel` (`merge`, 208-309) whose tree is a `LinkTreeProjection` of the deleted ledger design
(`src/core/link/types.ts:142-161`, nodes 102-134) stamped `reason: 'legacy_ledger_not_used'` (212). The panel
then renders it with `src/render/delegation/*` (~4.8k lines: `panel.ts:322-349`, `bar.ts:49-75`,
`statusline.ts:160-168`) instead of its own cards. `src/index.ts:113-114,198-201,240,253` and
`src/tree-page.ts:286-289,1027-1035,1156-1163,1179-1190` carry both the legacy collector and the native one.
Meanwhile the whole panel is built around `SubagentTree` (`src/types.ts:520-525`): cards, timeline, agent log,
briefs, progress and labels all take `SubagentTreeNode` (`docs/ARCHITECTURE.md` §4.4–§6.3).

### 2.2 Decision: children are `SubagentTreeNode`s

One root-agnostic tree per TUI process:

```
root                       (the session this TUI belongs to; any harness)
├─ native subagent …       (Codex: rollout scan as on main; Claude: Agent-tool sidechains)
├─ MCP child  ⌬/✳/π        (from the child record + the host's ChildSummary)
│  └─ native subagent …    (read-only; Codex child: rollout scan rooted at the child thread)
└─ Jev job ◎               (from the jev record + jev_snapshot)
```

- A new collector `src/collectors/children.ts` turns child records and host summaries into `SubagentTreeNode[]`
  and the bar/panel/dry-run append them to `tree.nodes`. The panel keeps *one* tree, *one* set of counts
  (`agentCounts`, `src/collectors/subagent-tree.ts:1304-1326`), one selection model.
- `SubagentTreeNode` gets three additive optional fields; nothing existing changes meaning:

```ts
// src/types.ts (additive)
harness?: 'codex' | 'claude' | 'pi' | 'jev';          // glyph beside the name when the tree spans harnesses
origin?: 'native' | 'hud';                              // 'hud' = created through hud_create / jev_open
request?: { kind: 'approval' | 'question' | 'permission' | 'dialog'; text: string; since: Date };  // needs the orchestrator
```

- `DelegationViewModel`, `HudDelegationData`, `nativeCallLabel`, `jevCallLabel` (`src/core/link/view-model.ts`),
  `render/delegation/*`, `core/link/*`, `core/capacity.ts`, `core/observation.ts` projections are deleted (WP2).

### 2.3 Node types and data sources

| Node | Identity | Data source | Status, clock | Text shown | Cost per tick |
|---|---|---|---|---|---|
| Codex root | `SessionFinder` as on main | rollout parse + `HudStatus` (unchanged) | unchanged | unchanged | unchanged |
| Claude root | statusline JSON `session_id` (`src/core/statusline-summary.ts:77-96` keeps `statuslineRef` minus the ledger) or, for the standalone panel, `--session <id>` / newest transcript for the cwd | native facts from the statusline JSON; transcript via `src/harness/claude/reader.ts` (kept) for the panel | from the transcript tail | model, context, cost (statusline) | one-shot (statusline) |
| Pi root | `ctx.sessionManager` | `ctx.getContextUsage`, `ctx.isIdle`, session file (`src/harness/pi/footer.ts:87-120` already) | footer events | footer lines | event-driven |
| Native subagent of the root | as on main (Codex); `ClaudeNativeTopology` (`src/harness/claude/topology.ts:75`) | as on main | as on main | as on main | as on main |
| MCP child (any harness) | child record `~/.hud/children/<ownerKey>/<childId>.json` | host subscription → `ChildSummary` (§2.8) | `starting` → `running` (turn in flight) → `completed` (idle after a turn) / `error` (exit ≠ 0, transport lost); `request` set while a request waits | name (orchestrator's `name` or `harness·c-7f3a`), model·effort, task head (≤ 300), last public message head (≤ 600), current tool (≤ 200), context % when the harness reports it, the request line | one socket message per change; 0 when quiet |
| Native subagent of a Codex child | rollout scan rooted at `nativeRef.threadId` under the child's `CODEX_HOME` (from the record) | `buildSubagentTree` (`subagent-tree.ts:968-983`) with a shared parent map (WP6: one scan, many roots) | as on main | as on main | shares the scan cache (`tree-scan-store.ts`) |
| Native subagent of a Claude child | `ClaudeNativeTopology` over the child transcript path from the record | same reader | as on main's Claude reader | name, status | one tail read per changed file |
| Jev job | `~/.hud/jev/<ownerKey>/<instanceId>.json` | host `jev_snapshot` result cached in the summary (today `native-calls.ts:98-149` asks per tick) | running / blocked (CAPTCHA, login) / closed | url host, goal head, last snapshot line | 0 when quiet |

Scope rule: a TUI asks the host only for **its owner** (root session). Unrelated sessions never appear, and a
`hud panel --all` debug switch is the only exception (replacing `CODEX_HUD_PANEL_ALL_DELEGATIONS`,
`src/tree-page.ts:286`).

### 2.4 What each node shows (and where)

The card rules of `docs/ARCHITECTURE.md` §6.3 hold: model-written text on cards, raw text in the Inspector. For an
MCP child:

- **Card / compact row:** status marker (existing set), harness glyph (`⌬` Codex, `✳` Claude, `π` Pi, `◎` Jev;
  moved from `render/delegation/glyphs.ts` into `render/subagent-chip.ts`), name, model·effort badge, turn clock,
  context meter when known, newest model note (progress summary), current action `▸ npm test`, and while a request
  waits one line `⚑ approval · rm -rf build (2m)` in the alert colour. Children of the child (its native
  subagents) are its child lines as today.
- **Timeline:** each turn is a stage (`stages[]`): started at `hud_send`, ended at `turn_done` with the result head;
  requests appear as `⚑` entries; nothing else is invented.
- **Inspector:** the request text whole (`flowLines`), the last result whole, the task (create prompt), the native
  ref and transcript path under `▾ More`, and a fixed note "read-only: the orchestrator drives this child". The
  `o`/`⇢` switch action is disabled for `origin:'hud'` nodes (there is no `/subagents` entry to switch to).
- **Bar:** `Agents 2▸ 1⚑ 1✓` — the existing module over `agentCounts`; the attention badge adds "child needs the
  orchestrator" (`render/attention.ts`) ranked with pending approvals; the notice zone gets `✓ reviewer finished ·
  12s ago` from `BarNoticeTracker` for free because children are L1 agents.
- **Claude statusline (`hud statusline`):** line 1 unchanged (`render/statusline-session.ts`), with the counts at
  its end; line 2 `⧉ ▸ π implementer 4m · ⚑ ⌬ reviewer approval 1m · +1✓`. The pure functions of
  `render/delegation/statusline.ts:160-260` are rewritten over `SubagentTreeNode[]` (≈ 150 lines) and the
  legacy `readStatuslineSummary` second line (`src/cli/statusline.ts:98-130`) goes.
- **Pi footer:** the third line's `HUD <summary>` (`src/harness/pi/footer.ts:265-303`) becomes `HUD ⧉ 1▸ 1⚑` from the
  in-process subscription; the ledger-backed provider (`core/delegation-summary-pi.ts`, H16) is deleted.

### 2.5 Reuse of main's Codex tree reading

Unchanged for the root. For Codex children, `buildTreeSteps` is generalised to accept several roots and return one
subtree per root from a single parent map; the scan cache key already includes the rollout path, so children's
rollouts under another `CODEX_HOME` get their own entries. `readAgentTokens` (`src/collectors/agent-context.ts:136`)
works on a Codex child's rollout path as it does for native agents, so Codex children get context % and tok/s
without the host.

### 2.6 Performance budget

| Stage | Today | v2 target | How |
|---|---|---|---|
| Bar cold start to first paint | module graph 149 modules / 44.6k lines, 36 modules / 11.4k historical (App. A) | −36 modules; ≤ 150 ms on the owner's machine with a warm scan cache | WP1–WP2 |
| Panel cold start | 193 / 63.9k, 46 / 13.9k historical | −46 modules; ≤ 300 ms to first frame, tree may still say loading | same |
| Children per tick (bar, 1 s) | `list` + `wait` per owner, 40 ms cap (`native-calls.ts:165-169`), spawns a host on `ENOENT` (`host-ipc.ts:201-282`) | 0 syscalls when nothing changed (subscription); ≤ 2 ms p50 / 40 ms cap on change; **never starts a host** | §2.8 subscription |
| Panel tick | same | same; child native-subagent scans share one yielding scan (`buildSubagentTreeYielding`, 4 ms slices) | WP6 |
| Statusline (one-shot) | ledger open + sqlite | one connect + one `list` with a 20 ms budget, else "host down" | WP6 |
| Host | one per owner, `process.env` of the MCP | one per user; idle CPU 0; ring 512 msgs / 4 MiB kept (`host.ts:80-105`) | §6 |

Acceptance is measured with the existing `CODEX_HUD_PROFILE=1` stage log (`docs/reference.md`, "All environment
variables"): a `children` stage ≤ 5 ms p99 with three live children.

### 2.7 Rejected alternatives

- *Keep `DelegationViewModel` and feed it from the host.* It drags `LinkTreeProjection`, coverage/ledger chips,
  conflict relations and 4.8k lines of renderers whose vocabulary (slots, reconcile, resume, pane) is gone.
- *A separate "Children" pane.* Two trees, two selections, two count vocabularies; the owner wants one glance.
- *Poll the host per tick.* Cheap but not zero; a subscription makes quiet sessions cost nothing and gives the Pi
  footer and wake the same stream.

### 2.8 Interfaces

```ts
// src/managed/child-record.ts — written by the host, read by every TUI (0600)
export interface ChildRecord {
  child: string;                       // 'c-7f3a9c'
  owner: Owner;                        // { harness:'claude', sessionId:'1d2e…' }
  harness: 'codex' | 'claude' | 'pi';
  name: string | null;                 // orchestrator's label: 'implementer'
  nativeRef: NativeRef;                // src/managed/types.ts:3-6, unchanged
  cwd: string;
  transcriptPath: string | null;       // Codex rollout / Claude transcript / Pi session file, when known
  codexHome?: string;                  // Codex only: where the child's rollouts live
  createdAt: number;
  closedAt?: number; closeReason?: 'closed' | 'idle_timeout' | 'host_exit' | 'exit';
  wake: WakeTarget;                    // §5
}

// src/managed/child-summary.ts — in the host; sent on the subscription and by hud_list/hud_read
export interface ChildSummary {
  child: string; harness: ChildRecord['harness']; name: string | null;
  state: 'starting' | 'running' | 'idle' | 'needs_parent' | 'failed' | 'closed';
  turn: { n: number; startedAt: number | null; endedAt: number | null };
  lastMessage: { at: number; head: string /* ≤ 600 */; bytes: number } | null;
  action: { name: string; target: string /* ≤ 200 */; since: number } | null;
  request: { requestId: string; kind: 'approval' | 'question' | 'permission' | 'dialog'; text: string /* ≤ 2 KiB */; since: number } | null;
  usage: { contextTokens?: number; contextWindow?: number; inputTokens?: number; outputTokens?: number; costUsd?: number } | null;
  model: string | null; effort: string | null;
  seq: number;                         // last event seq for this child
}

export type ChildEvent =
  | { seq: number; child: string; at: number; type: 'created' | 'turn_started' | 'closed' }
  | { seq; child; at; type: 'turn_done'; status: 'completed' | 'interrupted' | 'failed'; text: string /* head+tail ≤ 8 KiB */; usage?: ChildSummary['usage'] }
  | { seq; child; at; type: 'message'; role: 'assistant'; head: string /* ≤ 600 */ }
  | { seq; child; at; type: 'tool'; phase: 'start' | 'end'; name: string; target: string }
  | { seq; child; at; type: 'request'; request: NonNullable<ChildSummary['request']> }
  | { seq; child; at; type: 'request_done'; requestId: string }
  | { seq; child; at; type: 'exit'; code: number | null; signal: string | null }
  | { seq; child; at; type: 'error'; code: string; message: string };

// src/collectors/children.ts
export class ChildrenCollector {
  constructor(home: string, owner: Owner | null, port?: HostPort);   // never starts a host
  /** Records from disk + live summaries from the subscription; ≤ 40 ms; [] with `unavailable` when the host is down. */
  collect(nowMs: number): { nodes: SubagentTreeNode[]; unavailable: string | null };
  /** Fires on any host message so the bar/panel can `wakeCollection()`. */
  onChange(cb: () => void): void;
  close(): void;
}
```

Mapping `ChildSummary` → `SubagentTreeNode`: `id = child`, `name = name ?? \`${harness}·${child.slice(2,6)}\``,
`status`: starting→`starting`, running/needs_parent→`running`, idle→`completed`, failed→`error`, closed→`completed`
with `statusAt = closedAt` (the 3-minute linger puts it away); `task` = create prompt head (≤ 300), `charge` =
none, `stages` = turns, `lastReport.text` = `lastMessage.head`, `action`, `contextUsage` from `usage`,
`startedAt = createdAt`, `turnStartedAt`, `model`, `effort`, `rolloutPath = transcriptPath` (Codex children only
feed `readAgentTokens`), `harness`, `origin:'hud'`, `request`.

Host subscription: `subscribe { owner, afterSeq }` on one long-lived connection; the host pushes
`{ seq, summary?: ChildSummary, event?: ChildEvent }` frames ≤ 64 KiB, at most 16 subscribers, slow readers are
dropped (they reconnect and resync from records). This replaces today's one-request-per-connection socket
(`host-ipc.ts:51-108`) for readers; mutating calls keep request/response.

---

## 3. HUD Pi package

### 3.1 Shape

`packages/hud-pi/` with `package.json { "pi": { "extensions": ["./extensions/hud.ts"] } }`, built from
`src/harness/pi/*.ts` (`dist/`), linked as `~/.pi/bundles/hud` by the installer — the same packaging the owner
uses for pi-roles (`~/codex/MySkills/pi-roles`, linked `~/.pi/bundles/roles`). One entry, two modes chosen at
`session_start` by the environment:

| Mode | When | Registers | Talks to |
|---|---|---|---|
| parent | no `HUD_CHILD` in env | the tool table of Appendix B via `pi.registerTool` (as `extensions/pi/hud-delegate.ts` does today); `/hud` command (`status`, `close <child>`, `footer on|off`); footer lines; wake delivery | the host in-process through `NativeHostClient` (socket), owner = `{harness:'pi', sessionId: ctx.sessionManager.getSessionId()}`; one subscription for footer + wake |
| child | `HUD_CHILD` set (the host sets it when it spawns `pi --mode rpc -ne -ns -e <hud-pi> [args]`) | `ask_orchestrator` only | nothing: the rpc stream is the event channel; the question goes through `ctx.ui` |

Rejected: spawning `hud-mcp` over stdio from the extension (today's `PiDelegationBridge`,
`src/harness/pi/delegation-bridge.ts:6-80`). It costs a process and an MCP handshake per Pi session, needs the fd-3
identity dance (`delegation-channel.ts:41-50`), and buys nothing: the tool table is a shared module both the MCP
server and the extension import (`packages/hud-mcp/src/managed-tools.ts:39-106` is already imported by
`extensions/pi/hud-delegate.ts`). The "parent-side MCP connection" of the fixed input is read as "the parent-side
attachment to HUD's delegation service": same tools, same semantics, same host — without a stdio process. §8 Q1
asks the owner to confirm this reading.

### 3.2 Structured event protocol to HUD

Pi in `--mode rpc` already streams `agent_start`, `message_end`, `tool_execution_start/end`, `agent_settled`,
`extension_ui_request` to the host, and the adapter maps them (`src/harness/pi/rpc-adapter.ts:96-160`). The host
normalises them into `ChildEvent` (§2.8): `agent_start → turn_started`, `message_end(assistant) → message`,
`tool_execution_* → tool`, `agent_settled → turn_done` (text = last assistant message via `get_entries`),
`extension_ui_request → request`, process exit → `exit`. The same normalisation covers Codex app-server
notifications (`turn/started`, `item/*`, `turn/completed`, server requests —
`src/harness/codex/managed-adapter.ts:281-360`) and Claude SDK messages (`assistant`, `result`, `canUseTool`,
`onElicitation`, `onUserDialog` — `src/harness/claude/sdk-adapter.ts:315-404`). The Pi package adds no second
protocol; the harness's official stream *is* the structured report.

### 3.3 `ask_orchestrator` as a standard child → parent request

```ts
// packages/hud-pi/extensions/hud.ts, child mode
pi.registerTool({
  name: 'ask_orchestrator',
  description: 'Ask the orchestrator one question and wait for the answer. Use only for decisions you cannot make from the brief.',
  parameters: { question: string, options?: string[] },
  async execute(_id, { question, options }, signal, _update, ctx) {
    const answer = options?.length
      ? await ctx.ui.select(question, options)         // → extension_ui_request{method:'select'}
      : await ctx.ui.input(question);                   // → extension_ui_request{method:'input'}
    return { content: [{ type: 'text', text: answer ?? '(no answer)' }] };
  },
});
```

In rpc mode `ctx.ui.*` becomes an `extension_ui_request`, which the host already relays as a `NativeRequest`
(`rpc-adapter.ts:96-155`); the parent sees `ChildEvent{type:'request', kind:'question', text}` on `hud_wait`, is
woken (§5), answers with `hud_respond{child, requestId, response:{text}}`, and the host sends
`extension_ui_response`. In an interactive Pi (no HUD, or the owner running a role by hand) the same tool just
prompts the human. Codex and Claude children get the equivalent for free: Codex `request_user_input` /
`execCommandApproval` server requests and Claude `canUseTool` / `onElicitation` / `onUserDialog` callbacks are
relayed the same way, so **every child of every harness asks its parent through one path**. The file protocol
(`<qa-dir>/qN.md` → `qN.answer.md`, `--notify`, `--qa-timeout`) is not used under HUD.

### 3.4 Relation to pi-roles (two layers, confirmed)

- pi-roles keeps: roles (system prompts, model per role, read-only guard), `/role`, `/brief`, `pi-role` launcher for
  the visible herdr-tab workflow, `--qa-dir` file questions for that workflow.
- HUD package provides: channel (tools in a parent, `ask_orchestrator` in a child), events (via rpc), wake, footer.
- One change in pi-roles (outside this repo): register its own `ask_orchestrator` only when `--qa-dir` is given, so
  a child launched by HUD with `-e ~/.pi/bundles/hud -e ~/.pi/bundles/roles --role implementer` has exactly one
  `ask_orchestrator`. Child launch line: `pi --mode rpc -ne -ns -e <hud-pi> -e <roles> --role <r> [--allow-write]`,
  where everything after `<hud-pi>` comes from `hud_create.options.args` chosen by the orchestrator.

### 3.5 herdr-delegate through HUD later

Yes, as a headless path: the Claude main session calls
`hud_create{harness:'pi', cwd, name:'implementer', prompt:'@<brief path> <message>', options:{args:['-e','~/.pi/bundles/roles','--role','implementer']}}`
and waits on `hud wait` (§5). The herdr tab + `pi-role` launcher stays the visible, manual alternative; HUD gives
the bounded lifecycle the owner's memory asks for (idle close, §6.1). The two are not mixed in one child.

---

## 4. Model summaries for all sessions

### 4.1 Today

The generators consume the tree and the main parse: `briefMaterial(tree, {main, recap, logs, …})`
(`src/collectors/briefing.ts:878`), `recapInput` (`src/collectors/recap.ts:183`) over `RolloutParseResult`,
`ProgressSummarizer` (`progress-summary.ts:280`) over node reports/stages/actions, `ModelJobs`
(`model-jobs.ts:559`) for digests, labels (`labelSource(node)`, 318), causes, titles, and `AgentLog.observe`
(`agent-log.ts:211`) which writes observed entries from node fields (`observedEntries`, 79). Privacy limits are
the ones in `docs/reference.md` "LLM" (tasks ≤ 300, updates ≤ 600, answers ≤ 8 000, prompts/replies ≤ 4 000 in
all) and `docs/ARCHITECTURE.md` §5.4; `codex-hud brief --dry-run` prints the material (`src/collectors/brief-dry-run.ts:38-94`).

### 4.2 Decision: two generic shapes, no new generator

1. **Children of any harness** reach the generators as `SubagentTreeNode` (§2.8). Because the projection fills
   `task`, `stages[].intent/result`, `lastReport`, `action`, `name`, `role`, `status`, `children`, every feature
   works unchanged: the periodic brief reports them, progress notes land on their cards, result digests take the
   turn result, labels use the create prompt (`labelSource` reads `charge ?? task`), causes use the error event,
   the agent log records started/finished/failed/report.
2. **Roots of any harness** reach the recap through a small interface the Codex parse already satisfies:

```ts
// src/collectors/main-transcript.ts
export interface MainTranscript {
  sessionId: string;
  prompts: Array<{ at: number; text: string }>;          // user → assistant, ≤ 600 each when sent
  replies: Array<{ at: number; text: string }>;          // assistant public final/commentary only
  plan?: PlanProgress;                                    // src/types.ts PlanProgress (Codex plan, Claude todos via harness/claude/todos.ts)
  approvals?: Array<{ at: number; summary: string; answered: boolean }>;
  compactions: number;
  turnEnded?: number;
}
export function codexMainTranscript(parse: RolloutParseResult): MainTranscript;   // today's recapInput inputs
export function claudeMainTranscript(result: ClaudeReaderResult): MainTranscript; // src/harness/claude/reader.ts (kept)
export function piMainTranscript(result: PiReaderResult): MainTranscript;         // src/harness/pi/reader.ts (kept)
```

`recapInput` takes a `MainTranscript`; `codexMainTranscript` is a rename of what it reads today, so the Codex root
is unchanged (WP6); Claude/Pi roots are WP11.

### 4.3 Privacy boundary (unchanged, extended by rows)

| Material | Children (new) | Rule |
|---|---|---|
| task | create prompt head ≤ 300 (brief), ≤ 400 with name (labels) | same as native agents |
| latest update | `lastMessage.head` ≤ 600 | public assistant text only |
| stage result / digest | `turn_done.text` ≤ 8 000 (head+tail) | public final message only |
| current action | tool name + target ≤ 200 | as native |
| request text | ≤ 2 000, only to the Approval words job when it is on | as native approvals |
| never | reasoning/thinking blocks (Codex `reasoning` items, Claude `thinking`, Pi `thinking`), env, prompts the orchestrator did not write, native refs, paths | `ChildSummary` never carries them; the host drops them at normalisation |

`brief --dry-run` gains the children: `dryRunText` appends `ChildrenCollector.collect()` nodes (read-only: records +
a `list` if the host is up, never a start) before `briefMaterial`, so the printed material shows exactly the child
lines that would be sent. A `--root <harness>` switch is added only with WP11.

Rejected: a new "delegation digest" generator or a second log. The existing six features cover what the owner
asked for (brief, recap, progress, digest, names) once children are agents.

---

## 5. Wake

Facts from `docs/design/notify-wake-lifecycle-cache.md` §2 (versions as read there): Claude's background command
completion starts a new turn in an idle interactive TUI (2.1.305); `codex queue --thread` writes a durable row
that the owning TUI polls every ~10 s and dispatches only when idle (0.166), is rejected while a daemon runs for a
forced-embedded TUI, and `--no-daemon` is rejected; pi `sendMessage(..., {deliverAs:'followUp', triggerTurn:true})`
delivers after tools finish (1.5.0). None interrupts a running turn; each wake costs the parent one model sample,
so wakes are coalesced.

### 5.1 Per parent harness

| Parent | Mechanism | Delivery guarantee | What the parent sees |
|---|---|---|---|
| Codex | the host spawns `codex queue --thread <root session_id> --message <line>` with `CODEX_HOME` from the captured env and the `codex` executable captured at `hud_create` (`/proc/<pid>/exe` of the harness ancestor, as `main.ts:75` does today, else PATH); 10 s timeout, detached; receipt `accepted | rejected{reason} | unknown` is **advisory** | at-least-once attempt; delivered when the TUI is idle; coalesced: one message per child per idle period; retried once after 30 s if the owner's read cursor has not passed the event (`lastReadSeq` in the host) | one queued user message: `[hud] reviewer (⌬ c-7f3a) finished turn 2 · "LGTM with two nits…" · hud_read{child:"c-7f3a"} · hud_wait{afterSeq:17}` (≤ 512 bytes, control-stripped) |
| Claude Code | `hud wait --owner <key> [--child <id>] --after <seq> [--timeout 1500]`: connects to the host socket, long-polls, prints one line, exits 0; printed by `hud_create` as `wake.command` with the instruction to run it in the background | delivered when the waiter exits (Claude's task notification at the next idle); the waiter exits on the first event after `--after`, on host exit (`host down`), or at the timeout with `timed out; rerun: <command>`; unattended caps (30 min default / 2 h max per the matrix) are respected by the default timeout | the `<task-notification>` with the same one line |
| Pi | the parent package's subscription receives the event and calls `pi.sendMessage({customType:'hud_wake', content, display:true, details}, {triggerTurn:true, deliverAs:'followUp'})` (`src/harness/pi/wake-extension.ts:87-104` logic kept, socket dropped) | exactly once per seq (the package keeps `lastDeliveredSeq`); delivered after the current tools finish | a follow-up message with the same line |

Events that wake: `turn_done`, `request`, `exit`, `error`. `message`/`tool` never wake. Jev: `run` completion and
`blocked` snapshots wake like `turn_done`/`request`.

### 5.2 F2 and the flaky receipts

- F2: the queue-woken turn was refused by `resolvers.ts:302`; with §1 the turn is a normal Codex call. Nothing else
  is needed.
- Receipts: today `sendNativeWake` kills `codex queue` after 2 s (`src/managed/host-wake.ts:51-155`), while the CLI's
  own startup can exceed that; the receipt was `unknown/timeout` 2 of 3 and the message may still have landed. v2:
  10 s timeout, the receipt is logged on the child record (`wake.last = {at, result}`) and shown in the Inspector,
  and delivery is judged by the owner's cursor, not by the receipt. The retry is bounded (one), so a dead parent
  costs two spawns per child event at most and then nothing.

### 5.3 Rejected

- Blocking `hud_create` until the child finishes: serialises delegation.
- MCP notifications/elicitation as a wake: no harness turns them into a model turn (matrix §2.4).
- Codex `turn/steer` through an app-server socket: the owner's TUIs run embedded (matrix §2.2) and it would steer
  a running turn — a wake must not interrupt.

---

## 6. Lifecycle and environment

### 6.1 Host and children

Today: a host per owner (`host-ipc.ts:27-30`), spawned on the first `ENOENT`/`ECONNREFUSED` of **any** call
including `list` (`host-ipc.ts:201-282`), unrefs its server only after an explicit close (`host-ipc.ts:35-49`),
and bootstrap-only hosts stay alive on purpose (`src/managed/host-entry.ts:18-20`) — F6. Jev's `release()` only
ends stdin (`src/managed/jev-host.ts:108-110`) and `createJevHost` keeps the host referenced while the bridge
lingers — F7.

v2 rules:

| Process | Started by | Lives while | Ends when |
|---|---|---|---|
| host (`~/.hud/host.sock`, one per user) | the first `hud_create`/`jev_open` of any owner (lock `host.sock.start` as today) | any child connection or Jev instance is live, or a request is in flight | nothing retained for `graceExitMs` (default 60 s) → `server.close()` → exit 0; also on `SIGTERM`. Readers (`subscribe`, `list`, `read`, `wait`) never start it and never keep it alive |
| child harness process (Codex `app-server`, Claude `claude` via SDK, Pi `--mode rpc`) | the host, stdio-bound (`stdin` pipe), not detached | a turn runs, or the parent read/sent within `idleCloseMs` (default 30 min) | `hud_close`; idle timeout (never while a turn runs; the native session stays resumable with `hud_create{resume}`); host exit (the host closes every transport first; a harness exits on stdin EOF); `closeReason` recorded |
| Jev bridge (python) | the host per instance | the instance exists | `jev_close` → `stdin.end()` then `SIGTERM` after 5 s, `SIGKILL` after 10 s; host exit |
| `hud wait` waiter | the Claude parent (background) | until one event, host down, or `--timeout` | exits by itself; no loops |
| hud-mcp (stdio) | the harness | the harness process | stdin EOF; the 30 s `parentAlive` check (`server.ts:270-273`) stays |
| Pi package | Pi | the Pi session | `session_shutdown` |
| bar / panel / statusline | tmux / Claude | as on main | as on main |

"Work the user wants to keep" is protected by three rules: a running turn is never cut by a timer; `hud_close` is
explicit; the native session file outlives the process and `hud_create{resume: nativeRef}` continues it later
(all three adapters support resume: `managed-adapter.ts:153-200`, `sdk-adapter.ts:174-196`,
`rpc-adapter.ts:172-187`). The parent is told why a child went away (`closeReason` in `hud_list` and the Inspector).

Rejected: keeping per-owner hosts. Two owners → two node processes idling; the TUI would open N sockets; the
per-owner isolation was an authentication artefact (§1.7). The cost of one host per user is a larger blast
radius on a host crash (§9); children are stdio-bound to it, so a crash leaves no orphans.

### 6.2 Children get the user's real environment (F3)

The host is spawned with the MCP's `process.env` (`host-ipc.ts:119-123`), which Codex has filtered (F3), and
children inherit it (`host-config.ts:74`). v2: the environment is **captured on the caller's side at every
`hud_create`/`jev_open` and passed to the host in the request**; the host applies it to that spawn only.

- Codex and Claude parents (Linux): `env = read('/proc/<harness pid>/environ')` of the nearest harness ancestor
  (`findHarness`, kept) — literally the environment the user's Codex/Claude runs with (proxy, PATH, `CODEX_HOME`,
  `CLAUDE_CONFIG_DIR`, API keys). Fallback when unreadable (another platform): `process.env`.
- Pi parent: `process.env` of the Pi process (in-process).
- HUD removes only its own `HUD_*` variables, then **adds** `HUD_CHILD`, `HUD_CHILD_OF` (§1.4) and, for Codex,
  nothing else — `CODEX_HOME` is whatever the parent had, so the child runs on the same account.
- Nothing is persisted; the env travels once over the 0600 socket. A later `export` in the user's shell reaches
  the next child because capture is per call, which also answers the second half of F4.

Children still load the user's full MCP/plugin set (7–15 s startup, F3): that is their configuration, and
non-interference says HUD does not touch it; the cost is shown on the card as the `starting` clock.

### 6.3 Jev interpreter and credentials (F4, F5)

- Interpreter, in order: `config.json jev.python`, `HUD_JEV_PYTHON` from the captured env, a probe
  `python3 -c 'import jev'` with the captured env, then `jev_python_not_found` listing what was tried. Today's
  `options.python ?? process.env.HUD_JEV_PYTHON ?? 'python3'` (`jev-host.ts:52-59`) is replaced by this resolver.
- Credentials: the bridge gets the captured env of the `jev_open` call, so they are whatever the user's shell had
  at that moment.
- `screenshots` is explicit and defaults to `false`; `record_dir` only records (F5). The 5 s screenshot IPC timeout
  is reported as a `blocked`-style snapshot, not a failure.

---

## 7. Migration plan

Principles: cut the coupling first so the historical modules fall out of every live module graph; delete in
segments that each leave `npm test` green; build v2 on the cleaned tree; the main features (`origin/main`
codex-hud bar, panel, brief, installer) must work after every package. Implementers per the brief: **Grok** core
code, **pi** well-specified tests/fixtures, **frontend-implementer** rendering (design by the Fable-max subagent per
the owner's routing). Sizes: S ≤ half a day, M ≤ 2 days, L more.

| WP | Goal | Files / areas | Acceptance | Size | Who |
|---|---|---|---|---|---|
| **WP0** Baseline | Freeze what must stay green | tag `v1-historical`; `tests/run-core.sh` lists the main-feature suites (render, collectors, settings, visual baselines, integration); record `npm test` and `npm run test:visual` results | the list exists and passes at `e533c44` | S | Grok |
| **WP1** Cut the hot spots | Live processes stop importing the historical stack | `src/index.ts` (H1: 3, 113–122, 198–209, 227–232, 239–253, 280–303, 316, 320, 347, 407, 426), `src/tree-page.ts` (H2: 1–13, 286–289, 343–346, 372–386, 1027–1035, 1156–1163, 1179–1190, 1299, 1785–1812, 1878–1885), `src/cli/statusline.ts` + `src/core/statusline-summary.ts` (H3), `src/cli/hud.ts` (H4), `src/harness/pi/footer.ts:8` + `extensions/pi/hud-footer.ts` (H16); a temporary `ChildrenCollector` returning `[]` replaces `NativeCallCollector` + `merge` | `tsc --listFiles` for `dist/index.js`, `dist/tree-page.js`, `bin/hud-statusline` contains no `src/ledger`, `src/core/link`, `src/core/run`, `integrations/herdr`; visual baselines unchanged except the removed delegation scenes; `npm test` green | M | Grok |
| **WP2** Delete segment A (historical stack) | Remove the dead code and its tests | `src/ledger/*`, `src/core/run/*`, `src/core/link/*`, `src/core/capacity.ts`, `src/core/observation.ts` projections, `src/collectors/delegation.ts`, `src/render/delegation/*`, `integrations/herdr/*`, capability/qualification modules, `src/cli/{run,run-wait,cache,migrate,digest,pi,launcher,link-export}.ts` (move `HudIO` to `src/cli/io.ts`), `bin/hud-run` + `package.json` `bin.hud-run`, runtime package scripts, `packages/hud-mcp/src/tools.ts`, `tests/fixtures/b10b-*`; delete the 72 HIST-ONLY and 98 MIXED-mostly-hist tests; trim the 205 MIXED-mostly-keep tests; dead stubs of inventory §7 (`src/managed/manager.ts`, `store.ts`, `core/interfaces/run-control.ts`, `core/launch/types.ts`, `render/delegation/index.ts`, `render/workbench.ts`, `render/subagent-tree-view.ts`, `render/sparkline.ts`, `collectors/history.ts`, `src/test-render.ts`) | `npm test` green; `git grep -l 'ledger\|delegate_\|hud-run' src packages bin` returns only `src/types/node-sqlite.d.ts` (daemon binding) and docs; `tsconfig.test.json` builds | M | Grok (+ pi: rewrite the shared fixtures the kept tests need) |
| **WP3** hud-mcp v2 core | Identity, tool table, child mode, env capture | `packages/hud-mcp/src/{main,server}.ts` simplified (no `bodies`, no `CallBudget`, no resolver); new `identity.ts` (§1.9), `env-capture.ts` (§6.2), `tools.ts` = Appendix B; delete `resolvers.ts`, `registry.ts`, `config.ts` (delegate/native parts), `hook/*`, `pi-channel.ts`, `pi-host.ts`, `wake-registration.ts`, `bin/hud-claude-hook.mjs` | tests (pi): `_meta` of the three shapes → owner; Claude registry fixture with mtime change → new session id; child mode refuses in ≤ 1 ms without touching the socket; env capture from a fake `/proc` reader strips `HUD_*` | M | Grok (tests: pi) |
| **WP4** Host v2 | One host, subscription, summaries, lifecycle | `src/managed/{host,host-ipc,host-entry,child-record,child-summary,jev-host}.ts`; normalisation in the three adapters (`harness/*/…-adapter.ts`), compact `hud_read` (F8: never return `initializationResult`, `sdk-adapter.ts:229-235`), idle/grace timers with injected clock, Jev release kill (F7), read-only paths never spawn (F6) | tests (pi, fake adapters): host exits `graceExitMs` after the last close; `list` on a dead socket returns records with `unavailable`; subscription fan-out and slow-reader drop; idle timeout never fires during a turn; `hud_read status` ≤ 2 KiB for a 38 KiB fake init result | M | Grok (tests: pi) |
| **WP5** Wake v2 | Three wake paths, receipts advisory, retry once | `src/managed/wake.ts`, `src/cli/wait.ts` (`hud wait`), Pi delivery in WP8 | tests (pi): fake `codex` binary slow by 3 s → `accepted`; cursor advance suppresses the retry; waiter prints one line and exits on event / host down / timeout | S | Grok (tests: pi) |
| **WP6** Children collector + tree merge | Children are agents in the tree; dry-run shows them | `src/collectors/children.ts`, `src/types.ts` (3 fields), `src/index.ts`, `src/tree-page.ts`, `src/collectors/brief-dry-run.ts`, `subagent-tree.ts` multi-root parent map, `harness/claude/topology.ts` for Claude child subagents; `recapInput` over `MainTranscript` (Codex only) | tests (pi): fixture host → nodes with the mapping of §2.8; `agentCounts` counts children as agents; dry-run output contains child lines within the limits of §4.3; `CODEX_HUD_PROFILE` `children` stage ≤ 5 ms p99 with three fake children | M | Grok (tests: pi) |
| **WP7** Rendering | Harness glyph, request line, Inspector sections, bar alert/notice, statusline line 2, Pi footer counts, i18n | `render/{cards,subagent-chip,monitor-inspector,monitor-timeline,attention,statusline-*}.ts`, `collectors/bar-notices.ts`, `harness/pi/footer.ts`, `render/i18n.ts`, visual baselines | visual tests at 32/40/48/56, EN/ZH, both colour modes; §8 checklist of `docs/ARCHITECTURE.md`; a card with a pending request shows the `⚑` line and the bar alert names it | M | frontend-implementer (design: Fable-max) |
| **WP8** HUD Pi package | Parent in-process tools, child `ask_orchestrator`, wake, footer | `packages/hud-pi/*`, `src/harness/pi/{hud-parent,hud-child,footer}.ts`; delete `extensions/pi/hud-delegate.ts`, `extensions/pi/hud-footer.ts`, `integrations/pi/hud-wake.ts`, `harness/pi/{delegation-bridge,delegation-channel,delegation-context,wake-extension}.ts` | tests (pi): a Pi rpc child's `ask_orchestrator` → `request` event → `hud_respond` → tool returns the answer; a parent session's tools call the fake host with the right owner; footer line from a fake subscription; pi-roles note filed for the `ask_orchestrator` registration rule | M | Grok (tests: pi) |
| **WP9** Installer, registration, skill, docs | One install + one registration; docs match | `install.sh` (build hud-mcp, link the Pi bundle, print registrations), `hud setup` (prints the same and checks the socket dir), `integrations/skills/hud-delegate/SKILL.md` rewritten for `hud_*`, `docs/ARCHITECTURE.md` §"Children", `docs/reference.md` child display + env table, `docs/delegation.md`; historical docs moved to `docs/archive/` | `./install.sh --sync` on a clean clone builds both programs; `hud setup` output matches the doc; `docs/reference.md` lists every new model input | S | Grok |
| **WP10** Real-client matrix | Close F2–F8 on real clients | `scripts/local-validation/*` without `delegate.json`/`native.json`/hook; 3 parents × 2 children + Jev, each create/send/read/resume/close/wake; performance checks of §2.6 | the results table of `docs/cloud/handoff/local-real-client-results-20261107.md` re-run with all rows PASS, wake rows included; no process left after the last close (`pgrep -f hud-mcp|host-entry|app-server` empty) | L | Hermes-style human-interaction run by the owner; pi for the scripts |
| **WP11** Non-Codex roots (phase 2) | Claude/Pi roots get the recap and a standalone panel | `claudeMainTranscript`, `piMainTranscript`, `hud panel --session`, status card variants without Codex-only fields | dry-run `--root claude` prints recap material within limits; the standalone panel shows a Claude root with its children | M | Grok + frontend-implementer |

Ordering: WP0 → WP1 → WP2 → WP3 → WP4 → WP5 → (WP6 ∥ WP8) → WP7 → WP9 → WP10 → WP11. WP3 and WP4 can start
on a branch during WP2 because they touch `packages/hud-mcp` and `src/managed` only; they merge after WP2.

---

## 8. Open questions for the owner

1. **Pi attaches in-process** (§3.1): the HUD Pi package registers the tool table through `pi.registerTool` and
   talks to the host directly, with no `hud-mcp` subprocess. This reads the fixed input's "parent-side MCP
   connection" as the attachment, not as a stdio MCP process. Confirm, or require the stdio form (cost: one
   process + handshake per Pi session, the identity hello of §3 instead of fd 3).
2. **One host per user** (§6.1) versus one per owner. Chosen: per user (lighter, one socket for the TUI, natural
   "parent exits, host continues"). The price is blast radius: a host crash takes every owner's children with it.
3. **Codex children see the `hud` tools** and are refused on call (§1.4). Alternative: pass
   `thread/start.config = { mcp_servers.hud.enabled: false }` to Codex children only, which keeps the child's
   context free of the tool schemas but is a configuration change HUD makes on the child's behalf.
4. **Default `idleCloseMs` = 30 min** for a child with no running turn and no parent read/send. Shorter saves
   memory (a Codex child with 8 MCP servers is not small); longer keeps warm contexts for follow-ups.
5. **Non-Codex roots in v2 or phase 2** (WP11). v2 as planned gives a Claude root the statusline (line 1 + children
   line 2) and a Pi root the footer, with the standalone panel and recap for those roots in WP11.

Everything else in §1–§7 is decided here and does not need the owner.

## 9. Risks

- **Undocumented carriers.** `x-codex-turn-metadata` and Claude's `sessions/<pid>.json` are not documented
  interfaces; a version may change their shape or stop updating the registry on `/clear`. Mitigation: WP10 pins
  the versions it was verified against in the validation doc; the identity module has one function per carrier
  with a fixture test; a change shows as `invalid_arguments` with the raw `_meta` keys named, never as a silent
  mis-attribution.
- **Codex daemon mode.** When Codex runs its shared daemon, MCP servers are spawned by the daemon and the
  harness ancestor's environment is the daemon's, not the TUI's (§6.2). The owner's TUIs run embedded today
  (matrix §2.2); if that changes, the Codex parent should pass `env` through `mcp_servers.hud.env` for the few
  variables that matter, which is still one registration.
- **`codex queue` reliability** is bounded by Codex (idle-only, ~10 s poll, daemon guard). The design tolerates a
  lost wake (the parent's next call drains events) but a Codex parent that never calls again stays asleep.
- **Single host crash** (Q2) ends every child; children's native sessions remain resumable, and the panel shows
  `closeReason: host_exit`.
- **Claude SDK pin vs installed `claude`.** `package.json` pins `@anthropic-ai/claude-agent-sdk 0.3.319` while the
  child runs the user's installed executable (`sdk-adapter.ts:69-91`); drift can break callbacks. WP10 records the
  pair that passed.
- **Pi rpc `ctx.ui` in a tool.** §3.3 assumes a tool-initiated `ctx.ui.input/select` surfaces as an
  `extension_ui_request` in `--mode rpc` (the adapter already relays that request type). WP8's first test checks
  it against the installed pi; if it does not, the fallback is a `hud_ask` rpc-side custom event with the same
  host mapping.
- **Deletion churn.** 205 tests need edits (Appendix A); the risk is dropping main coverage by accident. WP0's list
  is the guard, and WP2 must leave the visual baselines byte-identical outside the removed scenes.
- **Child startup cost** (7–15 s) stays as long as the user's configuration loads many MCP servers; HUD will not
  trim it (non-interference). The card's `starting` clock makes it visible rather than hidden.
- **Attribution of native-subagent callers to the root** (§1.3) means a Codex implementer's reviewer subagent could
  create a HUD child that the tree shows under the root, not under the reviewer. Acceptable for depth-one display;
  noted so it is not mistaken for a bug.

---

## Appendix A. Inventory summary (from the git-ignored `tmp/tasks/DES1/inventory.md`, at `f26e873`)

Totals: `src/` + `packages/hud-mcp/` 391 files / 99 164 lines, of which 139 files / 31 803 lines are removable with
the historical stack. Tests: 630 files / 179 002 lines — 72 HIST-ONLY (13 165 lines) and 98 MIXED-mostly-historical
(32 005) to delete, 205 MIXED-mostly-keep (78 565) to trim. Docs: 250 historical files / 65 291 lines.

Process-start module loads: `hud run wait` 119 modules / 31 592 lines (37 historical, 14 in `src/ledger/*`); bar
`src/index.ts` 149 / 44 646 (36 historical / 11 420); panel `src/tree-page.ts` 193 / 63 945 (46 / 13 887);
statusline 44 / 13 192 (2 historical); hud-mcp `main` 39 / 7 606 (0); `host-entry` 16 / 3 340 (0).

"KEEP?" groups and their v2 fate: cli-pi 11 modules / 4 655 lines (Claude/Pi transcript readers, `core/checkpoint.ts`,
`harness/claude/background|todos`) → readers kept for roots (§2.3, §4.2), `hud pi inspect` deleted; pi-footer 6 / 966 →
kept, data source changed (§2.4); cli-cache 2 / 595, cli-migrate 4 / 556, cli-launch 3 / 351 → deleted; brief-dry-run
2 / 119 → kept and extended (§4.3).

Hot spots (inventory §6) and the package that cuts each: H1 bar collector/merge (`src/index.ts`) → WP1; H2 panel
collector, Herdr `PanelHostController`, `DelegationLogView`, `PublicationWorker` (`src/tree-page.ts`) → WP1; H3
statusline line 2 ledger read (`src/cli/statusline.ts`, `src/core/statusline-summary.ts`) → WP1; H4 `src/cli/hud.ts`
static imports + `CallBudget` → WP1/WP2; H5 `src/cli/run.ts`, H6 `src/cli/run-wait.ts` (legacy wait beside
`runNativeWait`, 306–359), H7 `src/cli/runtime.ts`, H8 `src/cli/link-export.ts` (`HudIO`) → WP2; H9
`packages/hud-mcp/src/server.ts` bodies and `tools.ts` legacy → WP3; H10 type refs to `core/ledger-scope-read.ts`,
`config.ts` validator, `FileCallerRegistry`, `WakeRegistration` → WP3; H11 `packages/hud-mcp/src/lifetime.ts` →
`src/core/run/process.ts` (move `readProcess`/`sameProcessStamp` to a neutral module) → WP3; H12 native-call rows in
`DelegationViewModel` / `LinkTreeProjection` → WP6 (own projection) then WP2 deletes `render/delegation/*`; H13
packaging scripts → WP2; H14 `bin/hud-run` → WP2; H15 `tsconfig.test.json` single program + shared fixtures → WP2;
H16 Pi footer → ledger → WP1/WP8; H17 `install.sh` builds only `npm run build` → WP9.

## Appendix B. Tool table (served by hud-mcp to Codex and Claude parents; registered in-process for Pi)

| Tool | Arguments | Returns | Notes |
|---|---|---|---|
| `hud_create` | `{ harness:'codex'\|'claude'\|'pi', cwd, prompt?, name?, model?, effort?, resume?: NativeRef, fork?: NativeRef, options?: { args?: string[] /* pi only */, approvalPolicy?, sandbox? /* codex only, forwarded verbatim */ } }` | `{ child, harness, nativeRef, seq, wake: { kind:'automatic' } \| { kind:'background_command', command, note } }` | starts the host if needed; `prompt` sends turn 1; `resume` of a live child of another owner → `child_busy` |
| `hud_send` | `{ child, text, mode?: 'turn' \| 'steer' }` | `{ seq, turn }` | `steer` only while a turn runs (Codex `turn/steer`, Claude message push, Pi `steer`) |
| `hud_wait` | `{ child?, afterSeq, waitMs?: ≤ 120000 }` | `{ events: ChildEvent[] ≤ 50, seq, truncated }` | long-poll; advances the owner's read cursor (wake retry suppression) |
| `hud_read` | `{ child, what: 'status' \| 'result' \| 'transcript' \| 'context', offset?, limit? }` | `status` → `ChildSummary` (≤ 2 KiB); `result` → last turn text paged (≤ 32 KiB/page); `transcript` → recent public messages (`limit` ≤ 50, each ≤ 2 KiB); `context` → usage | never returns SDK init results (F8) |
| `hud_respond` | `{ child, requestId, response: { decision?: 'allow' \| 'deny', text?, option? } }` | `{ ok }` | maps to Codex `execCommandApproval`/input answers, Claude `canUseTool`/elicitation/dialog results, Pi `extension_ui_response` |
| `hud_cancel` | `{ child }` | `{ ok }` | interrupts the running turn only |
| `hud_close` | `{ child }` | `{ ok, closeReason:'closed' }` | ends the process; the native session stays resumable |
| `hud_list` | `{}` | `{ children: ChildSummary[] ≤ 50, jev: JevSummary[], host: { uptimeMs } }` | read-only; answers from records when the host is down |
| `jev_open` | `{ url, goals?, screenshots?: false, record_dir? }` | `{ instanceId }` | replaces `jev_create` |
| `jev_run`, `jev_snapshot`, `jev_command`, `jev_close` | as today (`packages/hud-mcp/src/jev-tools.ts:26-67`) | as today | `jev_list` folds into `hud_list` |

Codex `_meta`, Claude `claudecode/toolUseId` and Pi call ids are accepted on every call; nothing in `arguments`
selects an owner. Error codes: `depth_limit`, `child_busy`, `host_unavailable`, `invalid_arguments`,
`child_not_found`, `request_not_found`, `jev_python_not_found`.
