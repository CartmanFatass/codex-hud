# 04: Band above the prompt and live toasts from the shared job rows

**Status:** ready-for-agent
**Owner try:** yes
**Blocked by:** 03

**What to build:** Design: oracle report j173e9f379178e359, 'Slice 2: Band + Toast'. `hud watch --mod` also emits `band` (running workers with sonic counts, open questions, unobserved non-superseded failures, to-try items from STATE/tickets/tries without git) only when it changes, and `toast` records on live report/question/failure transitions. The mod keeps the band in `$.state` and draws it on AbovePrompt with no I/O during render, 0 rows when nothing to show or a survey is up, at most 3 rows sized to bodyColumns; toasts coalesce per flush, never on catch-up.

- [ ] Band shows nothing when idle/clean or `hasSurvey`; otherwise running/questions/failures/to-try within bodyColumns and ≤3 rows, read from `$.state` only
- [ ] Band states agree with jobRow, failure observation, supersession and try marks in unit tests; `hud_read` of a job clears it from the band
- [ ] Toasts fire on live report/question/failure transitions, one per flush, none on initial catch-up
- [ ] `claude plugin validate` / `claude plugin test` pass on terminal, desktop, vscode and mobile surfaces

## Comments
