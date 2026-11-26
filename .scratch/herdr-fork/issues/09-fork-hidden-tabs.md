# 09: Fork: hidden tabs

**Status:** done
**Owner try:** no
**Blocked by:** herdr-fork/07
**Objective:** herdr-fork

**What to build:** D-2026-11-26-01 step 1a (docs/fable-proposal/01-herdr-fork-final-plan.md §3). A tab carries a `hidden` flag, settable at `agent.start` (direct-exec) and `tab.create`, and later via a tab method. Hidden tabs are left out of the tab bar and next/previous tab navigation; the bar shows one count of hidden tabs. Focusing a hidden tab by API reveals it until it is hidden again. Persistence, live-handoff, exit policy and events are unchanged (it is an ordinary tab); `tab.list`/`tab.get` report `hidden`. Advertise a capability (ping capability field) so HUD can detect it. Fork changes in their own module with thin call sites. Work in ~/projects/herdr-hud on branch hud-09 from `hud`, merge into `hud`; never push; never install or touch ~/.local/bin/herdr or the running server.

- [x] Tests: a hidden tab is absent from the rendered tab bar and next/previous, the bar shows the hidden count, tab.list reports hidden, reveal and hide round-trip
- [x] Hidden flag survives live-handoff and cold restore; on_exit and tab.closed unchanged (tests)
- [x] ping reports the capability; cargo build --release; full suite no new failures vs 76b187b0; merged on `hud`

## Comments

## Comments

- 2026-11-26 main: imp ja376121ad29ffa60, 7fcd6ef8 on hud-09, merged on `hud` at d04b98fd. API: `tab.set_hidden {tab_id, hidden}`, `hidden` on `tab.create` and direct-exec `agent.start` (wins over focus), `tab.get/list` report `hidden`, `ping.capabilities.hidden_tabs`; `tab/pane/agent.focus` reveal. Rust 4,168 passed, only the pre-existing client_mode sigwinch failure; render benchmark unchanged within noise. Not installed yet (next install with 10 and 11).
