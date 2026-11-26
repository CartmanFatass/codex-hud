# 07: Settings save writes only the keys changed on the page

**Status:** done
**Owner try:** no
**Live try:** none
**Blocked by:** none
**Objective:** unattended

**What to build:** Seen 2026-11-26: main set roleCaps.imp 6 and impEvenPool [neon, sol] in ~/.hud/hud-settings.json at 07:14; at 07:17 the panel's Settings page saved (the owner changed pane strips / tree width) and wrote back its whole draft loaded before 07:14 (src/panel/settings-flow.ts ~97 `saveSettings(draftPage.draft)`), silently restoring imp cap 3 and the old pool. saveSettings (src/settings.ts ~225) already merges a patch onto the current file, but the panel passes the full draft. Fix: the Settings page keeps the snapshot it opened with and saves only the keys whose values differ from that snapshot (deep compare for arrays/objects such as roleCaps: patch only the changed entries), so changes made meanwhile by other writers (CLI, main, another panel) survive; no change when nothing differs. Check other full-object writers of hud-settings.json (bar settings, statusline settings, hud import) for the same pattern and fix them the same way.

- [x] A Settings save after another writer changed an unrelated key keeps that key (test)
- [x] Changing one roleCaps entry in Settings keeps other roleCaps entries written meanwhile (test)
- [x] Other full-object writers of hud-settings.json patch only their keys (tests)

## Comments

- Landed in this commit (replay base 55389a9cd9a2c0d5d7bb9f6ae4f8a91d6bd811a1); gate 5/5 passed.
