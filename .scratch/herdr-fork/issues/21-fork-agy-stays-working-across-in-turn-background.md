# 21: Fork: agy stays working across in-turn background work

**Status:** done
**Owner try:** no
**Live try:** after install, a live agy turn runs `sleep 6` in the background: herdr pane get keeps agent_status working through the wait and emits one change to idle/done within ~1.5 s after the turn ends
**Blocked by:** none
**Objective:** herdr-fork

**What to build:** Owner 2026-11-26: herdr has long shown Antigravity (agy) as idle/done while agy runs background work, and HUD worked around it from outside (D-2026-11-17-05, D-2026-11-18-04, D-2026-11-19-01). Design from oracle job jb786b61850a1b98a (read its full report: section Q3 option 5 and Slice 1, file:line in the fork @017b2700). Build in the fork (~/projects/herdr-hud, branch `hud`; own worktree and branch from `hud`; do not merge, push or install): (1) src/detect/manifests/antigravity.toml: widen `esc_cancel_footer_working` to bottom_non_empty_lines 10 and `spinner_working` to 24 (task panel and tall prompts push the markers out today); blocked rules still win. (2) A lazy turn-scoped descendant hold for Agent::Antigravity only: stamp turn_start_tick on the transition into Working (or an accepted prompt / user input while idle); only when PendingIdleConfirmation is about to confirm Working -> Idle (visible_idle false), walk /proc children of the verified agy root (pid + start token; direct-exec child_pid/child_start_time or AgentJobTracker's process on shell panes) with the existing budget (512 pids, 25 ms); hold Working with a 1 s recheck while any non-zombie descendant started at or after the turn start lives; release on exit, agent exit, reset, or new user input on that pane (owner-chosen default: a human's new prompt releases a lingering daemon hold). Pre-turn descendants do not count but are walked through; turn-1 launch-window non-shell MCP helpers and npm exec / pnpm dlx / npx / uvx bootstrap chains (port of MyHUD src/mcp/cli-judge.ts bootstrap) are exempt while turn children under them count. Zero /proc walks while the screen already says Working, Blocked or confirmed Idle. (3) Capability `agy_background_work: true` on ping, schema artifact regenerated. (4) Hardening from the same report: `update.manifest_check` defaults to false so remote manifests never override the bundled antigravity.toml; `inspect_agy_prompt` (src/app/prompt_guard.rs) refuses Empty when the footer below the prompt shows `N task(s)`. (5) HUD-FORK.md documents all of it with the Apache-2.0 4(b) notices. Tests per the report's Slice 1 list; full fork test pass single-threaded (split around the known SIGPIPE case client_shell_attach_seeds_workspace), api_ping, live_handoff, release build.

- [ ] antigravity.toml windows widened; blocked dialogs still win (screen fixture tests: task panel, tall prompt)
- [ ] An in-turn agy descendant holds Working with 1 s rechecks and releases to idle/done within ~1.5 s of exit; pre-turn and launch-window MCP helpers do not hold; ephemeral <300 ms children do not flap (tests)
- [ ] No /proc walk while the screen already matches Working, Blocked or confirmed Idle (test)
- [ ] ping advertises agy_background_work; guarded prompt returns not_ready while held and when the footer shows N task(s); manifest_check defaults to false (tests)
- [ ] Full fork test pass, api_ping, live_handoff and release build green

## Comments
