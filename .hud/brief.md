# MyHUD standing brief

Applies to every worker job in this repository, after its own task.

- Rules from `docs/ARCHITECTURE.md` §8 are inlined below; open `docs/ARCHITECTURE.md` only when your change needs
  subsystem detail. `docs/spec.md` is the product boundary.
- Run every build and test through `/home/fires/projects/MyHUD/tmp/env.sh <command>` (temporary HOME, HUD_HOME,
  CODEX_HOME). Never run tests against the real home.
- Build with `npm run build && npm run build:test`, then run the tests for the code you touched. The full suite
  (`npm run test:mjs`, about 70 s) is the land gate's job; run it only when the brief asks.
- Code jobs run in their HUD-managed worktree: commit there, never push or land, and leave ticket files alone; the
  main session lands with `hud_land`, which records the ticket. Jobs without a worktree
  (docs, design samples, studies) commit with a pathspec (`git commit -m ... -- <paths>`) in the main checkout.
- Browser renders use `--password-store=basic --user-data-dir=$(mktemp -d)` (delete the dir after), or skip them:
  a default Chrome launch pops a keyring dialog on the owner's desktop.
- The repository is public: fixtures, docs and reports use synthetic data only; never copy keys, tokens or personal
  paths into the repo.
- Node >= 24. No new dependencies unless the brief allows them.
- Shared resources (the real install under `~/.hud`, live harness runs, the shared browser) are the main session's
  unless the brief names a lease to take with `hud_lease`.

## Rules every change keeps (`docs/ARCHITECTURE.md` §8)

**Rendering:**
- Every panel line is exactly `width` columns: measure with `visualLength`, cut with `truncateAnsi` (not UTF-16
  length). The bar stays English-only.
- External text passes through `monitorText` once; never sanitize the panel's own ANSI.
- Panel words go through `t()` with EN/ZH entries; colours use theme roles (including `theme.board`), not raw escapes;
  `none` emits no colour.
- Controls use words/icons with meaningful text, not shortcut letters as labels; footer shortcut hints stay whole when
  fitted.
- Drop optional fields before cutting; missing evidence stays absent/unknown; cards use observations + optional stored
  model text, never an inferred verdict.
- Rendering is pure: pass `nowMs`; no I/O, model calls, or lifecycle advances during paint; click geometry uses the
  same frame clock.

**Collection:**
- Rollout offsets are bytes; parses use the single-flight queue.
- SQLite is read-only and best-effort; scan changes bump `SCAN_VERSION`.
- Failed reads yield null/unknown, never a fabricated zero or clean state.
- Status collection must not run repository-provided Git commands/filters or fetch.
- Keep collection bounds and incomplete-coverage facts; do not claim bounded body reads make directory enumeration or
  native-session totals constant-cost.

**Privacy and repository:**
- The Model text master switch controls display requests (chat also requires a matching endpoint key); Sonic
  auto-thinking has its own explicit Decision API switch, independent of Model text, like quiet-job dispatch.
- List every new outbound model input in `docs/ARCHITECTURE.md` §5 and both reference languages (`docs/reference.md`,
  `docs/reference.zh.md`); land repair sends only the failing cherry-pick/gate step and its last 40 output lines to the
  source worker or same-role replacement.
- State is private: `writePrivateFile` or equivalent temp-file + `0600` + rename.
- Preserve owner configuration, keys, history and unrelated state; tests, fixtures, logs and README examples use
  synthetic data only.
