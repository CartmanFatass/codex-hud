# 23: A land that changes native/ publishes its binary on main

**Status:** ready-for-agent
**Blocked by:** none
**Owner try:** no

**What to build:** native-statusline/02 landed as 6ad0bf62, but afterwards the main checkout had no `dist/native/hud-statusline`; a manual `npm run build` then compiled it in 8.5 s. So the land's `after: npm run build` (or the tested-build reuse from perf-ts/06 and the artifact hand-off in `src/mcp/land-runner.ts`) skipped the native step, and the owner's Claude statusline kept running the TS path. Make a land whose commits change `native/` (or whose tested integration checkout built the native artifact) leave a hash-checked `dist/native/` on the main checkout, the same way `dist/` is published. When cargo is missing, the after step still succeeds and says once in the land result that the TS statusline stays in use.

- [ ] A land fixture that changes `native/` leaves `dist/native/hud-statusline` and `source.sha256` on main
- [ ] A land without native changes keeps the existing artifact; no cargo on PATH gives one note, not a failure
- [ ] Targeted land/build tests pass

## Comments
