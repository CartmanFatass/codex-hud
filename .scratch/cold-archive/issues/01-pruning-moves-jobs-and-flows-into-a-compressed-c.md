# 01: Pruning moves jobs and flows into a compressed cold archive: text forever, raw transcripts capped

**Status:** done
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Owner 2026-11-26 (D-2026-11-26-11, docs/spec.md §2.3): HUD data is valuable; pruning must stop destroying it. Today src/runtime/work-retention.ts deletes job dirs after JOB_RETENTION_MS (1 day), prunes raw stdout/stderr after the resume window, and unlinks terminal flows/q*.json and f*.json (plus gate logs) after a day; only prose-free monthly fact rows survive in archive/YYYY-MM.jsonl. Change every prune path to move-then-delete: before removing a job dir, flow record or gate log, write it into `$HUD_HOME/archive/cold/YYYY-MM/` as two compressed members per job (Node 24 built-in zstd, no new dependency): `<job>.text.*` (job.json, STATUS.json, usage.json, brief.md, report.md, report-meta, qa/*, worker-tree, its f*/q* flow records and gate logs) and `<job>.raw.*` (stdout/stderr, sonic-session.jsonl and other session copies). Flow records not owned by one job (q* runs) get their own `<flow>.text.*`. Raw logs pruned early after the resume window go into the raw member, not the bin. Writes are atomic and idempotent (a re-run sweep never duplicates or truncates; a failed archive write keeps the source for the next sweep, as §2.3 already says). Cap: setting `retention.coldRawCapGB` (default 20): when the raw members exceed it, delete the oldest raw members first; text members are never deleted. Files 0600, dirs 0700. hud_read on a pruned job reads its report (digest and full) from the cold archive; `hud archive` (or an existing CLI verb) lists and extracts a job. Live retention, panel reads and watcher cost stay as today (no scan of the cold archive on refresh).

- [x] A pruned clean job leaves a text member with brief, report, records, its land flow and gate log, and a raw member with its logs; the live dir is gone; round-trip extraction is byte-identical.
- [x] Early raw-log pruning after the resume window moves the logs into the raw member instead of deleting them.
- [x] Terminal q*.json runs are archived as their own text member before unlink (compatible with imp-daily-facts/02's events line, which stays).
- [x] With the raw cap set low in a test, the oldest raw members are deleted first and no text member is ever deleted.
- [x] hud_read job=<pruned job> returns the report digest and full pages from the cold archive.
- [x] Archive write failure keeps the source and retries next sweep; repeated sweeps never duplicate members.
- [x] Watcher refresh cost unchanged (measured); docs/reference.md and ARCHITECTURE describe layout, cap and reader.

## Comments

- Landed in this commit (replay base 9cc04e5447ff6f6e0f094b294f622640be7c45d7); gate 5/5 passed.
