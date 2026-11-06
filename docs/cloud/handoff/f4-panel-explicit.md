# F4-PANEL-EXPLICIT handoff

Base: `a1250f07995465b40e29a284a732978894c3e7ee`.
Base tree: `708eb6a30002ca749ba27d00aadb7d10dcd2265d`.
Implementation source only; independent review/publication pending. No commit,
branch/ref movement, integration merge or production promotion was performed.
The source workspace is a partial materialization. Missing files are not deletions.

## Delivered scope

- Bounded explicit panel controller, pure candidate/display/modal reducer.
- Actual monitor/control-bar/Inspector and tree-page lifecycle/input composition.
  The page consumes the same Digest-only orchestration seam as the owned tests:
  whole-read routing, visible surfaces, exact success receipts and ordinary
  collection completion. No test-only replacement dispatcher is used.
- Monitor-only D, named command, nonrepeating prefix and closed-panel no-op.
- EN/ZH labels, safe model-text wrapping and fixed refusal reasons.
- Three dedicated synthetic unit suites, including real core fake-fetch and
  private SQLite success/denial/cancellation seams.
- Consumes the separately owned opaque core plan-lifetime veto, never derives
  continuity or authority from public plan equality. The original environment
  identity and core baseline remain private, and one-use confirmation passes the
  guard into the existing source-authority chain.
- No saved notes, provider implementation, material authority, report-body reader,
  ledger mutation, paused chat UI, live send/ask or card/cache rewriting.

## Evidence

PASS: `bash -n bin/codex-hud-keys bin/codex-hud-command`.
PASS: three dependency-free tests of the actual shell scripts with fake tmux in
private temporary homes. Raw evidence and exact source/delta hashes are supplied
with the package outside the source tree.

NOT_RUN: all npm builds, emitted TypeScript suites, UI/visual/runtime behavior,
format check, fixture check and focused synthetic timing measurements. Ordinary
local dependencies are absent. Historical CI at the unchanged base is not
validation of this change. No real HOME, provider, Herdr, terminal font, host
process or user account operation was used.

## Local checks on the final candidate SHA

Use the normal repository dependencies in a full checkout, Node 22.13+ or 24,
and temporary HOME/HUD_HOME. Do not use a partial source tree as a full checkout.

```bash
npm run build
npm run build:test
npm run build:hud-mcp
node --test \
  dist-test/tests/unit/delegated-digest-panel.test.js \
  dist-test/tests/unit/delegated-digest-panel-render.test.js \
  dist-test/tests/unit/delegated-digest-panel-input.test.js \
  dist-test/tests/unit/delegated-digest-lifetime.test.js \
  dist-test/tests/unit/control-bar.test.js \
  dist-test/tests/unit/monitor.test.js \
  dist-test/tests/unit/panel-command.test.js \
  dist-test/tests/unit/workbench-input.test.js \
  dist-test/tests/unit/prefix-keys.test.js \
  dist-test/tests/unit/b10b-s3-actions.test.js \
  dist-test/tests/unit/b10b-s3-input-keys.test.js \
  dist-test/tests/unit/b10b-s3-keys.test.js \
  dist-test/tests/unit/b10b-s3-width.test.js \
  dist-test/tests/unit/delegation-inspector-slice.test.js \
  dist-test/tests/unit/delegated-digest.test.js \
  dist-test/tests/unit/delegated-report-read.test.js \
  dist-test/tests/unit/source-model-config.test.js \
  dist-test/tests/unit/digest-cli.test.js
npm run test:visual
npm run format:check
npm run check:fixtures
git diff --check
```

Run emitted suites only after successful build:test; report absence/failure
rather than using old emitted files. Preserve existing applicable performance
budgets. The new focused two-node unchanged/changed render-cost test reports
three runs, n=200 after 20 warmups, nearest-rank p50/p95/p99/max and host/runtime.
This measures pure renderMonitor only, not a full page paint or collection.
A separate real-core synthetic test observes fs.openSync/readSync and SQLite
BEGIN/COMMIT, plus the actual metadata onQuery callback. It expects preparation
18 queries/six transactions/eight JSON reads and retained revalidation nine
queries/three transactions/four JSON reads. It checks zero such I/O on clock,
model and unchanged paints, synchronous hiding before the first read, and no
extra check from multiple paints or concurrent completion calls.

The new measurement scopes are explicit: metadata preparation plus page settle
(n=10 after three warmups), and three runs of the production ordinary-completion
hook (n=20 after three warmups each). The hook includes real metadata I/O plus
renderMonitor, frameDiff and a synthetic memory write enqueue for hidden/restored
frames. It does not measure preceding collectors or actual terminal/stdout
latency. Report host/runtime, warmup, n and nearest-rank p50/p95/p99/max; keep the
three-second planning deadline and focused 50 ms p99/200 ms max completion budgets.
Full actual collection/terminal measurements remain a separate local check,
not an inference from the focused hook. None of these TS measurements has run
here. No historical B10D/P065 population or WSL qualification is restarted.

## Disposable local UI checklist

1. Render the actual panel using synthetic data and fake transport in EN and ZH
   at 32, 40, 48, 56 and 80 columns. Verify text width and control visibility.
2. Select a completed delegated report. Click Digest or use focused/prefix D.
   Confirm no transport call until Generate/Enter, with the same click/key target.
3. Review source/session/thread/report and destination. Scroll exact identifiers.
   Test disabled/missing scope, grant, source off/paused and unreadable config.
4. Repeat D, click and Enter; test paste and arbitrary letters during planning,
   confirmation and response headers/body. None can reach the harness. Cancel,
   q, settings/help, root/selection/new report and shutdown suppress late output.
   Test a whole read containing cancellation followed by D/Enter/paste: no tail
   bytes may reach the main pane. Check each real settings, dirty settings leave,
   Help, activity, Find, evidence and log surface rejects prefix D without closing
   itself or queuing a Digest destination; literal search D remains search text.
   Defer A's cleanup, cancel A, explicitly complete same-target B, then change B's
   Changes/Inspector focus, scroll and Keys-here state. Settle A and verify no
   text, focus, scroll, keys or repaint effect. Repeat no-op/double confirmation
   and shutdown while cleanup is pending.
5. Inspect the result and normal report/status/card/log facts side by side. The
   result is clearly model-written, only for one completed report, with its
   original generation time and cache status. Malicious controls/bidi are escaped.
6. Revoke scope/grant or change source configuration. On the next ordinary
   collection completion, stale text disappears before metadata validation.
   Restoring configuration alone must not restore it or make a request.
7. Pause legacy models while running: it cancels locally. Resume/presets/reset
   cannot restart or authorize this per-source action. Check other existing
   Open/log/Resume/Reconcile/diagnostics controls and nonmonitor D unchanged.
8. Verify real font, Herdr and provider behavior separately only when explicitly
   supplied. They remain NOT_RUN, not simulated production claims.

The original core API and the guard composition remain part of the package
review. The key/context ruling additionally authorizes only the three exact
expectation updates in b10b-s3-input-keys and one D row in each EN/ZH reference.
No other old tests or reference prose are changed. The recheck is instrumented
as digest.revalidate at actual collection completion. It remains added work
subject to applicable controller/I/O/full-tick budgets; no timing result exists
until the local checks are executed.
