# 04: Owner panel actions reach MCP-task clients; retry and land intents

**Status:** done
**Blocked by:** 03

**What to build:** Rank 5: tries.jsonl marks and panel actions are delivered to MCP-task clients too (not only hud watch); r on a failed job and m on a to-try slice write an intent that reaches the main session, which decides (the panel never briefs or chains). Spec §2.1.4 and §2.2.6 sentences as told to the owner.

- [x] Pressing y on a to-try slice reaches a Claude Code task session without hud watch
- [x] r and m write an intent the session receives; nothing is dispatched by the panel
- [x] npm test and check:fixtures pass

## Comments

- Landed e59e931992d651ec00e34a5b3d2f1e8b9a678e2d; gate 6/6 passed.
