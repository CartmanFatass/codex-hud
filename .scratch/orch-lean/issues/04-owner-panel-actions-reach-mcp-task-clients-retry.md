# 04: Owner panel actions reach MCP-task clients; retry and land intents

**Status:** claimed
**Blocked by:** 03

**What to build:** Rank 5: tries.jsonl marks and panel actions are delivered to MCP-task clients too (not only hud watch); r on a failed job and m on a to-try slice write an intent that reaches the main session, which decides (the panel never briefs or chains). Spec §2.1.4 and §2.2.6 sentences as told to the owner.

- [ ] Pressing y on a to-try slice reaches a Claude Code task session without hud watch
- [ ] r and m write an intent the session receives; nothing is dispatched by the panel
- [ ] npm test and check:fixtures pass

## Comments
