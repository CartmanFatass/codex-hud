# 02: Progress page shows only what is still to try

**Status:** ready-for-agent
**Blocked by:** 01

**What to build:** Architect, 2026-11-17: "what else hasn't been tried?". On the Progress page, selecting the to-try
count filters the page to slices in state `try`, grouped by milestone (older milestones folded), with a visible way
back to the full feed.

- [ ] Filter by the ledger's exact state, never by matching prose.
- [ ] The filter shows in the crumb or header so the owner knows the page is filtered; Esc or the same key clears it.
- [ ] Zero extra reads (the ledger is already parsed).
- [ ] Main-path frame test with a synthetic ledger across two milestones.

## Comments
