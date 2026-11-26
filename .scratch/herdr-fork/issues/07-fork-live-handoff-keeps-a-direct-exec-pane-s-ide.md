# 07: Fork: live-handoff keeps a direct-exec pane's identity and exit policy

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** herdr-fork/05
**Objective:** herdr-fork

**What to build:** Installing 0.9.5-hud.0409f9fa by live-handoff (2026-11-25) left the 06 imp's tab open after its job closed: handoff import (`src/persist/restore.rs` ~700-750) allocates a new terminal_id (`TerminalId::alloc()` at :709) and marks imported argv terminals `with_respawn_shell_on_exit()` (:713), so HUD's reaper saw `root pane terminal_id mismatch` and refused (correctly), and an exiting root would get a shell instead of the on_exit policy. launch_id already survives. On live-handoff import, keep for each imported pane: terminal_id, declared agent kind, agent name and managed phase (Active stays Active), exit_policy (no respawn shell for direct-exec roots; shell-typed panes keep today's behaviour), and pid/pid_start_time as reported by agent/pane info. Cold restore after a server stop is unchanged (processes are gone there). Work in ~/projects/herdr-hud on a branch from `hud` (hud-07), merge into `hud`; never push; never install, never touch ~/.local/bin/herdr or the running server; tests use their own sockets.

- [ ] live_handoff test: a direct-exec pane started with a name and close_on_zero keeps terminal_id, launch_id, declared kind, name, interactive_ready and exit policy after handoff; its clean exit then closes the tab and emits tab.closed with the same launch_id and terminal_id
- [ ] A shell-typed pane keeps today's handoff behaviour (existing tests pass)
- [ ] cargo build --release and live_handoff/restore suites pass; full suite no new failures vs 0409f9fa; merged on `hud`; nothing pushed or installed

## Comments
