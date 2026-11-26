# 02: Hand a pane to a worker: menu action "investigate this"

**Status:** ready-for-agent
**Owner try:** yes
**Blocked by:** select-send/02
**Objective:** interaction

**What to build:** D-2026-11-26-02, lower priority. A pane action (menu first; drag with a modifier only if it does not clash with text selection, split resizing or apps that take the mouse) sends the pane's recent visible output, its source and an owner line to a chosen working job via the select-send/02 path (excerpt record, id, answer tied back). Default owner line: "Investigate this".

- [ ] Tests: the action sends the visible region once with its source to the chosen job; a closed target is refused
- [ ] Owner try: from a failing test pane choose "investigate this" on a worker; its answer appears next to the excerpt

## Comments
