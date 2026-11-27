# 02: Cold archive repair: close the remaining deletion paths and snapshot Pi sessions before they move

**Status:** done
**Live try:** none
**Blocked by:** 01

**What to build:** Repair from milestone review j23ab25bbcd1130a6 (findings 1 and 3) of cold-archive/01 (spec §2.3, D-2026-11-26-11: every prune path is move-then-delete; a failed archive write keeps the source). Three paths still drop the last live copy without a cold write. (a) src/workflows/events.ts:63-68 unlinks an orphan `flows/<id>.json.gate-N[-rerun].log` from the notice scan as soon as its land receipt is missing. Remove that unlink from the notice scan (no archive I/O in the watcher/notice path) and let the archive-aware retention sweep in src/runtime/work-retention.ts move orphan gate logs into the owning job's text member (or a `<flow>.text` member when no job owns it) before deleting them, keeping the file when the write fails. (b) src/mcp/ticket-edit-queue.ts:195-198 evicts settled `flows/te*.json` receipts (plus `.noticed`/`.observed` sidecars) via pruneTicketEdit (src/mcp/ticket-edit-state.ts:39-42) at the MAX_RECEIPTS admission limit. Archive the receipt as its own `<te-id>.text` member before removing it; if the cold write fails, keep that receipt (admission must still proceed or fail with a clear error, never silently drop data). (c) src/runtime/watch-runtime.ts:440-458 and :1179-1184 rename job-local `sessions/*.jsonl` and `.dispatch/*/sessions/*.jsonl` into Pi's native store before archiveJobCold collects the tree. Keep the native-store preservation and its seven-day guard, but put the job-local session bytes into the job's raw member first (before the move), so `hud archive extract` restores them and a failed cold write leaves them at the source. Also delete the duplication the review named: merge `archiveJobFlowsCold`/`archiveFlowCold` into one lookup+merge and `readPinnedRegular`/`readRegularNoFollow` into one fd-based read. No new dependency; files 0600, dirs 0700; watcher refresh still does zero cold-archive I/O.

- [x] An orphan gate log whose land receipt is gone is no longer unlinked by the notice scan; the retention sweep archives it (job text member or own flow member) and only then deletes it; with the archive write failing the log stays and is archived on the next sweep (test).
- [x] Evicting a settled te* ticket-edit receipt at the receipt limit writes it to a cold text member first; with the cold write failing the receipt and its sidecars remain (test).
- [x] A Pi job with job-local sessions/*.jsonl and .dispatch/*/sessions/*.jsonl, when expired, has those files in its raw member (byte-identical through hud archive extract) and still in Pi's native store; with the cold write failing they remain in the job dir (test using a Pi-style job, not only a CLI job).
- [x] archiveJobFlowsCold/archiveFlowCold and readPinnedRegular/readRegularNoFollow each collapse to one implementation; existing cold-archive and retention tests stay green.
- [x] Watcher refresh test still asserts zero cold-directory operations.

## Comments

- Landed in this commit (replay base ebaa2dacb0eb2be2ac31dbce58ecc87c1de1de18); gate 5/5 passed.
