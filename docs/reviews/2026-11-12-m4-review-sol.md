Verdict: changes-required

Reviewed commit: `3b17f7a0`, in `<review worktree>`. Four major findings block release: three spec violations and one cost violation. The review followed the shipping entry points, including unchanged code, rather than treating the milestone diff as the entire product.

## Axis 1: spec compliance / scope

### 1. Major — Home's progress brief is permanently tied to the ranking cache

**Location:** `src/collectors/home-recommendation.ts:49`, `:86–95`, `:108–109`.

An unchanged or failed ranking prevents the independently configured progress brief from refreshing or appearing. The ranking fingerprint excludes current sentences; after the first brief, `cached.tried` makes `update()` return forever for that fingerprint. A ranking failure instead stores `undefined`, which also permanently short-circuits that fingerprint, and `apply()` cannot display a brief without a successful ranking row.

**Owner-visible scenario:** A job stays working while its sentence advances from implementation to integration checks. Even ten minutes later with a five-minute Summary interval, Recommended Home still shows the initial brief. Separately, a Decision API error suppresses the brief even when the text-model service works.

**Verification:** An isolated probe against the compiled implementation produced one ranking and one brief initially; after advancing the clock ten minutes and changing the sentence, both counts remained one and the old brief remained. With ranking returning HTTP 400 and the text model available, brief submissions were zero. The orchestrator clarified that both behaviours violate intent: the brief must be independent of ranking success and refresh, at most once per Summary interval, when its own digest changes.

**Smallest fix:** Give the brief its own digest/cache state, including current card sentences, and its own interval gate. Evaluate that path independently of ranking-cache returns and failures; keep ranking's separate two-minute gate.

### 2. Major — A normal Claude installation can bypass every shared bar look

**Location:** `src/cli/statusline.ts:139–147`; installation prerequisite at `install.d/claude.sh:76–81`.

The shared bar renderer and `applyBarSettings()` run only when an explicit `config.json.statusline` section exists. The installer creates that section only by importing an existing claude-hud configuration. Consequently, an installation without that legacy file gets the old minimal renderer, which ignores the shared bar-style selection and omits the parity fields. This violates §2's all-three-bars look choices and M1's Claude statusline parity.

**Owner-visible scenario:** Install the Claude extension without the old claude-hud plugin configuration, then select Micro Glyphs or Gauge Plates in Settings. Both render exactly `Opus 4.5 · ctx 42%`; changing the look does nothing. Adding `{"statusline":{}}` makes the same inputs use the shared renderer and produce different looks, confirming that the missing configuration—not missing facts—is the cause.

**Smallest fix:** Initialize the supported HUD statusline configuration during installation when no imported configuration exists, or make the normal installed command use the shared renderer with defaults. Preserve the existing backup behaviour; do not require a prior plugin installation to enable the promised HUD bar.

### 3. Major — The explicitly retired execution platform still ships as production source

**Location:** `src/ledger/ledger.ts:201`; related retained modules include `src/ledger/schema.ts:1`, `src/ledger/intents.ts:1`, `src/ledger/reconcile.ts:1`, `src/core/supervision.ts:1`, and `src/roles/pi-owned/runtime.ts:1`.

The repository still contains the SQL ledger writer/schema, execution-intent and reconciliation machinery, supervision code, and the obsolete owned-role runtime. These are not the thin job-file facade described by the spec. §3 rules out an own execution platform, and M2 explicitly requires deleting the retired stack rather than merely disconnecting its entry points.

**Consequence:** The M4 checkout/build still carries thousands of lines of prohibited, unreachable execution machinery for the owner and future changes to maintain. This is a cleanup/spec failure, not a claim that the active MCP currently opens the old ledger. A runtime-import sweep excluding type-only imports found approximately 6,700 lines in the examined retired modules unreachable from the shipping roots; the ledger writer itself has no shipping caller.

**Smallest fix:** Delete the unreachable ledger writer/reconciler, obsolete runtime/supervision modules and their exclusively dependent code. Retain only genuinely used projection types or small helpers; do not replace the retired stack with another abstraction. In particular, do not indiscriminately delete all of `src/core`: some pure helpers remain in use.

## Axis 2: simplicity, quality, and cost

### 4. Major — The 200-job display limit does not bound job discovery or cold bar reads

**Location:** `src/collectors/thin-jobs.ts:121–151`.

Every refresh enumerates the entire jobs directory and reads/parses a receipt for every historical job before applying the 200-job limit. With the bar optimization enabled, it first reads every job's `STATUS.json`, even for unrelated panes. The cache is process-local, so the short-lived Claude statusline pays that cold-read cost again on every invocation. The panel and pi footer also synchronously probe the entire accumulated directory, although they can reuse cached bodies.

**Owner-visible scenario:** Ordinary retained job history grows while the owner works in a different pane. Opening or refreshing an otherwise empty bar still scans that whole history, making bar/panel work scale with all past jobs rather than current observations. This breaks the brief's §4 requirement for bounded, incremental reads; limiting the returned array is not a collection budget.

**Verification:** With 1,000 unchanged, old, closed jobs belonging to another pane, each of two cold collector instances parsed 1,000 receipt bodies and returned zero lanes. The existing warm-cache test also explicitly expects all 300 receipts to be parsed on its first scan; it does not cover the per-invocation statusline cache reset.

**Smallest fix:** Bound discovery and body-read work per refresh and retain an incremental discovery/signature cache across short-lived statusline invocations. Reuse a file-based display cache/cursor rather than introducing a watcher or daemon; the result cap must not be the only bound.

## Optional

No additional optional findings. Coverage suggestions, speculative races, and formatter/style changes are not being used to block this release.

## Verified

- Reviewed `docs/spec.md`, the milestone brief and its approved trade-offs, `docs/delegation.md` step 5, architecture guidance and applicable agent/directory notes. Confirmed the detached checkout is at `3b17f7a0` and remained clean.
- Followed installation/uninstallation through `install`, its client hooks and `bin/hud`; uninstall is correctly routed by the shell launcher, not missing because it is absent from the TypeScript command dispatcher. Synthetic installer checks passed; no real owner configuration was changed.
- Followed all six thin MCP tools, role-file loading and overrides, inherited caller notification binding, job-file observations, the on-demand watcher, and the Jev CLI wrapper. Focused tests exercised the real dispatcher/wrapper paths with synthetic external tools.
- Checked Project control-plane/progress/ticket collection and Home's spare-row progress rendering. The compact Home collection path avoids the Project-only git/control-plane work; the panel also suppresses the bar's background git refresh.
- Checked Claude caller binding and bounded native transcript replay, nested-child attachment, resumed/completed agent handling, model-text/decision-label gating and caching, settlement-time preference, panel-width propagation, and the three bar implementations. The focused tests below passed; finding 2 concerns the configuration path those bar-renderer tests do not establish.
- Checked Gemini/OpenAI/TypeSafe transport, primary/fallback selection, Gemini cooldown, separate LLM/Decision ledgers, unlimited-cap handling, and model-text/localized decision paths. No credential-value display/log/persistence leak was found in the reviewed paths: UI state uses key presence/variable names, provider credentials are private, and provider failure messages do not expose response bodies. Network authorization necessarily carries the configured keys. No real keys or authenticated providers were used.
- Ran a runtime-import/dead-code sweep, excluding type-only imports, and checked the retained ledger/owned-role modules rather than assuming old filenames were necessarily unused. Finding 3 is limited to the retired machinery, not the live pure projection helpers.

### Commands and actual results

1. `git diff --check c283e7ea..HEAD` — **exit 0**. `git status --short` — **empty**. `git rev-parse --short HEAD` — **`3b17f7a0`**.
2. Focused check, using the project's isolated-home wrapper:

   ```sh
   <repo>/tmp/env.sh node --test --test-reporter=spec \
     tests/unit/install-script.test.mjs tests/unit/install-claude.test.mjs \
     tests/unit/install-codex.test.mjs tests/unit/install-pi.test.mjs \
     tests/unit/thin-mcp.test.mjs tests/unit/thin-job-scan.test.mjs \
     tests/unit/pi-package.test.mjs tests/unit/decision-labels.test.mjs \
     tests/unit/home-recommendation.test.mjs tests/unit/project-page.test.mjs \
     tests/unit/project-tickets.test.mjs tests/unit/home-progress.test.mjs \
     tests/unit/claude-nested-replay.test.mjs tests/unit/native-tree.test.mjs \
     tests/unit/panel-width.test.mjs dist-test/tests/unit/jev-gemini.test.js \
     dist-test/tests/unit/bar-themes.test.js dist-test/tests/unit/pi-footer.test.js \
     dist-test/tests/unit/statusline-parity.test.js
   ```

   **209 tests; 209 passed; 0 failed/cancelled/skipped; exit 0.** No full suite was rerun. Existing compiled artifacts for the probed paths were newer than their source files.
3. Three isolated `node --input-type=module -e` probes exercised the real compiled Home recommendation service, installed statusline launcher, and thin-job collector. Results are quoted under findings 1, 2 and 4. All fixtures used temporary directories and synthetic data and were removed afterward.

Live herdr/tmux layout, logged-in client/browser behaviour and installation against the owner's real files were not exercised. Those remain owner/local validation, not simulated production acceptance.

<job>/report.md — 4 findings (4 major, blocking).
