# 01: A deleted job leaves one line of facts

**Status:** ready-for-agent
**Blocked by:** async-watch/03 (it rewrites the watcher's delete branch)

**What to build:** Proposal docs/neon-proposal/14-job-archive-ledger.md with its §6 defaults (owner, 2026-11-22): before the watcher deletes a closed job directory it appends one JSON line of the job's facts (no report text) to `$HUD_HOME/archive/YYYY-MM.jsonl`; nothing reads it yet; no retention for the archive yet; retention of jobs unchanged. Add the spec sentence the owner approved: "Before deleting a closed job directory, the watcher appends one line of the job's facts (no report text) to `$HUD_HOME/archive/YYYY-MM.jsonl`; nothing reads it yet."

- [ ] A retention test shows the line written before the delete, with no report text; a failed append never blocks the delete
- [ ] npm test and check:fixtures pass

## Comments
