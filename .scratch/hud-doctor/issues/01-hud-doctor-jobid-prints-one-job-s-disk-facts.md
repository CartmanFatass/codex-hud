# 01: hud doctor <jobId> prints one job's disk facts

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Proposal docs/neon-proposal/13-hud-doctor-job.md (owner 2026-11-22: do it). Read-only `hud doctor <jobId>`: identity, the shared reader's verdict (jobRow, never readRow which writes), raw STATUS.json (unknown fields as-is), turn/receipt validity for CLI jobs, open questions, checks bound to the current report, last progress, stop/close markers, supervisor/worker liveness, and a hints section of direct field comparisons. No writes, no network, no herdr, no panel page, no MCP tool. Missing/corrupt/oversize files show missing/unreadable. The proposal's line numbers are stale: current code wins (thin-main is split into src/mcp/{store,dispatch,mcp}/).

- [x] hud doctor <id> prints the sections for a synthetic pi job, a CLI job with a stale receipt (hint names the fields), and a headless job
- [x] Invalid id and missing job dir give a clear error and nonzero exit; corrupt JSON shows unreadable without crashing
- [x] Test proves no file under the job dir changes (mtime/content) after a run
- [x] hud help lists doctor; docs/reference.md + reference.zh.md describe it

## Comments

- Landed c055516ed08d438095cd5acfe4ac53ee7b5fabac; gate 5/5 passed.
