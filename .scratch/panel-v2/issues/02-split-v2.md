# 02: Split layout V2: working cues, adjustable split ratio, focus auto-compact and scrollbar

**Status:** ready-for-agent
**Blocked by:** 01

**What to build:** `docs/spec.md` §2.2 & `.scratch/panel-v2/spec.md` §2. Eliminate blind spots in Split Home's non-selected rows, make the list/preview split adjustable and focus-responsive, and draw a zero-width scrollbar on scrollable previews.

- [ ] Non-selected working cues in `src/render/split-home.ts`: for active `working` lanes not currently under the cursor, surface compact keyword spans (from `modelSentence`) or `latestProgress` / factual verb in the row's middle slot when width allows (or a compact single sub-line when height allows), so parallel worker progress is visible at a glance.
- [ ] Adjustable split ratio & focus auto-compact in `src/render/split-frame.ts` and `src/render/split-input.ts`: add `splitRatio` to `MonitorState` (persisted across panel self-reload), adjusted with `=` / `+` (grow list) and `-` (grow preview) or dragging the `rule` divider row with the mouse. When `state.splitFocus === 'preview'`, auto-compact the top list pane to at most 3 context rows around `scene.cursor` so the preview gets maximum vertical space; `Esc` restores the list height.
- [ ] Zero-width preview scrollbar in `src/render/split-frame.ts`: when `scene.preview.length > previewRoom`, paint a subtle scrollbar track/thumb (`┃` for thumb, `│` or dim dot for track; ascii `#` / `|`) on the rightmost column (`width - 1`) of the preview rows without exceeding exact `width` cells.
- [ ] Add EN/ZH strings and unit/frame tests in `tests/unit/split-layout.test.mjs`.

## Comments
