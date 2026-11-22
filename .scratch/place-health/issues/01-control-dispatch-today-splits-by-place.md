# 01: Control's Dispatch today splits by place

**Status:** ready-for-human
**Blocked by:** primitives/03

**What to build:** Proposal docs/neon-proposal/16-per-place-dispatch-health.md with its §6 defaults (owner, 2026-11-22): local calendar day; a role gets per-place sub-rows (launches, launch failures, hand-offs to main, quota marks) only when it used 2+ places or had a failure or quota mark; no chain-row note; no inferred "hang" count, only recorded facts. Display only, no routing change. Spec wording as approved: "today's per-role dispatch health, split by place". Update reference.md / reference.zh.md Control Usage.

- [x] Synthetic jobs on two places show two sub-rows with the right counts; a single clean place shows none
- [x] npm test and check:fixtures pass

## Comments
