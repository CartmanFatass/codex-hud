# 02: Return the next actionable fact on a single-job read

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** `hud_read({job})` returns a small state row on quiet work, and enough content to act on a question, block, failure or report. Make launch metadata and verbose progress explicitly retrievable without requiring an extra call for ordinary work.

- [ ] Ordinary quiet read targets 60–150 B (actual UTF-8 `content[0].text`). Omit empty/default diagnostics; provide an explicit detail path for former metadata including model provenance, options, progress and git diagnostics. Preserve necessary worktree handoff information.
- [ ] Keep qN and its question, actionable errors, unread report body/truncation and `report_unchanged`; requesting `full:true` still means reread report, not diagnostics. A result that delivers a report keeps exactly the same read/close semantics; do not consume a report without actually returning it, or confuse observation with acceptance.
- [ ] Do not change list compact/recent, `wait_ms`, watcher behavior, `changes` cursor, receipts or panel data. Migrate test/diagnostic consumers to explicit detail; compare quiet/actionable payloads and test schema parity, read-once and idle-grace behavior.

## Comments

Scheduled after 01 to avoid overlapping edits; no functional dependency.
