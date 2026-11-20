# Model picker upgrade

Sample: `docs/design/model-picker/index.html` (ca82c3fa), settled by the owner 2026-11-20 with the main session's
recommendations on its "To settle" list. Builds on CONTROL-TAB-03 (one list grouped by provider, typed filter over the
full ID, discovery on opening Control or refresh only). Spec: `docs/spec.md` §2 "Control tab" (picker sentence).
Terminal only: no web console (owner, 2026-11-20).

## Settled
1. The picker zooms the panel's own herdr pane when it opens and restores the zoom on close only if the picker set it.
   Below about 100 columns, outside herdr, or when zoom is refused, the narrow 40-column picker is used.
2. Pinned rows (empty query only): the current model and the models this role's presets use, tagged with the preset.
   No Recent section (no new record file). Pinned models also stay in their group.
3. Narrow picker: provider groups start folded with counts; typing opens matching groups. Zoomed picker: groups start
   open. Headers stay off the cursor path; a click folds or unfolds one.
4. Providers that are off: one muted, non-selectable line names them; their models are not offered; a current model
   whose provider is off stays pinned with `⊘`.
5. Model facts: the discovery cache keeps `pi --list-models`'s context, max-out, thinking and images per model (same
   single call). Rows carry the HUD state (`✗` exhausted with time to reset, `⊘` off, `?` unknown provider).
6. No price column (no local source for listed models).
7. `^R` refreshes inside the picker; the first Esc clears a typed filter, the next Esc closes without setting.
8. Narrow picker: the bottom strip (whole ID wrapped, ctx/out/think/img, state) is always shown.
9. Still one list and one cursor; no provider rail.

## Shared rules
- 40-column frames exact width, EN and ZH, Split and Classic; frames follow the sample.
- No new timers or polling; no subprocess per key or tick; discovery only on opening Control or refresh.
- Mouse: a click selects a row, Enter or a second click on the same row sets, the wheel scrolls, a click on a provider
  header folds it.
- Synthetic data in tests; temp HOME/HUD_HOME via tmp/env.sh.
