# 01: A deleted job leaves one line of facts

**Status:** ready-for-human
**Blocked by:** async-watch/03 (it rewrites the watcher's delete branch)

**What to build:** Proposal docs/neon-proposal/14-job-archive-ledger.md with its §6 defaults (owner, 2026-11-22): before the watcher deletes a closed job directory it appends one JSON line of the job's facts (no report text) to `$HUD_HOME/archive/YYYY-MM.jsonl`; nothing reads it yet; no retention for the archive yet; retention of jobs unchanged. Add the spec sentence the owner approved: "Before deleting a closed job directory, the watcher appends one line of the job's facts (no report text) to `$HUD_HOME/archive/YYYY-MM.jsonl`; nothing reads it yet."

- [x] A retention test shows the line written before the delete, with no report text; a failed append never blocks the delete
- [x] npm test and check:fixtures pass

## Comments

- 2026-11-22 landed f796f2eb (imp on astra, jc7ea46fc67cf7a2f): src/roles/job-archive.ts; fact fields v, job, archived_at, project, role, harness, model, thinking, preset, used_place, attempts, dispatch codes, state, exit_reason, timestamps, checks, repair_of, parent_job, package, outcome; .archived marker prevents duplicates; failure never blocks delete. Decision renumbered D-2026-11-22-16 (22.14 was taken). Main: 1008/1008, unit, check:fixtures.
