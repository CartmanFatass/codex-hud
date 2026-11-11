# Installer extensions

`./install --with claude,pi,codex` sources each selected `install.d/<name>.sh` and calls
`hud_ext_install`. Extensions define both `hud_ext_install` and `hud_ext_uninstall`.
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

## The HUD display is opt-in per launch

The installer never edits shell rc files. At the end of `./install` it prints the shell
functions for the extensions you selected; paste the ones you want into your shell rc:

```sh
claudeH() { claude --settings "$HUD_HOME/claude.json" "$@"; }
piH() { pi -e "$HUD_HOME/pi-display" "$@"; }
codexH() { hud codex "$@"; }
```

- `claudeH` starts Claude with the HUD statusline for that launch only
  (`--settings` merges `$HUD_HOME/claude.json` over the unchanged global settings);
  plain `claude` starts without it. `CODEX_HOME` is left to the caller: `codexH` runs
  `hud codex` with whatever `CODEX_HOME` the shell already exports.
- `piH` starts pi with the HUD display package (`$HUD_HOME/pi-display`: the owned
  footer, the Work segment and `/hud`); plain `pi` loads only the delegation package.
- `codexH` starts Codex through the existing `hud codex` tmux-bar launcher.

The panel never opens by itself: Claude and pi use `/hud`; Codex uses F12.
Claude gets a `/hud` command file (one line: run `hud panel` with Bash and report the pane id);
pi gets the `/hud` command from the display package. Codex installs no prompt file.

## What each extension changes

- **claude**: registers the six-role MCP (`claude mcp add -s user hud`), links the
  `hud-delegate` skill and `hud-statusline`, writes `~/.claude/commands/hud.md`, and
  writes `$HUD_HOME/claude.json` (the statusline settings file `claudeH` passes with
  `--settings`). It never writes `statusLine` into the global `settings.json`; an
  earlier HUD install's statusline there (command ending in `hud-statusline`) is
  removed, an owner's own statusline is left alone. Uninstall removes the command
  file and `claude.json`; it restores nothing, and it keeps the settings backup only
  while that backup still holds the only copy of an owner's statusline.
- **pi**: prepares `$HUD_HOME/pi-package` (delegation tools + `hud-delegate` skill,
  registered with `pi install`) and `$HUD_HOME/pi-display` (footer, Work segment,
  `/hud`; never registered, loaded by `pi -e`). It adds the `-extensions/p10k-footer.ts`
  filter to pi's settings and imports `p10k-footer.json` when present. Workers run
  plain (`pi-role -ne`) and load neither package's display. Uninstall removes both
  package directories and the filter.
- **codex**: registers the six-role MCP (`codex mcp add hud`), links the
  `hud-delegate` skill and removes the legacy `$CODEX_HOME/prompts/hud.md` only if it
  still contains the HUD-owned line (uninstall also removes an old owned copy).
  `hud codex` is the HUD launch (tmux bar); F12 opens the panel.
