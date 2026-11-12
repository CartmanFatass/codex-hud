# Pi packages `hud` and `hud-display`

`./install --with pi` materializes `package.json`, `binding.json`, `binding.mjs`,
`extensions/hud.mjs` and a symlink to the canonical `skills/hud-delegate` under
`$HUD_HOME/pi-package/`, then registers it with `pi install`: the delegation
package, always loaded, holding the six role tools and the skill. It also
prepares `$HUD_HOME/pi-display/` (same binding files, `extensions/hud-display.mjs`)
and registers it too: the footer, the Work segment and `/hud`. Do not also load it
with `pi -e`, or two footers run. The binding names the installed tree (checkout or
extracted release), HUD home and Node executable directly; there is no release
manifest, digest or version pin. `./install` builds the tree before registering.
Each manifest selects only its own extension (plus the skill in the delegation
package), never `hud-footer.ts`,
managed `hud-delegate.ts` or the worker-only `integrations/pi/worker.ts`.
Host pi libraries are peers, never bundled dependencies. No dotfile is shipped.

## Behavior

- `/hud on|off|toggle|status|reconnect|help` is a **local registered command** of
  the display package; bare `/hud` toggles. Unknown input and local failures give a
  bounded visible
  notification. It never sends a user message or starts a provider turn.
- The six canonical `hud_roster`, `hud_create`, `hud_read`, `hud_send`,
  `hud_respond`, `hud_close` proxies (delegation package, always loaded) use A2's
  private stdio MCP/fd3 evidence bridge.
  No `mcp.json` entry or generic MCP registration is used. Native context selects
  identity, not model arguments or inherited session variables. The bridge epoch
  starts on native startup; the child MCP is lazy, on the first persisted call.
- `session_shutdown` and before-switch/fork/tree fence synchronously. Cleanup
  clears `hud-delegation`, restores the native editor/footer, cancels the timer, disposes subscriptions and
  closes the old private channel and exact panel generation. Jobs are not closed.
  A canceled transition stays unbound until `/hud reconnect`. Successful tree
  navigation rebinds. A `/tree` keeps an open panel; a panel you closed stays
  closed. Continuity requires this generation's live occupant/instance proof
  within a 150 ms read-only hook budget; failed,
  canceled or uncertain navigation grants no reopening. The memory-only marker is
  consumed once, never persisted. Reload creates a new extension instance.
- Only `hasUI && mode === 'tui'` permits the footer, status segment, timer or panel operation.
  RPC (even with hasUI) and print retain role tools without those TUI effects.
- The panel never opens by itself: no session event splits a pane; only `/hud`
  (display package) opens one. Workers, nested
  sessions and an inherited pane variable alone do not authorize a
  split. A3 supplies serialization, ownership receipts and generation fencing.
  There is no tmux fallback. Outside herdr, tools and native UI still work.
  A native `parentSession` is deliberately fail-closed for the panel even after an
  ordinary `/fork`: the old generation closes, the fork's tools/segment rebind,
  and `/hud on` returns `panel_nested_session`. Follow-up: qualify an ordinary
  top-level `/fork` for the panel via a native topology seam; not implemented here.
  **Reload limitation:** `/reload` closes an open panel and leaves it closed.
  Tools and segment rebind; use `/hud on` to open exactly
  one replacement. Reload continuity is not persisted or implemented in A5.
- `/hud off` is session-local and closes only the panel. `/hud on|off|toggle`
  retain their A5 panel meaning; they never hide the everyday footer.
  A3 does not resurrect a
  manually closed display on automatic events; `/hud on` explicitly reopens it.

## Footer ownership and freshness

The HUD now owns the pi footer: one line below pi's own editor, drawn by the same builder as Claude's statusline and the
Codex bar, so it shows the same fields in the same order (`model effort │ context │ repo branch │ cost │ notice zone
···· MCP n  skills n`; see `docs/reference.md`, The bottom bars). Other extensions' `setStatus` entries, including
`hud-delegation`, share the right cluster at the lowest priority. The notice zone tells events only (a HUD job started,
finished or failed, each for three minutes; the footer host sees no skill loads) and pins what needs you. pi's own `CustomEditor`
(keybindings, input, paste and autocomplete) is not replaced; host libraries remain unbundled peers. No competing
footer should be loaded. Shutdown, navigation fencing and `/hud footer off` restore pi's default UI.
`/hud footer on` mounts the HUD footer again. These bare footer controls do not
operate the panel; panel controls do not operate the footer. A footer-off choice
survives same-session `/tree` and `/hud reconnect`; a new session or reload resets it.

Settings live in `$HUD_HOME/config.json` under `piFooter`, with the original `footer` and `band` boolean keys, which
now switch the fields they name inside the one line. Without the section all defaults are on (the owner's settings are
an explicit import, not new defaults). The look is the HUD's display settings: `barStyle` (`line` or `p10k`) and
`barFields`, in `$HUD_HOME/hud-settings.json`; `PI_HUD_PALETTE` and `PI_HUD_MARKS` are gone.
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

Both `$HUD_HOME/pi-package` and `$HUD_HOME/pi-display` are registered with `pi install`
(workers run plain with `pi-role -ne` and load neither).
The installer backs up `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/settings.json`
once to `settings.json.hud-backup` before changing it or running pi registration.
It adds `-extensions/p10k-footer.ts` to the top-level `extensions` array, preserving
all other entries and keys. Nothing under the agent's `extensions` directory is
moved, deleted or edited, including symlinks into Fishpref. If `p10k-footer.json`
exists in that agent directory, `hud import apply --pi-footer --from ABS` imports
its options into HUD configuration. If pi is not on PATH, registration warns and
is skipped; the package and footer settings are still prepared.

Uninstall calls `pi remove`, removes only the exclusion entry, deletes the backup
and removes `$HUD_HOME/pi-package` and `$HUD_HOME/pi-display`. It does not restore the whole settings backup
over later edits or remove imported HUD configuration. Neither operation reloads
a running client. Restart/reload at the chosen boundary; verify the band, spinner,
other statuses, `/hud footer off` and narrow widths on the owner's terminal.

## Isolated validation

- `node --test tests/unit/install-pi.test.mjs tests/unit/pi-package.test.mjs`
  runs install/uninstall with a fake pi command, then loads the real checkout
  entry with a recording synthetic API, actual A3 control and synthetic native
  transport/process ports. `pi-package-role.test.mjs` separately exercises real
  MCP/fd3/facade calls.
- `node tests/pi-package-mutants.mjs` kills disposable emitted-module mutants
  (the six ownership/identity controls, live tree proof and
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
