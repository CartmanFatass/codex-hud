# UX-PASS

Owner 2026-11-20: UI/UX optimization before M5; the model selection experience was the named pain. Two oracle
designs, both settled by the owner with every recommendation ("可以 都做"):

- `docs/design/ux-pass/model-selection.md` (M = model selection + pi footer quota): S1–S5.
- `docs/design/ux-pass/overall.md` (O = overall): slices 1–6.

Spec: `docs/spec.md` §2 Control tab picker sentence, mouse sentence and EXP proxy sentence (updated 2026-11-20).

## Settled (owner, 2026-11-20)
Model selection:
1. No automatic pane zoom: the picker opens in the panel's own pane; two columns from about 100 columns wide.
2. One click on a picker row sets the model.
3. Footer quota percent means used, as on Claude's statusline (bar fills and reddens the same way).
4. Filtered results are one flat ranked list; the browse view stays grouped.
5. S5 (one picker for CLI and AI Studio places) is built too.

Overall:
1. Footers drop movement and global keys; Home's count shortens under 56 columns.
2. Split Progress rows show the slice's text, cut, in place of the state word.
3. Chinese minutes: `分`, not `分钟`.
4. The normal state is silent: no `models on` in the top row, no `installed`/`listed` on enabled harness rows.

## Shared rules
- Each ticket builds its design section exactly; the section's before → after rows are the template and its
  Acceptance list is the completion criteria.
- 40-column frames exact width, EN and ZH, Split and Classic. Reference EN/ZH and Help updated where they quote changed
  rows or keys.
- No new timers, polling, reads, subprocesses or settings; render/input changes only unless the section says otherwise.
- Snapshots updated only for intended changes; synthetic data; temp HOME/HUD_HOME via tmp/env.sh.
