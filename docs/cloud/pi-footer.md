# Opt-in Pi footer

The extension at `extensions/pi/hud-footer.ts` replaces Pi's built-in footer only
when explicitly loaded. It uses the official Pi v1.4.0 public UI API pinned to
commit `4a080252f06caf63a525d7873c5d94d3c23887e0`:

- [Official custom-footer example](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/examples/extensions/custom-footer.ts)
- [ExtensionContext and setFooter](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/extensions/types.ts)
- [Session entries and getBranch](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/session-manager.ts)

This is a source/API pin, not runtime version attestation. Other versions are not
claimed compatible. RPC can report `hasUI: true`, but a custom footer is TUI-only;
the extension also requires `ctx.mode === 'tui'`.

## Try it explicitly

Build the repository, then load it into an existing compatible Pi installation:

```sh
npm run build
pi -e /absolute/path/to/codex-hud/extensions/pi/hud-footer.ts
```

`/hud-footer off` restores the default footer. `/hud-footer on` reinstates it, and
`/hud-footer` toggles it. This choice is in memory, not saved. This package does
not install Pi, modify user settings, register itself for future sessions, send a
prompt, request credentials or make any provider call. Loading it explicitly is
required; no central CLI/package entry or existing default is changed.

The footer displays the native current model/effort, estimated context usage,
current-branch usage, shortened current session ID, HUD-summary availability,
native Git branch when available, and other extensions' status text. Native text
is stripped of control/direction characters and every line fits the requested
terminal width. It has three rows, plus one row when other extension statuses
are available. At narrow widths lower-priority text is truncated.

## What the values mean

- `ctx ~...` is the official `getContextUsage()` estimate. Unknown tokens after
  compaction remain `?`, even when the context window is known. No model-name
  lookup invents a context window.
- `current branch` totals are assistant `message` entries returned by native
  `sessionManager.getBranch()`. Input, output, cache-read and cache-write are
  separate. `$` is the sum of reported `usage.cost.total`, not a bill or a total
  for all branches. Explicit zero remains zero.
- Entry IDs are counted once. Missing/invalid usage fields and duplicate IDs
  with conflicting metrics make the affected metrics unknown and coverage
  partial; a known subset is not presented as a complete total. A malformed
  message entry or more than 10,000 native branch entries makes all totals
  unknown/partial. An observed empty branch has zero assistant usage.
- Official standalone `usage` entries such as `cache_warm`, compaction summary
  usage, branch-summary usage, user messages and tool results are outside these
  assistant-interaction totals. Assistant entries remain included regardless of
  stop reason. No message content, thinking, images or tool arguments are read.
- `idle` is the native `isIdle()` observation, not proof of task success,
  quiescence, process exit or a managed run's terminal state.

Snapshot refresh happens on session start/tree navigation, compaction, finalized
messages, model/effort changes and agent start/end. Paint and resize render only
that captured snapshot, not the entire branch. The native `getBranch()` call
itself builds its own array; the extension caps subsequent processing and does
not claim a wall-clock bound for that native API. Branch subscriptions are
disposed on replacement, toggle-off and shutdown. There are no polling timers.

## Optional HUD summary seam

The default entry deliberately says `HUD unavailable`. No summary-storage
contract exists yet, and this extension does not guess a HUD_HOME, source root,
summary path or ledger location.

A trusted composition can use `createPiFooterController({ summary })` from
`dist/harness/pi/footer.js`. `summary` receives a frozen copy of the current
native display identity `{sessionId, sessionFile, sessionDir, leafId}` and returns
already available in-memory data, or `undefined`. It must not perform I/O in the
callback. The accepted presentation shape is:

```json
{
  "identity": {
    "sessionId": "synthetic-session-a",
    "sessionFile": "/synthetic/pi/a.jsonl",
    "sessionDir": "/synthetic/pi",
    "leafId": "synthetic-leaf-a"
  },
  "observedAt": 1800000000000,
  "coverage": "complete",
  "delegated": { "total": 3, "working": 1, "waiting": 1 }
}
```

Every field is validated. All four identity fields must match, coverage must be
complete, the observation must not be future-dated or more than 15 seconds old,
and counts must be nonnegative safe integers with working + waiting <= total.
Invalid, mismatched, stale or partial summaries display their unavailable state
without counts. Cached accepted data is copied and rechecked for age on paint.
This is a local display seam, not a new persisted/export schema. It infers no
SourceId, caller identity, managed relationship, launch/resume support or control
authority. No summary is injected by the default extension.

## Credential-free checks

```sh
npm run build
npm run build:test
HOME=$(mktemp -d) HUD_HOME=$(mktemp -d) node --test dist-test/tests/unit/pi-footer.test.js
node scripts/demo-pi-footer.mjs
```

An optional SDK check validates the extension entry against actual published
v1.4.0 declarations, without changing this repository's dependencies or executing
Pi. Installation scripts are disabled. This is not required to run the simulation:

```sh
sdk=$(mktemp -d)
npm install --prefix "$sdk" --ignore-scripts --no-audit --no-fund --package-lock=false @earendil-works/pi-coding-agent@1.4.0
node scripts/check-pi-footer-sdk.mjs "$sdk"
```

The demo loads the actual extension entry, registers its actual event handlers
and renders through its actual footer factory, with a synthetic native context.
It demonstrates current-branch usage, unknown context after compaction, a tree
switch, narrow rendering, and restoring the default. Tests also cover duplicate
and conflicting usage, partial/missing fields, injected summary validation and
expiry, session replacement, modes, unsafe text, resize and subscription cleanup.
Neither requires a provider. This is a runnable simulation, not a live Pi TUI
or account verification, and it does not complete all F2 integration or C–F.
