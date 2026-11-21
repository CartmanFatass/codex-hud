# MyHUD standing brief

Applies to every worker job in this repository, after its own task.

- Read `docs/ARCHITECTURE.md` (§8 rules every change keeps) before changing code; `docs/spec.md` is the product boundary.
- Run every build and test through `/home/fires/projects/MyHUD/tmp/env.sh <command>` (temporary HOME, HUD_HOME,
  CODEX_HOME). Never run tests against the real home.
- Build with `npm run build && npm run build:test`. The full `npm run test:mjs` takes about 4–5 minutes: run it as
  `timeout 600 npm run test:mjs`, once at the end, only when the brief asks for full suites.
- Code jobs work in the worktree the brief names (`../MyHUD-wt/<WP>`, branch `wt/<WP>`); commit there, never push. The
  main session integrates.
- The repository is public: fixtures, docs and reports use synthetic data only; never copy keys, tokens or personal
  paths into the repo.
- Node >= 24. No new dependencies unless the brief allows them.
- Shared resources (the real install under `~/.hud`, live harness runs, the shared browser) are the main session's
  unless the brief names a lease to take with `hud_lease`.
