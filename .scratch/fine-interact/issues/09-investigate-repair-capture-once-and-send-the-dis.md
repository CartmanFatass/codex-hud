# 09: Investigate repair: capture once and send the displayed snapshot

**Status:** done
**Live try:** On a pane whose output keeps scrolling (e.g. a running log), invoke hud.select-send.investigate, pick a working job and press Enter once: the job receives exactly the viewport shown in the composer, without a 'Content changed' re-prompt.
**Blocked by:** none

**What to build:** Milestone review j65cc7a44c3a0636f finding 3 (~/.hud/jobs/j65cc7a44c3a0636f/report.md). Investigate already captures a valid `source:'visible'` snapshot and shows it, but `src/cli/select-send.ts` (~188, ~307-331) takes a baseline and rereads on every Enter via `refreshSelectionExcerpt` (`src/roles/select-send.ts` ~655-700): on a scrolling log pane the excerpt keeps being replaced and the owner can never send the displayed text; a failed confirmation-time read is treated as unchanged. Delete the Investigate baseline and submit-time refresh: capture once at open (refuse a failed capture as today), then confirm and send exactly the snapshot shown. Leave the coordinate/staleness refresh for text-selection mode unchanged. Also delete the now-dead `initialQuestion` in `src/render/select-send-composer.ts` (~53,60); the mode default suffices.

- [x] In investigate mode no baseline is captured and no reread happens on Enter; the displayed snapshot is sent once
- [x] A fixture that advances the pane viewport after the picker opens still sends the original displayed text exactly once on confirmation
- [x] Text-selection mode keeps its staleness refresh (existing select-send tests pass)
- [x] Initial visible-read failure still refuses with nothing sent; `initialQuestion` removed with no callers left

## Comments

- Landed in this commit (replay base 7bfec410e91a042b8820a8148ee13960da1826fc); gate 5/5 passed.
