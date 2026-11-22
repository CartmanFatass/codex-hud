# 02: Worker and runtime bins become TypeScript

**Status:** ready-for-human
**Blocked by:** 01

**What to build:** S2 (:630): 12 packages/hud-mcp/bin/*.mjs move into src/runtime and src/worker with 1-6 line wrappers; owner default: hud-notify library functions sink into src/roles/notify.ts. CLI paths, argv and exit codes unchanged.

- [x] Wrappers keep every bin path, argv and exit code
- [x] npm test and test:release pass

## Comments

The current package has 17 bins. The 13 moved entries include the reloadable watch runtime; `hud-mcp`, `surface`, `generation` and `agy-events` remain source-only for pre-build startup or hook delivery.

- Landed 5d595bdbf38190924f20011d27fe8cae0109573d; gate 6/6 passed.
