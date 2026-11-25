# 04: npm test passes on a fresh GitHub runner

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** First CI run on universal-hud (run 45608424975, after eng-hygiene/01) fails `npm test` in both matrix cells with the same four failures; they pass in the local land gate, so they depend on the environment (main's CI has failed since at least 2026-11-14). Failures: (1) tests/unit/daemon-binding-async.test.mjs:215 'tuiPidForPane runs tmux asynchronously' expects 4678, got null (runner likely has no tmux, or a different one); (2) tests/unit/git-safety.test.mjs:138 'Project: repository/unsafe/submodule' TypeError path argument undefined (the Project path reads some env or file the runner lacks; Changes/Claude/Codex/pi cases pass); (3) tests/unit/thin-mcp-ticket-queue.test.mjs:298 'ticket queue keeps going past an answered worker question' condition did not settle after 16 s; (4) tests/unit/vendored-lock-stamp.test.mjs:9 ENOENT node_modules/.hud-package-lock-hash, because npm ci deletes the vendored marker (eng-hygiene/01 found this and added `git restore -- node_modules` only before test:release). Reproduce in a fresh clone under a temp HOME with `npm ci`, no tmux/herdr/pi/claude on PATH and no ~/.hud, then fix each at its cause: make tests self-contained (fake binaries on a test PATH, explicit env), fix product code only if it is wrong outside the owner's machine, and move the CI restore step so the vendored marker exists for npm test. Another job (eng-hygiene/02) is replacing fixed sleeps in tests now; keep edits to thin-mcp-ticket-queue.test.mjs minimal.

- [ ] Each of the four failures reproduced in the clean environment and its cause named in the report
- [ ] All four pass in that clean environment with NO_COLOR unset and =1; no test skipped or assertion removed; a skip-if-missing is not allowed where a fake binary works
- [ ] The same tests still pass in the normal local environment
- [ ] ci.yml restores the vendored node_modules files before npm test; test:release still runs after it

## Comments
