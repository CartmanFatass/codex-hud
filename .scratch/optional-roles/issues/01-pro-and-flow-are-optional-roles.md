# 01: pro and flow are optional roles

**Status:** ready-for-human
**Blocked by:** none

**What to build:** Owner 2026-11-22: `pro` (web ChatGPT/Gemini/AI Studio) and `flow` (Google Flow images/video) leave the default roster and become optional roles: shipped but off until the owner turns them on (hud setup, Control, or a role file in $HUD_HOME/roles). Off roles are absent from hud_roster and refused by hud_create with a hint naming how to turn them on. Existing owner role files that define them keep working. Spec §2.1.2 sentence on pro changes (draft; the main session tells the owner).

- [x] A fresh HUD_HOME roster lists no pro or flow; turning one on lists it and hud_create works
- [x] hud_create role pro when off returns a clear hint
- [ ] npm test and check:fixtures pass

## Comments

- The fixture check passed. The full `npm test` run had three timeout cancellations; all three passed in an isolated serial rerun.
