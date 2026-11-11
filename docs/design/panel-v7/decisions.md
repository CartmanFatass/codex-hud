# Panel v7: owner decisions (2026-11-11)

The owner picked the independent PANEL-FREE design ("stems and tracks", `notes.md`, `final.html`,
`screens.txt`) with small adjustments. Where earlier panel decisions (tmp PANEL-POLISH, VIS4, VIS5, VIS6) conflict
with this page, this page wins.

Adjustments to the drawn design:
1. Harness is shown only when it is not pi (`claude`, `codex`, `jev`); `native` stays.
2. Zhipu mark: plain `ℤ` (U+2124) in the default text colour (as drawn).
3. No blank line inside a decision (as drawn).
4. The selected row is the lighter band, as drawn; no cursor glyph, so no double cursor.
5. "report ready" (to accept) = settled with a report that `hud_read` has not read yet (`read_at` in job.json).
6. Answering from the panel (`a b answer` on the ask slab) is not built in this round; the slab shows `⏎ read`.
7. Model text marks (`[[k:…]]` key phrase, `[[i:…]]` identifier) come with AI-THIN. Until then the fallback:
   identifiers (backticks, paths, `--flags`) lavender, nothing bold inside sentences.
8. Width: `hud panel --width N`, default 56; the design holds at 56.
