# 17: Fork: a hidden tab opened for a look hides again when focus leaves it

**Status:** done
**Owner try:** no
**Blocked by:** none
**Objective:** herdr-fork

**What to build:** Owner 2026-11-26: opening a hidden tab (focus via tab.focus / pane.focus / agent.focus, or a click on the hidden count) should be a peek: when focus moves to another tab, the tab hides again. `tab.set_hidden {hidden:false}` stays an explicit pin that keeps it visible. Add a `peek` state to hidden tabs: focus on a hidden tab reveals it as peeked (tab.get/list report `hidden:false, peek:true`); leaving focus (another tab focused in that workspace, or the client switching workspace) restores `hidden:true` and clears peek; `tab.set_hidden` false clears peek (pinned), true hides. Peek is not persisted across cold restore (a peeked tab restores hidden); live-handoff carries it. Capability: `ping.capabilities.hidden_tabs_peek`. Document in HUD-FORK.md. Fork worktree on its own branch from `hud`; do not merge; never push or install.

- [ ] Tests: focus a hidden tab -> visible with peek; focus another tab -> hidden again; set_hidden false while peeked -> stays visible after focus leaves; set_hidden true hides; cold restore of a peeked tab -> hidden; live-handoff keeps peek
- [ ] HUD-FORK.md updated; fmt, clippy -D warnings, schema check, unit tests single-threaded, api_ping, live_handoff, release build
- [ ] Live try: none (checked with herdr-fork/18)

## Comments
