# 30: fork: the pane right-click menu lists pane plugin actions

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Repo: ~/projects/herdr-hud (the herdr fork). fine-interact/02 shipped the MyHUD plugin action `hud.select-send.investigate` with `contexts = ["pane"]`, but herdr's pane right-click menu (src/client/shell/context_menu.rs ~55-82, `ClientContextMenuTarget::Pane`) does not list plugin actions, so "Investigate this" is unreachable from the mouse. Add every registered plugin action whose contexts include `pane` to that menu (after the built-in items, separated), invoking it with the right-clicked pane as the target even when that pane is not focused. Never touch ~/.local/bin/herdr or the running herdr server; main installs the tested build.

- [ ] Fork test: a registered `contexts = ["pane"]` action appears in the Pane context menu; an action without `pane` does not
- [ ] Fork test: choosing it on an unfocused pane invokes the action with that pane's id, not the focused pane's
- [ ] Fork test suite passes; the report names the built binary path for main to install

## Comments
