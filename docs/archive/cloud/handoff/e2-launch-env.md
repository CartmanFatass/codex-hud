# E2-LAUNCH-ENV handoff

## Frozen input and scope

Base: `a1250f07995465b40e29a284a732978894c3e7ee`.
Base tree: `708eb6a30002ca749ba27d00aadb7d10dcd2265d`.

Changed files are limited to `bin/codex-hud`, `bin/codex-hud-toggle`,
`bin/codex-hud-resize`, the new `tests/unit/hud-launch-env.test.mjs`, and these
two E2 launch documents. No new runtime helper or package manifest entry is
needed. Existing key/command helpers and the ten TypeScript aliases are
unchanged. Read the [feature notes](../e2-launch-env.md) for exact semantics.

Implementation selects explicit neutral names before legacy validation,
including before internal height/position assignments. Width crosses only the
new session boundary with two explicit environment argv values, and generated
panel commands set both selectors to their computed requested width. Resize
continues to prefer its saved session policy. No identity, authorization,
source/home, installation or capability contract changes.

The source is a verified partial materialization, not a complete Git checkout.
Required existing wrapper regressions were recovered at exact base blobs and
preserved unmodified. Missing local paths are not repository deletions.

## Executed checks

- PASS: individual `bash -n` checks for all three changed shell scripts.
- PASS: `node --check tests/unit/hud-launch-env.test.mjs`.
- PASS: bounded `node --test tests/unit/hud-launch-env.test.mjs`, 16 test groups,
  on Linux with Node 24.22.1. Each actual shell invocation has an 8-second
  deadline, a bounded cleanup fallback, direct-child exit/pipe-close receipt,
  and an owned-process-group absence check. Overall run limit: 180 seconds.
- PASS: exact changed-path/base-blob checks, full-tree overlay/hash, portable
  patch application round trip and added-line whitespace check.

Captures and command receipts are kept outside the source tree. The earlier
15-group run is retained separately. A syntax-check failure while authoring
the raw fake-script fixture was corrected before either behavioral run; it was
not a product test failure. The final evidence inventory identifies exact bytes.

NOT_RUN: normal TypeScript builds, emitted product CLI routing, renderer/settings
suites, Prettier, full functional/visual suites, runtime archive build, existing
integration scripts and live tmux/Herdr/provider tests. Compatible pinned
compiler/formatter/runtime dependencies are unavailable; no substituted modules,
compiler, remote build outputs, registry retries or workflow changes were used.
Base-commit CI is not validation of this change. Fake assertions are not native
or production capability evidence. No reader/tick performance path changed.

## User-local checklist at the final candidate SHA

Use the coordinator's final independent test-candidate commit, not a moving
integration branch. Work only with disposable private `HOME`, `CODEX_HOME` and
`HUD_HOME`; no real account, settings, transcript, provider or active tmux server.

1. Rerun `bash -n` separately on each changed script, `node --check` on the new
   suite and `node --test tests/unit/hud-launch-env.test.mjs` under a 180-second
   outer guard. Save the optional synthetic captures outside the checkout.
2. With the ordinary pinned dependencies, run `npm run build` and
   `npm run build:test`, then the emitted `product-cli-routing`, `hud-env` and
   `settings` unit suites. Run the normal formatter and `git diff --check`.
3. Run the existing `test-hud-resize.sh`, `test-wrapper-codex-home.sh`,
   `test-wrapper-main-pane-env.sh` and `test-wrapper-base-index-smoke.sh`
   regressions in a disposable environment with explicit time limits. Confirm
   none can auto-install/build unexpectedly or inherit real homes/credentials.
4. On a fresh, uniquely named **test-owned** tmux server, validate the
   `test-toggle-real-tmux.sh` behavior and neutral/legacy launch/toggle width
   cases. Audit its fixed socket/test paths first; never point it at an active
   user server. Check bar/panel replacement, pane focus and resize hooks.
5. Build/package the ordinary runtime and compare the packaged three existing
   shell helpers byte-for-byte with the final source. Confirm no new helper is
   needed and the original package mapping is intact.

Native Windows/PowerShell aliases and real Herdr qualification are separate
work. Publication, if authorized after fresh review, is an independent test
candidate for later local verification, not an integration merge or release.
