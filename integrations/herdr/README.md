# Herdr integration

`hud panel` uses the running fork's `dock` capability over the herdr socket. The
session-wide right-edge dock defaults to a 56-column overlay; Settings → Panel
can set its width or switch to push mode. The installed `herdr` CLI still handles
editor and commit-view tabs opened from the dock (`src/cli/panel-pane.ts`).

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
and no detached retry helper or retry file is created. Press Tab in the composer
for the [working-job target picker and excerpt replies](../../docs/reference.md#send-a-pane-selection-to-a-worker).

The installer prints an optional `prefix+a` binding for `~/.config/herdr/config.toml`.
If you choose a different key, it must not collide with herdr's default bindings.
