# 02: A place catalog and a safe write for the panel

**What to build:** the data the control plane page needs to switch places: a catalog per harness (agents, models,
thinking levels; shipped defaults, `$HUD_HOME/harnesses.json` additions) and functions that write a role's `run`
list to `$HUD_HOME/roles/<role>.json` (atomic, keeps unknown fields, refuses a symlink) and clear an exhausted mark.
No rendering.

**Who:** agy-imp (gemini-4-hydrogen-high) · **Size:** about 150 source lines

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Catalog lists what `hud_create` accepts for each harness
- [ ] Writing a run list then `hud_roster` shows it; unknown fields kept; symlink refused; shipped files never written
- [ ] Clearing a mark makes the place available again
