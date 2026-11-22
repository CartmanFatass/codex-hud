# 02: Draft the restructured spec and decisions log, audited both ways

**Status:** done
**Blocked by:** none

**What to build:** Proposal 17 Slice 3: clause map of the current docs/spec.md (every clause S-NNN mapped KEEP / LOG / FLAG, kept in tmp/tasks, not committed), a structured docs/spec.md (current declarative contract only, numbered subsections, no meaning added or dropped) and docs/decisions-log.md (the dated owner decisions and history moved out, each spec rule pointing to its entry). FLAG errata F-1..F-6 listed for the owner, applied only as the owner ticks them (default Q1 A: align to the decisions already in force). Q2 A: decisions-log not in the release archive. Then a fresh oracle at its default audits forward (nothing dropped or weakened) and backward (nothing added). Committed on a branch only; nothing lands before the owner approves.

- [x] Clause map has no unmapped clause; oracle audit finds no dropped, weakened or added rule (or lists them)
- [x] Owner gets the new spec, the log, the errata table and the audit to approve

## Comments

- 2026-11-22: draft a15deee7 approved by the owner after two oracle audits (jobs of 2026-11-22); lands in 03.
