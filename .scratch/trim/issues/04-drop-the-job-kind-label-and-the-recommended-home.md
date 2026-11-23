# 04: Drop the job kind label and the Recommended Home ranking

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Owner approved (D-2026-11-22-27): remove the Decision API `kind` label (Inspector's two-word kind row) and Home's Recommended mode (model ranking/folding of cards and its progress line); Home keeps the deterministic Default order. Keep outcome labels, quiet repeated failures, question category, review severity and routing decisions. A saved Recommended setting loads as Default. Update spec §2.2.3 (Default or Recommended line) and §2.2.8 (labels list), reference*.md. Report the decision-call reduction expected from the call log.

- [ ] No kind or home-ranking Decision API calls are made
- [ ] Home order is the Default order; setting removed; old value loads as default
- [ ] Inspector has no kind row
- [ ] Spec, reference updated; tests pass

## Comments
