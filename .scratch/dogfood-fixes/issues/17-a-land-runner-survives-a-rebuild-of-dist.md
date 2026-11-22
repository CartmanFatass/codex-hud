# 17: A land runner survives a rebuild of dist

**Status:** done
**Blocked by:** none
**Owner try:** no

**What to build:** 2026-11-22: two lands (perf-hygiene/05 flow ffc20f4c322f2231e, dogfood-fixes/16 flow f25bd7ab7d7655046) failed at `repair 1` with `The requested module './abstract-lock.js' does not provide an export named 'abstractAddress'`. Each `dist/mcp/land-runner.js` started before another land's `after: npm run build` rebuilt `dist/` with ddfdb4c8 (which added `abstractAddress` and `runner-lifetime.js`). It then lazily imported the new `runner-lifetime.js` against its cached old `abstract-lock.js`. Any long-lived HUD process that imports from `dist/` after start (land-runner, hud-mcp, hud-watch, panel) can break this way whenever a land rebuilds. Fix it so a running process never mixes builds, choosing the simplest option. Two candidates: (a) load every module eagerly at start, with no dynamic `import()` of project modules after start; or (b) run land-runner (and any other per-flow process) from an immutable snapshot of `dist/` taken at spawn, while long-lived servers restart or reload as a whole when `dist/` changes (the watcher already reloads). A failed import in a runner fails the step with a clear "HUD was rebuilt; retry the land" message and leaves the flow retryable.

- [x] A test rebuilds a module that a running land-runner has not imported yet, and the flow still finishes (or fails with the retryable message, never a SyntaxError)
- [x] No dynamic import of a project module remains on the land-runner's repair path, or the runner runs from its snapshot
- [x] Targeted land tests pass

## Comments

- Landed 08aeec57914c111885ed96b233eb4558b6d4b64f; gate 5/5 passed.
