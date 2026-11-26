# 15: Settings repair: the first save with no settings file keeps the effective opening values

**Status:** done
**Live try:** none
**Blocked by:** none

**What to build:** Repair of chores/07 after milestone review je1cb09e15e4334b8 (finding 5; read its report for file:line). With no hud-settings.json, runtimeSettings (src/settings-runtime.ts ~5-19) opens with effective values (HUD_TREE_WIDTH, display theme/icons/bar). The Settings page then sends only the changed key, but saveSettings (src/settings.ts ~240-252) merges it onto defaultSettings() and persists and applies the result, so e.g. tree width 80 jumps to 56 and stays there. When the file is still absent at save time, use the effective opening values as the base; if another writer created the file meanwhile, merge against that file as now. Check the other settings writers fixed in chores/07 for the same first-save gap.

- [x] Test: no settings file, HUD_TREE_WIDTH=80, change only a pane-strip setting and save: saved and applied treeWidth stays 80 (and other effective display values are kept)
- [x] Test: file created by another writer between open and save: the save merges onto that file
- [x] Existing stale-save tests pass

## Comments

- Landed in this commit (replay base 3bba88d739d0d32f81e527ffc61f4289ab8149ad); gate 5/5 passed.
