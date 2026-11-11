# HUD release activation and recovery

This is an **owner-confirmed checklist**, not an automatic installer. Do not run it against a real home merely
because a rehearsal passed. Close config editors first. Stop on a changed-file conflict, an unknown client write,
a private symlink target, missing dependency or permission prompt. Never force restore, delete a retained release,
run `install.sh`/`uninstall.sh`, or change `cx`, the old marked rc blocks, `hud codex`, tmux or the Codex bar.

The release rehearsal is opt-in, not `npm test`:

```sh
node tests/integration/r6a-release-rehearsal.mjs --run --out NEW_ABSOLUTE_DIRECTORY \
  --codex ABS_CODEX --claude ABS_CLAUDE --pi ABS_PI
```

It uses fresh HOME, HUD_HOME, CODEX_HOME and CLAUDE_CONFIG_DIR, without inherited HERDR_* or provider credentials.
Only the clean packer's isolated `npm ci` receives transport proxy variables. It builds two releases in a disposable
local clone, relocates the artifacts, deletes that actual clone, and executes the installed artifact. Existing shared
herdr/pi test fixtures provide synthetic process ports; they are **not real herdr qualification**. The native Claude
ordinary-prompt negative control contacts only a localhost rejecting recorder (no model execution or external provider).
The report records host, SHA, versions, commands, PASS/FAIL/NOT_RUN, raw samples, RSS and process evidence.

## Choose explicit paths

Use absolute canonical paths. Do not select a symlinked client settings target implicitly. In the examples:

- `NODE`: approved real Node executable (Linux, Node 22.13+ within 22.x, or Node 24).
- `BUNDLE`: unpacked, verified artifact, wherever it was relocated; **not the source checkout**.
- `PREFIX`: private runtime prefix; `DIGEST`: bundle's manifest SHA-256 from the stage preview.
- `HUD_HOME`: private HUD home, normally `~/.hud`; `SHIM_DIR`: chosen public command directory.
- `RELEASE="$PREFIX/releases/$DIGEST"` after staging.
- `CODEX`: explicit installed executable; `CODEX_HOME`: **one** selected configuration home, never a glob.
- `PI_SETTINGS`: actual selected personal pi `agent/settings.json`; `CLAUDE`: explicit installed executable.
- `BACKUPS`: new private directory for reviewed plan JSON, receipt paths, native backups and absence records.

For the normal Claude profile `CLAUDE_CONFIG_DIR="$HOME/.claude"`; statusline setup currently refuses other homes.
Keep the command arrays explicit (Bash):

```sh
COMMON=(--prefix "$PREFIX" --release "$DIGEST" --hud-home "$HUD_HOME" --shim-dir "$SHIM_DIR")
```

Save each preview JSON. Review **every** target, original/proposed hash, mode, absence and confirmation. An activation
apply uses `--plan PLAN_ID` (the JSON's `planId`), repeating exactly the same options. It returns a `receipt` path.
Runtime staging instead uses its `planDigest`. Never substitute one for the other. Plan IDs are not reusable approvals.

## 1. Runtime prefix and one HUD home

**Preview (read-only):**

```sh
"$NODE" "$BUNDLE/install-runtime.mjs" preview --prefix "$PREFIX" --stage-only yes
"$NODE" "$BUNDLE/activate-runtime.mjs" install preview "${COMMON[@]}"
```

The prefix must already be an explicitly approved private directory (0700). The first command's preview must precede
staging; the activation preview is run after staging. Stage with the exact returned runtime plan digest:

```sh
"$NODE" "$BUNDLE/install-runtime.mjs" stage --prefix "$PREFIX" --expect RUNTIME_PLAN_DIGEST
```

**Changes:** immutable release plus runtime stage receipt; activation selects it and creates only missing HUD-owned
display/panel/integration directories. `config.json`, `credentials.env` and `routing.toml` are preserved, not migrated
or replaced. Import old settings separately if needed; integration activation grants no credential/endpoint change.

**Restore:** use the activation receipt as in row 2. An interrupted activation's error includes `restore_receipt=...`:

```sh
"$NODE" "$BUNDLE/activate-runtime.mjs" install restore --receipt ACTIVATION_RECEIPT
```

This is the explicit crash-recovery path. It reclaims only conclusively dead matching activation locks. Never remove
locks by hand. Immutable releases and recovery journals stay retained, even for an initially absent HUD home.

**Check afterwards:** prefix/HUD-home permissions, selected digest, unchanged existing keys/config/routing. A staged
release does not by itself activate clients. No model, browser, job or panel is started by staging/activation.

## 2. Only three public shims

**Preview:** the second preview in row 1 includes this row. A1 publishes home/directories and public shims in one
transaction; confirm rows 1 **and** 2 before applying it. Read row 3's conditional decision before this apply:
if PATH needs a startup-file change, include its `--rc-file` in this **same** base preview/apply, not a second
already-selected base transaction. The command below is the no-rc case:

```sh
"$NODE" "$BUNDLE/activate-runtime.mjs" install apply "${COMMON[@]}" --plan PLAN_ID
```

**Changes:** only `hud`, `hud-statusline`, `hud-mcp` in `SHIM_DIR`, each pinned to this immutable release. Foreign
collisions refuse; `codex-hud` and `cx` are never published or replaced. No global MCP-surface export.

**Restore (ordinary reverse):**

```sh
"$NODE" "$RELEASE/pi-package.mjs" restore-preview --receipt ACTIVATION_RECEIPT
"$NODE" "$RELEASE/pi-package.mjs" restore --receipt ACTIVATION_RECEIPT --plan RESTORE_PLAN_ID
```

All client receipts use the same A1 reverse interface; the basename of this thin command does not restrict restoration
to pi. The bootstrap also supports `uninstall preview|apply --receipt ... [--plan ...]`.

**Check:** run the installed artifact's `bin/hud --help`; inspect the three shim pins. Do not add the runtime prefix's
whole `bin/` to PATH: it contains compatibility commands deliberately excluded from public activation.

## 3. Shell PATH, only if necessary

**Preview:** if `SHIM_DIR` is already on PATH, omit `--rc-file` (no rc write). Otherwise choose **one** startup file:

```sh
"$NODE" "$BUNDLE/activate-runtime.mjs" install preview "${COMMON[@]}" --rc-file "$RC_FILE"
```

**Changes:** in addition to the base targets approved in rows 1–2, only the displayed marked `universal-hud PATH`
block, not any legacy `codex-hud` block. Use this preview **instead of** the no-rc activation preview, then apply once
by repeating that option with `install apply ... --plan PLAN_ID`. If row 2 was already applied, reverse it before
choosing a fresh combined base activation, while no client receipts are active. Do not create/apply/restore a temporary
second base around an older receipt and then continue client changes: A1's restore proof is not transitive.
No shell sourcing or interactive prompt is performed.

**Restore:** row 2's restore-preview/restore with the **combined base receipt**; it also reverses the base selector
and shims, not just PATH. An intact owned block can be removed while preserving unrelated later text; an edited
owned block is a conflict.

**Check:** original startup bytes/mode after restore; legacy markers remain. The rehearsal tests this optional row.

## 4. Claude plugin (manual backup: no HUD transaction for native manager writes)

First materialize the pinned HUD-owned plugin. Choose the future row-6 parity-inventory path now (its content is
reviewed in row 6):

```sh
"$NODE" "$RELEASE/claude-plugin.mjs" preview "${COMMON[@]}" --node "$NODE" --parity-inventory "$INVENTORY"
"$NODE" "$RELEASE/claude-plugin.mjs" apply "${COMMON[@]}" --node "$NODE" --parity-inventory "$INVENTORY" --plan PLAN_ID
"$CLAUDE" plugin validate "$PLUGIN"
```

`PLUGIN` is the preview's generated `plugin` path under HUD_HOME. Do not install before the isolated A4 native
write-set probe passes on the installed CLI's observed writes, residue, links and registration. The CLI version
is recorded as evidence only, never an allowlist gate:

```sh
"$NODE" tests/integration/r6a-claude-probe.mjs writes "$PLUGIN" "$CLAUDE"
"$NODE" tests/integration/r6a-claude-probe.mjs smoke "$PLUGIN" "$CLAUDE"
```

These test-driver paths require the acceptance kit checkout, not a runtime source import. The shipped plugin and its
MCP/hook adapters run only from the artifact. A source-free transient load is `--plugin-dir "$PLUGIN"`; the probe
uses that with `/hud:hud status`, `/hud status` and `/hud:setup preview`, plus failure/ordinary-prompt controls.

The opt-in rehearsal also tests literal backup/copy-back solely on its own fresh synthetic files after verifying
all observed write paths, residue and post-uninstall hashes. The row-4 probe passes on those behaviors, not a vendor
version pin. Synthetic copy-back proves the limited restore operations; it is not permission to touch an owner home.

The verified write set includes these **files**, the local marketplace registration, and the owned
`plugins/cache/hud-rehearsal/hud/VERSION` cache subtree. Before native install, record absence for any missing file;
for existing files use these literal backup operations (the rehearsal exercises backup **before** native mutation):

```sh
cp -p "$CLAUDE_CONFIG_DIR/settings.json" "$BACKUPS/claude-settings.json"
cp -p "$CLAUDE_CONFIG_DIR/.claude.json" "$BACKUPS/claude-state.json"
cp -p "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json" "$BACKUPS/installed_plugins.json"
cp -p "$CLAUDE_CONFIG_DIR/plugins/known_marketplaces.json" "$BACKUPS/known_marketplaces.json"
```

Run only lines whose source existed; retain an explicit absence record for the others. If a marketplace/cache target
already exists and is foreign, stop. `MARKETPLACE` is the locally reviewed marketplace used by the probe: name
`hud-rehearsal`, plugin `hud`, source `./plugins/hud`, version equal to this release, with a copy of `PLUGIN` under
`plugins/hud`. Do not register an unreviewed remote marketplace.

```sh
"$CLAUDE" plugin marketplace add "$MARKETPLACE" --scope user
"$CLAUDE" plugin install hud@hud-rehearsal --scope user
```

**Changes:** Claude's own user-scope enabledPlugins/installation/marketplace registration and owned cache. The HUD
materialization receipt does **not** journal native writes. Incidental client logs/backups are recorded separately.

**Restore:** row 6 first, then row 5, then native uninstall:

```sh
"$CLAUDE" plugin uninstall hud@hud-rehearsal --scope user
"$CLAUDE" plugin marketplace remove hud-rehearsal
cp -p "$BACKUPS/claude-settings.json" "$CLAUDE_CONFIG_DIR/settings.json"
cp -p "$BACKUPS/claude-state.json" "$CLAUDE_CONFIG_DIR/.claude.json"
cp -p "$BACKUPS/installed_plugins.json" "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json"
cp -p "$BACKUPS/known_marketplaces.json" "$CLAUDE_CONFIG_DIR/plugins/known_marketplaces.json"
```

Only copy back backups that existed, only after verifying the current files still match the rehearsed native
post-uninstall state (no intervening edits). For originally absent paths remove only the unchanged newly created
file from this exact write set. Never blindly copy, delete or restore the entire plugin cache. Claude keeps the
unchanged cache and an `.orphaned_at` marker; retain it unless separately approved. Restore the materialization
receipt last using row 2's interface.

**Check:** compare each restored file, e.g. `cmp "$BACKUPS/claude-settings.json" "$CLAUDE_CONFIG_DIR/settings.json"`,
and modes; test originally absent targets are absent. No old/new HUD MCP instance should be selected together.
Restart/reload only at an owner-chosen boundary. Plugin discovery is not verified role admission.

## 5. Optional bare `/hud` alias

Canonical plugin spelling is `/hud:hud`. The bare alias is **not an unconditional readiness claim**: the actual CLI
probe and all required failure controls must pass; external-hook-timeout interception remains a separately recorded
A4 limitation. Prefer leaving the alias unselected until that owner gate is resolved.

**Preview (only with the fresh probe JSON and exact plugin hashes):**

```sh
"$NODE" "$RELEASE/claude-plugin.mjs" preview "${COMMON[@]}" --node "$NODE" --parity-inventory "$INVENTORY" \
  --alias-proof "$ALIAS_PROOF" --alias-home "$HOME"
```

**Changes:** only an absent personal `.claude/commands/hud.md`; collisions refuse. Namespaced commands need no alias.
Apply repeats these options with `apply --plan PLAN_ID`. **Restore:** row 2's reverse commands with the alias receipt;
never remove an edited alias. **Check:** `/hud:hud status` and optional `/hud status` are local blocked commands with
zero provider requests, not a shell-injection prompt sent to a model. Ordinary prompts remain unaffected.

## 6. Claude statusLine — A8 switch blocked pending parity

**For this A8 release, keep claude-hud and its statusLine setting.** The owner decision in concept §15,
2026-11-10 ("The HUD replaces claude-hud and p10k-footer at parity"), installs A8 first but leaves this switch blocked
by the parity check. The in-flight STATUSLINE-PARITY release supplies the owner's enabled fields and wrapper before
switching. This package does not implement that parity or authorize bypassing the check.

The preview below is safe to inspect; the apply/restore examples describe the synthetic rehearsal and the later
parity-approved switch, **not an instruction to switch the owner's statusline in A8**.

Keep the third-party plugin installed. Inventory its **actually enabled fields and wrapper**, not this synthetic
rehearsal's compact fields. Missing enabled fields or a tee/toktrack/width wrapper blocks an automatic switch; get a
separate owner decision, do not edit the inventory to hide gaps.

**Preview:**

```sh
"$NODE" "$RELEASE/claude-parity.mjs" preview --home "$HOME" --config "$ENABLED_FIELDS_CONFIG"
```

Save that reviewed JSON as `INVENTORY`. The plugin setup hook delegates to the existing settings writer. A convenient
shell invocation of the same local setup path (no Claude/provider) is:

```sh
hud_setup() {
  "$NODE" -e 'console.log(JSON.stringify({hook_event_name:"UserPromptExpansion",expansion_type:"slash_command",command_name:"hud:setup",command_args:process.argv[1]}))' "$1" |
    "$NODE" "$PLUGIN/scripts/hook.mjs"
}
hud_setup preview
```

The block reason contains JSON with `comparison` and `statusline`. Require comparison PASS, review it, and save the
**inner `statusline` plan JSON**, unchanged, to `STATUSLINE_PLAN`. Then:

```sh
hud_setup "apply --plan '$STATUSLINE_PLAN'"
```

**Changes:** only `settings.json.statusLine`, pinned to this release; exact original bytes/mode are in the returned
`statusline.backup`. Apply this **last** among Claude settings changes.

**Restore FIRST:** `hud_setup "restore --backup '$STATUSLINE_BACKUP'"`. **Check:** original complete setting/wrapper
and bytes/mode are back; observe native visual/latency fields under the owner gate. A passing synthetic compact render
does not establish parity with the owner's existing HUD or WSL qualification.

## 7. Pi package selection (A8 retains p10k-footer until the parity release)

**Preview and materialize:**

```sh
"$NODE" "$RELEASE/pi-package.mjs" preview "${COMMON[@]}" --node "$NODE"
"$NODE" "$RELEASE/pi-package.mjs" apply "${COMMON[@]}" --node "$NODE" --plan PLAN_ID
"$NODE" "$RELEASE/pi-package.mjs" row-7-preview "${COMMON[@]}" --settings "$PI_SETTINGS" --package "$PI_PACKAGE"
```

`PI_PACKAGE` comes from the materialization preview. **Changes:** add that exact local package to selected personal
settings only; no generic `mcp.json` entry. Existing HUD resource conflicts require a separate preview/owner edit.
Symlinked private settings are not followed. Apply with `row-7-apply` and the exact plan ID.

**Restore:** row-7 receipt first, materialization receipt second, using row 2's commands. Reload/restart only when
chosen by the owner. **Check:** `/hud status` routes locally without provider work; six role proxies, one evidence
channel, and `hud-delegation` status key. **For A8, p10k-footer stays installed and owns the footer**, including
model/cost/status fields and narrow-width behavior. This is transitional, not a permanent p10k ownership rule:
the in-flight PI-FOOTER-PORT and STATUSLINE-PARITY parity release switches both surfaces, with the HUD taking over
the pi footer and retiring p10k-footer under explicit owner configuration changes. Do not implement or perform that
switch from this runbook's A8 package. The no-provider rehearsal uses the real pi RPC command path; TUI/herdr visual
checks remain R7.

## 8. Private p10k, only if needed

**only if the segment does not show; owner-private; no command shipped** The owner's p10k footer already consumes
extension statuses (A5), so this row is expected to be unnecessary: **SKIP / NOT_RUN, no changes**.

**Preview:** no private patch is authorized by this public release. First inspect extension statuses in the owner's
normal footer; if it already renders `hud-delegation`, skip this row. No automatic preview/edit command exists for an
unknown private target. Record that fact rather than inventing a path or following a symlink.

**Changes if separately approved:** a tiny owner-reviewed Fishpref patch to its existing status segment, never a copy
in this repo; p10k remains sole `setFooter` owner for A8 until the parity release. **Restore:** exact separately approved private file/link backup and
tested revert. **Check:** other footer fields persist through HUD unload. Private patch/owner-home execution is
NOT_RUN here and cannot honestly have a rehearsed public command.

## 9. One selected Codex config and verified user skill location

**Discover first** (the executable runs in a fresh temporary home, not your selected home):

```sh
"$NODE" "$RELEASE/codex-activation.mjs" probe --codex "$CODEX" --user-home "$HOME" --codex-home "$CODEX_HOME"
```

Save output as `CODEX_PROOF`. Use its `skillDirectory` as `SKILL_DIRECTORY`; do not assume a location or copy one
from another Codex version. The probe plants a synthetic candidate and requires native `skills/list` to identify it
as enabled user scope. Changed executable bytes invalidate the proof. Skill resources under Codex home are refused.
HUD_HOME and the selected CODEX_HOME must be canonical, disjoint paths: either nesting direction is refused with
`hud_codex_home_overlap_refused`, before any client or HUD-state mutation.

**Preview:**

```sh
"$NODE" "$RELEASE/codex-activation.mjs" preview "${COMMON[@]}" --node "$NODE" --codex "$CODEX" \
  --codex-home "$CODEX_HOME" --skill-directory "$SKILL_DIRECTORY" --proof "$CODEX_PROOF"
```

**Changes:** append one `mcp_servers.hud-mcp` stdio entry, approved Node + absolute immutable MCP entry, child-only
HUD_HOME and HUD_MCP_SURFACE=roles; add absent `hud-delegate/SKILL.md` in that verified user directory. All original
TOML bytes/comments/profiles and other skills are preserved. Duplicate/foreign name, invalid duplicate TOML or skill
collision refuse. Never wildcard across Codex homes. Apply with the same options and `apply --plan PLAN_ID`.

**Restore:** `codex-activation.mjs restore-preview --receipt ...`, then `restore --receipt ... --plan ...`.
A stale config/skill edit conflicts, never overwrites. **Check:** `"$CODEX" mcp list`, native skill discovery, one MCP
registration only, no bar/launcher changes. After restore compare original bytes and mode and pre-existing skill peers.

**Binding limitation:** “HUD role calls are unavailable in this Codex connection because HUD cannot verify the calling
thread. Passive HUD observation remains available.” Initialize/tools/list can succeed while all role calls still
refuse `identity_unverified`. Do not retry with invented thread IDs, relaunch loops, or a hidden transport. Live native
provenance qualification is a separate owner/R7 gate, not something activation proves.

## 10. Optional persistent HUD preferences

**Preview:**

```sh
"$NODE" "$RELEASE/pi-package.mjs" row-10-preview "${COMMON[@]}" --panel-auto-open false
```

**Changes:** only HUD_HOME/integration-config.json's panelAutoOpen; other values preserved. Apply using
`row-10-apply` with the exact plan ID. `/hud off` itself remains session-local. **Restore:** this row's A1 receipt via
row 2. **Check:** persistent selection is restored; panel-off summaries become honestly unavailable rather than
starting a hidden producer. Standalone full-footer selection is not supplied by this command and needs explicitly
disabling the other footer owner under a separate preview.

## Upgrade, downgrade, uninstall and drain

1. Keep the old immutable release and every receipt. Stage N+1 separately; never garbage-collect N or hot-reload jobs.
2. Reverse client activation: statusLine **first**, then row 10, row 9, row 7 selection/materialization, row 5 alias,
   row 4 native manager and materialization, in reverse receipt order where applicable. Stop on any conflict.
   **Then reverse the current base activation receipt too**, using row 2's restore-preview/restore. A1 recognizes
   one-hop restore evidence, not arbitrary chains of previously restored shim identities. Never force a stale
   original receipt through a conflict. At this owner-confirmed boundary the selector and three public shims are
   temporarily absent; this does not kill live jobs or remove retained releases.
3. Preview/apply a fresh N+1 base activation (selector/public shims), then repeat rows 4–10 with new pins and new
   approvals. Keep this new base receipt. No in-place client re-pinning. An old running primary's helper still
   loads retained N, not the new selector.
4. Rollback uses the **same reverse-and-re-enable procedure**: reverse N+1 clients, reverse its base activation
   receipt to the unselected state, preview/apply a fresh N base activation, then re-enable N clients with fresh
   previews. Keep the fresh rollback base receipt. Restore the routing config that the older parser supports if a
   routing schema changed; never silently strip helper routing fields.
5. Final uninstall: reverse all client receipts first. Preview with
   `"$NODE" "$BUNDLE/activate-runtime.mjs" uninstall preview --receipt CURRENT_BASE_ACTIVATION_RECEIPT`, then apply with
   the exact plan ID. After rollback this means the **fresh rollback** receipt, not the initial install receipt. Result is **`deactivated; release retained`**, not a purge. Backups, keys, history, results,
   active owners and releases remain. No job is killed/replayed by client deactivation.
6. **Drain old R2b/direct jobs through their already-running owning version before switching control ownership.**
   Inspect/read existing jobs, answer legitimate QA through that owner, wait/read its report, explicitly close through
   that owner, and confirm its exact agents/tabs gone. New releases read legacy history but refuse legacy mutations;
   do not run a stored private reaper or adopt/relaunch an old job. Unknown inventory/ownership means stop, not kill.

### PIROLE owner checks (R7, NOT_RUN by this rehearsal)

- Review public role/skill language, one-helper discipline, sonic ≤10/reviewer ≤3, QA 1200 s timeout/default wording.
  Adopt routing examples only by explicit preview; native pi login/auth/models stay pi-owned.
- Confirm actual `herdr integration status` is current and its managed pi ID/version header matches. Missing/outdated
  instructs `herdr integration install pi`; the HUD never installs it automatically. Real herdr/home changes need
  separate authorization; the synthetic mismatch and replaced-file controls grant no production capability.
- Verify one real cross-harness main → imp → sonic/fresh reviewer → caller-backgrounded wait → read → close sequence,
  correct parent attribution, QA answer versus timeout/default, continuation grace, finite autoclose and repeated close.
- Verify exact tab/pane/process stamps, no focus theft or second notify channel, no private toolkit/extra SDK/package
  import, no provider call for local `/hud`, and no leftover owned processes after cleanup.
- Ordinary main-session switch or MCP exit must not kill delegated jobs. Old release helpers must remain pinned after
  a real activation change. Codex's daemon-backed role admission remains unavailable pending native qualification.
- Qualify owner footer/statusline fields, narrow terminal widths, panel-off stale behavior, actual backup restoration,
  provider/browser scenarios and WSL performance separately. Synthetic process success is not those acceptances.
