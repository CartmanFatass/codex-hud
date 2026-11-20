# 02: Harness switches end to end

**Status:** ready-for-agent
**Blocked by:** 01

**What to build:** The Harnesses view on Control (`h`; sample frames 3a–3d, 7a–7c): Runner, CLI agents, Browser tools, Pi providers; Space/Enter toggles a switch, Del removes (= off), folded "Off (N)", `i` add-back list. Switches persist as `disabled` IDs (`pi`, `pi:<provider>`, `cli:<agent>`, `bro:<tool>`) in `$HUD_HOME/harnesses.json` (absent = on). One shared chain evaluation (states active/standby/off/exhausted/missing, provider attribution per design.md §2) used by the panel, `hud_roster` and `hud_create` (including `preset`, `on` and `model` overrides); no place → `no_available_place` before any job is created. Role files never change. See design.md §1 first two bullets, §2, §3 Harnesses bullet.

- [ ] `cli:grok` and `pi:xai` off independently; runner off keeps provider switches
- [ ] off + quota then restore; explicit `on` / `model` override on an off target refused, not rerouted
- [ ] no cache / no discovery still dispatches (absent = on); unknown provider shown, not blocked
- [ ] panel, roster and create agree on the sample scenario (`imp [daily] → agy` with xai off)
- [ ] role files byte-identical after toggles
