# 01: CI covers the working branch, the native crate and the release archive

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** .github/workflows/ci.yml only runs on push to main and pull requests, but work lands on universal-hud. It also never builds or tests native/ (Rust) and never runs tests/release-archive.test.mjs (npm run test:release). Extend CI so a push to universal-hud runs the same job as main, add a job that installs a stable Rust toolchain and runs cargo build and cargo test in native/, and run npm run test:release after npm test. Find out whether integrations/claude-mod/tests (they import claude-code/testing) can run outside Claude Code; if they can, add them, if not, say why in the report and do not add a stub. Do not change the local land gate in .hud/project.json.

- [ ] A push to universal-hud triggers CI (on.push.branches includes it); main and pull_request triggers unchanged
- [ ] A native job runs cargo build and cargo test in native/ with a pinned stable toolchain action and cargo cache
- [ ] npm run test:release runs in CI and passes locally in a temp HUD home
- [ ] claude-mod tests are either run in CI or the report states the blocker
- [ ] actionlint (or a YAML parse) passes on the workflow; no other files change except a one-line note in docs/ARCHITECTURE.md if it describes CI

## Comments
