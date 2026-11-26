# Herdr integration

The HUD uses the installed `herdr` CLI for panel splits and editor panes
(`src/cli/panel-pane.ts`). Panels default to 56 columns and are named `hud panel`.
The split ratio sizes the original pane; HUD requests `1 - width / callerColumns`,
clamped to 0.1–0.9, or 0.7 when the caller's terminal width is unknown.

`src/integrations/herdr/transport.ts` remains the low-level transport for existing
integrations. There is no version pin or capability manifest in this directory.
Tests use fake Herdr responses, never the owner's running session.

## Selection-to-main plugin (`plugin/`)

`integrations/herdr/plugin/` is the `hud.select-send` herdr plugin linked by
`./install --with herdr`. Its `hud.select-send.send` action opens a small modal
composer popup showing the exact excerpt and one question line. Press Enter in
the composer to send the excerpt with its source (`project`, `pane`, `job` if
a worker pane, `time`) to the responsible main session through HUD's normal
delivery path. If herdr refuses direct guarded typing, the composer shows a
waiting status and retries there within a 10-minute window. Press Esc while
waiting to cancel without sending. The action never sends without confirmation,
and no detached retry helper or retry file is created.

The installer prints an optional `prefix+a` binding for `~/.config/herdr/config.toml`.
If you choose a different key, it must not collide with herdr's default bindings.
