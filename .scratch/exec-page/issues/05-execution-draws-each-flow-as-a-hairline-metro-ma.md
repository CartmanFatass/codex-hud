# 05: Execution draws each flow as a Hairline metro map with a station cursor and one detail line

**Status:** ready-for-agent
**Owner try:** yes
**Live try:** Owner opens the Execution tab during a live queue run and reads progress from the map.
**Blocked by:** 02

**What to build:** Owner picked C · Hairline (2026-11-26) from docs/design/metro-map/README.md + sample.html; spec in docs/design/tab-roles/README.md §3a ("Chosen look"). Replace the vertical-wave workflow rows with one map per open flow under its header: light `─│╭╮╰╯` travelled in `muted`, `╌╎` ahead in `frame`, one neutral line for all flows, colour only for state; glyphs, tokens, row budget, ASCII (icons=text) and no-colour rules exactly as the README's Hairline column. Keys: while the cursor is on a map ←/→ move between stations and ↑/↓ across lanes then leave the map; Tab/Shift-Tab always switch tabs; Enter on a station opens the Inspector, on the header Run Detail. Per-station cursor and per-cell mouse hits. Detail line: station under the cursor, else the one that changed last. Width: collapse settled stations to `●×N` and not-started waves, batch pool as one group, council members as lanes into the synthesis. Legend behind `?`. Exact-column frames per ARCHITECTURE §8.

- [ ] Golden frames at 40, 62 and 80 columns, EN and ZH, colour/no-colour/ASCII, match the README's Hairline frames for the queue (3 parallel), failed + repair + gate, held, batch, council, long-run collapse and two-flows-plus-legend scenarios.
- [ ] Keyboard and mouse: station cursor, lane moves, Tab switching, Enter targets, as described; covered by input tests.
- [ ] The old wave rows and their glyphs `⚖ ★` are gone from Execution; docs/reference.md describes the map, keys and legend.
- [ ] Render cost per frame stays within the panel's current budget (measured).

## Comments
