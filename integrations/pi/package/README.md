# Pi package `hud` (R6A-A5)

This is an **opt-in template**, not a live installation. Activation materializes
`package.json`, `binding.json`, `binding.mjs`, `extensions/hud.mjs`, this README and
the hash-verified canonical `skills/hud-delegate/SKILL.md` under
`$HUD_HOME/installation/integrations/<integrationId>/pi/`. The manifest explicitly
selects that one extension and one skill. It never discovers `hud-footer.ts`,
managed `hud-delegate.ts` or the worker-only `integrations/pi/worker.ts`.
Host pi libraries are peers, never bundled dependencies. No dotfile is shipped.

## Behavior

- `/hud on|off|toggle|status|reconnect|help` is a **local registered command**. Empty
  arguments mean status. Unknown input and local failures give a bounded visible
  notification. It never sends a user message or starts a provider turn.
- The six canonical `hud_roster`, `hud_create`, `hud_read`, `hud_send`,
  `hud_respond`, `hud_close` proxies use A2's private stdio MCP/fd3 evidence bridge.
  No `mcp.json` entry or generic MCP registration is used. Native context selects
  identity, not model arguments or inherited session variables. The bridge epoch
  starts on native startup; the child MCP is lazy, on the first persisted call.
- `session_shutdown` and before-switch/fork/tree fence synchronously. Cleanup
  clears `hud-delegation`, restores the native editor/footer, cancels the timer, disposes subscriptions and
  closes the old private channel and exact panel generation. Jobs are not closed.
  A canceled transition stays unbound until `/hud reconnect`. Successful tree
  navigation rebinds. A `/tree` keeps an open panel; a panel you closed stays
  closed. Continuity requires this generation's live occupant/instance proof
  within a 150 ms read-only hook budget and still honours `panelAutoOpen`; failed,
  canceled or uncertain navigation grants no reopening. The memory-only marker is
  consumed once, never persisted. Reload creates a new extension instance.
- Only `hasUI && mode === 'tui'` permits the footer, status segment, timer or panel operation.
  RPC (even with hasUI) and print retain role tools without those TUI effects.
- Auto-open also requires native header/session evidence, complete process ancestry,
  foreground TTY and exact herdr process/pane/instance proof. Workers, nested
  sessions, missing proof and an inherited pane variable alone do not authorize a
  split. A3 supplies serialization, ownership receipts and generation fencing.
  There is no tmux fallback. Outside herdr, tools and native UI still work.
  A native `parentSession` is deliberately fail-closed for the panel even after an
  ordinary `/fork`: the old generation closes, the fork's tools/segment rebind,
  and `/hud on` returns `panel_nested_session`. Follow-up: qualify an ordinary
  top-level `/fork` for the panel via a native topology seam; not implemented here.
  **Reload limitation:** `/reload` closes an open panel and leaves it closed even
  with auto-open enabled. Tools and segment rebind; use `/hud on` to open exactly
  one replacement. Reload continuity is not persisted or implemented in A5.
- `/hud off` is session-local and closes only the panel. `/hud on|off|toggle`
  retain their A5 panel meaning; they never hide the everyday footer. `panelAutoOpen` in HUD-owned
  `integration-config.json` controls the persistent default (absent = on).
  The package never writes this preference on startup. A3 does not resurrect a
  manually closed display on automatic events; `/hud on` explicitly reopens it.

## Footer ownership and freshness

The HUD now owns the pi footer: the authorised p10k-footer port draws the same
Powerlevel10k band in the editor's top border, working spinner, full-width bottom
rule and dim identity row. It uses pi's own `CustomEditor` (keybindings, input,
paste and autocomplete are inherited); host libraries remain unbundled peers.
Other extensions' `setStatus` entries, including `hud-delegation`, appear in the
identity row through the original statuses segment. No competing footer should be
loaded. Shutdown, navigation fencing and `/hud footer off` restore pi's default UI.
`/hud footer on` mounts the HUD footer again. These bare footer controls do not
operate the panel; panel controls do not operate the footer. A footer-off choice
survives same-session `/tree` and `/hud reconnect`; a new session or reload resets it.

Settings live only in `$HUD_HOME/config.json` under `piFooter`, with the original
`footer` and `band` boolean keys. Without the section all original defaults are
on (the owner's settings are an explicit import, not new defaults).
`PI_HUD_PALETTE=p10k|gruvbox|nord|tokyo-night` and `PI_HUD_MARKS=ascii` are unchanged.
Except for bare `/hud footer on|off` (whole-footer session controls), the original
option grammar is namespaced unchanged under `/hud footer`: for example
`/hud footer off lens viz`, `/hud footer on all`, `/hud footer band off`,
`/hud footer footer off`, `/hud footer toggle git`, `/hud footer reset` or
`/hud footer list`. These write only the HUD config section, never pi's settings.

Explicit import (no discovery; preview writes nothing; existing keys win):

```sh
hud import preview --pi-footer --from "$PI_AGENT_DIR/p10k-footer.json"
# After inspecting the preview:
hud import apply --pi-footer --from "$PI_AGENT_DIR/p10k-footer.json"
```

Both paths must be absolute. Unknown groups, keys, wrong-zone keys and nonboolean
values refuse. Apply preserves unrelated HUD configuration and backs up any
changed existing destination. Repaint/resize only fits retained native statistics:
usage/rates/viz are captured on lifecycle events and git refresh is asynchronous,
never launched from render. No history traversal happens on repaint.

Native session/model/agent/message/tree/compaction events and one single-flight
5-second TUI timer read only the **exact current root's** compact role-summary
cache (20 ms cooperative ceiling), using `readRoleSummary`/`renderRoleSummary`.
Only changed text is published. Expired/unavailable/wrong-root cache clears the
segment even while idle; no stale counts are retained. The path does no directory
scan, herdr call, process launch or network. The panel is the producer. With it off,
counts honestly expire (60 seconds); no hidden producer is started for cosmetics.
Status strings are bounded to 160 columns; the port's original width/drop priorities control final layout.

## Owner steps (plan §H rows 7, 8 and 10)

Stage/verify an immutable release first. Commands below are **previews**, with
synthetic variables/paths; do not run against a real client without approving the
exact displayed actions. No install command runs a model, client or panel.

```sh
# Generate package under HUD_HOME. Apply requires the exact same options + --plan ID.
node "$RELEASE/pi-package.mjs" preview --prefix "$PREFIX" --release "$DIGEST" \
  --node "$NODE" --hud-home "$HUD_HOME" --shim-dir "$SHIM_DIR"
# After approved apply, the returned piPackage path is PACKAGE.

# H7: separate settings-only owner diff, not implicit in package materialization.
node "$RELEASE/pi-package.mjs" row-7-preview --prefix "$PREFIX" --release "$DIGEST" \
  --hud-home "$HUD_HOME" --shim-dir "$SHIM_DIR" \
  --settings "$PI_AGENT_DIR/settings.json" --package "$PACKAGE"
# row-7-apply with the same options and --plan ID applies A1's journaled step.

# H10: optional, separate persistent preference diff (default is already true).
node "$RELEASE/pi-package.mjs" row-10-preview --prefix "$PREFIX" --release "$DIGEST" \
  --hud-home "$HUD_HOME" --shim-dir "$SHIM_DIR" --panel-auto-open false
# row-10-apply with the same options and --plan ID; affects panel preference only.

# Reverse newest receipts first; review conflicts, then use the fresh restore ID.
node "$RELEASE/pi-package.mjs" restore-preview --receipt "$RECEIPT"
node "$RELEASE/pi-package.mjs" restore --receipt "$RECEIPT" --plan "$RESTORE_ID"
```

Rows 7/10 use A1 declarative steps and its backup of bytes/mode/absence, exact
post-hash conflict refusal, symlink refusal and reverse restore. Other settings
are preserved. Recovery journals/immutable releases remain. Public shims/selector
are still part of the A1 preview; inspect every action even when unchanged.
A symlinked personal settings file is **refused**, never followed into Fishpref.
Known conflicting historical HUD opt-ins are refused for a separate owner-approved
resource-selection change, never silently disabled. No `mcp.json` is written.
After approval, the owner chooses a restart/reload boundary; activation never
reloads a running client. On upgrade, do not select old and new HUD entries at once.

**H8 / footer replacement (owner step before enabling this package):** remove the
old p10k-footer extension from pi's auto-discovery path. There is deliberately no
coexistence detector: two `setFooter`/editor owners would fight. Review this backup
command, then run it yourself at the chosen install boundary (the HUD never does):

```sh
mkdir -p "$PI_AGENT_DIR/backups"
mv "$PI_AGENT_DIR/extensions/p10k-footer.ts" \
  "$PI_AGENT_DIR/backups/p10k-footer.ts.$(date +%Y%m%d-%H%M%S).bak"
```

`PI_AGENT_DIR` is the owner's explicit absolute pi agent directory (normally
`~/.pi/agent`). If this is a symlink, `mv` backs up the symlink, not its Fishpref
target. Also deselect any explicitly configured p10k entry and historical
`hud-footer.ts` opt-in; do not load either alongside the ordinary package. Do not
remove the source in Fishpref. Restart/reload only after the backup and resource
selection review. Verify the band, spinner, other statuses, `/hud footer off` restoration
and narrow widths on the owner's terminal before calling live activation accepted.
Rollback: deselect the HUD package, restore the backed-up extension to its exact
original path (only if that path is absent), then restart/reload.

## Isolated validation

- `node --test tests/unit/pi-package{,-role}.test.mjs` loads the real generated
  entry with a recording synthetic API, actual A3 control and synthetic native
  transport/process ports; separately exercises real MCP/fd3/facade calls.
- `node tests/pi-package-mutants.mjs` kills nine disposable emitted-module mutants
  (the six ownership/identity controls, live tree proof, auto-open preference and
  stale-result generation adoption).
- `PI_PACKAGE_DIR=/absolute/installed/pi-coding-agent node tests/probes/pi-package-sdk.mjs`
  checks the used declarations against installed pi 1.5.1.
- `... node tests/probes/pi-package-cli.mjs` clean-builds a disposable artifact,
  discovers its local-path package from a temporary personal settings file and
  drives the installed CLI through a PTY. All model-capable input points at a
  **loopback recording fake provider with a dummy key**; automatic networking is
  disabled. No real provider or real client home is used. This is not a
  distribution-pack/signature qualification or a real herdr split/focus test.
- `node tests/probes/pi-package-cost.mjs` records three runs of 250 passive ticks,
  load time and private MCP startup/RSS separately. No full bundle verification is
  performed on ticks or commands.

Every run must use fresh temporary HOME, HUD_HOME, CODEX_HOME and pi agent dir,
clear inherited settings/color/HERDR variables, and shadow herdr with a fake on
PATH. Synthetic evidence is not owner-machine acceptance. Live panel
right-split/focus, footer display/font/palette parity, actual resume/fork and exact client
restore remain owner gates.
