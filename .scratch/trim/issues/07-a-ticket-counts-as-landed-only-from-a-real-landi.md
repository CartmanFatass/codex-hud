# 07: A ticket counts as landed only from a real landing, and owner_try no never waits for Accept all

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** 2026-11-23 the owner's Accept all accepted TEST-FLAKES-08 although that ticket is still being worked on (job j1df094c3b4c948ac) and is `Owner try: no`. Cause in src/collectors/project-board.ts landedTickets (~l.419-449): every commit in the last 64 whose subject names a ticket id adds it to `landed`, so the main session's ticket-file commit `test-flakes/08: sweep fixed short waits` (only .scratch/ touched) made it `try` in ticket-rollup.ts derive (~l.58). Fix: (1) subject ids count as landing evidence only when the commit touches a path outside .scratch/ (the same rule the file-path branch already uses), or when the ticket file carries the land flow's recorded landing; (2) a landed ticket with `Owner try: no` becomes done (shown as landed), never `try`, so Accept all and the band count only owner-try tickets. Keep old try records readable.

- [ ] A .scratch-only commit naming a ticket id does not mark it landed or try
- [ ] A landed owner_try:no ticket shows as done and is not counted by Accept all or the band
- [ ] Landed owner_try:yes tickets still show as try; existing tests and frames updated where they relied on the old rule

## Comments
