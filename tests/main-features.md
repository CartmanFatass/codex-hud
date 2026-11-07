# Main-feature manifest

Baseline `9108482`. `tests/main-features.json` is the map `tests/run-main.sh` enforces. The gate does not read git history.

## Shape

One shape. The test map is the `tests` object. There is no fallback to another key.

```json
{
  "baseline": "9108482",
  "coverage": ["tests/unit/example.test.ts"],
  "tests": {
    "tests/unit/example.test.ts": {
      "branch": ["tests/unit/example.test.ts"],
      "assertions": ["the test title"],
      "assertStatements": ["<sha256 of each main assert* statement>"]
    }
  },
  "scenes": { "panel/en/tab/minimal/32x32": { "kept": "<sha256>" } },
  "mixed": {
    "tests/unit/example.test.ts": { "mainAssertions": ["the test title"] }
  }
}
```

`coverage` is the stored list of main test paths. The keys of `tests` must equal it. An entry is `{ "branch", "assertions", "assertStatements" }` or `{ "changed": "<reason>" }`. `changed` must be a non-empty string and cannot be combined with `branch`. This manifest has no `changed` entries.

A scene is `{ "kept": "<sha256>" }` or `{ "removed": "<reason>" }`. The hash is SHA-256 of the canonical JSON of that frame (object keys sorted). Every scene here is `kept`. Extra branch frames, including the `delegation/` scenes, are not main scenes.

`branch` paths are repo-relative. For every main test the branch carrier is the same path.

## What the gate checks

`tests/run-main.mjs` checks all of the following, then `node --test` runs the branch column. After the run, every assertion title of a node:test carrier must be a passed TAP line (`ok N - <title>`, any indent, outside YAML). `SKIP` and `TODO` are not passes. A title that contains `${...}` is a pattern: each interpolation matches `.+`. node --test writes a source `\` as `\\` and a source `#` as `\#`; the check reverses those two escapes and then requires the source title.

- The keys of `tests` equal `coverage`.
- Each kept scene's frame in `tests/fixtures/visual-baselines.json` hashes to the stored sha256.
- Each stored assert-statement hash still occurs in the carrier. `assertExceptions` may list a main hash under its assertion title. When that entry also has `branch`, the replacement hash must occur in the carrier.
- Each `mixed` title occurs in its file.

JS and TS statements are Prettier-normalised (print width 120, single quotes, ES5 trailing commas), then whitespace-collapsed. The hash covers `assert` and `assert.*` calls. Python `assert` statements, shell commands whose name contains `assert` (`assert_eq`, `run_and_assert_*`; a `name() {` definition is not a call), and PowerShell `Assert-*` calls are whitespace-collapsed and hashed the same way.

The gate builds `build` and `build:test` only. It does not build hud-mcp. No mapped file imports `packages/hud-mcp/dist`, and main's `npm test` does not build it either.

`RUN_MAIN_INTEGRATION=1` runs integration shell scripts marked `"integration": "opt-in"`. Exit 77 is a skip. The others are `{ "manual": "<reason>" }` and are listed, not executed. Manual scripts need a real tmux server, a PTY, or native Windows Git Bash.

## What is keyed

Every path under `tests/` at `9108482` is accounted for. Keys of `tests` are the tests: `tests/unit`, `tests/integration` (shell and Python), the five performance scripts, and `tests/windows/test-powershell-entrypoints.ps1`.

These are not keys. The tests that use them name them:

- `tests/fixtures/**` (modules, rollout jsonl, and the visual-baseline scene file)
- `tests/integration/fake-tmux/tmux`
- `tests/performance/results-*.json`
- `tests/run-integration.sh` and `tests/update-visual-baselines.mjs` (runners)

## How a name was chosen

Match was by path first, then by `test(` / `it(` / `describe(` title, then by the code under test. Each main title was read on both sides. None were removed.

1. Files with `test(` / `it(` / `describe(` string titles use those titles, in source order. A template title is kept as the source template. Asserts inside a test are not listed again.
2. Other files use the check names the file already prints or passes: shell `ok`, `assert_eq`, `assert_contains`, `assert_alias_*`, and `run_and_assert_*` labels, plus `echo` strings that state an expected or failed check; Python `assert` messages, `AssertionError` messages, and `wait` / `wait_for` / `wait_store` labels; `.mjs` `assert` message arguments, and a comment that sits directly above a group of asserts that have no message; PowerShell `-Message` strings; performance `compare()` labels.

A shell script whose only action is to launch its Python partner is named `runs tests/integration/<file>.py`. The Python file is its own key.

Python f-strings are written as `${name}`. `f'Back hidden at end: {s}'` is `Back hidden at end: ${s}`.

An assert with no message and no adjacent comment is not given a separate name. The file mapping still covers it. The statement hash still covers an `assert*` call that has no message.

## B17 test double

Eleven carriers keep model outcomes only through the B17 test double (`7f07c5a`; native-hud-v2 §4.1 fact 1 and §4.2(1)): `brief-report`, `briefing`, `i18n`, `model-telemetry`, `summary-status`, `model-runtime`, `reply-language`, `small-model`, `model-jobs`, `progress-summary`, `recap`. `divergence` records that on every assertion of those files. The production `SmallModel` is not what those tests construct. `SyntheticModel`, `authorizedSyntheticPreview`, or `syntheticRecapScopes` grants the synthetic fixture.

`syntheticRuntimeFile` redirects only `cache.json` to `materials-v1/replies/cache.json`. `calls.json` and `claims.json` stay beside the directory. Where an assert used to read `path.join(dir, 'cache.json')` or `path.join(dir, name)`, `assertExceptions` names that main statement and requires the `syntheticRuntimeFile` replacement, with the same expected mode `0o600` and the same entry counts 3, 6, and 200.

WP1 replaces `core/materials/*` and these carriers go back to constructing the production `SmallModel` with main's expectations. The owner ruled (2026-11-07, docs/universal-hud-concept.md §15) that the reply cache returns to main's location `<dir>/cache.json`; the four `assertExceptions` that pin the moved cache path are removed at that point. Until then, `tests/unit/b17-legacy.test.ts` "golden legacy Codex: explicit backend plus historical feature defaults preserves identical request bytes" is the interim carrier of the claim that the production path sends the same bytes.

## Mixed files

`mixed` names main-feature assertions that must move before that file is split. Historical assertions are left out. Branch-only "byte for byte" / "as it was" guards are not listed: main's own files already pin those outcomes, and the guards become empty once the delegation path is deleted.

| File | What must move |
|---|---|
| `tests/unit/monitor.test.ts` | the 51 main titles. The publication-notice test stays out. |
| `tests/unit/session-navigation.test.ts` | the 22 main titles plus the two stale-view titles. The ambiguous delegation-picker test stays out. |
| `tests/unit/b11-cli.test.ts` | the wrapper-help and panel titles, including the standalone-panel template. |
| `tests/unit/product-cli-routing.test.ts` | root help, package bins, and the two panel-entry titles. Two expectations narrow when they move: the bin loop keeps the bins that stay, including `hud-statusline`; the panel spawn drops `CODEX_HUD_PANEL_ALL_DELEGATIONS` and keeps `dist/tree-page.js` plus the caller environment. |
| `tests/unit/b17-legacy.test.ts` | the identical-request-bytes title above. |

`tests/unit/settings.test.ts` stays a main carrier. Its 15 main titles are the settings load, save, and validation checks. The two E2 titles (selector B shadows A; an empty selector does not fall back) are branch-added selector coverage. They are not main assertions and they are not mixed, because this file is not split. `withSettingsFile` also points `HOME`, `HUD_HOME`, and `CODEX_HOME` at the temp directory and restores them. That isolates the process. The 15 main assertions keep their expected values.

## Judgements

The WP0 manifest report records each call. Formatting-only edits keep the named outcomes. The layout fixture's long `cwd` is data beside the asserts; the three `assert.ok` calls are unchanged. The crowded-row status block renames the project fixture to `demo-repo` inside three matchers; `assertExceptions` requires those replacement matchers. The drop order and the messages "at 40 the branch goes first" and "then the window" stay.
