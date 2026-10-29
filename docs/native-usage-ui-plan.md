# Native usage analytics and TokWatch-inspired UI

Development branch: `codex/dev-native-usage-ui`, based on `a142353`.

## Scope

Ship a native Codex HUD implementation of historical token usage (today, seven
days and thirty days), task/self/descendant attribution, daily trends and
model/effort/role breakdowns. Make these discoverable through a separate Usage
page. Improve the session sidebar's hierarchy with a quieter TokWatch-inspired
presentation and accessible detail navigation. The earlier HTML preview is a
design direction using synthetic values, not a working implementation.

The first release does not add multi-provider collection, pricing, subscription
capacity estimates, model-quality rankings, or independent server-model audits.
Those are separate follow-up features, not implied by token accounting.

## Architecture

- A native asynchronous usage service reads Codex session and archive records.
  It owns its persistent private index, parser state and evidence diagnostics.
- Rendering consumes in-memory snapshots. Opening Usage triggers a background
  refresh; subsequent refreshes while visible are throttled. A history refresh
  must never be awaited by the live collection or rendering loop.
- `src/usage-types.ts` is the explicit data/UI boundary. The service exposes
  `refresh()`, `snapshot({period, nowMs, rootId?})`, and `close()`.
- Usage is an independent page/overlay, not a new agent-monitor pane. This
  avoids changing the meaning of saved pane layouts and navigation settings.
- Time ranges use local calendar days and identify their timezone. Current-task
  scope means the selected root and recorded descendants; all-local scope means
  the configured Codex home. A Codex home is a source, not a proven subscription
  account identity.

## Accounting requirements

- Read usage events, not context-window occupancy. Cached input is a subset of
  input; reasoning output must not be added twice to total output.
- Keep the original thread identity when a fork contains copied parent
  metadata. Distinguish inherited events from independent child events; lineage
  alone must not silently turn an unrelated fork into a delegated task.
- Repeated counters, resumed file copies, malformed/truncated records, counter
  resets and changes of model/effort need explicit handling and synthetic tests.
- Missing evidence is unknown, never zero. Known subtotals with coverage gaps
  remain visibly partial; retain source, range and last-update provenance.
- Existing and archived copies must not inflate usage. Unchanged files should
  be reused, while replacement, shrinkage and failure cannot bless a stale
  cursor as current.
- The first cumulative-only report establishes a baseline; it cannot prove
  which day or model incurred the preceding accumulated consumption. Do not
  manufacture an event from it. Later deltas or a reliable last-usage record
  can provide localized evidence.
- Persist only the metadata needed for accounting, without message bodies,
  credentials or model-generated interpretations. Write state privately and
  atomically; multiple HUD instances must not corrupt the store.

### Fork evidence limit

The reference parser's fork tests copy metadata and contexts but do not prove
that copied parent token events are removed. A later foreign metadata record
must therefore not be treated as a new owner. Old inherited usage can establish
a baseline but must not be billed to the child. Restore attribution only at a
reliable owner/turn boundary; an event merely dated after owner creation is not
sufficient proof. Where that boundary cannot be established, retain ambiguity
in coverage rather than asserting a complete total. Synthetic fixtures verify
these rules; they do not certify every upstream fork encoding.

## Ownership and sequence

1. Architecture review: read-only investigation of native accounting boundaries
   and the real runtime integration paths.
2. Data implementation: `usage-types.ts`, `collectors/usage-*`, synthetic
   analytics tests. Own the complete read/index/query outcome.
3. UI implementation: rendering, settings/presets, runtime integration and
   command/key routing, with focused tests and reviewed visual baselines.
4. Root integration: shared Git operations, documentation, cross-layer tests,
   isolated runtime acceptance and final delivery.
5. Independent review: stable diff against the original requirements, prioritizing
   incorrect accounting, blocking reads, regressions and inaccessible controls.

The implementation owners share the development checkout with disjoint paths.
Additional worktrees are unnecessary unless ownership starts to overlap. The
pre-existing untracked `.omp/` directory is outside this task.

## Acceptance

- Baseline: 1,028 unit tests and 47 JavaScript suites passed before edits.
- Targeted accounting tests: duplicate/replayed/copied records, fork ownership,
  date and model boundaries, corrupt sources, persistence and refresh lifecycle.
- UI tests: English and Chinese, 32/40/48/56 columns plus wide view, no-color,
  selection/detail, period and scope switching, empty/partial/loading states.
- Stable integrated build and full relevant test suites; inspect changed
  terminal-cell baselines rather than treating regeneration as acceptance.
- Real tmux interaction on a private socket and throwaway Codex home with
  synthetic logs: open Usage, navigate, refresh, return, and verify keys do not
  leak to the Codex pane. Never restart or drive a user's live session.
- Record actual checks, known limits and activation instructions. Do not deploy
  or claim a running session changed merely because source/build tests passed.

## Progress

- Architecture, interface and ownership plan completed before parallel changes.
- Analytics and UI implemented by separate owners; root integrated documentation,
  real tmux tests and the reproducible synthetic performance probe.
- Independent UI review findings (clean Settings navigation, no-color active
  tab, uncertain empty-state wording) fixed and verified.
- Independent data review found conflicting labels across duplicate records;
  role/model/effort now remain unknown and partial when evidence conflicts,
  while numeric totals stay deduplicated. The targeted fix was independently
  verified, including ordering and matching-copy cases.
- Full regression, relevant no-color checks, private tmux acceptance and bounded
  performance validation completed. See [the acceptance record](./native-usage-acceptance.md)
  for actual results and limitations. Existing live sessions were not restarted.
