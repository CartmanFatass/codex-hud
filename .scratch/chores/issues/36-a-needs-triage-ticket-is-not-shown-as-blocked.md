# 36: A needs-triage ticket is not shown as blocked

**Status:** ready-for-agent
**Owner try:** no
**Live try:** Open nav-redesign on the Feature page and confirm 15 shows the triage word
**Blocked by:** none

**What to build:** 2026-11-27 live try: the Feature page showed nav-redesign/15 (Status: needs-triage, Blocked by: none) as `受阻` / blocked. needs-triage must render as its own state word (e.g. `待分拣` / `triage`) and must not count toward blocked counts on Feature, Objective or Project rows.

- [ ] Test: a needs-triage ticket with no blockers renders the triage state word in EN and ZH and is not counted as blocked
- [ ] TZ=UTC node tests/run-mjs.mjs 8 passes

## Comments
