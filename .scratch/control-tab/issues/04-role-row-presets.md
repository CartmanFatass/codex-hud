# 04: Presets on the role row

**Status:** done (accepted by the owner; see STATE ledger)
**Blocked by:** 01

**What to build:** On a role row `c`/`C` switch to the next/previous preset at once; `p` opens one filterable list of presets plus Custom (file chain); `N` new from the current chain, `R` rename, `D` delete with preview (sample frames 4a–4d). Persistence per design.md §1: `active_preset` selector (null = Custom), `hidden_presets` to suppress inherited names, only the changed preset written to the owner layer, project-pinned roles read-only with a lock row. Registry returns the effective run/preset after the merge; `hud_create(preset)` never mutates files. `I` (new from empty) and chain editing come in 05.

- [ ] two identical saved chains selectable by name
- [ ] rename/delete an inherited preset survives relaunch; deleting the selected one falls back to the file chain with a preview
- [ ] legacy role files (no selector) behave exactly as today
- [ ] project-pinned role shows source + lock, no edit keys
- [ ] 40-col frames match the sample
