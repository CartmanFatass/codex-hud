# Installer extensions

`./install --with claude,pi,codex,browser,herdr` sources each selected `install.d/<name>.sh` and calls
`hud_ext_install`. Extensions define both `hud_ext_install` and `hud_ext_uninstall`.
An optional `hud_ext_check` runs after name validation, before builds or filesystem changes
(install only); herdr and browser use it to refuse missing requirements without changing anything.
The functions receive exported environment variables `REPO` (checkout root), `HUD_HOME`
(default `$HOME/.hud`) and `BIN_DIR` (`$HOME/.local/bin`). Hooks should be idempotent;
a failing hook stops the installer.

`./install --uninstall` calls `hud_ext_uninstall` for every `install.d/*.sh` present;
`--with name,...` limits it to those extensions. Core uninstall keeps HUD data.

Run `CODEX_HOME=... ./install --with codex` once per Codex home (default `~/.codex`).
Before the full uninstall, remove each extra Codex home's registration with
`CODEX_HOME=<home> ./install --uninstall --with codex`, then run the full uninstall
for the remaining home. The first uninstall removes the shared commands, so use the
repository's `./install` (not `hud uninstall`) for subsequent homes and the full uninstall.

## Status lines are always on; only the panel is opt-in

After installing the selected extensions, ordinary `claude` and `pi` launches load
Claude's statusline and pi's footer. Codex's tmux bar comes with `codexH`.
The installer never edits shell rc files; with the Codex extension selected it prints
only this function to paste into your shell rc:

```sh
codexH() { hud codex "$@"; }
```

`codexH` uses the existing `hud codex` tmux-bar launcher and leaves `CODEX_HOME`
to the caller.

The panel never opens by itself: Claude and pi use `/hud`; Codex uses F12.
Claude gets a `/hud` command file (one line: run `hud panel` with Bash and report the pane id);
pi gets the `/hud` command from the display package. Codex installs no prompt file.

## What each extension changes

- **claude**: registers the six-role MCP (`claude mcp add -s user hud`), links the
  `hud-delegate` and `hud-setup` skills and `hud-statusline`, writes `~/.claude/commands/hud.md`, and
  writes the HUD `statusLine` into global `settings.json` (refresh interval 5),
  following symlinks and retaining a one-time plain `.hud-backup`. An owner's own
  non-HUD statusline is left alone. Uninstall removes the HUD statusline, restores
  a backed-up owner statusline, and removes the owned command and any old owned
  `$HUD_HOME/claude.json`. Unrelated settings and files stay.
- **pi**: prepares and registers both `$HUD_HOME/pi-package` (delegation tools +
  `hud-delegate` and `hud-setup` skills) and `$HUD_HOME/pi-display` (footer, Work segment, `/hud`)
  with `pi install`. Registration is idempotent, including hand-registered packages.
  It adds the `-extensions/p10k-footer.ts` filter to pi's settings and imports
  `p10k-footer.json` when present. Workers load the display package too; the panel
  still never opens automatically. Uninstall uses `pi remove` for both packages,
  removes both directories and reverses the filter change.
- **codex**: registers the six-role MCP (`codex mcp add hud`), links the
  `hud-delegate` and `hud-setup` skills and removes the legacy `$CODEX_HOME/prompts/hud.md` only if it
  still contains the HUD-owned line (uninstall also removes an old owned copy).
  Before MCP edits, the resolved `config.toml` gets a one-time plain `.hud-backup`.
  The official Codex commands may drop comments; a warning names that retained
  backup if the number of comment lines falls. No comments are reinserted.
  `hud codex` is the HUD launch (tmux bar); F12 opens the panel.
- **herdr**: checks PATH for `herdr`, `pi-role`, `pi-role-reap`, `pi-dispatch` and `pi`,
  printing their locations and sources. Only missing `herdr` fails installation.
  No external tool or herdr registration is installed; uninstall is a stated no-op.
- **browser**: checks PATH for `google-chrome`, `jev-ask`, `jev-aistudio` and `jev-flow`,
  printing locations and sources. Missing Chrome or `jev-ask` fails in preflight;
  the other CLIs are optional and reported. Nothing is installed, configured or launched:
  no HUD config, marker, browser directory or backup is written. Configure Chrome and
  the external Jev CLIs separately; their own setup is used for browser jobs. Uninstall
  is a stated no-op. Project reports browser availability with the same Chrome + `jev-ask`
  PATH check. The Decision API and panel need no browser extension.
