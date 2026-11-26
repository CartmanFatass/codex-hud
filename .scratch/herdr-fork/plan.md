# herdr fork plan (D-2026-11-25-09)

Source: oracle j66f7c7b4cf976c21 (2026-11-25), herdr upstream `github.com/herdrdev/herdr` at e8d7d970 (v0.9.5 + 43), Apache-2.0. Personal, independent fork: no upstream PRs; upstream taken selectively.

## Decisions (main, 2026-11-25)

- **Direct-exec agent tabs.** The agent binary is the PTY root of its tab (`Workspace::create_tab_argv_command` → `Tab::new_argv_command` → `PaneRuntime::spawn_argv_command`, already in herdr). No interactive shell: no `.zshrc` PATH reordering, no ZDOTDIR wrapper, no powerlevel10k helpers, and the kernel gives herdr the exit status. HUD passes the worker environment explicitly (its own process env, which came from the owner's shell: PATH, CODEX_HOME, GOOGLE_*, NVM_*, plus the job's HUD variables).
- **`on_exit` default `CloseOnZero`.** A clean exit closes the tab (and emits `tab.closed`); a crash keeps the tab with its scrollback readable until HUD closes it after failure retention.
- **Self-update off.** `herdr update` and `herdr channel set` refuse in the fork; `version_check` defaults false; build as `0.9.5-hud.<sha>` (`HERDR_BUILD_CHANNEL=hud`).
- **Repository.** Local git repo `~/projects/herdr-hud` (full clone of upstream, branch `hud`), no remote push until the owner asks.
- **Install is the main session's step, with owner confirmation.** Back up `~/.local/bin/herdr` as `herdr-0.9.5-upstream`, atomic `mv` of the built binary, `herdr server live-handoff` (transfers live PTYs to the new binary). Everything, including the main session, runs inside herdr.
  After the binary is replaced, the running server's own exe is "(deleted)": run `herdr server live-handoff --import-exe ~/.local/bin/herdr --expected-version <new version>`.

## Primitives (fork side, LoC are oracle guesses)

| | Primitive | Where | LoC |
|---|---|---|---|
| a | `agent.start` direct-exec (new tab or pane, executable, argv, cwd, env, label, on_exit) returns `{agent, tab, root_pane, pid, pid_start_time, launch_id}`; `pane.exited` carries `exit_code`/`signal` | `src/api/schema/agents.rs:186-196`, `src/app/agents.rs:145-236`, `src/pane.rs:2726-2770` (status dropped at 2748-2753), `src/platform/linux.rs:672-712` (`process_start_token`), `src/events.rs:79-83`, `src/api/schema/events.rs:526-529` | 100-145 |
| b | `launch_id` minted per tab, on `TabInfo`/`PaneInfo`/`AgentInfo` and tab/pane created/closed/exited events; persist `next_workspace_id` | `src/workspace/tab.rs:38-52`, `src/persist/snapshot.rs:16-29`, `src/workspace.rs:151-173`, `src/api/schema/tabs.rs:65-73`, `src/api/schema/events.rs:474-529` | 50-75 |
| c | declared agent kind pinned on `TerminalState` (no process-name detection) | `src/terminal/state.rs:2039`, `src/pane.rs:929,1057`, `src/app/agents.rs:431-451` | 35-55 |
| d | `on_exit: Close / CloseOnZero / Remain`; `PaneDied` that removes a tab emits `tab.closed` | `src/app/api.rs:308-327,541-554`, `src/app/actions.rs:2059-2080` | 40-60 |
| - | self-update lock | `src/update.rs:2184`, `src/cli.rs:190`, `src/config/model.rs:32-57`, `src/build_info.rs:3-25` | ~15 |

Build: Rust toolchain pinned 1.96.1 in `rust-toolchain.toml` (machine has 1.97.1 via rustup; pin or install), **Zig 0.16.0** required by `crates/ghostty-vt/build.rs` (absent; install user-local). Cold release build ~2-4 min.

## HUD side (deleted once adopted, ~420-480 LoC)

`src/runtime/cli-invocation.ts` (shim, ZDOTDIR wrapper, witness, startup shell snapshot), `src/runtime/tab-shell.ts`, `src/runtime/tab-owner.ts:10-19`, `packages/hud-mcp/bin/hud-cli.mjs` exec-witness, most of `src/runtime/reap-tab.ts`, `closedTabs`/close reconciliation in `src/runtime/watch-runtime.ts` and `watch.ts`, close handling in `src/runtime/cli-supervisor.ts`, `retryBusyPane`/`HUD_TAB_LAUNCH`. Kept: `src/roles/worker-tree.ts` (headless and detached descendants), `cli-kinds.ts`, `cli-judge.ts`.

HUD detects the fork's capabilities (version suffix `-hud` or an API capability field) and keeps today's path on stock herdr until the fork is installed.

## Backlog (D-2026-11-26-02, owner 2026-11-26)

Allowed, not scheduled. Order after D-2026-11-26-01 steps 1–3 unless the owner moves one up:

1. Unattended service: owner sets it up and switches it on; keeps configured work moving and hands back at
   configured points; may be a resident service; never inferred from activity or presence.
2. Single-project execution page: live worker views, thumbnails, delegation; separate from Home.
3. Selection sent directly to a working job, for tasks that gain from closer interaction (needs answer correlation).
4. Universal herdr-drawn statusline for every client; native statuslines stay until it matches them.
5. Fine-grained interaction, lower priority: advisor side window, drag a pane to a worker, pane annotations.
6. TODO, not now: cross-machine control (phone client, remote worker pool).
