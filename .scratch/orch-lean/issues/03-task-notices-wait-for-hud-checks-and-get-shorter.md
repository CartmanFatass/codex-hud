# 03: Task notices wait for HUD checks and get shorter

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Rank 7: the MCP task completion for a job with checks is sent after its HUD checks finish; notices arriving within 3 s coalesce; the notice text drops to state, report path and one-line summary (~140 tokens). Spec §5 MCP-ORCH sentence as told to the owner.

- [ ] A job with checks wakes the session once, after the checks
- [ ] npm test and check:fixtures pass

## Comments
