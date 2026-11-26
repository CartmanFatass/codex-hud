# 03: Resident project strip replaces the folded project picker

**Status:** ready-for-agent
**Owner try:** no
**Live try:** open /hud panel on 项目, see MyHUD and other registered projects on one row with ● on projects that have live jobs; click another project and then +N
**Approved removals:** The folded `▾ 项目 1/7` project picker header on the Project tab (replaced by the strip; the Projects list stays behind +N).
**Blocked by:** 01
**Objective:** interaction

**What to build:** D-2026-11-26-04; template README §2 Project strip, frames strip, ov-req-62, ov-quiet-62, 40-column frames. Under the tabs on 项目 and 执行 (not 首页 or 控制): one row ` mark name ` per registered project in the panel's project order (own project first, never re-sorted), marks `?` open owner request, else `●` live work, else none (idle muted); current project on the title surface; a rule fills the rest. Too wide: idle projects leave from the end into `+N`, then names shorten to 8 cells, only then marked projects fold and `+N` carries their strongest mark; the current project always stays. Click a name to switch; click or Enter on `+N` opens today's grouped Projects list. `[ ]` still switch. It replaces the `▾ 项目 1/7` header. Data: the light per-project facts (open request, live jobs) are read on every tab at the overview's 5 s cadence (today only while Home or the Projects list shows: panel/controller.ts:357-363), off the paint path.

- [ ] 项目 and 执行 show the strip with marks, current highlighted, +N folding in the stated order; the ▾ picker header is gone
- [ ] Click switches project; +N opens the Projects list; [ ] unchanged
- [ ] Marks stay fresh on every tab within the 5 s cadence without extra reads while the panel is hidden
- [ ] Render tests at 40 and 62 columns with 7 synthetic projects, EN/ZH, no-colour; docs/reference.md updated

## Comments
