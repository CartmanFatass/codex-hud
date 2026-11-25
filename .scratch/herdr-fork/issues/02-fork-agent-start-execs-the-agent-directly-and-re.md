# 02: Fork: agent start execs the agent directly and returns its PID, start time and exit; declared kind; close on clean exit

**Status:** done
**Owner try:** no
**Blocked by:** 01
**Objective:** herdr-fork

**What to build:** Plan rows a, c, d in `.scratch/herdr-fork/plan.md`. `agent.start` gains a direct-exec mode (new tab, or pane split) taking executable, argv, cwd, env, label, kind and on_exit; it spawns the agent as the PTY root (no shell) and replies `{agent, tab, root_pane, pid, pid_start_time}` (start ticks from `process_start_token`). `pane.exited` carries `exit_code` and `signal` from the reaped `ExitStatus`. The declared kind is pinned on `TerminalState` so recognition never depends on the process name. `on_exit: close | close_on_zero | remain` (default close_on_zero for direct-exec starts); a `PaneDied` that removes a tab emits `tab.closed`. The shell-typed `agent.start` path stays as it is. Rust tests in the fork for each; a CLI form of the new start (`herdr agent start --exec ...` or similar) for HUD and manual use. Work in ~/projects/herdr-hud on branch `hud`; commit there; never push; do not install.

- [x] Direct-exec start replies with pid and pid_start_time equal to /proc/<pid>/stat field 22 of the agent process, and the agent's parent is herdr (no shell)
- [x] pane.exited reports exit_code / signal; with close_on_zero a clean exit closes the tab and emits tab.closed, a nonzero exit leaves it readable
- [x] A declared kind is recognized even when the executable's basename differs (symlink to a versioned file)
- [x] Fork tests cover each; cargo build and the touched tests pass; nothing pushed or installed

## Comments

- 2026-11-25 main: merged on herdr-hud `hud` at 3027f8dd (02: 08c6fc1e, 03: 0aaeaedd; merge job j56d355e887263b01). Full suite 4,156 passed, 1 pre-existing upstream failure (client_mode sigwinch palette). Installed by main: ~/.local/bin/herdr = 0.9.5-hud.3027f8dd (sha256 3668a558…), stock kept as ~/.local/bin/herdr-0.9.5-upstream; live-handoff of the running server succeeded, all tabs kept, launch_id present.
