# Read-only statusline validation, 2026-11-05

Scope: the bounded direct-child statusline implementation on
`codex/statusline-delegation-summary-20261105`, based on
`22bbb50a5563e3fe134d2af31f34a3190f72aa3e`. The enclosing commit identifies the
complete source and evidence. Tests ran on Linux x64, Node v24.22.1, temporary
synthetic ledgers and source directories, with no real provider or user settings.

- `npm run build`: passed.
- `npm run build:test`: passed.
- Focused command in [focused-node24.txt](focused-node24.txt): 67 passed, 0 failed,
  1 explicitly skipped opt-in B12 disk benchmark (68 total). Files were
  statusline-summary, statusline-preview, statusline-settings, b10b-statusline,
  product-cli-routing and b12-store, with test concurrency 1.
- The new summary suite contributed 11 passing tests, including both actual CLI
  entrypoints and exact stored-byte accounting before projection decoding.
- [Changed-file format check](format-check.txt): passed using the existing local
  Prettier binary because this worktree did not contain Prettier.
- [Cloud runner self-test](cloud-runner-self-test.txt): passed; the finite runner
  now includes the summary suite in its explicit focused list.
- `git diff --check`: passed.

This is focused cloud functional validation, not all-repository qualification,
Node 22 validation, hosted CI, a 1000-sample performance series, live Claude-client
verification, default settings installation, package release or acceptance of
unrelated historical milestones. Initial fixture development failed publication
because its synthetic continuity omitted the run/generation tuple; the fixture
was corrected to use the same exact tuple as its committed stamp. No production
validation was bypassed to make that fixture pass.
