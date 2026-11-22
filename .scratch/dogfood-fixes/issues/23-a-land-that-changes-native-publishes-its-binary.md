# 23: A land that changes native/ publishes its binary on main

**Status:** done
**Blocked by:** none
**Owner try:** no

**What to build:** native-statusline/02 landed as 6ad0bf62, but afterwards the main checkout had no `dist/native/hud-statusline`; a manual `npm run build` then compiled it in 8.5 s. So the land's `after: npm run build` (or the tested-build reuse from perf-ts/06 and the artifact hand-off in `src/mcp/land-runner.ts`) skipped the native step, and the owner's Claude statusline kept running the TS path. Make a land whose commits change `native/` (or whose tested integration checkout built the native artifact) leave a hash-checked `dist/native/` on the main checkout, the same way `dist/` is published. When cargo is missing, the after step still succeeds and says once in the land result that the TS statusline stays in use.

- [x] A land fixture that changes `native/` leaves `dist/native/hud-statusline` and `source.sha256` on main
- [x] A land without native changes keeps the existing artifact; no cargo on PATH gives one note, not a failure
- [x] Targeted land/build tests pass

## Comments

- Landed 9bbb5da2f8e888b82232040b9db09131ac7a0a54; gate 5/5 passed.
- 2026-11-22 after landing 90cba6ef: the land of this very ticket (run by the pre-fix land runner) again left main without `dist/native/`; a manual `npm run build` restored it from cargo's cache in 0 s. Check on the next land that `dist/native/hud-statusline` survives; if it does not, reopen.
