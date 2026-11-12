# 05: Every review finding is fixed until both reviewers accept

**What to build:** the blocking findings of 04 are fixed in one slice; if anything changed, the reviewers check the
fixes again until both verdicts are accept.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] Every blocking finding fixed or explicitly accepted by the owner
- [ ] Both reviewers' last verdict is accept; full test suite green

**Owner decisions (2026-11-12):** Sol finding 3 (delete the unreachable retired ledger writer/reconciler, intents,
supervision and pi-owned runtime, plus code only they use) is approved. The imp lists the files and the user-visible
features they back (expected: none) before deleting, and keeps anything a shipping entry point still reaches.
