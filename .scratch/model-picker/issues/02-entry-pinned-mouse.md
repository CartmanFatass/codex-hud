# 02: Visible entry, pinned rows, folds and mouse

**Status:** ready-for-agent
**Blocked by:** 01, control-tab/04

**What to build:** Every place row in the Control role chain shows a clickable model field (`[model ▾]`, `[default ▾]`
when unset) and the footer hint starts with `m model`. With an empty query the picker pins the current model and the
models this role's presets use (tagged with the preset); pinned models also stay in their group. Narrow picker groups
start folded with counts and typing opens matching groups. Mouse per spec.md shared rules (click selects, Enter or a
second click sets, wheel scrolls, header click folds). Sample frames 1a–1b, 2a–2c. See spec.md settled 2, 3.

- [ ] clicking the model field opens the picker on that place; `m` still does
- [ ] pinned rows show current and this role's preset models only with an empty query
- [ ] folded groups open when typing matches them; a header click folds and unfolds
- [ ] mouse select / set / wheel work in Split and Classic
- [ ] 40-col EN/ZH frames match the sample
