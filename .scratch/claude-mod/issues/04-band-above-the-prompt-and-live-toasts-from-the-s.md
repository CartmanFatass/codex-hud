# 04: Band above the prompt and live toasts from the shared job rows

**Status:** done
**Owner try:** yes
**Blocked by:** 03

**What to build:** Design base: oracle report j173e9f379178e359, 'Slice 2: Band + Toast', narrowed by spec §4 (22.28, attention first; 2026-11-23). The band is for the owner, not the main session: it shows only what needs the owner now, otherwise nothing. `hud watch --mod` also emits a `band` record (only when it changes) with: STATE `Waiting for the owner` items for this project (first item text + count), and the count of slices waiting for the owner's Accept all (same count as the Project Inbox hub). No running-worker counts (the statusline has them), no job failures or worker questions (the main session handles those). The mod keeps the band in `$.state` and draws it on AbovePrompt with no I/O during render: 0 rows when nothing needs the owner or a survey is up, at most 2 rows sized to bodyColumns. One toast only when a new owner-needed item appears (never on catch-up, one per flush).

- [x] Band is empty when nothing needs the owner or `hasSurvey`; otherwise ≤2 rows within bodyColumns from `$.state` only, EN/ZH per panel language
- [x] Band items agree with STATE Waiting (incl. `(waits on …)` drop rule) and the Inbox Accept all count in unit tests
- [x] A toast fires only when a new owner-needed item appears, once per flush, none on initial catch-up
- [x] `claude plugin validate` / `claude plugin test` pass on terminal, desktop, vscode and mobile surfaces

## Comments

- Landed in this commit (replay base 11adc84deeb3b7233daac7e15314341e21b36d0d); gate 5/5 passed.
