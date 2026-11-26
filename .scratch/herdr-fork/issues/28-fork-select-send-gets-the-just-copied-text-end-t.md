# 28: Fork: select-send gets the just-copied text end to end (owner live failure of 16)

**Status:** ready-for-agent
**Owner try:** yes
**Live try:** after install, drag-select a line in a worker pane with the mouse, press Ctrl+b a within 30 s: the HUD composer opens with that text
**Blocked by:** none
**Objective:** herdr-fork

**What to build:** Owner live try of herdr-fork/16 on the installed 0.9.5-hud.00caf385 (client and server both new, 2026-11-26): drag-select text with the mouse (copy_on_select default true), then `prefix+a` (keys.command plugin_action hud.select-send.send, plugin manifest contexts=["selection"], MyHUD integrations/herdr/plugin) shows HUD's 'No selection to send' toast: the plugin's HERDR_PLUGIN_CONTEXT_JSON had neither selected_text nor selection. Each half has unit tests (server: src/app/custom_commands.rs plugin_command_delivers_copied_text_after_pane_content_changes; client: recent_copied_selection in src/client/shell/actions.rs:263-318, 690-740, mouse.rs:1755-1775), but nothing tests the chain. Reproduce end to end in the fork's client/headless test harness: drag-select in a pane, mouse up (copy request + response), then the prefix key, then the plugin_action key, through command.invoke to the plugin process env. Cover at least: selecting in the focused pane; selecting in a pane that was not focused before the drag (does mouse down focus it, or does `recent.pane_id != focused_pane_id` drop the text?); the prefix keypress and its timeout between copy and action; a pane whose content changes between copy and action; whether the plugin's `contexts = ["selection"]` gate refuses or strips copied text when there is no live selection. Find where the text is lost, fix it at that point (keep: copy behaviour, highlight timing, 30 s window, clear-on-next-click), and keep the end-to-end test. If the cause is outside herdr (e.g. the host terminal handles the drag and herdr never sees it), say so with the evidence instead of changing code. Document in HUD-FORK.md. Fork worktree on its own branch from `hud`; do not merge, push or install.

- [ ] An end-to-end test drives drag-select, mouse up, prefix+a and asserts the plugin receives selected_text equal to the copied text (focused and previously unfocused pane)
- [ ] The cause is named with file:line; the fix keeps copy behaviour, the 30 s window and clear-on-next-click
- [ ] fmt, clippy, isolated client/headless tests, release build pass

## Comments
