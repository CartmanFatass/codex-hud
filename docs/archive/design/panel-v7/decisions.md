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

Polish after the first acceptance run (PANEL-POLISH, 2026-11-11):
9. Enter on a Work job card opens its `report.md`, else `brief.md`, in `$EDITOR` beside the panel (Home's Enter still
   goes to Work; a card with an open question still opens its `qa` files).
10. The footer shows whole key hints only; at a narrow width hints are dropped from the right. Every painted row is
    erased before it is written, so a full-width row keeps its last cell (`⏎ open`, `done 2m`).
11. A job lane's line map has only the stops it has: build and done, plus review and accept once a job in it has a
    review round. The Work stop names follow the map.
12. A worker's herdr tab is `<role> <package or brief title>` cut to about 28 columns, with a four-character job
    suffix only when another open job's tab has the same label.
