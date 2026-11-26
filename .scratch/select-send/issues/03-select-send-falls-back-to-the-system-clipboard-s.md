# 03: Select-send falls back to the system clipboard (send what was just copied)

**Status:** ready-for-agent
**Owner try:** yes
**Live try:** copy any text (in herdr, Windows Terminal or another app), press Ctrl+b a in a herdr pane: the composer opens with that text marked 来自剪贴板; confirm sends it to the main session
**Blocked by:** none
**Objective:** interaction

**What to build:** Owner 2026-11-26, after the copy-on-select memory (herdr-fork/16) failed live: 'can it just send the copied content; that is more general'. In the plugin action (src/roles/select-send.ts handleSelectionAction, src/cli/select-send.ts runSelectSendAction), take the text in this order: live selection (selected_text or selection coords, as today) → the system clipboard. Clipboard reader, first that exists and answers within 1.5 s: `wl-paste --no-newline` when WAYLAND_DISPLAY is set (on WSLg this mirrors the Windows clipboard), `xclip -selection clipboard -o` / `xsel -bo` when DISPLAY is set, `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -Command Get-Clipboard -Raw` on WSL, `pbpaste` on macOS; strip a trailing CR/LF pair from PowerShell output; bound the read to the existing excerpt cap. A clipboard excerpt has no verified source: the composer shows it as `来自剪贴板` (EN `From clipboard`) with the focused pane as context only, never as a claimed source location, and the owner confirms before anything is sent (as today). Empty clipboard or no reader: the toast says `没有选中或复制的内容` (EN `Nothing selected or copied`). Make sure herdr invokes the action without a live selection (plugin manifest `contexts`), adjusting integrations/herdr/plugin/herdr-plugin.toml if needed. Tests use a synthetic reader via an env override (no real clipboard). Update docs/reference.md (select-send). Out of scope: changing herdr.

- [ ] With no selection, the action reads the clipboard through the first available reader within 1.5 s and opens the composer with that text marked From clipboard (tests with a synthetic reader)
- [ ] A live selection still wins over the clipboard; empty clipboard or no reader shows the new toast (tests)
- [ ] The composer never presents a clipboard excerpt as from a pane location; nothing is sent without the owner's confirm (test)
- [ ] EN/ZH strings; docs/reference.md updated

## Comments
