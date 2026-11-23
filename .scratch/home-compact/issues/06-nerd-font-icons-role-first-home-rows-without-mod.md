# 06: Nerd Font icons, role-first Home rows without model, and per-role worker counts

**Status:** ready-for-human
**Owner try:** yes
**Blocked by:** none

**What to build:** Owner 2026-11-22 (spec §2.2.9 line 22.24, D-2026-11-22-24) after trying the title-less Home. (1) Home job rows: no model, no effort, no route tier or headless marks (Inspector keeps them); the role icon comes first, before the ticket id; no running glyph (the blue ◉ goes; the state column shows only exceptions). (2) Icons: new default set `nerd` (Font Awesome glyphs in the BMP, which the owner's MesloLGS NF renders); keep `unicode` (today's set) and `text`; old values still load. Owner-picked glyphs, by codepoint: imp U+F0AD wrench, frontend-imp U+F1FC paint_brush, general U+F013 cog, oracle U+F0EB lightbulb, reviewer U+F002 search, sonic U+F0E7 bolt (replaces ⚡ in ⚡N); states: asking U+F059 question_circle (amber), failed U+F057 times_circle (red), unread report U+F0E0 envelope (green), done U+F058 check_circle, queued U+F252 hourglass_half, stalled U+F186 moon, stopped U+F04D stop. Write them as \u escapes in source (literal PUA characters get lost in some tools). The role icon table is shared with the statuslines (TS and native Rust) and the pi footer: they follow the same setting. Stage strip ●◐○ stays. (3) Home top line right side: worker counts per role since this panel opened, every state counted (running, done, failed alike), e.g. `<imp> 5 <frontend> 2 <bolt> 7`; a panel restart starts from zero; no persistence. Help legend, reference EN/ZH and golden frames follow.

- [x] Home rows: role icon first, no model/effort/route marks, no running glyph; exceptions keep their state icon
- [x] Icons setting nerd (default) / unicode / text; Nerd glyphs are the listed codepoints; statusline (TS and native) and pi footer use the same role icons per setting; text mode unchanged
- [x] Top line right side counts workers per role since panel start in any state; restart resets (test with an in-memory panel)
- [x] Golden frames for nerd, unicode and text at 42/80 in zh and en; npm test and check:fixtures pass; reference and Help updated

## Comments

- Landed in this commit (replay base 0d943adbc4826046d96745229045f981965e65f0); gate 5/5 passed.
