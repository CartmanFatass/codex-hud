# 02: Async herdr calls in the CLI supervisor

**Status:** ready-for-human
**Blocked by:** 01

**What to build:** 06 S2: hud-cli.mjs and quiet-decision use async herdr calls with an external abort signal, so a stop or closed tab aborts in-flight work at once; /quit cancelled by tab_closed records closed, not failed.

- [x] stop-requested becomes stopped within 500 ms with zero Decision API calls
- [x] A hung herdr call does not block the supervisor loop

## Comments

- 2026-11-22 landed f644b00a (imp j6019dcfeb9a33bb0): hud-cli herdr calls async + cancellable; quiet-decision takes the abort signal; hud-watch defers the tab-close verdict while a live supervisor holds STATUS.json.quit-<pid>. stop → stopped in 104–110 ms with 0 Decision calls; hung read + tab close settles in 4–6 ms. Main: 995/995, unit, check:fixtures.
