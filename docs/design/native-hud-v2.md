# Native HUD v2.2: identity, display, Pi package, summaries, wake, lifecycle, migration

Design decision document, revision 2.2 (2026-11-07), branch `universal-hud` at `e9dc2d1` (the code is identical to
`9e46378` and `e533c44`; the later commits only added documents). v2.1 applied the ChatGPT Pro review of v2 (ACCEPT
WITH CHANGES, ten required changes) and the owner's decisions of 2026-11-07 on the five open questions and the
three forks that followed (§8; nothing is left open). v2.2 applies the Opus review of v2.1 (ACCEPT WITH CHANGES:
H1–H2, M1–M10, L1–L10, and the simplification O1), after re-reading every code reference it cited; all of them
held. Where a review corrected this document's reading of the code, the correction is stated in place. The document
answers the seven questions of the DES1 brief inside the owner's fixed inputs (`docs/universal-hud-concept.md` §15,
entries "2026-11-07 本地对齐：产品定义重置" and "2026-11-07 设计定稿").

Jev (the ChatGPT/Gemini ask driver, the Jev Ultrafast port under `src/jev/`, the `jev_ask*` and `jev_*` tools, the
decision providers) is designed in the companion document **JEV1** (`docs/design/jev-in-hud.md`). This document
points to it and does not duplicate it; Appendix B copies its tool arguments verbatim.

Baselines (WP0): review SHA `9e46378` (code); `main` SHA `9108482`, the main-feature baseline every package
preserves. Paths are repo-relative; `file:line` refers to the tree at `9e46378`. Every example (ids, paths, names)
is synthetic.

The thesis in four lines:

1. **Identity is data the harness hands us, bound once per attachment and rebound cheaply.** Codex says which
   thread calls in `_meta`; Claude writes its live session id in a per-pid registry file; the Pi extension *is* the
   session. Per-call verification (`/proc` ancestry, hook records, fd-3 tickets, rollout headers) goes away. What
   stays is a small binding contract (§1.2): validate the carrier, snapshot the caller per request, fence stale
   callbacks when the session changes, keep the source location.
2. **An MCP child is an agent in the tree the panel already draws, read from a file.** Children of any harness are
   projected into `SubagentTreeNode` (`src/types.ts:451`) from the child records the host writes, so cards,
   timeline, agent log, bar counts, notifications, briefs, progress notes, digests and names work through the same
   code, and the TUI costs one `stat` per tick (§2.8). `src/render/delegation/*` and the link view model are
   deleted. Connection lifecycle and turn outcome are separate facts; "closed" never means "succeeded".
3. **One host per HUD home, with a clock and a bounded close.** The host starts only on `create`, never on a read,
   exits by itself when nothing is retained, closes quiescent children on a timer, and owns every process it starts
   through a tested close ladder and a crash sweep (§6.1).
4. **Pi attaches in-process, and a child never sees the HUD tools.** The HUD Pi package registers the same tool table
   through `pi.registerTool` and shares hud-mcp's validation and dispatch; in a child of any harness the HUD tool
   table is empty, direct calls are refused, and the host enforces depth again (§1.4). Children ask their parent
   through one request path and the parent answers with `hud_respond` (§3.3).

---

## 0. Fixed inputs, restated as constraints on the design

| Fixed input | What it pins in this document |
|---|---|
| Any of Claude Code / Codex / Pi is the main session; symmetric roles | §1 one identity rule per harness, same tool table and the same child projection for all three (§2) |
| MCP is the one interface (create, send, read, resume, close, wake) and the TUI's data source | Appendix B tool table; the TUI reads the child records the host writes, nothing else (§2.3, §2.8) |
| Non-interference: connect and observe; children keep the harness's own configuration, including permission modes; HUD only passes the user's environment through | §6.2 environment capture; no `-c`, no settings file, no MCP config override for children; no permission-mode fields in the model-facing API and no permission changes through answers (§1.4, §3.3, Appendix B) |
| Pi exception: `pi -ne -ns -e <HUD Pi package> [-e pi-roles]`; the package gives channel, wake, footer, events | §3, in-process (Q1 decided) |
| Depth one; children do not obtain the hud MCP; children's native subagents unrestricted, shown read-only | §1.4 child mode: empty tool table, call refusal, host-side depth; §2.3 rows "native subagent of a child" |
| Display scope: the root (any harness), its MCP children, their native subagents; nothing else | §2.2 owner-scoped collection |
| Keep all `origin/main` features; delete the historical stack | §7 work packages, Appendix A |
| Lightweight, fast, clear; performance first-class; one install + one registration per harness; bounded lifecycles | §1.5, §2.6, §6.1 |
| Child requests are answered by the main session through `hud_respond` (as herdr's `ask_orchestrator`); re-wake after 1 h, withdraw and close `abandoned` after 2 h, both configurable | §3.3 completion evidence, §5.1 wake list, §6.1.4 |

---

## 1. Identity and attachment

### 1.1 Today, in the code

- Every tool call resolves the caller again: `packages/hud-mcp/src/server.ts:131`
  `const resolution = await this.source.resolve(params._meta, definition.name);`, and
  `SessionRefResolver.resolve` (`packages/hud-mcp/src/resolvers.ts:157-364`) rechecks ancestry and process start
  stamps (161-178, 349-353), denies a harness whose argv contains `app-server|daemon` (177-178), compares
  `/proc/<pid>/exe` with a configured path (203), reads Claude's registry (204-217), consumes a hook record
  (220-227), requires both Codex carriers and compares them (270-281), rejects a native subagent caller whose
  `threadId` differs from `sessionId` (283-289), locates the Codex rollout and parses its header (290-299), and
  refuses a Codex turn whose `turn_trigger` is not `exec` on an `exec` source (302) — the cause of F2 in
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
- Ownership includes a `sourceId` (`src/managed/relations.ts:5-22`): source location matters today, and v2.2 keeps
  it as recorded data (§1.2) rather than as part of the key.
- Codex starts stdio MCP servers with a minimal environment — `HOME LANG LOGNAME PATH SHELL TERM USER` plus the
  registration's `env` table (`docs/probes/codex-mcp-launch.md`, conclusion table) — so a hud-mcp under Codex
  sees neither `HUD_HOME` nor `CODEX_HOME` in its own environment (§1.3, §6.2).

### 1.2 Decision: declared identity with a binding contract

Identity is **declared at attachment and rebound from a cheap local source**, never verified against process
evidence. An *attachment* is one physical connection (one hud-mcp stdio process, or one HUD Pi extension instance)
carrying one *current logical session*:

```ts
Attachment { attachmentId, owner: { harness, sessionId }, source, home, generation }
```

- `attachmentId` = `sha256(pid '\0' procStart)` of the hud-mcp process, a random UUID for a Pi extension instance.
  Two attachments to one resumed session share the owner key but keep their own observer long-polls and wake
  bindings, keyed by `attachmentId` (§5).
- **Owner key** = `(harness, sessionId)`; `ownerKey = sha256(harness + '\0' + sessionId)[:16]`. `source` — the
  `CODEX_HOME`, `CLAUDE_CONFIG_DIR` or Pi session directory the session lives in — leaves the key but is **recorded**
  on every child record and compared: a caller presenting the same `(harness, sessionId)` from a different source
  (a copied home, a copied session file) is refused with `source_mismatch`; `hud_create{resume}` uses the recorded
  source, never whichever home the new caller happens to supply.
- **Where `home` and `source` come from** (M1): at attachment hud-mcp resolves `HUD_HOME`, `CODEX_HOME` /
  `CLAUDE_CONFIG_DIR` and the child marker `HUD_CHILD`/`HUD_CHILD_OF` with one precedence: its own environment, then
  (Linux) `/proc/<harness ancestor pid>/environ`, then the defaults (`~/.hud`, `~/.codex`, `~/.claude`). Under Claude
  the first step suffices (Claude does not clear the environment it gives stdio servers, `docs/probes/cc-mcp-env.md:43`); under
  Codex the second is the normal path because of the minimal MCP environment (§1.1). On a platform without
  `/proc`, a Codex registration needs `env = { HUD_HOME, CODEX_HOME }` in its table; Linux needs nothing.
- `generation` increments on every rebind: Claude registry change after `/clear` or `--resume` inside one process
  (observed in `docs/probes/b1-call-source.md:69-79`: harness and MCP pids persist, the registry changes), Pi
  `session_start`/switch/fork, and for Codex a call whose `session_id` differs from the attachment's (L1: Codex
  binds its owner from the first call's `_meta`; the probe shows `/new` replacing the MCP instance and native
  subagents getting their own MCP pids, so a rebind inside one Codex process is not expected, but the same rule
  handles it). Observer long-polls, wake bindings and in-flight callbacks carry the generation they were created
  under; the host ends observers and drops wake attempts whose generation is stale.

The binding contract, per request:

1. **Validate the carrier; reject contradictions.** Codex: when both `_meta.sessionId/threadId` and
   `x-codex-turn-metadata.session_id/thread_id` are present they must agree, else
   `invalid_arguments{carrier_mismatch}`; when only one carrier is present it is accepted. Today's code requires
   both (`resolvers.ts:270-281`), so the single-carrier case is new behaviour with its own fixture (WP2a) and probe
   P5 records which shapes the real clients send. Claude: the registry record must carry the pid and process start
   captured at attachment (as `resolvers.ts:206-208` checks today), else `identity_unavailable`; a missing or
   malformed registry is an error, never "the last session".
2. **Snapshot the caller per request.** The `Caller` resolved at request entry travels in the host envelope; an
   asynchronous operation never re-reads "the current session" mid-flight and never acts for a replacement session.
3. **Fence by generation**, as above.
4. **Host-side scoping and depth.** Every mutation resolves under the full owner tuple at the host; a `create`
   whose owner is itself an active child (§1.4) is refused with `depth_limit` whatever the MCP decided.
5. A **call id** (Codex `callId`, Claude `claudecode/toolUseId`, Pi tool call id) is recorded on the child record
   for display and dedupe only.

### 1.3 The source of truth per harness

| Parent harness | Session identity | Where it comes from | Refresh | Notes |
|---|---|---|---|---|
| Codex | `x-codex-turn-metadata.session_id` (root thread) and `.thread_id` (calling thread), or `_meta.sessionId`/`threadId` (`resolvers.ts:270-281` shows both carriers); both present → must agree | every `tools/call` `_meta`; `source` = `CODEX_HOME` resolved per §1.2 (ancestor environ under Codex) | per call, zero cost; a different `session_id` is a rebind | A native subagent of the root (`thread_id != session_id`, `parent_thread_id` set) is **accepted and attributed to the root session** and shares the root's HUD ownership scope; the calling thread is kept as `caller.threadId`. `turn_trigger` is ignored (F2). `thread_source` is ignored. |
| Claude Code | `<CLAUDE_CONFIG_DIR>/sessions/<claude pid>.json` `.sessionId` — the registry Claude keeps current (the hook, `hook/command.ts:90-101`, and the resolver, `resolvers.ts:204-217`, already require it to match the live session) | at attachment: the MCP's parent `claude` pid (ppid walk ≤ 8, `packages/hud-mcp/src/process.ts:95-121`, run **once**) and `CLAUDE_CONFIG_DIR` per §1.2 (own env under Claude) | one bounded read (≤ 16 KiB, the bound `hook/command.ts:91` uses today) of the registry per call, matched against the captured pid and process start; a changed `sessionId` is a rebind | No PreToolUse hook. `claudecode/toolUseId` is the call id. Claude native subagents (Agent tool) share the process and are attributed to the root. |
| Pi | `ctx.sessionManager.getSessionId()` inside the HUD Pi package (§3) | the extension itself; `session_start` / `session_before_switch` / fork / tree events rebind | event-driven | No hud-mcp process, no fd 3, no tickets. |

Resume and multiple sessions: Codex `codex resume <id>` keeps the thread id, Claude `--resume` keeps the session
id, Pi resume keeps the session header id (`src/harness/pi/delegation-context.ts:158-231` reads it today) — the
owner key is stable across resume, so the parent lists its children again (the "same parent resumes, lists,
reads" row of the results table). Two *different* sessions of one harness are two owner keys; two attachments to
the *same* resumed session share the key and the host serves both (§6.1). A fork is a new session with no
children; it may adopt a *closed* child with `hud_create{resume}` (§1.9), never a live one of another owner
(`child_busy`). Registry freshness across every Claude in-process resume path and future client versions is
unverified: probe P1 (§7) checks it on the real clients before the deletions start.

### 1.4 Child mode (Q3 decided): no HUD tools in a child, refusal, host-side depth

A child Codex or Claude starts with the user's configuration, which includes the `hud` MCP registration (F3 counted
8 MCP servers per Codex child). HUD does not change that configuration; the same `hud-mcp` binary detects that it
runs inside a HUD child and exposes nothing:

- The host sets `HUD_CHILD=<childId>` and `HUD_CHILD_OF=<ownerKey>` in every child's environment (the launch
  marker). Pi children never load hud-mcp at all (`-ne`); the HUD Pi package in child mode registers only
  `ask_orchestrator` (§3.1).
- hud-mcp classifies itself **at `initialize`** from the marker — (a) its own environment (Claude forwards it),
  (b) on Linux the harness ancestor's `/proc/<pid>/environ` (the ancestor is the child's own `codex`/`claude`
  process, whose launch environment the host set, so Codex's minimal MCP environment cannot hide the marker) — and
  again on every rebind. The empty tool table rests on (a)/(b). (c) The **active-child index**
  `~/.hud/active/<childId>.json` (one small file per live child, written by the host before the first prompt, carrying
  the native thread/session id once the harness has bound it, removed on close) guards **calls**: a caller whose
  session id appears in the index is refused even when the marker was lost. For Codex the session id arrives only
  in `tools/call` `_meta`, after `tools/list` was answered, so (c) cannot shape the table (L3); for a new Claude
  child the native id is known only from the first SDK message (`sdk-adapter.ts:300-311,323-331`), which is why the
  index is keyed by `childId` and gains the native key on binding (L2). Never a scan of the historical `children/`
  directory, never a result cached for the process lifetime.
- In child mode `tools/list` returns an **empty** table. A direct `tools/call` of a HUD tool (a cached schema, a
  hand-written call) answers `{error:'depth_limit', message:'This session is a HUD child; ask the orchestrator
  instead.'}` without touching the socket; nothing in child mode ever starts a host.
- The host refuses `create` for an owner whose session id is in the active-child index (§1.2 rule 4): depth is
  enforced twice, once at the MCP and once at the host.
- Publication precedes input: the host writes the active-child index entry and the child record, and only then sends
  turn 1. A write failure fails the `create` with `child_record_unavailable`. Today `bind` swallows relation-write
  errors into `persistenceError` (`src/managed/host.ts:106-120`); that cannot stay once the record enforces depth.
- The child's native subagents (Codex `spawn_agent`, Claude Agent tool) are untouched; they inherit the marker and
  are therefore child-mode too.

Rejected: passing a per-thread config override (Codex `thread/start.config`, Claude SDK `mcpServers` +
`strictMcpConfig`) to drop the `hud` server. The Claude form drops *all* user servers (violates non-interference);
the Codex form is version-dependent and still leaves Claude different. The marker + empty table costs nothing and
is uniform. (Q3 of v2 is closed; §8.)

### 1.5 What the user configures (one install, one registration per harness)

- `./install.sh` builds `dist/`, `packages/hud-mcp/dist/` **and** `packages/hud-pi/dist/` (today it runs only
  `npm run build`, inventory H17) and prints:
  - Codex: `codex mcp add hud -- node <checkout>/packages/hud-mcp/bin/hud-mcp.mjs` (or the `[mcp_servers.hud]`
    table for `config.toml`), once per `CODEX_HOME` in use. No `env` block on Linux (§1.2).
  - Claude: `claude mcp add --scope user hud -- node <checkout>/packages/hud-mcp/bin/hud-mcp.mjs`.
  - Pi: `pi install <checkout>/packages/hud-pi` — pi's supported package registration (it writes the package
    declaration into pi's `settings.json` under the configured agent directory; `PI_CODING_AGENT_DIR` is honoured).
    For a child started with `-ne`: `-e <checkout>/packages/hud-pi`. v2's claim that a link under `~/.pi/bundles/`
    is enough was wrong: pi 1.5.0's extension loader discovers the project and global extension directories,
    configured packages and explicit `-e` paths, and a package directory is accepted through its `package.json`
    `pi.extensions`; it does not discover a bundles directory. The owner's `~/.pi/bundles/hud` link is kept only as a
    stable path for `-e` (pi-roles is loaded the same way, by its launcher). The global registration loads the
    package in parent mode into every interactive `pi` that does not pass `-ne` — intended: that is how the owner's
    Pi main session gets the tools; `pi-role` sessions pass `-ne` and do not load it (L10).
- `HUD_HOME` defaults to `~/.hud` (0700). Tests set it explicitly; users never do.
- `~/.hud/config.json` is optional and small: `{ idleCloseMs, graceExitMs, requestStaleMs, requestAbandonMs,
  turnDeadlineMs?, startTimeoutMs, closeTimeoutMs, maxChildren, codex: { executable }, claude: { executable },
  pi: { executable }, jev: { … } }`.
  The `jev` block is JEV1 §4.6 (shared-Chrome settings, `stateDir`, proxy, decision backend, ask limits); Jev
  credentials live in `~/.hud/jev.env` (0600), read per job; there is no interpreter setting because there is no
  Python (JEV1 §4.1). Nothing in the file changes a child's behaviour; it only says where HUD finds programs and how
  long it keeps processes.

### 1.6 Fate of today's pieces

| Piece | v2.2 |
|---|---|
| `delegate.json` (`config.ts:144-189`), `HUD_MCP_PROFILE` (`main.ts:24-26`) | deleted; harness inferred from the call |
| `native.json` (`host-config.ts:59-71`), `nativeProfiles` env merge (`host-config.ts:72-120`) | deleted; children launch with the harness defaults on the captured environment; per-create options come from the orchestrator (Appendix B; `options` is Pi-only and rejected elsewhere) |
| Claude PreToolUse hook (`packages/hud-mcp/src/hook/*`, `bin/hud-claude-hook.mjs`, `HUD_CLAUDE_HOOK_CONFIG`, `claude.settings.json`) | deleted; replaced by the registry read in §1.3; WP11's upgrade check reports leftover hook entries |
| `/proc` evidence (`process.ts:22-40` reads `stat`, `cmdline`, `environ`, `ns/pid`; `pi-host.ts:12-35`; `hook/process.ts:66-116`) | no longer identity evidence. `/proc/<pid>/environ` of the harness ancestor stays as the **environment source** (§6.2), the **home/source resolver** (§1.2) and the **child-marker source** (§1.4) on Linux; `findHarness` runs once at attachment |
| Pi fd-3 channel (`delegation-channel.ts`, `delegation-context.ts`, `pi-channel.ts`, `pi-host.ts`) | deleted (§3) |
| `MemoryCallerRegistry`/`FileCallerRegistry`/`registerCaller` (`registry.ts:25-146`) | deleted |
| `wake_register` on every call (`main.ts:60-90`, `host-wake.ts:158-205` methods) | replaced by a wake binding computed at attachment and refreshed on reattach (§5) |
| `identity_unverified`, `stale_context`, `unsupported` resolutions (`resolvers.ts:18-27`) | the refusal classes left: `depth_limit`, `child_busy`, `host_unavailable`, `host_shutting_down`, `host_incompatible`, `invalid_arguments`, `identity_unavailable`, `source_mismatch`, `limit_exceeded` |
| Python Jev bridge (`src/managed/jev-bridge.py`, `PythonJevBridge`, `HUD_JEV_PYTHON`) | deleted with the TypeScript port (JEV1 §4.1) |
| `packages/hud-mcp/src/tools.ts` (legacy `TOOLS`, imported by `server.ts:9`) | deleted in WP2b; the new shared module is `hud-tools.ts` (M8), so nothing overwrites a file a later package deletes |

### 1.7 Security posture (single-user local tool)

Still defended: (a) other local users — `HUD_HOME` 0700, socket 0600, child records 0600, `writePrivateFile`
pattern as on main (`docs/ARCHITECTURE.md` §5.1); (b) accidental cross-session action — every host request carries
the owner and the host only lists/acts on that owner's children; the source check of §1.2 catches a copied home;
(c) terminal injection — wake and notice text is control-stripped (`src/notify.ts` already does this;
`src/managed/wake-message.ts` keeps the 512-byte cap); (d) **HUD's own summary traffic** leaves the machine only
when the model features are on (§4). (d) says nothing about the children, their configured MCP servers and plugins,
or Jev's browser, which talk to the network on their own terms; HUD neither adds nor removes that. (e) The
orchestrating model cannot change a child's permission mode or the user's settings through HUD (§3.3, M10).

Deliberately dropped: proving that the calling process is the session it claims (ancestry, procStart, exe path,
rollout header digest, hook tombstones, fd ownership, fingerprints). A same-uid process can already read every
file and signal every process; the checks defended a boundary that does not exist and cost a process spawn per
Claude call and ~300 lines per harness.

### 1.8 Rejected alternatives

- *Keep per-call verification but fix F2.* Removes one line (`resolvers.ts:302`) and keeps the hook, fd 3, three
  config files and the `/proc` rechecks. It does not meet "one install + one registration", and the hook is a
  spawn per call.
- *Bind once at `initialize` with a secret in `mcp_servers.hud.env`.* Needs per-harness env in the registration,
  cannot follow a session change inside a live process (the probes show one), and adds a credential to a tool with
  no adversary.
- *A per-owner host as today (`host-ipc.ts:27-30`, one socket per `ownerKey[0:32]`).* See §6.1.
- *A lifetime-long session cache per MCP process* (v2's "declared once"). The probes show the session changing
  under a live MCP process; the cheap rebind of §1.2 is what the evidence supports.

### 1.9 Interfaces

```ts
// packages/hud-mcp/src/identity.ts (replaces resolvers.ts, registry.ts, hook/*, pi-channel.ts, pi-host.ts)
export interface Owner { harness: 'codex' | 'claude' | 'pi'; sessionId: string }
export interface Attachment { attachmentId: string; owner: Owner; source: string; home: string; generation: number }
export interface Caller { attachment: Attachment; callId: string | null; threadId: string | null }
export type IdentityError = 'identity_unavailable' | 'invalid_arguments' | 'source_mismatch' | 'depth_limit';
export function resolveLaunchEnv(env: NodeJS.ProcessEnv, procEnviron: () => Record<string, string> | null): { home: string; source: string | null; child: { id: string; of: string } | null }; // §1.2 precedence
export function codexCaller(current: Attachment, meta: unknown): Caller | { error: IdentityError; detail: string }; // carriers, no I/O; rebinds on a new session_id
export function claudeCaller(current: Attachment, registry: RegistryReader, meta: unknown): Caller | { error: IdentityError; detail: string }; // one bounded read
export function ownerKey(owner: Owner): string;                          // sha256(harness\0sessionId).slice(0,16)
export function childMode(launch: ReturnType<typeof resolveLaunchEnv>): boolean;   // marker only; the active index guards calls

// packages/hud-mcp/src/hud-tools.ts — one implementation shared by server.ts (MCP) and packages/hud-pi (in-process)
export interface HudTools {
  list(mode: 'parent' | 'child'): ToolDefinition[];                     // 'child' → []
  invoke(caller: Caller, name: string, args: unknown, signal: AbortSignal): Promise<ToolResult>; // validation, dispatch, errors, result shaping
}
```

The host's request envelope is `{ v: 2, caller: Caller, method, params, env?: Record<string,string> }` (`env` on
`hud_create`, and on `jev_ask` for the proxy defaults of JEV1 §4.6); a host that receives another `v` answers
`host_incompatible{expected, got}` (L7). `src/managed/relations.ts` `DirectRelation` (11-18) is replaced by the
child record of §2.8.

---

## 2. Display model

### 2.1 Today

The bar and panel draw children through `NativeCallCollector` (`src/collectors/native-calls.ts:63-310`), which
asks the host for `list` + `wait` per owner with a 40 ms budget (165-169) and *merges* the result into a
`DelegationViewModel` (`merge`, 208-309) whose tree is a `LinkTreeProjection` of the deleted ledger design
(`src/core/link/types.ts:142-161`, nodes 102-134) stamped `reason: 'legacy_ledger_not_used'` (212). Two corrections
to v2's reading: the bar's collector constructs `new NativeHostClient(home, false)` (`native-calls.ts:67-70`) and
`invoke` refuses to start a host when `launch` is false (`host-ipc.ts:207-212`), so the TUI never spawns a host
today — F6 is about the MCP's read tools, whose client launches (`main.ts:56`); and in the native-only case the panel
keeps its own rows and *appends* compact delegation rows (`monitor-panes.ts:579-587`), while only the legacy branch
replaces the view (588-600). The renderers under `src/render/delegation/*` (5 122 lines: `panel.ts:322-349`,
`bar.ts:49-75`, `statusline.ts:160-168`) and `render/monitor.ts:1-35` (which still imports `core/link/view-model`
and `delegation/*`) are what the cleanup removes. `src/index.ts:113-114,198-201,240,253` and
`src/tree-page.ts:286-289,1027-1035,1156-1163,1179-1190` carry both the legacy collector and the native one.
Meanwhile the whole panel is built around `SubagentTree` (`src/types.ts:520-525`): cards, timeline, agent log,
briefs, progress and labels all take `SubagentTreeNode` (`docs/ARCHITECTURE.md` §4.4–§6.3).

### 2.2 Decision: children are `SubagentTreeNode`s

One root-agnostic tree per TUI process:

```
root                       (the session this TUI belongs to; any harness)
├─ native subagent …       (Codex: rollout scan as on main; Claude: Agent-tool sidechains)
├─ MCP child  ⌬/✳/π        (from the child record the host writes)
│  └─ native subagent …    (read-only; Codex child: rollout scan rooted at the child thread)
└─ Jev job ◎               (from the Jev job file the host writes; JEV1 §4.8)
```

- A new collector `src/collectors/children.ts` turns child records and Jev job files into `SubagentTreeNode[]`
  and the bar/panel/dry-run append them to `tree.nodes`. The panel keeps *one* tree, *one* set of counts
  (`agentCounts`, `src/collectors/subagent-tree.ts:1304-1326`), one selection model.
- `SubagentTreeNode` gets four additive optional fields; nothing existing changes meaning:

```ts
// src/types.ts (additive)
harness?: 'codex' | 'claude' | 'pi' | 'jev';          // glyph beside the name when the tree spans harnesses
origin?: 'native' | 'hud';                              // 'hud' = created through hud_create / jev_ask / jev_open
link?: { lifecycle: ChildRecord['lifecycle']; outcome: ChildRecord['outcome']['status']; closeReason?: ChildRecord['closeReason']; pendingRequests: number };
request?: { requestId: string; kind: string; summary: string; since: Date };   // the first unanswered request (Jev: kind 'dialog')
```

- `DelegationViewModel`, `HudDelegationData`, `nativeCallLabel`, `jevCallLabel` (`src/core/link/view-model.ts`),
  `render/delegation/*`, `core/link/*`, `core/capacity.ts`, `core/observation.ts` projections are deleted (WP2b).

### 2.3 Node types and data sources

| Node | Identity | Data source | Status, clock | Text shown | Cost per tick |
|---|---|---|---|---|---|
| Codex root | `SessionFinder` as on main | rollout parse + `HudStatus` (unchanged) | unchanged | unchanged | unchanged |
| Claude root | statusline JSON `session_id` (`src/core/statusline-summary.ts:77-96` keeps `statuslineRef` minus the ledger); for the standalone panel `--session <id>`, or, without it, the transcript for the cwd **only when exactly one is live** (modified within 5 min) — otherwise the panel lists the candidates and asks for `--session` | native facts from the statusline JSON; transcript via `src/harness/claude/reader.ts` (kept) for the panel | from the transcript tail | model, context, cost (statusline) | one-shot (statusline) |
| Pi root | `ctx.sessionManager` | `ctx.getContextUsage`, `ctx.isIdle` (`src/harness/pi/footer.ts:46-47,218-231` already), session file | footer events | footer lines | event-driven |
| Native subagent of the root | as on main (Codex); `ClaudeNativeTopology` (`src/harness/claude/topology.ts:75`) | as on main | as on main | as on main | as on main |
| MCP child (any harness) | child record `~/.hud/children/<ownerKey>/<childId>.json` | the record, re-read when the owner's stamp changes (§2.8) | lifecycle × outcome mapping of §2.8; `request` set while an unanswered request waits | name (orchestrator's `name` or `harness·c-7f3a`), model·effort, task head (≤ 300), last public message head (≤ 600), current tool (≤ 200), context % when the harness reports it, the request line | one `stat` of the stamp; on change, a re-read of ≤ 8 small files |
| Native subagent of a Codex child | rollout scan rooted at `nativeRef.threadId` under the child's `source` (from the record) | `buildSubagentTree` (`subagent-tree.ts:968-983`) with a shared parent map (WP6: one scan, many roots) | as on main | as on main | shares the scan cache (`tree-scan-store.ts`) |
| Native subagent of a Claude child | `ClaudeNativeTopology` over the child transcript path from the record | same reader | as on main's Claude reader | name, status | one tail read per changed file |
| Jev job (`jev_ask`) and Jev instance (`jev_open`) | `~/.hud/jev/<ownerKey>/<job>.json` | the job file, covered by the same owner stamp | JEV1 §4.8 mapping (`queued/sending/awaiting/reconciling → running`, `needs_human → running + request{kind:'dialog'}`, `answered/incomplete/not_submitted/dry_run_ok → completed`, `pre_send_failed/wait_failed/timed_out/interrupted/abandoned → error`) | `Pro·review-v2`, phase line (`▸ wait: generating 12m`), answer head ≤ 600, `model` = decision backend | same stamp, no extra cost |

Scope rule: a TUI reads only **its owner's** directory (root session). Unrelated sessions never appear, and a
`hud panel --all` debug switch is the only exception (replacing `CODEX_HUD_PANEL_ALL_DELEGATIONS`,
`src/tree-page.ts:286`).

### 2.4 What each node shows (and where)

The card rules of `docs/ARCHITECTURE.md` §6.3 hold: model-written text on cards, raw text in the Inspector. For an
MCP child:

- **Card / compact row:** status marker (existing set), harness glyph (`⌬` Codex, `✳` Claude, `π` Pi, `◎` Jev;
  moved from `render/delegation/glyphs.ts` into `render/subagent-chip.ts`), name, model·effort badge, turn clock,
  context meter when known, newest model note (progress summary), current action `▸ npm test`, and while a request
  waits one line `⚑ approval · rm -rf build (2m) +1` in the alert colour (`+1` = further unanswered requests).
  Children of the child (its native subagents) are its child lines as today.
- **Timeline:** each turn is a stage (`stages[]`): started at `hud_send`, ended at `turn_done` with the result head;
  requests appear as `⚑` entries; nothing else is invented.
- **Inspector:** every pending request whole (`flowLines`), the last result whole, the task (create prompt head and
  a locator to the native transcript), the lifecycle line (`connected · turn 3 completed 40 s ago`, or
  `closed · idle_timeout`, or `lost · host down, resume with hud_create{resume}`), the native ref, source and
  transcript path under `▾ More`, and a fixed note "read-only: the orchestrator drives this child". The `o`/`⇢`
  switch action is disabled for `origin:'hud'` nodes (there is no `/subagents` entry to switch to).
- **Bar:** `Agents 2▸ 1⚑ 1✓` — the existing module over `agentCounts`; the attention badge adds "child needs the
  orchestrator" (`render/attention.ts`) ranked with pending approvals. Completion notices: `BarNoticeTracker`
  (`src/collectors/bar-notices.ts:45-53`) announces a completion only after it has seen the agent running or
  starting; that baseline stays. For `origin:'hud'` nodes WP7 keys the notice on `(child, outcome.turn)` so two turns
  completing between two ticks (record debounce) give two notices and a re-rendered summary gives none.
- **Claude statusline (`hud statusline`):** line 1 unchanged (`render/statusline-session.ts`), with the counts at
  its end; line 2 `⧉ ▸ π implementer 4m · ⚑ ⌬ reviewer approval 1m · +1✓`. The pure functions of
  `render/delegation/statusline.ts:160-260` are rewritten over `SubagentTreeNode[]` (≈ 150 lines) and the
  legacy `readStatuslineSummary` second line (`src/cli/statusline.ts:98-130`) goes.
- **Pi footer:** the third line's `HUD <summary>` (`src/harness/pi/footer.ts:265-303`) becomes `HUD ⧉ 1▸ 1⚑`, read
  from the records when the footer factory runs (one `stat` of the stamp, a re-read on change) and refreshed when
  the package's observer long-poll returns a wake; the ledger-backed provider (`core/delegation-summary-pi.ts`, H16)
  is deleted.

### 2.5 Reuse of main's Codex tree reading

Unchanged for the root. For Codex children, `buildTreeSteps` is generalised to accept several roots and return one
subtree per root from a single parent map; the scan cache key already includes the rollout path, so children's
rollouts under another `CODEX_HOME` get their own entries. `readAgentTokens` (`src/collectors/agent-context.ts:136`)
works on a Codex child's rollout path as it does for native agents, so Codex children get context % and tok/s
without the host.

### 2.6 Performance budget

| Stage | Today | v2.2 target | How |
|---|---|---|---|
| Bar cold start to first paint | module graph 149 modules / 44.6k lines, 36 modules / 11.4k historical (App. A) | −36 modules; ≤ 150 ms on the owner's machine with a warm scan cache | WP1–WP2 |
| Panel cold start | 193 / 63.9k, 46 / 13.9k historical | −46 modules; ≤ 300 ms to first frame, tree may still say loading | same |
| Children per tick (bar, 1 s) | `list` + `wait` per owner, 40 ms cap (`native-calls.ts:165-169`), plus `jev_list`/`jev_snapshot` per tick (98-149); never starts a host (`native-calls.ts:67-70`) | one `stat` when nothing changed; ≤ 2 ms p50 / 5 ms p99 on change (re-read of ≤ 8 records + Jev job files); no socket; never starts a host | §2.8 stamp file |
| Panel tick | same | same; child native-subagent scans share one yielding scan (`buildSubagentTreeYielding`, 4 ms slices) | WP6 |
| Statusline (one-shot) | ledger open + sqlite | records + `host.json` only; no connect | WP6 |
| MCP read tools (`hud_list`, `hud_read`, `hud_wait`) | the MCP's client launches a host on `ENOENT` (`main.ts:56`, `host-ipc.ts:201-282`) — F6 | `launch:false`; answer from records with `unavailable:'host_down'` | WP2a |
| Host | one per owner, `process.env` of the MCP; one request per connection | one per HUD home; idle CPU 0; ring 512 msgs / 4 MiB kept (`host.ts:80-105`) for `hud_wait` only; no reader fan-out | §6 |

Acceptance is measured with the existing `CODEX_HUD_PROFILE=1` stage log (`docs/reference.md`, "All environment
variables"): a `children` stage ≤ 5 ms p99 with three live children, and exactly one filesystem call per quiet tick
(counted with an injected `fs`).

### 2.7 Rejected alternatives

- *Keep `DelegationViewModel` and feed it from the host.* It drags `LinkTreeProjection`, coverage/ledger chips,
  conflict relations and 5.1k lines of renderers whose vocabulary (slots, reconcile, resume, pane) is gone.
- *A separate "Children" pane.* Two trees, two selections, two count vocabularies; the owner wants one glance.
- *Poll the host per tick* (v2's and today's shape, `list` + `wait` over a socket). A socket round trip per tick
  per TUI, and nothing when the host is down.
- *A live host subscription for the TUI* (v2.1: snapshot, deltas, `gap`, 16 subscribers, 64 KiB frames,
  slow-reader drop, reader-retention exclusions). It bought "0 syscalls when quiet", which no requirement asks for,
  at the price of a second protocol inside the host and a long-lived reader socket per TUI. One `stat` per tick of
  a stamp file (§2.8) is cheaper to build and to run, and behaves identically when the host is down (O1).
- *One `status` field for connection and outcome* (v2's `closed → completed`). Closing a failed, interrupted or
  disconnected child must not turn it into a success: the panel deliberately keeps failures while completed nodes
  expire (`src/render/panel-state.ts:65-84`) and the agent log reads `completed` as finished
  (`src/collectors/agent-log.ts:79-85`).

### 2.8 Interfaces

```ts
// src/managed/child-record.ts — written by the host, read by every TUI (0600). Rewritten at once on create, binding,
// turn_done, request, request_done, request_stale, close and lost; otherwise debounced to ≤ 1 write/s per child.
// The record is the complete display state: there is no separate live "summary" type (L5).
export interface ChildRecord {
  child: string;                       // 'c-7f3a9c'
  owner: Owner;                        // { harness:'claude', sessionId:'1d2e…' }
  createdBy: string;                   // attachmentId of the creating attachment
  harness: 'codex' | 'claude' | 'pi';
  name: string | null;                 // orchestrator's label: 'implementer'
  model: string | null; effort: string | null;
  nativeRef: NativeRef | null;         // src/managed/types.ts:3-6; null until the harness reports its binding
  source: string;                      // CODEX_HOME / CLAUDE_CONFIG_DIR / Pi session dir of this child
  cwd: string;
  transcriptPath: string | null;       // Codex rollout / Claude transcript / Pi session file, when known
  task: { head: string /* ≤ 300 */; bytes: number; sha256: string } | null;   // create prompt; full text is in the native transcript
  lifecycle: 'starting' | 'connected' | 'closing' | 'closed' | 'lost';
  outcome: { turn: number; status: 'none' | 'running' | 'completed' | 'interrupted' | 'failed' | 'unknown';
             startedAt: number | null; endedAt: number | null; head: string /* ≤ 600 */ };
  stages: Array<{ n: number; startedAt: number; endedAt: number | null; status: ChildRecord['outcome']['status']; head: string /* ≤ 200 */; requests: number }>; // last 8
  requests: Array<{ requestId: string; kind: string; summary: string /* ≤ 300 */; since: number; answeredAt?: number }>;   // pending; answeredAt set by hud_respond until request_done
  lastMessage: { at: number; head: string /* ≤ 600 */; bytes: number } | null;
  action: { name: string; target: string /* ≤ 200 */; since: number } | null;
  usage: { contextTokens?: number; contextWindow?: number; inputTokens?: number; outputTokens?: number; costUsd?: number } | null;
  process: { pgid: number; procStart: string } | null;   // §6.1 containment; null for a harness the host cannot address
  createdAt: number; lastEventAt: number;
  closedAt?: number;
  closeReason?: 'closed' | 'idle_timeout' | 'abandoned' | 'exit' | 'startup_failed' | 'host_shutdown' | 'swept';
  hostGeneration: string;              // boot id of the host that wrote this record
  seq: number;                         // last event seq folded into this record
  wake: WakeBinding;                   // §5
}

export type ChildEvent = { generation: string; seq: number; child: string; at: number } & (
  | { type: 'created' | 'turn_started' | 'lost' }
  | { type: 'closed'; closeReason: NonNullable<ChildRecord['closeReason']> }
  | { type: 'turn_done'; status: 'completed' | 'interrupted' | 'failed'; text: string /* head+tail ≤ 8 KiB */; usage?: ChildRecord['usage'] }
  | { type: 'message'; role: 'assistant'; head: string /* ≤ 600 */ }
  | { type: 'tool'; phase: 'start' | 'end'; name: string; target: string }
  | { type: 'request'; request: HudRequest }                       // §3.3
  | { type: 'request_stale'; requestId: string; ageMs: number }    // once per unanswered request at requestStaleMs (H1)
  | { type: 'request_done'; requestId: string; how: 'answered' | 'withdrawn' | 'expired'; evidence: 'native' | 'inferred' }  // §3.3
  | { type: 'exit'; code: number | null; signal: string | null }
  | { type: 'error'; code: string; message: string });

// src/collectors/children.ts — no socket, no callbacks
export class ChildrenCollector {
  constructor(home: string, owner: Owner | null, fs?: StampFs);
  /** One stat of the owner's stamp; on change, re-read the owner's records and job files. ≤ 5 ms p99. */
  collect(nowMs: number): { nodes: SubagentTreeNode[]; unavailable: 'host_down' | null };
}
```

**Change detection (O1).** After each batch of record writes the host bumps one per-owner stamp file
`~/.hud/children/<ownerKey>/.stamp` (`{ generation, seq, at }`, atomic rename); Jev job files under
`~/.hud/jev/<ownerKey>/` are covered by the same stamp. The bar and panel `stat` that file once per tick and
re-read the owner's files only when it changed; the statusline reads records once. Host liveness is read from
`~/.hud/host.json` (`{ generation, pid, procStart, protocol }`, written at boot, removed at graceful exit): a record
whose `hostGeneration` is not the live host's and which is not `closed` is `lost`, without any connection. There is
no reader socket, no subscription, no fan-out, no slow-reader logic; display latency is one tick plus the ≤ 1 s
write debounce. Parents keep the `hud_wait` long-poll over the host ring (`host.ts:80-96`, 512 messages / 4 MiB,
display buffering not history): `hud_wait` returns `{ events, seq, generation, truncated, gap? }`, where `gap`
means the generation changed or `afterSeq` is older than the ring's oldest retained seq, and the parent re-reads
`hud_list`. Observers (`hud wait`, the Pi package) use `hud_wait{observe:true}`, which never advances the parent's
read cursor (L4). Today's one-request-per-connection socket (`host-ipc.ts:51-108`) stays for every call.

**Offline collection.** With the host down, `collect` returns the records: `lifecycle:'closed'` ones as recorded;
others as `lost` (status `error`, Inspector line "host down — recovery required", resume with
`hud_create{resume}`); never silently empty.

**Full results and history.** `hud_read{what:'result'|'transcript'}` serves from the ring while it can and otherwise
from the native history of the child's recorded `source`: Codex rollout file, Claude transcript file read directly
with `src/harness/claude/reader.ts` from `transcriptPath` (the SDK's disk reader uses the host's own `process.env`
and refuses a different `HOME`/`CLAUDE_CONFIG_DIR`, `sdk-adapter.ts:255-263`; a singleton host never mutates its
environment, so it does not use that reader), Pi session file. Pages are bounded (Appendix B).

**Mapping `ChildRecord` → `SubagentTreeNode`.** `id = child`, `name = name ?? \`${harness}·${child.slice(2,6)}\``,
`task` = `task.head`, `stages` = `stages[]`, `lastReport.text = lastMessage.head`, `action`, `contextUsage` from
`usage`, `startedAt = createdAt`, `turnStartedAt = outcome.startedAt`, `model`, `effort`, `rolloutPath =
transcriptPath` **for Codex children only** (it feeds `readAgentTokens` and the cause job's rollout read, L6; Claude
and Pi files are not rollouts), `harness`, `origin:'hud'`, `link`, `request` = first entry of `requests` without
`answeredAt`. `lastEventAt` = latest evidence of any kind. `status` and `statusAt`:

| lifecycle | outcome | `status` | `statusAt` | shown as |
|---|---|---|---|---|
| starting | — | `starting` | — | starting clock (7–15 s is normal, F3) |
| connected | none | `starting` | — | "connected, waiting for its first turn"; never expires |
| connected | running | `running` | — | turn clock; an unanswered request keeps `running` and adds the `⚑` line |
| connected | completed | `completed` | `outcome.endedAt` | idle; put away after the linger |
| connected | interrupted / unknown | `unknown` | `lastEventAt` | `hud_cancel`, or no evidence yet |
| connected | failed | `error` | `outcome.endedAt` | kept until put away by hand |
| closing | any | as the outcome | as above | "closing…" |
| closed (`closed`, `idle_timeout`, `exit`, `host_shutdown`) | completed / failed | as the outcome | `outcome.endedAt` | Inspector shows `closeReason` |
| closed (same reasons) | none / running / interrupted / unknown | `unknown` | `closedAt` | `closed · idle_timeout` etc.; never `completed` |
| closed (`startup_failed`, `abandoned`, `swept`) | any | `error` | `closedAt` | the error event text / "abandoned: no answer in 2 h" / "swept after host loss"; kept, since someone must look |
| lost | completed / failed | as the outcome | `outcome.endedAt` | the outcome stands; the connection does not |
| lost | other | `error` | `lastEventAt` | "host down — recovery required"; kept until resumed or swept (M3: `unknown` would expire from the default view, `panel-state.ts:78-84`) |

---

## 3. HUD Pi package

### 3.1 Shape (Q1 decided: in-process)

`packages/hud-pi/` with `package.json { "pi": { "extensions": ["./dist/hud.js"] } }`, built from
`src/harness/pi/*.ts`, registered with `pi install <checkout>/packages/hud-pi` (§1.5). One entry, two modes chosen
at `session_start` by the environment:

| Mode | When | Registers | Talks to |
|---|---|---|---|
| parent | no `HUD_CHILD` in env | the tool table of Appendix B via `pi.registerTool`, each handler calling the **same** `HudTools.invoke` that hud-mcp's `server.ts` calls (shared validation, dispatch, error codes and result shaping, §1.9); `/hud` command (`status`, `close <child>`, `footer on|off`); footer lines; wake delivery | the host socket directly, owner = `{harness:'pi', sessionId: ctx.sessionManager.getSessionId()}`, one attachment id per extension instance; one in-process observer long-poll `hud_wait{observe:true, wakeOnly:true}` for wake; the records (via the stamp) for the footer |
| child | `HUD_CHILD` set (the host sets it when it spawns `pi --mode rpc -ne -ns -e <hud-pi> [args]`) | `ask_orchestrator` only | nothing: the rpc stream is the event channel; the question goes through `ctx.ui` |

Rejected: spawning `hud-mcp` over stdio from the extension (today's `PiDelegationBridge`,
`src/harness/pi/delegation-bridge.ts:6-80`). It costs a process and an MCP handshake per Pi session, needs the fd-3
identity dance (`delegation-channel.ts:41-50`), and buys nothing: today the extension already imports the tool
schemas from hud-mcp (`extensions/pi/hud-delegate.ts:10-20`); v2.2 shares the implementation, not only the schema.
The fixed input's "parent-side MCP connection" is read as "the parent-side attachment to HUD's delegation service":
same tools, same semantics, same host — without a stdio process. The owner confirmed this reading (§8 Q1).

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
// packages/hud-pi/src/hud.ts, child mode
pi.registerTool({
  name: 'ask_orchestrator',
  description: 'Ask the orchestrator one question and wait for the answer. Use only for decisions you cannot make from the brief.',
  parameters: { question: string, options?: string[] },
  async execute(_id, { question, options }, signal, _update, ctx) {
    const answer = options?.length
      ? await ctx.ui.select(question, options, { signal })        // → extension_ui_request{method:'select'}
      : await ctx.ui.input(question, undefined, { signal });      // → extension_ui_request{method:'input'}
    return { content: [{ type: 'text', text: answer ?? '(cancelled)' }] };
  },
});
```

The `{ signal }` is required: pi wires dialog cancellation only when the dialog receives it (pi 1.5.0
`rpc-mode`, dialog helper with `opts.signal`), and `ExtensionUIDialogOptions` is the third argument of
`ctx.ui.select/input`. In rpc mode the request surfaces as an `extension_ui_request`, which the host already relays
as a native request (`rpc-adapter.ts:96-155`); the parent sees `ChildEvent{type:'request'}` on `hud_wait`, is woken
(§5), answers with `hud_respond`, and the host writes the `extension_ui_response`.

**Requests keep their native shape.** v2's `kind/text` + `decision/text/option` lost information: Codex can ask
several questions at once, Claude elicitation carries a schema, approvals carry commands and reasons, and the
adapters already relay complete payloads (`managed-adapter.ts:338-349`, `sdk-adapter.ts:358-404`,
`rpc-adapter.ts:122-138`). v2.2 uses one discriminated request and one `hud_respond`:

```ts
export type HudRequest = { requestId: string; child: string; since: number; summary: string /* ≤ 300 */ } & (
  | { harness: 'codex'; kind: 'exec_approval' | 'patch_approval'; command?: string; cwd?: string; reason?: string }
  | { harness: 'codex'; kind: 'user_input'; questions: Array<{ id: string; text: string; options?: string[] }> }
  | { harness: 'claude'; kind: 'ask_user_question'; questions: Array<{ id: string; text: string; options?: string[] }> }  // AskUserQuestion via canUseTool (M2)
  | { harness: 'claude'; kind: 'tool_permission'; toolName: string; input: unknown /* ≤ 8 KiB */ }
  | { harness: 'claude'; kind: 'elicitation'; message: string; schema: unknown /* ≤ 8 KiB */ }
  | { harness: 'claude'; kind: 'user_dialog'; message: string; options?: string[] }
  | { harness: 'pi'; kind: 'select' | 'confirm' | 'input' | 'editor'; title: string; options?: string[]; placeholder?: string }
  | { harness: 'codex' | 'claude' | 'pi'; kind: 'other'; nativeKind: string; payload: unknown /* ≤ 8 KiB */ });

export interface HudResponse {
  decision?: 'allow' | 'deny';                         // approvals / tool permission
  answers?: Record<string, string | string[]>;         // codex user_input and claude ask_user_question: question id → answer(s); claude elicitation: field → value
  value?: string; confirmed?: boolean; cancelled?: true;   // pi dialogs; cancelled is accepted for every kind
  raw?: unknown;                                       // forwarded verbatim; accepted only for kind:'other' (M10)
}
```

The host maps a `HudResponse` to the harness's own wire shape: Codex approval decisions and `user_input` answers
as the app-server expects; Claude `canUseTool` → `{behavior:'allow'|'deny', …}`, `AskUserQuestion` (delivered
through `canUseTool`, `docs/architecture/official-harness-reference-index.md:65`) → `{behavior:'allow',
updatedInput}` carrying the answers in the shape the SDK's user-input guide specifies, elicitation →
accept/decline/cancel with content, dialog results per the SDK; Pi `select`/`input` → `{value}`, `confirm` →
`{confirmed}`, any `cancelled` → `{cancelled:true}` — pi 1.5.0 reads exactly those fields (`rpc-mode`: `cancelled`
wins, then `value` or `confirmed`). Today's adapter forwards the response object verbatim and makes no such
translation (`rpc-adapter.ts:122-138`); WP4 pins each mapping with a fixture against the adapter code and the
pinned SDK.

**No permission changes through answers (M10).** The Claude mapping never emits `updatedPermissions` entries of
type `setMode`, nor any entry whose `destination` is not `'session'` (the SDK allows `userSettings`,
`projectSettings`, `localSettings`, `cliArg`; a model answer must not write the user's settings files or switch the
child's mode). `tool_permission` carries no `suggestions` to the model. `raw` is accepted only for `kind:'other'`.
On the Codex side the adapter's `...this.request.options` spread into `thread/start` (`managed-adapter.ts:157`)
goes with WP2c, and the host rejects `options` on non-Pi creates with `invalid_arguments{options_not_allowed}`.

**When is a request "answered"? (H2)** `hud_respond` records `answeredAt` on the pending entry at once — from then
on the request is not counted as unanswered by the `⚑` line, the idle rule or the stale/abandon policy — and the
host emits `request_done{how:'answered', evidence}` on the harness's own evidence:

| Harness | Completion evidence | `evidence` |
|---|---|---|
| Claude | the `canUseTool` / `onElicitation` / `onUserDialog` promise HUD returned has resolved (`relayNativeRequest`, `sdk-adapter.ts:358-380`; in-process, exact) | `native` |
| Codex | the JSON-RPC response to the server request was accepted by the transport (`managed-adapter.ts:349-350` drops the pending entry after `transport.respond` resolves); by protocol the server's request is complete. If the pinned app-server adds a resolved notification, it is preferred | `native` |
| Pi | the subprotocol has no acknowledgement (`rpc-adapter.ts:128-136`): the response was written **and** the next rpc event of that session arrived (`tool_execution_end` of the asking tool, `message_end`, `agent_settled`, or an `extension_ui_request` with another id), or 5 s passed after a successful write with the session quiet. A later `extension_ui_request` with the same id re-opens it | `inferred` |

A request the harness withdraws before an answer (`pi.extension_ui_expired`, a Codex turn interrupted, a Claude
abort) ends as `request_done{how:'withdrawn'}`; the abandonment policy (§6.1.4) ends it as `how:'expired'`.

Several requests may be pending at once (Codex approval while a Claude elicitation waits in another child; one
child with two). `hud_read{what:'status'}` (≤ 2 KiB) carries the count and the first unanswered request's
`summary`; `hud_read{what:'requests'}` lists them whole (≤ 10, each ≤ 8 KiB); the Inspector shows them all.
Unsupported shapes arrive as `kind:'other'` with the bounded payload and are answered with `raw`.

In an interactive Pi (no HUD, or the owner running a role by hand) the same tool just prompts the human. Claude
children ask through `AskUserQuestion` and elicitation, which the SDK already routes to HUD. Whether a Codex child
under app-server with the user's default collaboration mode can raise `requestUserInput` at all is not established
in the repo (the adapter names only `execCommandApproval`/`applyPatchApproval`, `managed-adapter.ts:287`; M2):
probe P3b settles it. If it cannot, the honest path is the one that works today: the Codex child ends its turn with
the question, `turn_done` wakes the parent, and the parent answers with `hud_send`. Either way every child reaches
its parent through HUD, and the parent answers from the main session. The file protocol (`<qa-dir>/qN.md` →
`qN.answer.md`, `--notify`, `--qa-timeout`) is not used under HUD.

### 3.4 Relation to pi-roles (two layers, confirmed)

- pi-roles keeps: roles (system prompts, model per role, read-only guard), `/role`, `/brief`, `pi-role` launcher for
  the visible herdr-tab workflow, `--qa-dir` file questions for that workflow.
- HUD package provides: channel (tools in a parent, `ask_orchestrator` in a child), events (via rpc), wake, footer.
- One change in pi-roles (the owner's package, outside this repo; scheduled under WP8 with the owner as its
  implementer, L10): register its own `ask_orchestrator` only when `--qa-dir` is given, so a child launched by HUD
  with `-e <hud-pi> -e <roles> --role implementer` has exactly one `ask_orchestrator`. The combined load is
  **acceptance evidence, not a note**: probe P3 (§7) observes pi's behaviour on a duplicate registration now, and
  WP8's tests include the composed launch line. Child launch line: `pi --mode rpc -ne -ns -e <hud-pi> -e <roles>
  --role <r> [--allow-write]`, where everything after `<hud-pi>` comes from `hud_create.options.args` chosen by the
  orchestrator.

### 3.5 herdr-delegate through HUD later

Yes, as a headless path: the Claude main session calls
`hud_create{harness:'pi', cwd, name:'implementer', prompt:'@<brief path> <message>', options:{args:['-e','<roles>','--role','implementer']}}`
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

Four facts v2 missed, which make "the generators work unchanged" false:

1. Model material passes a Codex-only bridge. `legacyTreeSubjects` reads `harness`/`origin`/`sourceId` off the
   node and marks it `universal` (`src/core/materials/request.ts:59-118`); `LegacyCodexBridge` then returns `null`
   for any subject whose `origin` is not `'native'` or whose rollout is not under the Codex `sessions/` directory
   (`src/core/materials/legacy.ts:148-220`). An `origin:'hud'` node gets no material at all.
2. `recapInput` reads more than prompts and replies: ordered transcript entries with reply/commentary kinds, the
   first user message, `transcriptDroppedAt`, `activity.state`, the pending approval's id and time, and it builds
   the scheduling fingerprints from them (`recap.ts:183-243`); `briefingSchedule` reads the same fields
   (`briefing.ts:937-972`).
3. The brief's scheduling fingerprints use **object identity**: `briefingSchedule` stamps `recordStamp(main)`
   (`briefing.ts:971`), and `recordStamp` is a `WeakMap` counter (`src/core/materials/request.ts:130-138`), so a
   projection object rebuilt on every tick would change the floor fingerprint on every tick; the brief job also
   checks `materialOptions.main.session.id` and `.session.rolloutPath` (`briefing.ts:1171-1173`) (M4).
4. The retained readers do not expose everything: the Claude reader deliberately keeps user prompt content out of
   reports and checkpoints and bounds assistant reports (`src/harness/claude/reader.ts:431-457`); failure causes read
   Codex rollout error material through `node.rolloutPath` (`model-jobs.ts:1339-1360`); approval wording runs only on
   the root's `pendingApproval` of kind `exec` (`model-jobs.ts:1390-1404`).

### 4.2 Decision: the generators stay; their inputs are adapted explicitly

1. **A generic public-material boundary** replaces `core/materials/{request,legacy}.ts`: each collector that builds a
   node attaches `material(node): { kind:'public_text'; read(): string; fingerprint: string } | null` — Codex native
   agents: the rollout under `sessions/` exactly as today; HUD children: the host-filtered record fields (task head,
   last message, turn result, error text); Claude native agents: the reader's reports; Jev: the job's answer head.
   Feature switches, scope selection, pause behaviour and output limits (`docs/ARCHITECTURE.md` §5.4) are preserved
   unchanged; only the "is this subject allowed" question moves from Codex-path checks to the collector that owns
   the node. `recordStamp` moves to a neutral module (`src/core/record-stamp.ts`) in WP1 before its old file goes.
2. **Children of any harness** reach the generators as `SubagentTreeNode` (§2.8): `task`, `stages[]`, `lastReport`,
   `action`, `name`, `status`, `children` are filled, so the periodic brief reports them, progress notes land on
   their cards, result digests take the turn result, labels use the create prompt (`labelSource` reads
   `charge ?? task`), and the agent log records started/finished/failed/report. Two generators need an input
   change: **causes** take `errorMaterial` from the child's `error`/`turn_done{failed}` event text when
   `origin:'hud'` (no rollout read); **approval words** run over the root's `pendingApproval` *and* over children's
   pending `exec_approval`/`tool_permission` requests (same prompt, same cache key rule).
3. **Roots of any harness** reach the recap and the brief through an ordered transcript shape that covers what the
   two functions read:

```ts
// src/collectors/main-transcript.ts
export interface MainTranscript {
  session: { id: string; path: string | null };          // the brief's identity check (briefing.ts:1171-1173)
  entries: Array<{ at: Date; role: 'user' | 'assistant'; kind: 'prompt' | 'reply' | 'commentary'; text: string }>;  // ordered, bounded buffer
  firstUserMessage?: { at: Date; text: string };
  transcriptDroppedAt?: Date;
  activity?: { state: 'working' | 'idle' | 'waiting'; updatedAt: Date; turnStartedAt?: Date };
  lastUserMessageAt?: Date; lastReplyAt?: Date; lastEventTime?: Date;
  pendingApproval?: { callId?: string; since: Date; kind: string; command?: string };
  planProgress?: PlanProgress;          // Codex plan; Claude todos via harness/claude/todos.ts; Pi: none
  compactCount: number;
}
export function codexMainTranscript(parse: RolloutParseResult): MainTranscript;   // memoised per parse object (WeakMap), so recordStamp is stable across ticks
export function claudeMainTranscript(result: ClaudeReaderResult): MainTranscript; // WP10: reader extended with prompt heads
export function piMainTranscript(result: PiReaderResult): MainTranscript;         // WP10
```

`recapInput` and `briefingSchedule` take a `MainTranscript`; `codexMainTranscript` is a memoised projection of what
they read today, so the Codex root's recap, fingerprints and scheduling are byte-identical **across consecutive
ticks over an unchanged rollout** (WP6 asserts two ticks, not one run). The Claude and Pi adapters fill what their
readers have and leave the rest undefined; the Claude reader gains user prompt heads (≤ 600, the recap's limit)
behind the same privacy rules (WP10).

Acceptance (WP9/WP10): brief, recap, progress, digest, names, causes and approval words exercised for each root
harness and each child harness on fixtures, with `brief --dry-run` parity: the printed material equals what the
generator would send.

### 4.3 Privacy boundary (unchanged, extended by rows)

| Material | Children (new) | Rule |
|---|---|---|
| task | create prompt head ≤ 300 (brief), ≤ 400 with name (labels) | same as native agents |
| latest update | `lastMessage.head` ≤ 600 | public assistant text only |
| stage result / digest | `turn_done.text` ≤ 8 000 (head+tail) | public final message only |
| current action | tool name + target ≤ 200 | as native |
| request text | `summary` ≤ 300, `command` ≤ 2 000, only to the Approval words job when it is on | as native approvals |
| never | reasoning/thinking blocks (Codex `reasoning` items, Claude `thinking`, Pi `thinking`), env, prompts the orchestrator did not write, native refs, paths | the record never carries them; the host drops them at normalisation |

`brief --dry-run` gains the children: `dryRunText` appends `ChildrenCollector.collect()` nodes (records only, never
a start) before `briefMaterial`, so the printed material shows exactly the child lines that would be sent.
`--root <harness>` is added with WP10.

Rejected: a new "delegation digest" generator or a second log. The existing features cover what the owner asked
for (brief, recap, progress, digest, names) once children are agents.

---

## 5. Wake

Facts from `docs/design/notify-wake-lifecycle-cache.md` §2 (versions as read there): Claude's background command
completion starts a new turn in an idle interactive TUI (2.1.305); the 30-min default / 2-h maximum background cap
applies to **unattended** sessions, interactive sessions have no limit (line 41); `codex queue --thread` writes a
durable row that the owning TUI polls every ~10 s and dispatches only when idle (0.166), is rejected while a daemon
runs for a forced-embedded TUI, skipped while `Interrupted`/plan mode, and `--no-daemon` is rejected; pi
`sendMessage(..., {deliverAs:'followUp', triggerTurn:true})` delivers after tools finish (1.5.0). None interrupts a
running turn; each wake costs the parent one model sample, so wakes are coalesced and nothing wakes a parent for
nothing.

The evidence is narrower than v2 said: the real-client run left the Codex queue wake and the Claude background
waiter untested as deliberate cases and recorded one Pi wake (`local-real-client-results-20261107.md:20-23`); the
matrix marks runtime cases unverified and limits `codex queue` by mode (`notify-wake-lifecycle-cache.md:41-65`).
Probe P2 (§7) runs each mechanism on the owner's clients before WP5 is sized as done.

### 5.1 Per parent harness: mechanism and the honest guarantee

| Parent | Mechanism | Guarantee | What the parent sees |
|---|---|---|---|
| Codex | the host spawns `codex queue --thread <root session_id> --message <line>` with `CODEX_HOME` from the captured env and the `codex` executable captured at attachment (`/proc/<pid>/exe` of the harness ancestor, as `main.ts:75` does today, else PATH); 10 s timeout, detached; receipt `accepted \| rejected{reason} \| unknown` is **advisory** | **submission** can be confirmed; **execution** depends on the owning client's mode and scheduler: embedded TUI → delivered at its next idle (`available`); daemon present or forced-embedded guard → `degraded{daemon}`; `codex exec` parent → `unavailable` | one queued user message: `[hud] reviewer (⌬ c-7f3a) finished turn 2 · "LGTM with two nits…" · drain with hud_wait{afterSeq:<your cursor>}` (≤ 512 bytes, control-stripped) |
| Claude Code | `hud wait --owner <key> --after <seq> --parent <pid> --timeout-ms <n>`: connects to the host socket, long-polls `hud_wait{observe:true, wakeOnly:true}` (never advances the read cursor, L4), prints one line, exits. `hud_create` returns `wake: { kind:'background_command', command, note }` and the skill **arms** it with Claude's background Bash (`run_in_background: true`) and **re-arms** after every wake or timeout. Default `--timeout-ms` = `requestAbandonMs` + 5 min (2 h 05) for an interactive parent, so re-arming costs no turn inside the abandon window (M7); the waiter is bounded by `--parent` and by generation change, not by the timeout | delivered only while a waiter is armed and the parent is an interactive TUI (`-p`/SDK parents: `degraded{no_background_turn}`, where the 30-min unattended cap would also apply); the waiter exits 0 with the line on a wake-worthy event, 2 on `host down`, 3 on timeout (`timed out; rerun: <command>`), 4 silently when its parent pid or the attachment generation is gone | the `<task-notification>` with the same one line |
| Pi | the parent package's observer long-poll returns the event and the package calls `pi.sendMessage({customType:'hud_wake', content, display:true, details}, {triggerTurn:true, deliverAs:'followUp'})` (`src/harness/pi/wake-extension.ts:87-104` logic kept, including its immediate session check; socket dropped) | queued through pi's scheduler, delivered after the current tools finish; duplicates suppressed **within one attachment** (`lastDeliveredSeq` in memory); a notice is harmless if repeated (same text, drain-from-cursor instruction) | a follow-up message with the same line |

`hud_create` and `hud_list` return the current binding `{ kind, capability: 'available' | 'degraded' | 'unavailable',
reason?, command? }`, computed at attachment and **refreshed on every reattach** (a resumed parent gets a fresh
binding, not the one captured when the child was created).

Events that wake (the host's `wakeOnly` filter and the waiter use the same list): `turn_done`, `request`,
`request_stale` (the decided 1 h re-wake, H1), `closed` with `closeReason:'abandoned'` (the decided 2 h close),
`exit`, `error`, `lost`. `message`, `tool`, `created`, `turn_started`, `request_done` and other `closed` reasons never
wake. Jev (JEV1 §4.8): `answered`, `incomplete`, `needs_human`, `uncertain`, `not_submitted`, `pre_send_failed`,
`wait_failed`, `timed_out`, `abandoned`; `sent` only with `wake_on_sent`.

### 5.2 Coalescing, retry, cursors

- **Coalescing** is a bounded debounce, not "one per idle period" (the host cannot observe the parent's idle
  periods): per owner, wake-worthy events are aggregated for 2 s, one attempt is in flight at a time, and the line
  names up to three events (`[hud] 2 events: reviewer finished turn 2; implementer asks approval · drain …`).
- **Retry** at most once, 30 s later, only if the owner's **read cursor** has not reached the first aggregated seq.
  A retry may enqueue a duplicate durable Codex row; the line is idempotent (it tells the parent to drain from its
  own cursor) so a duplicate costs one extra sample and nothing else. A dead parent costs two attempts per
  aggregation and then nothing.
- **Cursors, kept apart.** The parent's *read* cursor advances only through non-observer `hud_wait`/`hud_read`
  responses, and only to the last seq actually returned (a child-filtered or truncated page acknowledges nothing it
  did not return). Observers — the `hud wait` CLI, the Pi package, any `hud_wait{observe:true}` — never advance it.
  The TUI reads records and has no cursor at all. The *wake* bookkeeping (`lastAttemptAt`, `lastAttemptSeq`,
  `retries`, per owner) is the host's own. A cursor proves that data was returned, not that the model acted on it.
- **Generation.** Events carry the host's generation; a parent whose cursor belongs to an older generation gets
  `gap` and re-reads `hud_list`.

### 5.3 F2 and the flaky receipts

- F2: the queue-woken turn was refused by `resolvers.ts:302`; with §1 the turn is a normal Codex call. That removes
  the demonstrated failure; P2 (now) establishes that a queued line starts a turn on the owner's embedded TUI, and
  its re-verification after WP2a establishes that a HUD call in that turn is accepted.
- Receipts: today `sendNativeWake` kills `codex queue` after 2 s (`src/managed/host-wake.ts:51-155`), while the CLI's
  own startup can exceed that; the receipt was `unknown/timeout` 2 of 3 and the message may still have landed.
  v2.2: 10 s timeout, the receipt is logged on the child record (`wake.last = {at, seq, result, reason}`) and shown
  in the Inspector, and delivery is judged by the read cursor, not by the receipt.

### 5.4 Rejected

- Blocking `hud_create` until the child finishes: serialises delegation.
- MCP notifications/elicitation as a wake: no harness turns them into a model turn (matrix §2.4).
- Codex `turn/steer` through an app-server socket: the owner's TUIs run embedded (matrix §2.2) and it would steer
  a running turn — a wake must not interrupt.
- "Exactly once" for Pi: an in-memory cursor cannot promise it across a crash; duplicate suppression within an
  attachment plus harmless notices is what can be kept.
- A 25-minute Claude waiter timeout: it re-armed through a wasted parent turn every 25 minutes (about four inside
  the abandon window); the cap it respected applies only to unattended sessions.

---

## 6. Lifecycle and environment

### 6.1 Host and children

Today: a host per owner (`host-ipc.ts:27-30`), spawned on the first `ENOENT`/`ECONNREFUSED` of **any** MCP call
including `list` (`main.ts:56` → `host-ipc.ts:201-282`), unrefs its server only after an explicit close
(`host-ipc.ts:35-49`), counts every in-flight request the same way (`host-ipc.ts:74-94`, so a long `wait` would
keep it alive), keeps connections and pending requests in maps with no terminating path (`host.ts:69-74,169-202`),
and bootstrap-only hosts stay alive on purpose (`src/managed/host-entry.ts:18-20`) — F6. The adapters do not
establish bounded cleanup: Codex sends EOF, never signals, and may settle after 250 ms with `reaped:false` and an
unreferenced child (`src/harness/codex/app-server-transport.ts:333-366`); Claude's `close()` returns
`workStopped:'unknown'` (`sdk-adapter.ts:284-291`); Pi's `close()` resolves when `stdin.end()` completes
(`src/harness/pi/native-rpc-transport.ts:169-178`). "Stdio-bound, so a crash leaves no orphans" was therefore not
established by v2; §6.1.3 makes it a tested mechanism.

#### 6.1.1 Processes (Q2 decided: one host per HUD home; Q4 decided: 30-min quiescent idle close)

| Process | Started by | Retained by | Ends when |
|---|---|---|---|
| host (`~/.hud/host.sock`, one per `HUD_HOME`; `host.json` beside it) | the first `hud_create`/`jev_ask`/`jev_open` of any owner (lock `host.sock.start` as today, `host-ipc.ts:216-244`) | live child handles (`starting`/`connected`/`closing`), Jev jobs with a run and live Jev instances (JEV1 §4.7), startup reservations (a `create` admitted but not yet connected), in-flight **mutations**. **Not** by `hud_wait` long-polls (observer or not), `list` or `read` | nothing retained for `graceExitMs` (60 s) → shutdown (§6.1.2); `SIGTERM` → close every child through the ladder (§6.1.3), then the same shutdown. Readers never start it and never keep it alive |
| child harness process (Codex `app-server`, Claude `claude` via SDK, Pi `--mode rpc`) | the host, in its own process group, stdio-bound | a turn runs, an unanswered request is pending, or the parent **acted** within `idleCloseMs` (30 min) | `hud_close`; quiescent idle timeout (§6.1.4); abandonment (§6.1.4); host shutdown (`closeReason:'host_shutdown'`); its own exit (`'exit'`); `startTimeoutMs` (120 s) without a binding (`'startup_failed'`); every path runs the close ladder |
| Jev job / instance | the host, per `jev_ask` / `jev_open` | a run is in progress, or the instance is live | `jev_ask_close` / `jev_close` → abort ladder with the deadline counted **from the close call** (JEV1 §4.7); idle and abandon policies of JEV1 §4.7; host shutdown. An async task inside the host, not a subprocess |
| `hud wait` waiter | the Claude parent (background) | — | one wake-worthy event, host down, timeout, parent gone, generation changed (§5.1); never loops |
| hud-mcp (stdio) | the harness | — | stdin EOF; the 30 s `parentAlive` check (`server.ts:270-273`) stays |
| Pi package | Pi | — | `session_shutdown` |
| bar / panel / statusline | tmux / Claude | — | as on main |

Limits: `maxChildren` 8 live children per owner and 24 per host, plus JEV1's `liveLimit`/`queueLimit`; beyond them
`limit_exceeded`. A 30-minute timer alone does not bound their number; the limits do.

#### 6.1.2 Host shutdown with draining

When `graceExitMs` expires with nothing retained: set `shuttingDown` (admission answers `host_shutting_down`; a
`create` admitted in the same event-loop tick before the flag wins — admission and the flag flip are one
synchronous step), cancel long-polls with `host_shutting_down`, `server.close()`, drain accepted connections for
≤ 5 s, remove `host.json`, exit 0. `net.Server.close()` alone keeps already accepted connections, which is why the
long-polls are cancelled first. A new `create` that arrives before the flag flips cancels shutdown eligibility
atomically (it is a retained reservation from admission on).

#### 6.1.3 Bounded close and crash containment

Every close returns three separate results:

```ts
{ released: boolean;                             // the harness's own close API was invoked (EOF / query.close())
  exited: { code: number | null; signal: string | null } | 'unknown';   // the direct child process was reaped
  workStopped: 'confirmed' | 'unknown' }         // the harness reported its work ended (turn_done/agent_settled/result) before exit
```

Ladder, total ≤ `closeTimeoutMs` (15 s), deadline counted from the close call: (1) release — the harness's close
API (Codex: stdin EOF after the thread is quiet, Claude: `query.close()`, Pi: stdin EOF) and wait ≤ 5 s for exit;
(2) `SIGTERM` to the child's **process group**, ≤ 5 s; (3) `SIGKILL` to the group, ≤ 2 s. The explicit-close row of
the results table passed through step 1 for all three harnesses (≤ 1.2 s / ≤ 2.1 s / ≤ 5 s), so steps 2–3 are the
bound, not the norm. Containment: the host spawns each child with `detached: true` (its own process group) while
keeping its stdio pipes and the handle referenced, and records `{ pgid, procStart }` on the child record, so
descendants (a child's MCP servers, subprocesses) are addressed with the group. The Claude child is spawned by the
SDK, not by the adapter (`sdk-adapter.ts:69-91` only resolves the executable); probe P4 checks whether the pinned
SDK exposes the child process or a spawn hook, and otherwise `pathToClaudeCodeExecutable` points at a two-line
`setsid` launcher so the group exists (a launcher, not a configuration change).

Crash sweep, **by group, not by leader** (M5): at every host boot and on `hud setup --sweep`, for every record that
is not `closed` and whose `hostGeneration` is not the live host's: (1) `kill(-pgid, 0)` — `ESRCH` means nothing
remains and the record becomes `closed{'exit'}`; (2) otherwise enumerate `/proc/*/stat` for processes whose `pgrp`
(and, with `setsid`, `session`) equals the recorded `pgid` and whose start time is ≥ the recorded `procStart` — the
leader may be dead while its MCP servers live on, and that is the case the sweep exists for; (3) run the ladder on
that group and mark the record `closed{'swept'}`. Between a host `SIGKILL` and the next boot, a child that ignores
stdin EOF can live on; P4 measures whether any of the three harnesses does, and the limitation is stated in
`docs/reference.md`. This mechanism is the decided design (§8, 2026-11-07); a per-child parent-death guard is
considered only if P4 shows a harness ignoring EOF. A `SIGKILL` cannot run a handler, so nothing in the design
depends on one. The interactive parent and the shared Chrome process are never signalled (JEV1 owns its tabs, not
the browser).

After unclean host loss, a child's record shows `lost` until evidence says otherwise (§2.8); `closeReason:
'host_shutdown'` is written only by a host that closed the child itself.

#### 6.1.4 Idle, blocked and abandoned children

- **Quiescent-only idle close (Q4).** A child is eligible when *all* hold: `lifecycle:'connected'`; `outcome.status`
  not `running`; no queued input; no unanswered request (an answered one awaiting `request_done` does not block
  idle, H2); no native background work observed (Codex: every `item/*` started since the last `turn/completed` has
  ended; Claude: a `result` arrived for the last prompt and no callback is open; Pi: `agent_settled` after the last
  input); not within a startup, resume or close transition. A quiet stream is not idle. The clock is
  `idleSince = max(outcome.endedAt, lastOwnerActionAt)` where owner actions are `hud_send`, `hud_respond`,
  `hud_cancel` and `hud_create{resume}` — **passive reads (`hud_read`, `hud_wait`, `hud_list`, the TUI) never extend
  it**. A long turn is not eligible however old its send is. Checked every 60 s; `closeReason:'idle_timeout'`; the
  native session stays resumable.
- **Blocked.** An **unanswered** request older than `requestStaleMs` (1 h) emits `request_stale{requestId, ageMs}`
  once, which wakes the parent (§5.1); older than `requestAbandonMs` (2 h) the host withdraws it through the
  harness's own cancel path where one exists (`request_done{how:'expired'}`) and closes the child with
  `closeReason:'abandoned'` (`closed{abandoned}`, wake-worthy; the native session stays resumable). This is the
  separate policy the owner asked for; both numbers are configurable and were decided on 2026-11-07 (§8).
- **Running too long.** There is no wall-clock bound on a turn by default (decided, §8): "never during a turn" means
  an indefinitely running turn is never cut by HUD. `turnDeadlineMs` is opt-in; when set, the child is interrupted
  with `hud_cancel` semantics and its outcome is `interrupted`, never reinterpreted as idle.
- **Dead handles.** `exit`/`lost` events run the ladder's remaining steps and retire the connection; nothing stays
  in a map past its close. Jev's abandoned and blocked states follow JEV1 §4.7 (`abandonMs`, `needs_human`).

"Work the user wants to keep" is protected by: a running turn is never cut by a timer; `hud_close` is explicit; the
native session file outlives the process and `hud_create{resume: nativeRef}` continues it later (all three adapters
support resume: `managed-adapter.ts:153-200`, `sdk-adapter.ts:174-196`, `rpc-adapter.ts:172-187`) — resume restores
persisted history, **not** in-memory tool state, pending approvals or unflushed output, and the Inspector says so on
a `lost` child. The parent is told why a child went away (`closeReason` in `hud_list` and the Inspector).

Rejected: keeping per-owner hosts. Two owners → two node processes idling; the TUI would open N sockets; the
per-owner isolation was an authentication artefact (§1.7). The cost of one host per home is a larger blast radius
on a host crash, accepted with the tested sweep above (§8 Q2).

### 6.2 Children get the user's real environment (F3)

The host is spawned with the MCP's `process.env` (`host-ipc.ts:119-123`), which Codex has filtered (F3), and
children inherit it (`host-config.ts:74`). v2.2: the environment is **captured on the caller's side at every
`hud_create` and passed to the host in the request**; the host applies it to that spawn only. (`jev_ask` passes the
proxy variables the same way, for JEV1 §4.6's defaults.)

- Codex and Claude parents (Linux): `env = read('/proc/<harness pid>/environ')` of the harness ancestor found at
  attachment. This is the harness process's **launch environment** (proxy, PATH, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
  API keys as they were when the user started it), not a live view of the shell: a later `export` in the user's
  shell reaches the next harness the user launches, not a running harness or its next child. v2's "a later export
  reaches the next child" was wrong. Fallback when unreadable (another platform): `process.env`.
- Pi parent: `process.env` of the Pi process (in-process).
- HUD strips **selectively**: only `HUD_CHILD`, `HUD_CHILD_OF` and the legacy caller-identity names
  (`HUD_CALLER_ID`, `HUD_CONTEXT_ID`, `HUD_CONTEXT_GENERATION`, `HUD_MCP_PROFILE`, `HUD_CLAUDE_HOOK_CONFIG`,
  `HUD_PI_EVIDENCE_FD`, the list `host-config.ts:76-84` already removes) are removed; `HUD_HOME` stays in the child's
  launch environment, and the child's own hud-mcp finds it and `CODEX_HOME` through the resolution of §1.2 (own
  env under Claude, the ancestor's environ under Codex — Codex's minimal MCP environment would otherwise hide a
  custom home, M1). Then HUD **adds** `HUD_CHILD`, `HUD_CHILD_OF` (§1.4) and nothing else — `CODEX_HOME` is
  whatever the parent had, so the child runs on the same account.
- Nothing is persisted but the child's `source` (§2.8), which history reads use; the env itself travels once over
  the 0600 socket.

Children still load the user's full MCP/plugin set (7–15 s startup, F3): that is their configuration, and
non-interference says HUD does not touch it; the cost is shown on the card as the `starting` clock.

### 6.3 Jev: in-process, credentials from HUD's own file (F4, F5, F7)

v2's §6.3 (interpreter resolution, caller-env credentials, `import jev` probe) is withdrawn; JEV1 replaces it:

- The Jev Ultrafast agent and the ask driver are TypeScript inside the host (`src/jev/`, JEV1 §4.1–§4.2); there is
  no Python, no interpreter to find, no `HUD_JEV_PYTHON`. (The v2 probe would also have been wrong: the bridge
  imports `jev_ultrafast`, `src/managed/jev-bridge.py:25`, not `jev`.)
- Credentials come from `~/.hud/jev.env` (0600), read at the start of **each job**, never from the caller's
  environment (JEV1 §4.6); a rotated key takes effect on the next job, which answers the second half of F4. Proxy
  defaults and the decision backend (TypeSafe or the OpenAI Decisions API, JEV1 §4.11, D9) are JEV1 §4.6.
- `screenshots` is explicit and defaults to `false`; `record_dir` only records (F5).
- F7 ("host does not exit after `jev_close`"): v2's explanation (`release()` only ends stdin, the host keeps a
  reference) was not established by the code — at `9e46378` `jev_close` already deletes the instance
  (`src/managed/jev-host.ts:263-266`) and the reference accounting recognises `jev_close` (`host-ipc.ts:43-48`).
  The cause of the observed leak is unproven; the Python bridge disappears with the port, and JEV1 §4.7 gives the
  in-process jobs a close ladder whose deadline starts at the close call and a retention rule that excludes
  long-polls. WP12 re-tests "host exits `graceExitMs` after `jev_close`" as a matrix row.

---

## 7. Migration plan

Principles: pin the baselines first; probe the unverified mechanisms before deleting what currently works, with
only the code each probe needs; extract shared code before deleting its old home; delete in segments that each
leave the main suite green; build v2.2 on the cleaned tree; the main features (`origin/main` codex-hud bar, panel,
brief, installer) work after every package. Implementers per the owner's routing (2026-11-07): **Grok 4.7 high**
core code, **pi** well-specified tests and fixtures, **frontend-implementer** rendering (design by the Fable-max
subagent), an **Opus subagent** reviews every package; Codex is not available for implementation; Codex test cells
run on the `codex2` account with `gpt-6-luna` medium. Sizes: S ≤ half a day, M ≤ 2 days. From WP1 until WP6 the
TUI shows no MCP children (the temporary collector returns `[]`); the branch is dogfooded in that state and that is
accepted (L8).

### 7.1 WP0: baselines and the main-feature manifest

- **Inputs.** `git ls-tree -r --name-only 9108482 tests/` — main's own test list: 176 files (113 `tests/unit`, 36
  `tests/integration`, 8 `tests/performance`, fixtures) — and the scene list of `tests/fixtures/visual-baselines.json`
  at `9108482`. Main's `npm test` is build + `build:test` + `test:unit` + `test:mjs` (no `build:hud-mcp`).
- **Manifest** `tests/main-features.json`: for every main test file, `{ branch: [<branch test files>], assertions:
  [<named assertions to preserve>] }` or `{ changed: "<reason>" }`; for every visual scene, `kept` or `removed:
  <reason>`. For every MIXED branch test file touched later, the manifest names the main assertions to move before
  the file is split (the inventory's classifications are unverified and get checked file by file).
- **Gate.** `tests/run-main.sh` runs the branch column: `build:test`, then `node --test` over the mapped files plus
  `visual-baselines.test`. The main column is `npm test && npm run test:visual` in a `git worktree` at `9108482`.
- **Acceptance.** Zero unmapped main tests or scenes; `run-main.sh` green at `9e46378`; the main column green and
  recorded; `npm test` / `npm run test:visual` results at `9e46378` recorded.
- **Who.** Grok writes the manifest; pi writes the script; the orchestrator signs off the feature list and creates
  the tag `v1-historical` at `9e46378` (the only git write).

### 7.2 WP0.5: feasibility probes, split into "observe now" and "re-verify later"

Each probe states its pass criterion, the paragraph it amends, the scripts it reuses (`scripts/local-validation/*`,
`tests/probes/*.sh` and `tests/probes/lib`), and that its result file `docs/probes/v2-<probe>.md` uses synthetic
data only. pi writes the scripts; the owner (or Hermes) runs the clients; the orchestrator writes the amendments.
Nothing here needs code that does not exist at `9e46378`.

| Probe | Observe now (no new code) | Pass criterion | Amends | Re-verify after |
|---|---|---|---|---|
| P1 attachment switching | Claude `/clear`, `--resume`; Codex `/new`; Pi switch/fork: read `sessions/<pid>.json` and the `_meta` carriers before and after (the `tests/probes/lib` capture) | the registry's `sessionId` equals the new session within 1 s in 3/3 trials per path; Codex `_meta.session_id` changes on `/new` in 3/3 | §1.2, §1.3 | WP2a: a rebind ends the old observer long-poll and re-arms the wake binding (generation fencing) |
| P2 wake modes | Codex: `codex queue --thread` from a shell into the owner's idle embedded TUI, then with a daemon running, then a `codex exec` parent; Claude: a background `sleep 5; echo wake` with `run_in_background: true` in an idle interactive TUI, re-armed from the woken turn; Pi: today's `hud_wake` custom message | Codex: the queued line appears as a user turn within 30 s in 3/3 idle trials (daemon and `exec` outcomes recorded as `degraded`/`unavailable` evidence); Claude: a `<task-notification>` turn starts within 10 s in 3/3 and the re-arm works in 3/3; Pi: 3/3 | §5.1 capabilities | WP2a + WP5: a HUD call inside the queue-woken Codex turn is accepted (F2) |
| P3 Pi UI from a tool, package loading | a throwaway 20-line extension under `tmp/` whose tool calls `ctx.ui.select(..., {signal})` in `--mode rpc`; the same extension loaded together with pi-roles; `pi install <tmp dir>` into a temporary `PI_CODING_AGENT_DIR` | `extension_ui_request{method:'select'}` appears on stdout and the tool returns the written `value` in 3/3, returns `(cancelled)` on `{cancelled:true}` in 3/3; pi's behaviour on two `ask_orchestrator` registrations recorded (error or last-wins); `pi list` shows the installed package | §3.3, §3.4, §1.5 | WP8: the real package and the composed launch line |
| P3b Codex child question path | a Codex app-server child created with today's `managed_create` under the owner's default config, prompted to ask the user a question before proceeding | whether a `requestUserInput`-style server request arrives, 3 trials recorded either way | §3.3 (request path or `turn_done` + `hud_send`) | WP4: the chosen mapping |
| P4 process cleanup | today's host with one child per harness; `SIGKILL` the host; separately `kill(-pgid)` on a `setsid`-launched child with a subprocess; read the pinned SDK's types for a child-process/spawn hook | per harness: child exits within 5 s of stdin EOF (3/3) or not; descendants' fate recorded; group kill removes the subprocess in 3/3; the SDK hook question answered yes/no with the type name | §6.1.3 launcher and the stated limitation | WP3: the real ladder and sweep |
| P5 Codex `_meta` shapes | capture `_meta` on TUI calls, `codex exec` calls, native-subagent calls and the P2 queue-woken turn (`tests/probes/codex-mcp-launch.sh` already records `mcp.jsonl`) | every shape carries at least one of the two carriers; which ones are single-carrier recorded | §1.2 rule 1 | WP2a: the fixture set |

### 7.3 Work packages

| WP | Goal | Files / areas | Acceptance | Size | Who |
|---|---|---|---|---|---|
| **WP0** | §7.1 | §7.1 | §7.1 | S | Grok, pi, orchestrator |
| **WP0.5** | §7.2 | §7.2 | §7.2 | M | pi (scripts), owner (clients), orchestrator (amendments) |
| **WP1** Extraction and hot-spot cuts | Live processes stop importing the historical stack; shared code gets a neutral home | move `readProcess`/`sameProcessStamp` to `src/core/process-stamp.ts` (`packages/hud-mcp/src/lifetime.ts:1-2` imports `core/run/process` and `core/supervision`); `recordStamp` to `src/core/record-stamp.ts` (M4); `HudIO` → `src/cli/io.ts`; drop `CallBudget` from `server.ts:1-4`; `render/monitor.ts:1-35` off `core/link` and `delegation/*`; the readers' `core/checkpoint.ts` → `core/observation.ts` dependency extracted; the generic material boundary of §4.2(1); `src/index.ts` (H1), `src/tree-page.ts` (H2), `src/cli/statusline.ts` + `src/core/statusline-summary.ts` (H3), `src/cli/hud.ts` (H4), `src/harness/pi/footer.ts:8` + `extensions/pi/hud-footer.ts` (H16); a temporary `ChildrenCollector` returning `[]` replaces `NativeCallCollector` + `merge` | `tests/module-closure.mjs` (an `--import` hook that records every module loaded by `dist/index.js`, `dist/tree-page.js`, `bin/hud-statusline`, `packages/hud-mcp` main — the inventory's method; **not** `tsc --listFiles`, which lists all of `src/**/*` per `tsconfig.json:18`) shows no `src/ledger`, `src/core/link`, `src/core/run`, `integrations/herdr`; visual baselines unchanged except the removed delegation scenes; `run-main.sh` green | M | Grok |
| **WP2a** hud-mcp v2 core and the host/record contract (additive) | Identity, shared tools, child mode, launch-env resolution, records, stamp, events | `packages/hud-mcp/src/{identity,hud-tools,env-capture}.ts` (§1.9; `hud-tools.ts`, not `tools.ts`, M8), `server.ts` without resolver/bodies; `src/managed/{child-record,active-index,stamp}.ts`, `host.json`, the `v: 2` envelope; the new `hud_*` tools coexist with the old `managed_*` until WP2c | tests (pi): `_meta` of the three shapes → owner; both carriers disagreeing → `carrier_mismatch`; single carrier accepted; a Codex-shaped minimal environment plus a fake ancestor environ with `HUD_HOME=/tmp/x` resolves home `/tmp/x` and `source` = its `CODEX_HOME`, and with `HUD_CHILD` set classifies as child (M1); Claude registry fixture with a changed session → generation bump; child mode from own env and from a fake `/proc` environ → empty `tools/list`; a call whose session id is in the active index → `depth_limit`, no socket; `create` by an active child refused at the host; record and index written before turn 1; every record write bumps the owner's stamp; `hud_wait` → `gap` on generation change and on ring overrun; `host_incompatible` on `v: 1` | M | Grok (tests: pi) |
| **WP2b** Delete segment A (historical stack) | Remove the dead code and its tests | `src/ledger/*`, `src/core/run/*`, `src/core/link/*`, `src/core/capacity.ts`, `src/core/observation.ts` projections, `src/collectors/delegation.ts`, `src/render/delegation/*`, `integrations/herdr/*`, capability/qualification modules, `src/cli/{run,run-wait,cache,migrate,digest,pi,launcher,link-export}.ts`, `bin/hud-run` + `package.json` `bin.hud-run`, runtime package scripts, `packages/hud-mcp/src/tools.ts` (legacy), `tests/fixtures/b10b-*`; the HIST-ONLY tests and the MIXED-mostly-historical tests after their main assertions are moved per the WP0 manifest; dead stubs of inventory §7 | `run-main.sh` and `npm test` green; `git grep -l 'ledger\|delegate_\|hud-run' src packages bin` returns only `src/types/node-sqlite.d.ts` and docs; `tsconfig.test.json` builds | M | Grok (+ pi: shared fixtures the kept tests need) |
| **WP2c** Delete segment B (hud-mcp and host legacy) | Remove what WP2a replaced | `resolvers.ts`, `registry.ts`, `config.ts` (delegate/native parts), `hook/*`, `bin/hud-claude-hook.mjs`, `pi-channel.ts`, `pi-host.ts`, `wake-registration.ts`, `managed-tools.ts`, `src/collectors/native-calls.ts`, `src/core/delegation-summary-pi.ts`, `src/managed/relations.ts`, per-owner host paths, the Codex adapter's `options` spread and `approvalPolicy`/`sandbox` options (M10), `src/managed/jev-bridge.py` + `PythonJevBridge` (with J5) | `run-main.sh` green; the MCP serves only Appendix B | S | Grok |
| **WP3** Host lifecycle and cleanup | One host per home with bounded everything | `src/managed/{host,host-ipc,host-entry}.ts`: retention accounting (§6.1.1), shutdown with draining (§6.1.2), close ladder and process groups (§6.1.3), group sweep, quiescent idle, stale/abandoned requests, limits, startup deadline, `lost` on boot; clock injected | tests (pi, fake adapters and a fake process table): host exits `graceExitMs` after the last close while an observer `hud_wait` is open; `create` during the grace cancels shutdown; ladder reaches `SIGKILL` on a child that ignores EOF within 15 s; sweep terminates a group whose leader is dead and one member alive, leaves a reused pid alone (M5); idle never fires during a turn, with an unanswered request, or after a `hud_read`; fires after `hud_send` + 30 min quiet; with a fake clock an unanswered request emits `request_stale` exactly once at 1 h and at 2 h `request_done{expired}` plus `closed{abandoned}` (H1); an answered Pi request (`answeredAt` set, `request_done` pending) emits no `request_stale` and does not block idle (H2); `limit_exceeded` at 9 | M | Grok (tests: pi) |
| **WP4** Normalisation, requests, reads | Three adapters → `ChildEvent`; native requests kept whole; answered well-defined; compact and sourced reads | `harness/*/…-adapter.ts` normalisation; `HudRequest`/`HudResponse` mapping per harness (§3.3, incl. `ask_user_question`, Pi `value`/`confirmed`/`cancelled` and `{signal}`); the completion-evidence rules of §3.3; multiple pending requests; `hud_read` (`status` ≤ 2 KiB, F8: never `initializationResult`, `sdk-adapter.ts:229-235`; `requests`, `result`, `transcript` from the recorded source) | tests (pi, fixtures from the adapter code and the pinned SDK): each native request kind round-trips; a Codex two-question `user_input` answered by id; a Claude `AskUserQuestion` answered through `updatedInput` (M2); a cancelled Pi dialog writes `{cancelled:true}`; `request_done{evidence:'native'}` for Claude on promise resolution and for Codex on the accepted response, `{evidence:'inferred'}` for Pi on the next rpc event and on the 5 s quiet rule (H2); `options` on a Codex or Claude create → `invalid_arguments{options_not_allowed}`; a Claude answer carrying `setMode` or a `userSettings` destination is stripped to session scope; `raw` on a non-`other` kind refused (M10); `status` ≤ 2 KiB with a 3 KiB request pending; a Claude child under another `CLAUDE_CONFIG_DIR` has its transcript read directly | M | Grok (tests: pi) |
| **WP5** Wake | Three wake paths, honest capabilities, cursors | `src/managed/wake.ts`, `src/cli/wait.ts` (`hud wait`), Pi delivery in WP8; bindings refreshed on reattach | tests (pi): fake `codex` binary slow by 3 s → `accepted`; debounce aggregates two events into one line; read cursor advance suppresses the retry; truncated page does not advance past what it returned; an observer long-poll leaves the cursor unchanged (L4); waiter ignores `message`/`tool`, exits 0 on `turn_done` and on `request_stale` (H1), exits 2/3/4 as specified, exits when its parent pid is gone; default interactive timeout = `requestAbandonMs` + 5 min (M7); `degraded` for a `codex exec` parent | S | Grok (tests: pi) |
| **WP6** Children collector and tree merge | Children are agents in the tree; dry-run shows them; Codex recap unchanged | `src/collectors/children.ts` (stamp polling), `src/types.ts` (4 fields), `src/index.ts`, `src/tree-page.ts`, `src/collectors/brief-dry-run.ts`, `subagent-tree.ts` multi-root parent map, `harness/claude/topology.ts` for Claude child subagents; `main-transcript.ts` with memoised `codexMainTranscript`; `recapInput`/`briefingSchedule` over `MainTranscript` | tests (pi): fixture records → nodes with the mapping table of §2.8 (every row); host down (`host.json` stale) → `lost` nodes with status `error`, not empty, still listed after the linger (M3); `rolloutPath` set for Codex children only (L6); exactly one filesystem call per quiet tick with an injected `fs`; `agentCounts` counts children; dry-run output contains child lines within §4.3; Codex recap and brief fingerprints byte-identical across two consecutive ticks over an unchanged rollout (M4); `CODEX_HUD_PROFILE` `children` stage ≤ 5 ms p99 with three fake children | M | Grok (tests: pi) |
| **WP7** Rendering | Harness glyph, request line and count, lifecycle line, Inspector sections, bar alert/notice keyed by turn, statusline line 2, Pi footer counts, i18n | `render/{cards,subagent-chip,monitor-inspector,monitor-timeline,attention,statusline-*}.ts`, `collectors/bar-notices.ts`, `harness/pi/footer.ts`, `render/i18n.ts`, visual baselines | visual tests at 32/40/48/56, EN/ZH, both colour modes; §8 checklist of `docs/ARCHITECTURE.md`; a card with two unanswered requests shows `⚑ … +1` and none after `hud_respond`; a `lost` child shows the recovery line; two turns completing between ticks give two notices | M | frontend-implementer (design: Fable-max) |
| **WP8** HUD Pi package | Parent in-process tools over the shared dispatch, child `ask_orchestrator`, wake, footer, `pi install`; the pi-roles `--qa-dir` registration change (owner) | `packages/hud-pi/*`, `src/harness/pi/{hud-parent,hud-child,footer}.ts`; delete `extensions/pi/hud-delegate.ts`, `extensions/pi/hud-footer.ts`, `integrations/pi/hud-wake.ts`, `harness/pi/{delegation-bridge,delegation-channel,delegation-context,wake-extension}.ts` | tests (pi): a Pi rpc child's `ask_orchestrator` → `request` → `hud_respond{value}` → tool returns the answer; `hud_respond{cancelled:true}` → tool returns `(cancelled)`; a parent session's tools call the fake host with the right owner and attachment; the observer long-poll delivers a wake once per seq within an attachment; the footer line is rebuilt from fixture records when the stamp changes; the composed launch line with pi-roles loads with one `ask_orchestrator` (P3 evidence); `pi install packages/hud-pi` on a temporary `PI_CODING_AGENT_DIR` registers it | M | Grok (tests: pi); owner for pi-roles |
| **WP9** Summaries pipeline | Every summary feature for Codex roots and children of all harnesses | generic material boundary wired for all collectors (if not finished in WP1); causes from child error events; approval words over child requests; `brief --dry-run` parity | tests (pi): brief, recap, progress, digest, names, causes, approval words each produce material for a Codex child, a Claude child, a Pi child and a Jev job within §4.3 limits; dry-run text equals the generator input; reasoning blocks never appear | M | Grok (tests: pi) |
| **WP10** Non-Codex roots (Q5: inside v2 acceptance) | Claude/Pi roots get recap, brief and a standalone panel | `claudeMainTranscript` (reader extended with prompt heads), `piMainTranscript`, `hud panel --session` with the single-live-transcript rule, status card variants without Codex-only fields, `brief --dry-run --root` | dry-run `--root claude` / `--root pi` prints recap material within limits; the standalone panel shows a Claude root with its children; two live Claude transcripts in one cwd → the candidate list, not a guess | M | Grok + frontend-implementer |
| **WP11** Installer, registration, upgrade validation, skill, docs | One install + one registration; upgrades do not leave debris; docs match | `install.sh` (build hud-mcp and hud-pi, print the three registrations); `hud setup` (prints the same, checks the socket dir, `--check` reports obsolete Claude hook entries, old Pi extension paths in pi settings, stale `dist/`, an incompatible running host (`host.json` protocol), leftover `native-hosts/*.sock`, and prints the exact lines to remove without editing unrelated configuration; `--sweep`); `integrations/skills/hud-delegate/SKILL.md` for `hud_*` (arming and re-arming the Claude waiter, answering requests with `hud_respond`); `docs/ARCHITECTURE.md` §"Children", `docs/reference.md` (child display, env table, the host-loss limitation), `docs/delegation.md`; historical docs to `docs/archive/` | `./install.sh --sync` on a clean clone builds all three programs; `hud setup --check` on a home with a v1 hook and an old host reports both; `docs/reference.md` lists every new model input | S | Grok + pi |
| **WP12** Real-client matrix | Close F2–F8 on real clients with exact process tracking | `scripts/local-validation/*` without `delegate.json`/`native.json`/hook; 3 parents × 2 children + Jev, each create/send/read/respond/resume/close/wake, plus host-loss recovery and `jev_close` → host exit; performance checks of §2.6; the scripts record every pid HUD started (host, child pgid + stamp, waiter, Jev tabs) from the records and host log | the results table of `docs/cloud/handoff/local-real-client-results-20261107.md` re-run with all rows PASS including the wake and respond rows; after each `hud_close` the recorded group is gone within `closeTimeoutMs`; after the last close + `graceExitMs` the host pid is gone and the socket and `host.json` unlinked; the parent's hud-mcp exits with the parent; **no blanket `pgrep -f` assertion** (parent-owned MCP processes legitimately live on, unrelated sessions may match, Pi descendants may be missed) | L | owner (Hermes-style) + pi (scripts); Codex cells on `codex2` with `gpt-6-luna` medium |
| **J1–J9** Jev | per JEV1 §6 | `src/jev/*`, `src/managed/jev-host.ts`, `jev-tools.ts`, TUI rows, licences, jev-ask lock, real dry-runs | per JEV1 §5 | per JEV1 | per JEV1 |

Ordering: WP0 → WP0.5 (observe-now column) → WP1 → WP2a → WP2b → WP2c → WP3 → WP4 → WP5 → (WP6 ∥ WP8 ∥ J1–J4) →
WP7 → WP9 → WP10 → (J5–J8) → WP11 → WP12 (+ J9); the probes' re-verify column runs inside the WP named for it.
WP2a may start on a branch during WP1 (it touches `packages/hud-mcp` and `src/managed` only) and merges after WP1.
Each package is one Opus-subagent review; the same reviewer re-checks the fix.

Changes from v2's plan, for the record: baselines and a real main-feature gate first (v2's WP0 reused
`run-core.sh`, which never gated main features); probes before deletion (v2 deleted first); extraction before
deletion (v2's WP2 deleted modules that `server.ts:1,9`, `lifetime.ts:1-2`, `render/monitor.ts:1-35` and
`npm test` (`package.json:20`, `build:hud-mcp`) still consumed until its WP3); the old WP2/WP4 split by acceptance
boundary (WP2a/2b/2c; WP3 lifecycle vs WP4 normalisation); the `tsc --listFiles` gate replaced; upgrade validation
added; WP10's `pgrep`-empty assertion replaced by owned-process tracking; non-Codex roots inside acceptance. From
v2.1: the TUI subscription replaced by the stamp file (O1), probes split by what exists today (M9), the manifest
derived from main's own test list (M9).

---

## 8. Decisions on the open questions and forks

Decided by the owner on 2026-11-07 (with Pro's recommendation where it was adopted; the three forks as this
document recommended them; recorded in `docs/universal-hud-concept.md` §15, "2026-11-07 设计定稿"):

| Q | Decision | Where |
|---|---|---|
| Q1 Pi in-process or stdio MCP | **In-process**; validation, dispatch, errors and results shared with hud-mcp | §3.1, §1.9 |
| Q2 One host per user or per owner | **One host per effective HUD home** (normally one per user), owner-scoped state, per-child source and environment; the shared crash domain accepted with the tested close ladder and sweep | §6.1 |
| Q3 Advertise HUD tools to Codex children and refuse them | **No**: launch marker (own env / ancestor environ) → empty HUD tool table in child mode; direct-call refusal kept, the active-child index guarding calls; depth enforced again at the host; no change to unrelated native configuration | §1.4 |
| Q4 30-minute idle close | **Yes**, configurable, quiescent-only; passive reads never extend it; blocked/abandoned children have their own policy | §6.1.4 |
| Q5 Non-Codex roots in v2 or phase 2 | **Inside v2 acceptance**: panel, recap, brief and the other summaries for Claude and Pi roots (WP10); statusline/footer-only support does not complete the fixed scope | §4.2, §7 |
| Child requests | **Answered by the main session through `hud_respond`** (as herdr's `ask_orchestrator`); re-wake once after 1 h, withdraw and close `abandoned` after 2 h, both configurable | §3.3, §5.1, §6.1.4 |
| JEV1 D4 Jev lock granularity | **Decided in JEV1** (`docs/design/jev-in-hud.md`): only send, reconcile and connector approval hold the shared-Chrome lock; observation runs unlocked; the lock is a heartbeat lease with a nonce | JEV1 §4.5; §6.1.1 |
| JEV1 D7 Jev CLI retirement | **Decided in JEV1**: the CLI's ChatGPT/Gemini path retires behind the threshold of JEV1 §4.5 (matrix green plus one real answer per provider through MCP) | JEV1 §4.5 |
| F1 Crash containment | **Process groups + recorded `{pgid, procStart}` + a sweep at the next host boot** (by group, M5); no extra daemon, no native code; the window between a host `SIGKILL` and the next boot is accepted; a per-child parent-death guard (Linux `PR_SET_PDEATHSIG`) is considered only if probe P4 shows a harness ignoring stdin EOF | §6.1.3, §7.2 |
| F2 Abandoned requests | **Re-wake at 1 h (`requestStaleMs`, the `request_stale` event), close with `closeReason:'abandoned'` at 2 h (`requestAbandonMs`)**, both configurable; the native session stays resumable | §6.1.4, §5.1, §1.5 |
| F3 Turn wall-clock deadline | **None by default**; `turnDeadlineMs` is opt-in and, when set, interrupts with `hud_cancel` semantics (outcome `interrupted`, never "idle") | §6.1.4, §1.5 |

No forks remain open: everything in §1–§7 is decided here or in JEV1. The v2.2 review changes (H1–H2, M1–M10,
L1–L10, O1) were applied without a new fork; the one judgement call, O1, is recorded in §2.7.

## 9. Risks

- **Undocumented carriers.** `x-codex-turn-metadata` and Claude's `sessions/<pid>.json` are not documented
  interfaces; a version may change their shape or stop updating the registry on `/clear` or some resume path
  (P1 covers the paths the owner uses). Mitigation: WP12 pins the versions it was verified against; the identity
  module has one function per carrier with a fixture test; a change shows as `invalid_arguments` with the raw
  `_meta` keys named, or `identity_unavailable`, never as a silent mis-attribution.
- **Codex daemon mode.** When Codex runs its shared daemon, MCP servers are spawned by the daemon and the
  harness ancestor's environment is the daemon's, not the TUI's (§6.2, §1.2), and `codex queue` is `degraded`
  (§5.1). The owner's TUIs run embedded today (matrix §2.2); if that changes, the Codex parent should pass `env`
  through `mcp_servers.hud.env` for the few variables that matter, which is still one registration.
- **`codex queue` reliability** is bounded by Codex (idle-only, ~10 s poll, daemon guard). The design tolerates a
  lost wake (the parent's next call drains events) but a Codex parent that never calls again stays asleep.
- **Codex child question path** may not exist under app-server (P3b); the fallback (`turn_done` + `hud_send`) is
  honest but less structured than the other two harnesses' requests.
- **Host crash** ends every live child's connection; records show `lost` (kept visible, M3), children's native
  sessions remain resumable, orphans are swept by group at the next boot (§6.1.3); the window before that boot is
  accepted (§8 F1) and is revisited only if P4 shows a harness ignoring stdin EOF.
- **Claude SDK pin vs installed `claude`.** `package.json` pins `@anthropic-ai/claude-agent-sdk 0.3.319` while the
  child runs the user's installed executable (`sdk-adapter.ts:69-91`); drift can break callbacks, and whether the SDK
  exposes the child process for containment is P4's question. WP12 records the pair that passed.
- **Pi rpc `ctx.ui` in a tool.** §3.3 assumes a tool-initiated `ctx.ui.input/select` surfaces as an
  `extension_ui_request` in `--mode rpc` and honours `{signal}`; P3 checks it against the installed pi; if it does
  not, the fallback is a `hud_ask` rpc-side custom event with the same host mapping. Pi's "answered" is inferred
  (§3.3), so a quiet session can show a request as answered 5 s before pi has consumed it; the next
  `extension_ui_request` with the same id re-opens it.
- **Deletion churn.** 205 tests need edits (Appendix A); the risk is dropping main coverage by accident. WP0's
  manifest is the guard, and WP2b must leave the visual baselines byte-identical outside the removed scenes.
- **Child startup cost** (7–15 s) stays as long as the user's configuration loads many MCP servers; HUD will not
  trim it (non-interference). The card's `starting` clock makes it visible rather than hidden.
- **Attribution of native-subagent callers to the root** (§1.3) means a Codex implementer's reviewer subagent could
  create a HUD child that the tree shows under the root, not under the reviewer. Acceptable for depth-one display;
  noted so it is not mistaken for a bug.
- **Jev: the sidebar may not render in a headless viewport**, so the sidebar-diff locator is the second path, not
  the first (JEV1 §3); **the TypeScript port may drift in timing** from the Python original (post-input waits, stale
  detection), mitigated by verbatim page scripts, translated upstream tests and the real-browser guard check
  (JEV1 §4.1); **the OpenAI Decisions API does not document its choices-per-question or input-size limits**
  (JEV1 §4.11). The Jev lock and CLI-retirement questions are decided in JEV1 (D4, D7; §8), not here.

---

## Appendix A. Inventory summary (from the git-ignored `tmp/tasks/DES1/inventory.md`, at `f26e873`)

Totals: `src/` + `packages/hud-mcp/` 391 files / 99 164 lines, of which 139 files / 31 803 lines are removable with
the historical stack. Tests: 630 files / 179 002 lines — 72 HIST-ONLY (13 165 lines) and 98 MIXED-mostly-historical
(32 005) to delete, 205 MIXED-mostly-keep (78 565) to trim. Docs: 250 historical files / 65 291 lines. These
classifications and the module-load totals are the inventory's and were not independently verified; WP0's manifest
and WP2b's file-by-file pass are where they get checked. (`src/render/delegation/*` is 5 122 lines by `wc`, L9.)

Process-start module loads: `hud run wait` 119 modules / 31 592 lines (37 historical, 14 in `src/ledger/*`); bar
`src/index.ts` 149 / 44 646 (36 historical / 11 420); panel `src/tree-page.ts` 193 / 63 945 (46 / 13 887);
statusline 44 / 13 192 (2 historical); hud-mcp `main` 39 / 7 606 (0); `host-entry` 16 / 3 340 (0).

"KEEP?" groups and their v2.2 fate: cli-pi 11 modules / 4 655 lines (Claude/Pi transcript readers, `core/checkpoint.ts`,
`harness/claude/background|todos`) → readers kept for roots (§2.3, §4.2), `hud pi inspect` deleted; pi-footer 6 / 966 →
kept, data source changed (§2.4); cli-cache 2 / 595, cli-migrate 4 / 556, cli-launch 3 / 351 → deleted; brief-dry-run
2 / 119 → kept and extended (§4.3).

Hot spots (inventory §6) and the package that cuts each: H1 bar collector/merge (`src/index.ts`) → WP1; H2 panel
collector, Herdr `PanelHostController`, `DelegationLogView`, `PublicationWorker` (`src/tree-page.ts`) → WP1; H3
statusline line 2 ledger read (`src/cli/statusline.ts`, `src/core/statusline-summary.ts`) → WP1; H4 `src/cli/hud.ts`
static imports + `CallBudget` → WP1/WP2b; H5 `src/cli/run.ts`, H6 `src/cli/run-wait.ts` (legacy wait beside
`runNativeWait`, 306–359), H7 `src/cli/runtime.ts`, H8 `src/cli/link-export.ts` (`HudIO`) → WP1 (extract) / WP2b
(delete); H9 `packages/hud-mcp/src/server.ts` bodies and `tools.ts` legacy → WP2a/WP2b/WP2c; H10 type refs to
`core/ledger-scope-read.ts`, `config.ts` validator, `FileCallerRegistry`, `WakeRegistration` → WP2c; H11
`packages/hud-mcp/src/lifetime.ts` → `src/core/run/process.ts` → WP1 (`core/process-stamp.ts`); H12 native-call rows
in `DelegationViewModel` / `LinkTreeProjection` → WP6 (own projection) then WP2b deletes `render/delegation/*`; H13
packaging scripts → WP2b; H14 `bin/hud-run` → WP2b; H15 `tsconfig.test.json` single program + shared fixtures → WP2b;
H16 Pi footer → ledger → WP1/WP8; H17 `install.sh` builds only `npm run build` → WP11; plus `render/monitor.ts:1-35`
(link/delegation imports) → WP1, the readers' observation/checkpoint chain → WP1, and `recordStamp` in
`core/materials/request.ts` → WP1.

## Appendix B. Tool table (served by hud-mcp to Codex and Claude parents; registered in-process for Pi; empty in a child)

| Tool | Arguments | Returns | Notes |
|---|---|---|---|
| `hud_create` | `{ harness:'codex'\|'claude'\|'pi', cwd, prompt?, name?, model?, effort?, resume?: NativeRef, fork?: NativeRef, options?: { args?: string[] /* pi only */ } }` | `{ child, harness, nativeRef: NativeRef \| null, seq, wake: { kind:'queue'\|'background_command'\|'followup'\|'none', capability:'available'\|'degraded'\|'unavailable', reason?, command?, note? } }` | starts the host if needed; `prompt` sends turn 1 after the record is published; `resume` of a live child of another owner → `child_busy`; no permission-mode fields (`approvalPolicy`/`sandbox` of v2 are removed and the adapter's `options` spread goes in WP2c: permission modes are the user's configuration); `options` on a non-Pi create → `invalid_arguments{options_not_allowed}` |
| `hud_send` | `{ child, text, mode?: 'turn' \| 'steer' }` | `{ seq, turn }` | `steer` only while a turn runs (Codex `turn/steer`, Claude message push, Pi `steer`) |
| `hud_wait` | `{ child?, afterSeq, waitMs?, wakeOnly?: boolean, observe?: boolean }` | `{ events: ChildEvent[] ≤ 50, seq, generation, truncated, gap? }` | long-poll with `effectiveWaitMs = min(waitMs, 120000, clientToolTimeoutMs − margin)` (the rule JEV1 §4.4 cites from `docs/contracts/05-capabilities.md`); advances the owner's read cursor only to the last seq returned, and not at all with `observe:true` (the waiter and the Pi package); `wakeOnly` filters to the wake-worthy list of §5.1; `gap` → re-read `hud_list` |
| `hud_read` | `{ child, what: 'status' \| 'requests' \| 'request' \| 'result' \| 'transcript' \| 'context', requestId?, offset?, limit? }` | `status` → the `ChildRecord` with heads trimmed (task ≤ 300, outcome ≤ 600, lastMessage ≤ 300), `requests` reduced to the first unanswered entry plus `pendingRequests`, ≤ 2 KiB; `requests` → `HudRequest[]` (≤ 10, each ≤ 8 KiB); `request` → one, paged; `result` → last turn text paged (≤ 32 KiB/page); `transcript` → recent public messages from the recorded source (`limit` ≤ 50, each ≤ 2 KiB); `context` → usage | never returns SDK init results (F8); passive: never extends the idle clock |
| `hud_respond` | `{ child, requestId, response: HudResponse }` | `{ ok, how:'sent', answeredAt }` | §3.3 mapping per harness; `request_done{how:'answered', evidence}` follows on the harness's evidence; answers never change permissions (M10) |
| `hud_cancel` | `{ child }` | `{ ok }` | interrupts the running turn only |
| `hud_close` | `{ child }` | `{ ok, released, exited, workStopped, closeReason:'closed' }` | the ladder of §6.1.3; the native session stays resumable |
| `hud_list` | `{}` | `{ children: ChildRecord[] ≤ 50 (status form), jev: JevJobSummary[], host: { generation, protocol, uptimeMs } \| null, wake: WakeBinding, unavailable?: 'host_down' }` | read-only; answers from records when the host is down (`lost` where applicable) |
| `jev_ask` | `{ provider:'chatgpt'\|'gemini', label, prompt_file?, prompt?, attach?, mode?, dry_run?, max_wait_ms?, wake_on_sent?, decisions?, confirm_resend? }` | `{ key, state, seq, wake }` | JEV1 §4.4 verbatim: idempotent on `key`; `label` matches `[a-z0-9][a-z0-9-]{0,63}`; a `released` key needs `confirm_resend:true` (else `resend_needs_confirmation`), which may come only from the user's explicit decision; one send per key ever; returns ≤ 1 s (D3). (`effort` of v2.1 is gone: the model and effort word are configuration, D6) |
| `jev_ask_wait` | `{ key?, after_seq, wait_ms, resume? }` | `{ events[], seq }` | JEV1 §4.4: long-poll with the same `effectiveWaitMs` rule; `resume:true` restarts wait or reconcile per JEV1 §4.7, never a send |
| `jev_ask_read` | `{ key, what:'status'\|'answer', offset?, limit? }` | `status` ≤ 2 KiB; `answer` paged ≤ 32 KiB | JEV1 §4.4: read-only; the answer comes from the record's `answer_file` |
| `jev_ask_close` | `{ key }` | `{ ok, run, work }` | JEV1 §4.4: aborts observation with the ladder of JEV1 §4.7; the record is untouched; never undoes a send |
| `jev_open` | `{ url, goals?, screenshots?: false, record_dir?, decisions? }` | `{ instanceId }` | in-process Agent (JEV1 §4.4); replaces `jev_create` |
| `jev_run`, `jev_snapshot`, `jev_command`, `jev_close` | as today (`packages/hud-mcp/src/jev-tools.ts:26-67`) | as today; `jev_run` yields are published as host events (the ring, for `hud_wait`) and folded into the instance's job file (and the owner's stamp, for the TUI) | in-process; one instance is serial; `jev_list` folds into `hud_list` |

Codex `_meta`, Claude `claudecode/toolUseId` and Pi call ids are accepted on every call; nothing in `arguments`
selects an owner. Error codes: `depth_limit`, `child_busy`, `host_unavailable`, `host_shutting_down`,
`host_incompatible`, `invalid_arguments` (with `carrier_mismatch` / `options_not_allowed` detail),
`identity_unavailable`, `source_mismatch`, `limit_exceeded`, `child_not_found`, `child_record_unavailable`,
`request_not_found`, and from JEV1 §4.10: `jev_credentials_missing`, `ask_queue_full`, `ask_limit`, `browser_busy`,
`resend_needs_confirmation`, `decision_refused`, `decision_provider_error`.
