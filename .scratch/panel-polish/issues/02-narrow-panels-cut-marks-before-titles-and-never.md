# 02: Narrow panels cut marks before titles and never wrap Control rows

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Acceptance pass 2026-11-22 (frames 15, 17, 20): at 42 columns Home cut a title to 9 cells (`◉ auto-route/08 A headle… ⚒ ▆∅ ⚡2 0m`) although docs promise marks narrow before the title drops under 16 cells; Control → Usage → Dispatch today at 42 columns wraps `imp 31 jobs · … · avg` leaving `9m` alone on the next row, and cuts place names mid-word (`cli/agy (gemini-4…rogen-high)`). Fix both against the §8 width rules.

- [ ] At 42 and 48 columns a Home job row keeps ≥16 title cells while marks narrow (route marks and effort first) as docs/reference.md describes
- [ ] Dispatch today rows never wrap at 42 columns; place names cut at the end with …
- [ ] Golden frames for 42 columns added for both; npm test and check:fixtures pass

## Comments
