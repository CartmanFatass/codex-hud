# 02: Async herdr calls in the CLI supervisor

**Status:** claimed
**Blocked by:** 01

**What to build:** 06 S2: hud-cli.mjs and quiet-decision use async herdr calls with an external abort signal, so a stop or closed tab aborts in-flight work at once; /quit cancelled by tab_closed records closed, not failed.

- [ ] stop-requested becomes stopped within 500 ms with zero Decision API calls
- [ ] A hung herdr call does not block the supervisor loop

## Comments
