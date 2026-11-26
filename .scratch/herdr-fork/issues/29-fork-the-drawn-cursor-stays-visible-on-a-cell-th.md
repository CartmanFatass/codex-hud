# 29: fork: the drawn cursor stays visible on a cell the app already shows in reverse video

**Status:** ready-for-human
**Owner try:** yes
**Live try:** After install, the input prompt cursor is visible in a Claude Code pane inside herdr (focused and unfocused panes).
**Blocked by:** none
**Objective:** herdr-fork

**What to build:** Owner symptom (2026-11-26): no visible cursor in Claude Code panes inside herdr. Facts: `herdr pane read <pane> --format ansi` of a Claude Code pane shows the prompt `❯ ` followed by a reverse-video blank cell (`ESC[7m ESC[0m`), i.e. Claude Code draws its own block cursor. Herdr draws the terminal cursor by XOR-ing REVERSED on the cursor cell (`src/protocol/render_ansi.rs` ~205-222 and `frame_with_drawn_cursor` ~259-268). Hypothesis: Claude Code also leaves the real cursor visible on that same cell (for IME placement), so the two reversals cancel and nothing shows. This code is upstream herdr, not a fork change. Do: (1) confirm or refute the hypothesis with a test that feeds the terminal model a reverse-video cell and a visible cursor on it and checks the drawn frame/patch (both full frame and incremental patch paths, cursor moving onto and off the cell); also find where herdr chooses a drawn cursor versus the host terminal's real cursor and say which path the Claude pane uses. (2) Fix so a visible cursor on an already reversed cell is still visible (e.g. set rather than toggle REVERSED there, or another visible mark), without changing cursor drawing on normal cells and without leaving reversed residue when the cursor moves away. If the hypothesis is wrong, report the real cause with evidence before changing code. Record the behaviour in HUD-FORK.md.

- [ ] A test reproduces the invisible cursor on a reverse-video cell before the fix
- [ ] The cursor on a reversed cell is visible in both full-frame and patch rendering; moving off restores the app's own cell exactly
- [ ] Cursor drawing on ordinary cells is unchanged (existing tests pass)
- [ ] HUD-FORK.md records the change

## Comments
