# 03: Fork: every tab carries a launch_id on its info and events, and IDs survive restarts without reuse

**Status:** done
**Owner try:** no
**Blocked by:** 01
**Objective:** herdr-fork

**What to build:** Plan row b in `.scratch/herdr-fork/plan.md`. Mint a unique `launch_id` per tab (format like TerminalId: `launch_<micros_hex><seq_hex>`), put it (and `terminal_id`) on `TabInfo`, `PaneInfo`, `AgentInfo` and on tab/pane created, closed and exited events, and return it from tab create and the direct-exec agent start. Persist the workspace/tab/pane numbering high-water marks in the session snapshot so a server restart never hands out a recently used ID. Leave the handoff wire format version alone unless a field must cross it (then keep live-handoff from 0.9.5 working). Rust tests. Work in ~/projects/herdr-hud on `hud`; commit; never push; do not install.

- [x] launch_id is present on tab info and on every tab/pane created/closed/exited event, and differs for two tabs that get the same public ID
- [x] After a server restart (snapshot restore) newly created tabs do not reuse IDs handed out before the restart
- [x] live-handoff from the stock 0.9.5 binary to the fork still transfers running panes (test or documented manual check)
- [x] Fork tests cover each; nothing pushed or installed

## Comments

- 2026-11-25 main: merged on herdr-hud `hud` at 3027f8dd (02: 08c6fc1e, 03: 0aaeaedd; merge job j56d355e887263b01). Full suite 4,156 passed, 1 pre-existing upstream failure (client_mode sigwinch palette). Installed by main: ~/.local/bin/herdr = 0.9.5-hud.3027f8dd (sha256 3668a558…), stock kept as ~/.local/bin/herdr-0.9.5-upstream; live-handoff of the running server succeeded, all tabs kept, launch_id present.
