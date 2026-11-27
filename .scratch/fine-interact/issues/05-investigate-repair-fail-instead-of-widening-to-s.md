# 05: Investigate repair: fail instead of widening to scrollback; drop the default_question handoff

**Status:** done
**Live try:** On a scrolled-up pane, invoke hud.select-send.investigate and pick a working job: the excerpt is exactly the visible viewport; with the visible read made to fail, the action refuses with a message instead of sending scrollback.
**Blocked by:** none
**Objective:** interaction

**What to build:** Milestone review jd24d8862257fc92b finding 5 and its deletion note, on fine-interact/02. `src/roles/select-send.ts:538-560` (`readPaneVisibleText`) retries `pane.read` with `source: 'recent'` after an error/timeout and labels either result "visible region"; in the fork `recent` is an 80-row transcript tail, not the viewport, so a scrolled pane can send off-screen output. For Investigate, fail the capture (clear message, nothing sent) when the visible region cannot be read. Keep the selection-mode refresh behaviour of select-send/02 working (it shares this reader; if it still needs a fallback, keep that separate from Investigate). Document pane capture separately from selected text in Architecture §5 and reference.md. Simplify: remove the Investigate-specific `default_question` handoff field, its parser and fallback; initialise the editable owner line from `DEFAULT_INVESTIGATE_LINE` when `mode === 'investigate'`.

- [x] Test: a visible-read error or timeout in investigate mode refuses and sends nothing; no recent fallback is used for Investigate
- [x] Test: the owner line defaults to "Investigate this" without a default_question handoff field (field, parser and fallback removed)
- [x] Selection-mode refresh tests still pass
- [x] Architecture §5 and reference.md describe pane capture separately from selected text

## Comments

- Landed in this commit (replay base d3b0dc840f3b94efb00dfd63df567384865beb85); gate 5/5 passed.
