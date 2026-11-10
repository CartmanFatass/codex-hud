# Claude HUD plugin (opt-in, owner activation only)

This package materializes the `hud` plugin from immutable release templates under
`$HUD_HOME/installation/integrations/<integrationId>/claude`. Nothing in this repository
installs a plugin or edits live Claude settings automatically. Never use the historical
root installer for this integration. No HUD state is written below a Codex home.

## Components and pins

The release contains **plain-named templates**, not `.mcp.json` or `.claude-plugin`.
`claude-plugin.mjs` generates those names during separately previewed activation. The
manifest uses default discovery, declares hooks only in `hooks/hooks.json`, and never
contains `statusLine`. One version is taken from release metadata. The skill is copied
from the canonical `integrations/skills/hud-delegate/SKILL.md`, with its hash in the plan.

The generated binding pins an absolute immutable release, manifest digest, approved
canonical Node executable, canonical private HUD home and optional parity inventory.
Adapters resolve their binding relative to themselves, including from a Claude cache
path containing spaces; they never escape a cache through `../../dist`. Bootstrap
checks paths and the pinned manifest, not the entire bundle on every hook invocation.
Full inventory verification is an installation preflight, not a per-hook scan.

The MCP relay starts the pinned server with `HUD_HOME` and `HUD_MCP_SURFACE=roles` in
**the child's environment only**. It preserves the physical Claude ancestry and A2's
per-call session resolver. Initialize/list exposes precisely the six role tools. Claude
namespaces those tools for the plugin; neither hooks nor the skill assume a bare MCP
server prefix. No npx, install-on-start, credentials or global exports are used.

## Local commands and lifecycle

- `/hud:hud on|off|toggle|status|help` controls display only; omitted action is status.
- `/hud:setup` or `/hud:setup preview` is read-only. `apply --plan ABS` and
  `restore --backup ABS` require an explicit saved plan/backup. Quote paths with spaces.
- Bare `/hud` is a separately approved personal alias, never a manifest reservation.
  Its preview refuses collisions, including symlinks. It is offered only with an exact
  artifact's passing real-CLI zero-provider proof, not a Boolean readiness assertion.

`UserPromptExpansion` matches exactly `hud:hud`, `hud`, `hud:setup`. Installed Claude
2.1.319 exercised this event successfully with a recording localhost provider. There
is no ordinary-prompt hook. A strict `UserPromptSubmit` parser is retained for testing
or a separately verified older-client fallback, but is **not installed** alongside
expansion. Prose mentioning `/hud` and `/hudson` pass untouched. Unknown subcommands,
invalid grammar and local failures stay blocked with a bounded reason. Command bodies
contain no shell injection or model-side execution instructions.

SessionStart/End are finite local Node commands, not panel hosts. Input caps at 64 KiB
and 500 ms. Native capture caps at 450 ms, panel open at 3000 ms, close at 800 ms; hook
timeouts are 5 s and 2 s respectively. Setup subprocesses each cap at 1200 ms. Diagnostics
are bounded and never include task text. Closing MCP or a panel never closes jobs.
Only command interception has a fixed failure guard: one extra Node process captures at
most 8192 output bytes, kills its adapter at 4200 ms, and emits exactly one JSON result.
Startup/nonzero/invalid-output failures become a fixed local block; controlled failures
exit cleanly with their own block. Lifecycle bootstrap failures are quiet and never block.
Missing optional parity inventory never disables MCP, panels or statusline rollback.
The probe also records externally imposed Claude hook-timeout behavior. Such a platform
timeout can bypass command interception and reach the provider; it is not the internal
adapter deadline. On 2.1.319 an artificial 50 ms external hook timeout produced six
recorded localhost requests for each HUD command (the ordinary control also made six).
No zero-provider guarantee is made for external termination. Catchable startup failures
must all prove zero requests before alias readiness; that proof covers missing binding,
missing cached adapter, nonzero exit and a missing Node path. The timeout limitation does
not by itself prevent the optional alias, but is an explicit owner-visible platform limit.

Automatic panel eligibility is a **corroborated inference**, because Claude's native
registry has no affirmative topology field: A2 registry/session/process-start proof,
complete process ancestry, foreground TTY, exact herdr pane process and ordinary
interactive argv must all agree. Print/RPC/SDK/stream-json, worker/role markers, an outer
Claude, unreadable ancestry, mismatched stamps or unknown pane evidence suppress opening.
Hook JSON alone is never native evidence. Every stamp is checked again by `isCurrent()`
before A3 can split. If a future registry provides affirmative topology, prefer it.

A3 owns idempotency, private receipts and exact generation close. The hook retains the
returned generation via A3's receipt, checks the complete session root and permanently
fences that process/session epoch on SessionEnd. Late ends cannot close replacement
sessions. A same-process reuse of an already-ended identical session ID refuses reopening
rather than guessing an ABA epoch. Panel lifetime cleanup remains A3/A7's responsibility.

`off` is session-local. Persistent `panelAutoOpen: false` belongs in HUD-owned
`integration-config.json` through a separately previewed owner edit. Explicit `on` in an
ordinary interactive main skips this preference only. A3 still refuses worker/print/role
sessions, including explicit open, with `panel_worker_session; panel belongs to the main
session`. No evidence is forged to override that limitation. Real herdr split/focus
acceptance and A7 registration remain separate gates, not claims made by this package.

## Preview and rollback (synthetic path examples)

Stage the immutable runtime first; then:

```sh
node /tmp/release/claude-plugin.mjs preview \
  --prefix /tmp/home/runtime --release DIGEST --node /absolute/node \
  --hud-home /tmp/home/hud --shim-dir /tmp/home/bin
# Owner inspects all actions; repeat exactly with apply --plan PLAN_ID only after approval.
node /tmp/release/claude-plugin.mjs restore-preview --receipt /tmp/home/hud/installation/TRANSACTION.json
# restore --receipt ... --plan RESTORE_PLAN_ID reverses unchanged generated files.
```

Generated integration steps are the only exception to A1's reserved installation
metadata subtree. The ID is a deterministic hash of release plus binding, distinct
from the transaction ID. Foreign/pre-existing paths refuse; exact receipt-backed
reactivation is a journalled no-op. Another active receipt retains shared generated
files; the last owner can remove unchanged files only. Changed files cause a conflict.
Journals, locks, other IDs and arbitrary caller steps remain reserved.

**Owner row 4 — native plugin registration.** First run the temporary-home write-set
rehearsal from the checkout (absolute CLI and materialized plugin paths):

```sh
node tests/integration/r6a-claude-probe.mjs writes /tmp/materialized/claude /absolute/claude
claude plugin validate /tmp/materialized/claude
```

The rehearsal copies/rebinds the plugin to its own fresh homes. It records before/after
hashes and modes for every native install/uninstall/marketplace write, plus incidental
startup writes. The native manager changes `settings.json`, `plugins/known_marketplaces.json`,
`plugins/installed_plugins.json`, cache directories, `.claude.json` and native backups.
It does not promise a filesystem-atomic transaction. For live approval, snapshot existing
registry/settings bytes and modes (or absence), journal each native operation and its
result, and approve **that client's exact discovered write set** before native user-scope
marketplace add/install. Never restore an entire shared plugin cache blindly. Preserve
all unrelated servers/plugins and the third-party claude-hud plugin.

Claude keeps the plugin cache after uninstall; you can delete it by hand if wanted,
naming only the exact receipt-verified path. In the synthetic rehearsal that is
`$CLAUDE_CONFIG_DIR/plugins/cache/hud-rehearsal/hud/0.0.0` (under its temporary HOME's `.claude`).
A real installation must use its own recorded marketplace/version path; do not guess
or remove the shared `plugins/cache` root. HUD never deletes or restores it. The fixed 2.1.319 rehearsal permits only an unchanged,
exact installed cache file set plus `.orphaned_at`, empty registration containers and
native backups. Any changed/missing/extra cached file, symlink, unexpected residue or
other CLI version is NOT_VERIFIED and needs another rehearsal. Native uninstall removes
the registration, not arbitrary intervening work. Restore previously snapshotted owned
values/files only on matching post-hashes; otherwise stop for owner reconciliation.

**Owner row 5 — optional alias.** Prove routing first:

```sh
node tests/integration/r6a-claude-probe.mjs smoke /tmp/materialized/claude /absolute/claude
# Save the JSON report (without a log's trailing exit= line) under HUD_HOME.
node /tmp/release/claude-plugin.mjs preview \
  --prefix /tmp/home/runtime --release DIGEST --node /absolute/node \
  --hud-home /tmp/home/hud --shim-dir /tmp/home/bin \
  --alias-proof /tmp/home/hud/zero-model.json --alias-home /tmp/home
```

No alias is ready if the probe cannot prove all three commands local with zero provider
requests and an ordinary prompt reaching the fake. This proof covers the tested CLI and
artifact, not every future version. Alias apply uses the normal A1 receipt, backup of
absence and reverse restore; existing personal `commands/hud.md` always refuses.

**Owner row 6 — statusline parity and switch LAST.** Draft the comparison inventory
from an explicitly named third-party JSON configuration (never discovered automatically):

```sh
node /tmp/release/claude-parity.mjs preview --home /tmp/home --config /tmp/home/third-party.json
# Owner reviews stdout and saves it under HUD_HOME, then re-previews activation
# with --parity-inventory ABS, so the binding pins that inventory path.
# In Claude: /hud:setup preview
```

Inventory shape: `{version:1, settingsHash, configPath, configHash, enabledFields:[...]}`.
Preview re-reads and hashes both files, recursively inventories every enabled option,
and compares only compact model/context/cost/width coverage from
`docs/statusline/feature-coverage.md`. Unknown keys, details-only fields and tee/width/
toktrack wrappers are gaps. Missing inventory means NOT_VERIFIED; gaps block automatic
apply and are returned for an owner decision, not silently dropped. A stale config,
settings edit or foreign statusline plan refuses. Setup calls the existing pinned
`hud statusline settings preview|apply|restore`, never another JSON writer. It currently
refuses a custom CLAUDE_CONFIG_DIR other than HOME/.claude rather than editing the wrong
profile. Apply statusLine only after all native plugin/alias settings changes; its
existing backup preserves the entire original setting and wrapper bytes.

Rollback order: **statusline restore first**, alias activation restore second, native
plugin uninstall/owned registration restoration third, materialized activation restore
last. Restore statusline does not depend on parity. Close configuration editors and
never force restoration over changed bytes. No real owner settings or third-party config
were inspected during implementation.
