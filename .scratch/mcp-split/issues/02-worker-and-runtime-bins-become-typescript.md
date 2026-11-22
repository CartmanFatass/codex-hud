# 02: Worker and runtime bins become TypeScript

**Status:** claimed
**Blocked by:** 01

**What to build:** S2 (:630): 12 packages/hud-mcp/bin/*.mjs move into src/runtime and src/worker with 1-6 line wrappers; owner default: hud-notify library functions sink into src/roles/notify.ts. CLI paths, argv and exit codes unchanged.

- [ ] Wrappers keep every bin path, argv and exit code
- [ ] npm test and test:release pass

## Comments
