# 04: Leases for shared resources

**Status:** done
**Blocked by:** none

**What to build:** Starts after WORKER-MCP (worker-mode tool list). hud_lease({name, release?}) in both modes: an exclusive file under $HUD_HOME/leases/ keyed by project root and name; the call waits a bounded time inside the caller's own turn and returns granted or held_by; a lease whose holder job is terminal or whose process is gone is reclaimed by the next caller. No resident process. Control shows a lease row (name, holder, waiting, age). Proposal B1.

- [x] Two workers asking for the same lease: one is granted, the other gets held_by and is granted after release
- [x] A lease held by a closed or dead holder is reclaimed by the next caller
- [x] The main session can hold and release a lease
- [x] Control shows active leases
- [x] Main-path tests pass

## Comments
