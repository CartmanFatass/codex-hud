# 03: Zoomed picker

**Status:** done (accepted by the owner; see STATE ledger)
**Blocked by:** 02

**What to build:** Opening the picker zooms the panel's own herdr pane (`herdr pane zoom --on` on the panel pane) and
closing restores it only if the picker zoomed it. At the zoomed size (about 120×36) draw the grouped list with the pi
columns and HUD facts on the left, groups open, and the selected model's read-only detail on the right (full ID, all
columns, state, whether current, which roles and presets use it, list age, what Enter does). Below about 100 columns,
outside herdr, or when zoom is refused, the narrow picker is used. Sample frames 3a–3e. See spec.md settled 1, 3.

- [ ] zoom on open, restore on close only when the picker zoomed; an already zoomed pane stays zoomed
- [ ] fallback to the narrow picker below ~100 columns, outside herdr, or on a refused zoom
- [ ] detail shows used-by roles/presets and the provider-off case (frame 3e)
- [ ] EN/ZH frames at 120×36 match the sample
