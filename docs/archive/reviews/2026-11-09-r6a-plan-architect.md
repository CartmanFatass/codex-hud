# R6a installation design

## 1. Recommendation:

**Recommendation:** Extend the existing immutable-release installer with reversible client activation, a thin Claude plugin and pi package, and session-owned herdr panels; keep the old Codex installation and execution paths untouched until R6b.

This is a design against `universal-hud` HEAD observed as `da22075`, not an installation or live acceptance report. No live configuration, private Fishpref source, credentials, or client session was inspected or changed.

## 2. Reasons and important findings

1. **Reuse the installer, not the historical alias installer.** `scripts/runtime-package/installer.mjs:222–284,316–339` already validates a private prefix, immutable releases, selectors, receipts and stale plans. `scripts/install-runtime.mjs:9–19` deliberately supplies no PATH or provider setup. Those missing activation steps are R6a's work, not a reason to replace the installation transaction machinery.
2. **Do not put the existing prefix's entire `bin/` on PATH.** `scripts/runtime-package/manifest.mjs:58–64` includes `codex-hud` and `hud-run` as well as the new commands. Publishing that directory could shadow the daily-use installation. `src/cli/compat.ts:40–42` already provides an explicit `hud codex` route without replacing `cx`.
3. **Packaging alone does not make ordinary sessions work.** `packages/hud-mcp/src/role-main.ts:31–48` captures caller identity once. `src/roles/caller.ts:91–153` requires a particular pi argv layout and explicit session selection. An ordinary pi package cannot rely on that. Conversely, in-process session changes must not retain the previous caller. The orchestrator explicitly authorized a separate, narrow session-binding package during this consult: existing harness evidence only, current-session rebinding or per-call resolution, clear fail-closed errors, and concurrent-session/switch tests.
4. **Preserve source-qualified identity.** `src/roles/selection.ts:97–105` uses `sourceId/sessionId`, not `claude/sessionId` or `pi/sessionId`. `hud panel --harness X --session ID` must resolve a source, then translate to the existing observation root. Display flags never confer MCP authority (`src/cli/panel.ts:7–10,21–29`).
5. **There really is a footer ownership conflict.** `src/harness/pi/footer.ts:313–327` clears and replaces the host footer; its shutdown also calls `setFooter(undefined)`. Loading that controller alongside p10k is not coexistence. Installed pi 1.5.0 documentation says `setFooter` replaces the entire footer and supplies extension status data to the custom footer (`docs/extensions.md:2905–2911` in the installed package). Use a status segment, not two footer owners.
6. **The existing summary is not a role-job summary.** `src/core/delegation-summary-pi.ts:42–50` reads the historical committed delegation cache. `src/cli/statusline.ts:103–127` composes that cache and native calls. Neither installation metadata nor the footer may pretend these are complete R2 job totals. The orchestrator authorized a bounded, read-only role-summary adapter, shared between the two surfaces, with stamped cached facts and measured cost.
7. **Panel storage needs an explicit non-Codex boundary.** `src/utils/codex-path.ts:88–96` still writes HUD caches below Codex home; `src/tree-page.ts:544,681–688,733` uses it. The orchestrator authorized an explicit HUD-owned display-home route for non-Codex panels, preserving Codex defaults, and a tiny lifecycle export after R5-UX P2. No R6a rendering/settings/i18n redesign is needed.
8. **Statusline parity is not established.** `docs/statusline/feature-coverage.md` explicitly lists effort, tools/todos, Git, quotas, speed and toktrack tee among missing families, and explicitly says the owner's installed configuration was not compared. Replacing the owner's statusLine is an activation gate, not something a successful plugin install implies.
9. **Keep the architectural fences.** `docs/ARCHITECTURE.md:807–850` requires pure rendering, explicit model egress and private state. Concept §15 (`docs/universal-hud-concept.md:755–824,862–920`) keeps execution with herdr/Jev, main-session chaining, passive display and HUD-owned credentials. Closing a panel or MCP transport never means closing delegated jobs.

### Current external interface evidence

These are current **unversioned Claude documentation snapshots**, inspected during this consult, not proof about the owner's installed Claude version:

- [Plugin manifest](https://code.claude.com/docs/en/plugins-reference): plugin components include commands/skills, hooks and MCP servers; only `agent` and `subagentStatusLine` take effect in plugin `settings`, not main `statusLine`.
- [Skills](https://code.claude.com/docs/en/skills.md): custom commands are prompt-based skills; plugin commands are namespaced as `/plugin-name:skill-name`; shell `!` injection runs before the content is sent to Claude. Shell preprocessing is **not** a documented no-model command mode.
- [Hooks](https://code.claude.com/docs/en/hooks.md), sections `UserPromptSubmit` and `UserPromptExpansion`: submit receives the raw typed skill command; blocking prevents it reaching Claude. Expansion matches the command name and can also block it. `decision: "block"` with `reason` is documented. Submit hooks have no matcher; expansion hooks do.
- The same hook reference documents SessionStart on startup/resume/clear/compact/fork, SessionEnd, plugin-scoped MCP names, and short-lived command hooks. SessionEnd has a shared default 1.5-second budget. Hook processes have no controlling terminal: do not try to run the panel in the hook's stdio or `/dev/tty`.
- Installed **pi 1.5.0** docs under `~/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/docs/`: `packages.md` documents explicit `pi.extensions`/`pi.skills`, local-path packages and personal `agent/settings.json`; `extensions.md:315,393,475–530,601–607` documents command handlers preceding model input and session start/shutdown on replacement/reload; `extensions.md:2778–2791` documents session-scoped MCP registration. Host libraries are peer dependencies, not bundled copies.

**Answer to the Claude no-model question:** documented hook interception can perform the local panel action and block the command before a model request. A Markdown command containing a shell injection alone cannot promise that. Prefer a command-name-matched `UserPromptExpansion` hook, avoiding a Node spawn on every ordinary prompt. Prove it on the installed CLI before activation. `UserPromptSubmit` exact-command interception is a documented fallback if the installed CLI lacks expansion hooks; it has a per-prompt startup cost that must be measured. Do not silently fall back to asking the model to toggle a panel.

Not verified here: the owner's Claude command-routing/version behavior, bare `/hud` resolution, plugin-manager file mutations, live herdr split/close behavior, private p10k's status rendering, or enabled claude-hud fields. These have explicit checks below.

## 3. For the implementer

### A. Installation layout and transactions

Use these locations, with explicit overrides selected at preview time:

```text
~/.local/share/universal-hud/              private runtime prefix, 0700
  bin/                                   existing checked selector shims
  current                                existing atomic selector document
  releases/<manifest-sha256>/             built application + locked libraries
    bin/                                 including internal Codex compatibility scripts
    dist/
    packages/hud-mcp/{bin,dist}/
    integrations/skills/hud-delegate/
    integration templates, notices, installer
  receipts/                              existing runtime install/restore receipts

~/.local/bin/{hud,hud-statusline,hud-mcp}  individually approved public shims only

$HUD_HOME/                               default ~/.hud, canonical, private
  config.json                            existing non-secret provider configuration
  credentials.env                        existing hardened reader; 0600
  routing.toml                           owner-maintained routing, never auto-replaced
  hud-settings.json                      explicit universal display settings path
  display/                               non-Codex display caches/state
  installation/                          activation plans, backups, transaction journal
    integrations/<activation-id>/        generated thin client packages and binding files
  panels/                                small display-lifetime receipts
  ...existing job/Jev/association stores
```

The layout of `config.json`, routing and existing job stores is not redesigned. `hud-settings.json` remains the existing display-settings format; do not merge it into provider config. Existing configured files are preserved, and any copy/migration of display settings is separately previewed. Never import credentials from pi, Codex or jev-ask. Do not create a sample file that overwrites the credentials already installed by KEYS.

**Public interface:** add an installation-management CLI, separate from the existing role/provider `hud setup`. Suggested grammar: `hud install preview|apply`, `hud install restore`, `hud uninstall preview|apply`, all using an explicit plan/receipt. The first installation uses the bundle's `install-runtime.mjs` bootstrap plus an activation script from that bundle, because `hud` does not yet exist. No shell prompt; preview is read-only, apply requires the exact reviewed plan identifier. Installation must not call a model, start a job/browser, or open a panel.

Use the existing runtime apply/restore transaction unchanged where possible. Add a separate activation transaction rather than teaching the strict runtime prefix to accept arbitrary user files. An activation plan records:

- schema and transaction id; exact runtime digest and client package version;
- each canonical target, operation, original identity/hash/mode or absence, proposed hash;
- which integration is enabled, exact executable/source roots and public names;
- dependency/preflight results and explicit owner-confirmation items;
- ordered actions and recovery instructions.

Back up before each mutation, journal before/after results, and recheck the previewed state. Preserve unrelated JSON/TOML values. Refuse symlink/foreign-file replacements, stale plans and unsupported configuration layouts; inspect symlinked pi configuration explicitly rather than following it into Fishpref. Do not edit a symlink target without a separate owner-approved target and backup. Match the existing statusline writer's atomic private-file, lock and conflict behavior. Native client package-manager operations are journaled steps, not falsely described as one atomic filesystem transaction.

**Release contents:** build in clean staging, never copy a working `dist/` wholesale; the repo documents stale build outputs. Extend `scripts/pack-runtime.mjs`, `scripts/pack-cloud-preview.mjs` and runtime manifest tests for the skill, integration templates and all new entrypoints. Keep the reviewed dependency closure and notices. Do not install pi/Claude/Codex, herdr, pi-roles or browsers as implicit dependencies. Keep old host libraries until R6b; the newly activated role entry must not import/start the old execution host.

The manifest path validator currently rejects dot-prefixed components (`scripts/runtime-package/safety.mjs:17–24`). Either ship ordinary-named templates and materialize `.claude-plugin/plugin.json`/`.mcp.json` into the activation package, or admit only those exact packaged metadata paths in the inventory. **Prefer templates:** do not globally relax path validation to arbitrary dotfiles.

**Versioning:** use one release version across the plugin, pi package and runtime metadata; runtime identity remains the manifest digest, with commit/lock provenance. Client binding files pin an absolute immutable release and its digest. A cached Claude plugin must not use `../../dist` to escape its cache; its small adapter reads its own generated binding and dispatches to the pinned release. The pi package uses the same pin. Copy the canonical skill at build/materialization time and verify its hash; do not maintain three divergent skills.

**Upgrades:** install a new release, test it in isolation, then separately preview activation of new client package pins and public selector. Running sessions retain their owning release; no hot replacement or automatic `/reload`. New hooks must recognize receipts from an older panel and leave them alone unless ownership is proved. Do not garbage-collect old releases in R6a. Statusline setup currently pins an absolute release entry; changing it on upgrade requires another preview/apply, not editing a backup or assuming the PATH selector changes it.

**Uninstall:** reverse activation steps, restore prior values/absence, then deactivate public shims and the selector. Use backups in reverse transaction order. A changed user file causes a conflict report, not forced restoration. Keep backups and user-created keys/history/results by default. Remove only unchanged files recorded as created by this install. If running clients/jobs still refer to a release, report `deactivated; release retained`, not fully purged. Finish removal only after those owning sessions/resources have drained. This is compatible with R6b without implementing its migration machinery.

### B. Ordinary-session binding: prerequisite, not an env-var shortcut

Create a narrow resolver seam used by `role-main.ts`; retain the existing role tool schemas and execution model.

- **Claude/Codex:** resolve corroborated native session evidence at call admission, not once at MCP startup. Recheck after any asynchronous evidence acquisition before dispatch. For Claude use its current native session record and session id, with SessionStart/End evidence only where necessary to cover current-session transitions. A hook-supplied id alone must not become a global bearer credential. Late end/start events are generation-fenced. Missing/ambiguous evidence returns `identity_source_missing`, `identity_unverified` or `stale_context`, not a guessed cwd match.
- **pi:** reuse `PiDelegationBridge`, `PiDelegationChannel` and `PiEvidenceChannel` ownership/epoch mechanisms (`src/harness/pi/delegation-bridge.ts:19–78`; `packages/hud-mcp/src/pi-channel.ts:11–13,153–202`). Adapt the bridge to the six role schemas and role entry, not the old managed tools. Take session directory/id/file from extension context, validate native evidence, and close/recreate the channel on session replacement. Do not require special `--session-dir` argv merely to install the package.
- The pi extension registers six thin tool proxies from the canonical role schemas; calls travel over the actual private MCP channel. This preserves the common MCP implementation while supplying fd3 evidence. Do **not** additionally register the same server through pi's generic `mcp.json`/`registerMcpServer`: that path does not by itself transport the existing fd3 evidence, and would duplicate tools/processes. If native registration is chosen later, it must first prove an equivalent evidence transport.
- Fence the old epoch synchronously before cleanup. In-flight admission under an obsolete epoch refuses; already dispatched work is not replayed or canceled. Closing the transport does not close jobs.
- Main-session identity and top-level-panel eligibility are separate decisions. A real worker may use delegation tools without owning a side panel.

Tests must include ordinary pi startup, initially unpersisted session, first persisted call, reload, new/resume/fork/tree navigation, canceled transitions, MCP restart, PID reuse, two sessions sharing cwd/configuration, forged model arguments/env-only claims, and a transition racing tool admission. Include Claude `/clear` and `/resume` in-process and Codex current-thread changes. No cross-session selection or job access.

### C. Shared side-panel control and lifetime

Add `src/integrations/panel/` with a small control module, receipt codec and herdr adapter, plus a CLI entry. Reuse current bounded herdr transport patterns; do not build an execution daemon.

Expose:

```text
hud panel --harness claude|pi|codex --session ID [--source ABS]
hud panel --root SOURCE_ID/SESSION_ID       # preserved
```

These commands render in the current terminal. Internal integration commands `open|close|toggle|status` create/control the side pane. A plugin hook must call **open**, not spawn an indefinitely running render command in its own pipe. The split runs the pinned `hud panel --harness X --session ID` with the validated source and display-lifetime receipt.

Resolve source from validated native context or an explicit configured root. Use `makeSourceId` and the existing roster-root formatter. Session id alone is insufficient; do not use the harness name as the namespace.

**Eligibility:** auto-open only in a confirmed interactive top-level main session in herdr. Check the actual originating pane/process and harness evidence. Suppress native subagents/teammates and role-launched workers using existing launch/session evidence; an absent `agent_type` is not enough, and a named top-level `--agent` is not automatically a worker. Inherited `HERDR_PANE_ID` alone is not proof. Unknown eligibility means no automatic split and a concise diagnostic. Outside herdr, keep native status and MCP working; explicit panel command can run in another terminal. Do not add a tmux fallback for Claude/pi.

**Panel receipt, display-only:** schema, random generation, harness, complete display ref/root, main process PID/start stamp, herdr instance and originating pane, created panel pane/occupant evidence, pinned runtime digest, and phase (`opening`, `open`, `closing`, `closed` or `uncertain`). Store privately under a hash of the main process/pane identity. It must never be accepted as job control authority.

- Serialize open/close for the same main pane. Repeated SessionStart/compaction and `/hud on` are idempotent.
- Write opening intent before requesting the split. Pass a unique launch token into the panel process. A timed-out create is ambiguous: reconcile that exact token/pane, never blindly create again. The newly started panel self-registers its actual pane, closing the lost-response window.
- Create a split to the right without stealing main focus. Use literal argv/environment supported by herdr, not model-controlled shell text. Verify split and close capabilities on the installed herdr schema; do not change herdr's existing compatibility gates as a packaging shortcut.
- On main-session replacement, invalidate the previous generation and stop/reopen the display for the new root. An old SessionEnd must not close the new generation.
- SessionEnd/shutdown closes only the recorded HUD pane after revalidating occupant/instance. It never closes the main pane, worker tabs, jobs or browser resources. If another process occupies the pane, refuse.
- Closing a panel manually does not trigger automatic resurrection on a timer. `/hud on` explicitly reopens it. Auto-open preference defaults on in herdr; persist the off switch in HUD-owned integration configuration, not in R5's settings UI. Document whether `/hud off` is session-local and use an explicit setup option for the persistent default.

**Lifetime:** the panel itself monitors its main process stamp, generation, own terminal and herdr pane identity. SIGHUP, terminal closure, main exit or replaced generation ends it. SessionEnd is best-effort, not the only cleanup mechanism. Use one single-flight timer per visible panel, approximately one second for local process/generation checks and at most one herdr observation every three seconds; each request has a deadline. On prolonged unavailable ownership evidence, exit the HUD display without remotely killing an unverified pane. No restart loop.

Keep hooks short: bounded input (64 KiB), bounded diagnostics, an internal operation deadline below their configured timeout, and roughly one second for normal SessionEnd signaling. Panel cleanup handles the remainder. Lifecycle hooks print no task context and invoke no LLM.

**R5-UX seam:** after P2 merges, export the existing `runLivePage` at `src/tree-page.ts:510`; retain its existing entry guard at `2229–2230` and signal cleanup at `2197–2199`. A narrow panel entry sets the environment before dynamically importing/calling it and installs lifetime checks in the same process. Dispatch this entry before the broad CLI imports, following the waiter's narrow-entry precedent. Do not add a permanent wrapper/watchdog Node process merely to watch the panel. Dispose timers on exit. If a small cleanup callback is needed, keep that hunk confined to the existing `finish` lifecycle, not rendering or collection policy.

Set `HUD_SETTINGS_PATH` explicitly. Add an explicit display-home override to `src/utils/codex-path.ts`, used by the new Claude/pi panel entry as `$HUD_HOME/display`; preserve the current Codex default when not selected. Keep Codex transcript/source roots separate from HUD writable state. Do not fake `CODEX_HOME` to redirect writes. Tests assert that a Claude/pi panel writes no files below a real or synthetic Codex home.

### D. Claude plugin

Source templates under `integrations/claude/`, materialized as:

```text
claude/
  .claude-plugin/plugin.json
  .mcp.json
  hooks/hooks.json
  commands/hud.md
  commands/setup.md
  skills/hud-delegate/SKILL.md
  scripts/hook.mjs
  scripts/mcp.mjs
  binding.json
```

Manifest: `name: "hud"`, matching release `version`, description/license, default component discovery. Do not declare the same hooks both inline and in `hooks/hooks.json`. No main `statusLine` in the manifest.

`.mcp.json` defines one `hud-mcp` stdio server. Its executable is an approved Node path, args point to `${CLAUDE_PLUGIN_ROOT}/scripts/mcp.mjs`; the adapter loads the binding, supplies the canonical private `HUD_HOME`, forces `HUD_MCP_SURFACE=roles`, and enters the pinned server. Preserve current harness ancestry for identity resolution. No `npx`, install-on-start, credentials in JSON, or global `HUD_MCP_SURFACE` export. Expect plugin-scoped MCP tool names; do not hardcode the bare server prefix in hooks or the skill.

Hooks:

| Hook | Responsibility | Lifetime |
| --- | --- | --- |
| SessionStart | corroborate current session, signal binding generation where needed; idempotent panel open for an eligible main | finite local command; never a panel host |
| SessionEnd | fence that generation and request close of its exact panel | short finite command; missed hook covered by panel lifetime |
| UserPromptExpansion | intercept only HUD panel/setup command names; execute fixed local action and block model expansion | finite local command; no ordinary-prompt hook cost |

**`/hud`:** plugin-native canonical name is `/hud:hud`; do not claim that the plugin manifest reserves bare `/hud`. To meet the owner's exact spelling, propose a separately approved personal `~/.claude/commands/hud.md` alias, refuse a collision, and intercept its command name too. Before installing it, prove installed-CLI routing with synthetic hooks and zero provider requests. Alias/command bodies contain no shell injection or model-side execution recipe. Parse only a small grammar (`on`, `off`, `toggle`, `status`, `help`); block the HUD command even when the local operation fails, returning a visible finite reason. Unrelated commands pass untouched. Never use a prompt-prefix wildcard that intercepts prose mentioning `/hud`.

**Setup:** `/hud:setup` exposes preview and instructions; apply/restore require an explicit plan/backup argument and the prior owner confirmation. They call the actual `hud-statusline settings preview/apply/restore`, not a second JSON editor. The safest default setup action is read-only. Do not run live setup merely because a skill tells the model to do it.

**Statusline activation:** compare the owner's actually enabled claude-hud fields with `docs/statusline/feature-coverage.md`, including any surrounding tee/width wrapper. Preserve that entire original setting in the existing backup. Missing enabled fields block an automatic switch; return the difference for an owner decision, not a silent feature cut. Existing observation/performance/rollback gates remain. Keep the third-party plugin installed unless its removal is separately approved. Apply statusLine last among Claude settings changes so its exact-hash restore works in reverse order.

### E. Pi package and footer

Create a package under `integrations/pi/package/` (keep the current historical extension opt-ins intact):

```text
package.json                  name/version, pi-package keyword
extensions/hud.ts              one package entry
skills/hud-delegate/SKILL.md   generated canonical skill copy
binding.json                  generated release/home binding
README.md
```

Explicit `pi.extensions` and `pi.skills` entries prevent accidental loading of the historical `hud-footer.ts` or managed `hud-delegate.ts`. No bundled pi SDK; use host peer dependencies. A generated local package is sufficient for R6a; npm publication is not necessary to deliver it.

The extension owns `/hud`, the role MCP bridge, and a **segment**, not p10k's footer. `pi.registerCommand("hud", ...)` runs directly without `sendUserMessage` or an LLM call. Check UI mode as well as `hasUI`; RPC can have UI but is not a TUI panel target.

- `session_start`: rebind context; start the role bridge as needed; establish current segment; open an eligible panel.
- `session_shutdown`: synchronously fence the old context, clear only the HUD status key, dispose subscriptions/timers, close the bridge and request panel close. This includes reload/new/resume/fork in current pi.
- Retain conservative before-switch/fork/tree fencing and current-generation checks from the bridge where needed; handle canceled transitions explicitly, with a reconnect command rather than silently using old identity.
- Native model/message/agent/tree/compaction events refresh captured display data, never scan during footer render. Never send a status update as a user/model message.

**p10k recommendation:** publish `ctx.ui.setStatus("hud-delegation", text)`; p10k remains the sole `setFooter` owner and renders that key from `footerData.getExtensionStatuses()`. If it already renders statuses, no Fishpref change is needed. Otherwise provide a tiny reviewed patch for its existing status segment. Do not copy private p10k into this repo, monkey-patch `setFooter`, detect ownership by load order, or call `setFooter(undefined)` on unload. Missing p10k support degrades to no visible segment, not footer takeover. A standalone HUD full footer remains an explicit mutually exclusive option, not the package default.

**Summary seam:** add a shared role-job summary shape/reader with root, observation time, coverage, counts and source stamps. Count only facts the existing job collector can support; stale/nonterminal process evidence must not become a definite working count, and an unreadable root is unavailable, not zero. Keep historical/native summaries separately scoped rather than summing overlapping populations.

Use the existing panel's bounded job observation as the initial producer of a compact private role-summary cache; publish after collection, not during paint. The native footer/statusline reader only reads the exact root's bounded cache and checks its identity/stamps/freshness. Do not start a worker, herdr poll, browser or execution host to make the segment available. One small generation/freshness-aware cache per current identity, a fixed maximum document size (for example 16 KiB), and the existing 20 ms cooperative read ceiling are adequate. Pi may refresh that exact cache on events and one low-frequency, single-flight timer while its TUI is alive; no directory discovery in this path. Clear expired counts even when the main session is idle. Statusline reads once per invocation. Shared rendering is pure and width-bounded.

**Deliberate limitation:** with the panel off and no fresh producer cache, show unavailable/stale or omit counts. Do not pretend the historical cache covers new jobs. Making role summaries independently live without any panel would require another producer/polling owner; it is not necessary for this packaging slice and must not be smuggled in as a detached service.

### F. Codex and coexistence

Leave `~/codex/codex-hud`, `cx`, the marked legacy rc entries, Codex status behavior and tmux bar/panel toggle alone. Do not run root `install.sh` or `uninstall.sh`.

The new explicit `hud codex` path uses the shipped compatibility launcher and retains bar/panel mutual exclusion and session-scoped tmux options. It does not add a second herdr side panel. Protect this with WP0 and tmux fixtures. No unsupported native Codex statusline is proposed.

For role tools, offer a separate preview for one `hud-mcp` stdio entry in the selected Codex profile's `config.toml`, with a pinned command and per-server `HUD_HOME`/`HUD_MCP_SURFACE=roles`. Prefer a per-invocation configuration smoke before writing it. Preserve every other server and profile. Register the static delegation skill only in the installed Codex version's verified user skill directory; discover/document that location in the client probe, rather than assuming all versions use the same directory. No global shell env exports. Do not duplicate an existing server name or expose both old and new HUD tool surfaces in a newly activated session.

### G. Ordered, independently mergeable work packages

All packages require a fresh independent accept and the active merged-tree gate in STATE: unit, mjs, hud-mcp and WP0, with raw first/rerun results. Add focused build/format/fixture checks for changed files. Synthetic evidence is not live acceptance.

| Package | Goal, files and contract boundary | Dependencies / R5-UX overlap |
| --- | --- | --- |
| **A1 — Release and reversible activation foundation** | Extend `scripts/{pack-runtime,pack-cloud-preview,install-runtime}.mjs`, `scripts/runtime-package/*`; add activation transaction module/bootstrap and tests, release/activation docs. Template inventory, pins, public-shim subset, preview/apply/restore/uninstall. Do not prune legacy payload. | Start now, parallel with P2/P3. Own shared packaging inventory; integrate later packages' manifest additions serially. |
| **A2 — Current ordinary-session binding** | `packages/hud-mcp/src/role-main.ts`, new role resolver; `src/roles/caller.ts`; narrowly parameterize pi evidence bridge/channel and add role bridge entry/tests. Six schemas unchanged; existing fd3 trust, per-call/current-epoch identity. | Start now, parallel with A1 and R5-UX. Explicitly authorized by consult answer q1. |
| **A3 — Panel control core** | New `src/integrations/panel/*`, internal CLI control and receipt tests; parse `--harness/--session/--source` in `src/cli/panel.ts`. Fake transport and subprocess lifecycle harness. No UI file edits. | After interface agreement with A2; can run parallel with R5-UX and A1. At most three implementers overall. |
| **A4 — Claude package** | `integrations/claude/*`, setup/alias templates, hook/MCP adapters, statusline activation orchestration and tests/docs. | After A1/A2/A3 interfaces; parallel with P2/P3. No statusline renderer work or parity feature expansion. |
| **A5 — Pi package** | `integrations/pi/package/*`, new segment controller under `src/harness/pi/`, package/bridge/lifecycle tests. Reuse existing footer primitives but do not enable its ownership controller. | After A2/A3 interfaces; parallel with P2/P3 and A4 if capacity permits. Private p10k activation is owner work. |
| **A6 — Shared role-summary reader/codec** | New bounded cache codec/reader/producer helper near `src/roles/` or existing observation cache modules; adapters in `src/cli/statusline.ts` and new pi segment module; synthetic/cache-cost tests. No persisted job schema change. | Parallel with P2/P3; A5 consumes the stable reader. Producer wiring waits for A7. |
| **A7 — Serial panel integration** | `src/tree-page.ts`: export lifecycle entry, wire summary publication after job refresh, dispose publication/lifetime resources in existing cleanup. New narrow panel entry/early CLI dispatch; `src/utils/codex-path.ts` explicit display-home override. | **After R5-UX P2 merges**, coordinate against P3's current tree-page hunks. This is the only required R5 UI-orchestration file overlap; no `src/render/*`, `src/settings.ts`, `src/settings-runtime.ts` or i18n edits. |
| **A8 — Codex activation and release rehearsal** | Codex config/skill activation adapter, `tests/integration/r6a-*`, isolated client probes, restore/uninstall matrix and owner runbook. Final packaging inventory assembled by A1 owner. | After A1–A7. Most probe preparation runs in parallel; final integrated artifact checks follow merges. R6b not a dependency for additive opt-in installation. |

#### Test-plan headings for every package

**A1 — Unit/process:** clean bundle inventory/import closure; relocation and paths with spaces; wrong Node/platform; unsafe files, partial prefix, stale plan, competing writer; interrupted apply at every journal boundary; reverse multi-step restore; plugin-manager failure; existing PATH collisions; unchanged legacy rc/install; upgrading while an old process lazily imports its pinned release; uninstall refuses changed/live-owned content. **Real CLI:** installed artifact `--help`, stdin statusline and MCP initialize/tools-list in temporary homes, no provider. **Owner:** PATH choice and each live activation diff.

**A2 — Unit/process:** all identity and transition cases in §B; six tools only; no old-host imports; missing evidence never falls back. **Real CLI:** ordinary pi and Claude session discovery plus a read-only roster call under temporary homes; no special argv crutch. **Owner:** two simultaneous sessions, live resume/clear/fork and representative role call with correct parent attribution.

**A3/A7 — Unit/process:** duplicate open, close-before-open-completes, split timeout after creation, receipt loss, late end event, occupied/reused pane, instance replacement, missing herdr, parent crash, panel crash, terminal HUP, manual close, disabled auto-open, nested worker suppression, no stdout descriptor leak, no restart. Verify bounded child count, timer cleanup and non-Codex write isolation. **Real CLI:** isolated herdr tab/panes, real right split, no focus theft and no leftovers; private tmux WP0 for Codex. **Owner:** ordinary top-level Claude/pi, worker sessions and the daily `cx` path side by side.

**A4 — Unit/process:** manifest/template validation; cached plugin relocation; scoped server names; hook stdin/output and command grammar; exact interception only; statusline preview/backup/restore and stale-edit refusal. **Real CLI:** plugin validation/loading with synthetic HOME; `/hud:hud`, bare alias and `/hud:setup preview` result in zero provider requests; ordinary prompts unaffected. If model-free routing cannot be proved, mark that capability NOT_VERIFIED and do not install the bare alias as ready. **Owner:** enabled-field parity, visual/latency observation and actual backup restoration.

**A5 — Unit/process:** load package entry, not just controller; command registration; start/shutdown/reload/switch; no UI in print/RPC; status-key cleanup; zero `setFooter` calls in segment mode; p10k-like synthetic footer retains its own fields before/after package unload; SDK declaration check against installed pi. **Real CLI:** package discovery, `/hud` with no provider request, role bridge and repeated `/reload` without leaked MCP/panel processes. **Owner:** private p10k patch only if required, narrow terminal widths and actual restore.

**A6 — Unit/process:** exact source/root, zero versus unavailable, partial coverage, expired/future stamps, malformed/oversize/symlink cache, producer crash/atomic replacement, root switch during read, control-character sanitization; no scans/process launches/network on read or render. **Performance:** cold/warm cache-read and render cost, bytes/allocations, p50/p95/p99/max, sample count and host; three runs, with startup cost separate from hot-path cost. **Owner:** role completion while main is idle updates the segment with panel on; panel off becomes honestly unavailable rather than indefinitely current.

**A8 — Unit/process:** full fresh install → client enable → upgrade → downgrade → uninstall; existing configs preserved; partial failures leave a usable restore route; no old/new duplicate MCP entry; skill collision. **Real CLI:** Codex TOML/skill discovery and isolated tmux bar/panel; all three artifact-based client smoke paths, no source-checkout dependency. **Owner:** exact ordered checklist below, followed by R7 scenario acceptance, not a claim that packaging proves delegation/browser behavior.

Record process/RSS cost for client startup and a visible panel, hook latency, idle wakeups, and statusline end-to-end latency. Preserve the established statusline limits; do not raise deadlines to make packaging tests pass. No full bundle verification or dependency scan on every footer paint/hook invocation: verify at installation and bind to the immutable release.

### H. Owner-confirmation list, in application order

Every row is shown as a concrete path/value diff **before** application. Backups include bytes/mode or recorded absence and an installed hash. Close config editors during mutation. On upgrades, repeat the same procedure; never reuse an old confirmation for new bytes.

| Order | Live change requiring confirmation | Backup and tested restore |
| --- | --- | --- |
| 1 | Create/select runtime prefix and HUD home; create only missing HUD-owned integration/display configuration. Existing routing, `config.json`, `credentials.env` remain unchanged unless separately listed. | Runtime receipt plus activation journal. Restore previous selector/config or remove unchanged new files; retain keys/results. Any optional display-settings copy gets its own source/destination preview. |
| 2 | Publish only `~/.local/bin/hud`, `hud-statusline`, `hud-mcp` (or explicitly chosen directory). | Record existing entries/absence; refuse foreign collision by default. Restore prior exact entries. No `codex-hud`/`cx` replacement. |
| 3 | **Only if needed:** add that directory to the owner's selected shell startup file. Default: no rc edit when already on PATH. | Exact file backup, marked insertion and post-hash; reverse only the owned edit or refuse conflict. Never remove old codex-hud markers. |
| 4 | Register/install the Claude HUD plugin at user scope, with pinned local package/version. Enumerate the CLI's actual writes under the selected Claude config directory, including settings `enabledPlugins`, plugin installation/marketplace registries and the owned cache directory. | Rehearse native plugin install/uninstall in temporary HOME first to discover the write set; snapshot touched existing registry/config files, journal new paths. Native uninstall plus verified restoration of owned values/files. Do not blindly restore an entire plugin cache. No approval if the write set is still unknown. |
| 5 | Optional bare `/hud` personal command alias, only after the zero-model test and collision check. | Backup/absence receipt for `~/.claude/commands/hud.md`; remove/restore only if unchanged. Namespaced plugin command needs no separate alias file. |
| 6 | Replace Claude `settings.json.statusLine` with the previewed pinned `bin/hud-statusline` command, **after** field comparison and existing switch gates. | Existing `settings apply --plan` backup; existing `settings restore --backup` first on rollback, before reversing plugin settings. Retain third-party plugin and wrapper configuration. |
| 7 | Add the pinned local pi package to the actual personal `~/.pi/agent/settings.json` (or explicitly selected agent directory); disable only conflicting HUD opt-ins if present and approved. Do not modify private symlink targets implicitly. | Backup settings bytes/mode/absence and resource selection. Remove this exact package entry or exact restore on matching hash; reload/restart only at owner-chosen boundary. No `~/.pi/agent/mcp.json` entry for the evidence bridge. |
| 8 | **Only if needed:** private p10k change to render `hud-delegation` from extension statuses. | Separate owner-approved Fishpref patch and exact target/symlink backup, tested revert. p10k remains installed and keeps `setFooter`. This is not a public-repo implementation patch. |
| 9 | Add Codex `hud-mcp` entry to the specifically selected `~/.codex*/config.toml`; add the skill to the verified client skill location. | Exact TOML and skill-target backup/absence; restore only owned entry/directory, preserving other servers/profiles. Never wildcard over every Codex home. No bar or launcher settings change. |
| 10 | Optional persistent integration preference changes, such as panel auto-open off or standalone pi-footer selection. | HUD-owned config backup; no renderer/i18n edits. Full-footer selection additionally requires explicitly disabling the other footer owner and backing up that client selection. |

Apply no credential change or model endpoint change as part of integration activation. If an activation requires a new dependency, policy permission, previously unknown file write, or changed private link target, stop that step and issue a new preview. Client-owned incidental logs/cache writes from running smoke tests are recorded separately from installer-authored configuration changes.

### I. Risks and deliberate cuts

- **Claude docs can outrun the installed binary.** Namespacing, expansion hooks and exact zero-model behavior need a real CLI check. Do not advertise shell preprocessing as no-model execution. The fallback is a documented shell `hud` command until the hook path is verified, not an invisible model turn.
- **Enabled claude-hud parity can block switching.** R6a packages the existing renderer; it does not quietly add effort/Git/todo/quota features. Report the missing enabled fields for an owner decision or separate implementation slice.
- **Panel top-level proof and ambiguous herdr side effects are real acceptance items.** Unknown eligibility skips auto-open; unknown create outcome reconciles instead of retrying. Never use “no parent marker” as the sole positive proof for every harness.
- **Private p10k is uninspected.** A synthetic status-consuming footer proves the public seam, not the owner's extension. Preserve p10k and gate its patch separately.
- **A fresh role-summary producer is currently panel-scoped.** Panel-off unavailable counts are an honest cut. No hidden daemon is added to fix cosmetic freshness.
- **No R6b in disguise.** No old-host deletion, SDK/dependency pruning, job adoption, mass process killing, broad profile migration, default global MCP surface flip, or release GC. New client activation selects `roles` explicitly; old running owners remain intact.
- **No distribution expansion.** R6a uses the existing Linux/WSL + Node 22.13+/24 installer envelope. Native Windows/macOS installers, registry publication and auto-updaters are not required. Do not silently widen or tighten client capability gates based on a version string.
- **Uninstall is safe reversal, not erasure of intervening work.** Changed configs and live release references produce actionable partial/conflict results. Exact full restoration is proved when state still matches the install receipt; otherwise owner reconciliation is required.

**Optional hardening:**

- Publisher-signed release manifests: improves provenance beyond local hashes; costs signing-key/release infrastructure and recovery policy. Existing integrity checks remain required either way.
- A broader package-manager configuration-format matrix: supports more customized/symlinked homes automatically; costs additional mutation parsers and restore cases. R6a can refuse unsupported layouts with a manual plan.
- A non-panel role-summary producer: keeps native counts fresh with panels disabled; costs a separately owned refresh lifecycle and cache-writer coordination. Do not implement without a follow-up brief.

## 4. Scope:

**Scope: needs orchestrator** for package scheduling and owner activation, not a new product direction. The two discovered integration gaps—ordinary-session binding and the non-Codex panel/role-summary seams—were explicitly authorized by the orchestrator in this consult (q1 and q2) and are included as separate packages. The `tree-page.ts` lifecycle/publication hunk must merge serially after R5-UX P2, coordinated with P3. All live configuration writes, private p10k changes, statusline parity exceptions and client compatibility claims remain owner-confirmed gates. R6b retirement remains separate.

---

# R6a decided design (orchestrator, 2026-11-09)

Base: `architect-1.md` (astra high), accepted with the amendments below. Concept §15 "Plugin independence" (decided
after the consult) overrides every place where the architect kept a Codex or legacy default.

## Accepted as proposed

- A. Immutable-release installer reused; separate reversible activation transaction; public shims only
  `hud`, `hud-statusline`, `hud-mcp`; templates instead of relaxing dotfile validation; one release version; no GC;
  uninstall = safe reversal.
- B. Ordinary-session binding resolved per call (Claude/Codex native evidence; pi via the existing bridge/channel
  epochs, six role tools as thin proxies over the private channel, no generic `mcp.json` registration).
- C. Panel control core (`src/integrations/panel/`), receipts display-only, eligibility fail-closed, panel owns its
  lifetime, no watchdog process, no tmux fallback for Claude/pi.
- D. Claude plugin `hud`: `/hud:hud`, optional bare `/hud` alias only after the zero-model check;
  `UserPromptExpansion` preferred; statusline switch gated on enabled-field parity (owner decision on gaps).
- E. pi package with a status **segment** (`setStatus("hud-delegation")`); p10k stays the footer owner.
- A6 role-summary cache: panel-scoped producer, unavailable when the panel is off (honest cut accepted).
- H. Owner confirmation list, in that order, each row previewed with backup and tested restore.

## Amendments

1. **One HUD home for every harness.** Display caches/state go to `$HUD_HOME/display/` for Claude, pi **and Codex**
   (the `hud codex` panel included). Settings path `$HUD_HOME/hud-settings.json` for all. No "preserve Codex default"
   branch; `CODEX_HOME` is only a transcript source. This replaces the architect's §C last paragraph and A7's
   "explicit display-home override".
2. **New package A0 — Independence** (after R5-UX P1 merges; parallel with P2):
   - `getHudHome`/settings path → `$HUD_HOME` (default `~/.hud`) for all harnesses;
   - `hud import preview|apply` (one-time, backup, no overwrite of existing HUD files): `~/.codex*/hud-settings.json`
     (owner picks which), `~/.hud/jev.env` → `credentials.env` (names merged, existing wins), a jev-ask TOML →
     `config.json` `jev`/`aistudio` sections;
   - remove `briefingApiKey`, the `jev.env` fallback, runtime `JEV_ASK_CONFIG`/TOML reads, legacy
     `briefingApiReasoning` migration;
   - product small-model defaults: base `https://api.mistral.ai/v1`, `deepseek-v4-1-flash-1017` for all tiers,
     efforts none/low/high;
   - decision provider: `config.json` `decisions.primary` and `decisions.fallback`; fallback takes over on quota/auth/
     5xx/timeout for that call, recorded in the job record;
   - Jev: no hard-coded CDP URL in `browser.ts`/`aistudio-state.ts` paths; values come from `config.json`.
3. **New package PIROLE — pi-roles built in** (architect consult first, then implementer). Supersedes R2b's PATH
   discovery. The HUD ships its own pi extension (task contract, STATUS.json, call_sonic/call_reviewer,
   ask_orchestrator, DONE/FAILED, idle grace) and its own herdr launch/reap; role texts are HUD-owned and public-safe.
4. **A7** keeps only the `tree-page.ts` lifecycle export and summary publication (after P2).
5. **A8** Codex activation: the Codex `config.toml` MCP entry stays (it is the client's own registration point), but
   it points at `$HUD_HOME`; no HUD state under any Codex home.

## Order and capacity (max three implementers)

- Now: A1 (release/activation) and A2 (session binding), next to the running P1. PIROLE architect consult now.
- After P1 merges: P2, A0 (one of A1/A2 must have finished first to stay at three).
- Then: P3a, PIROLE, A3; then A4, A5, A6; A7 after P2 (and coordinated with P3); A8 last.

Cut from the architect plan: nothing beyond the Codex-default branch. Optional hardening (signed manifests, broader
config-format matrix, non-panel summary producer) not taken.
