# Pi package `hud`

`./install --with pi` materializes `package.json`, `binding.json`, `binding.mjs`,
`extensions/hud.mjs` and a symlink to the canonical `skills/hud-delegate` under
`$HUD_HOME/pi-package/`, then registers it with `pi install`. The binding names
this repo checkout, HUD home and Node executable directly; there is no release
manifest, digest or version pin. Build the checkout before loading the package.
The manifest selects only that extension and skill, never `hud-footer.ts`,
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

## Install and uninstall

```sh
./install --with pi
./install --uninstall --with pi
```

The installer backs up `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/settings.json`
once to `settings.json.hud-backup` before changing it or running pi registration.
It adds `-extensions/p10k-footer.ts` to the top-level `extensions` array, preserving
all other entries and keys. Nothing under the agent's `extensions` directory is
moved, deleted or edited, including symlinks into Fishpref. If `p10k-footer.json`
exists in that agent directory, `hud import apply --pi-footer --from ABS` imports
its options into HUD configuration. If pi is not on PATH, registration warns and
is skipped; the package and footer settings are still prepared.

Uninstall calls `pi remove`, removes only the exclusion entry, deletes the backup
and removes `$HUD_HOME/pi-package`. It does not restore the whole settings backup
over later edits or remove imported HUD configuration. Neither operation reloads
a running client. Restart/reload at the chosen boundary; verify the band, spinner,
other statuses, `/hud footer off` and narrow widths on the owner's terminal.

## Isolated validation

- `node --test tests/unit/install-pi.test.mjs tests/unit/pi-package.test.mjs`
  runs install/uninstall with a fake pi command, then loads the real checkout
  entry with a recording synthetic API, actual A3 control and synthetic native
  transport/process ports. `pi-package-role.test.mjs` separately exercises real
  MCP/fd3/facade calls.
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
