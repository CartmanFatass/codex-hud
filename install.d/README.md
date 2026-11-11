# Installer extensions

`./install --with claude,pi,codex` sources each selected `install.d/<name>.sh` and calls
`hud_ext_install`. Extensions define both `hud_ext_install` and `hud_ext_uninstall`.
The functions receive exported environment variables `REPO` (checkout root), `HUD_HOME`
(default `$HOME/.hud`) and `BIN_DIR` (`$HOME/.local/bin`). Hooks should be idempotent;
a failing hook stops the installer.

`./install --uninstall` calls `hud_ext_uninstall` for every `install.d/*.sh` present;
`--with name,...` limits it to those extensions. Core uninstall keeps HUD data.

Run `CODEX_HOME=... ./install --with codex` once per Codex home (default `~/.codex`).
