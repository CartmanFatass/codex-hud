# E2: neutral renderer and settings environment names

This bounded E2 slice adds ten aliases to the **existing** panel and renderer.
It does not finish all E2 renaming, replace the package, migrate settings, select
a new source, or qualify a provider. Run after the ordinary build:

```sh
HUD_THEME=latte HUD_DENSITY=focus HUD_TREE_WIDTH=72 node bin/hud panel
HUD_SETTINGS_PATH='/absolute/private/settings B.json' node bin/hud panel
node bin/hud panel --help
```

## Supported names and precedence

Each neutral name below has exactly the listed legacy counterpart. If the
neutral value is not `undefined`, it wins, including empty or invalid strings.
Otherwise the legacy value is selected. Parsing happens **after** selection;
an invalid neutral value never revives a shadowed legacy value.

| Neutral name | Legacy name | Existing interpretation |
|---|---|---|
| `HUD_SETTINGS_PATH` | `CODEX_HUD_SETTINGS_PATH` | Literal settings filename; empty selects the existing `CODEX_HOME` default |
| `HUD_THEME` | `CODEX_HUD_THEME` | `terminal`, `mocha`, `latte`, `titanium`, `none`; default `terminal` |
| `HUD_DENSITY` | `CODEX_HUD_DENSITY` | `focus`, `balanced`, `full`; default `balanced` |
| `HUD_GLYPHS` | `CODEX_HUD_GLYPHS` | `glyph`, `text`, `both`; default `both` |
| `HUD_ICONS` | `CODEX_HUD_ICONS` | `unicode`, `nerd`, `emoji`, `text`; default `unicode` |
| `HUD_LOOK` | `CODEX_HUD_LOOK` | `tab`, `band`, `tile`, `frame`, `pill`; default `tab` |
| `HUD_REDUCED_MOTION` | `CODEX_HUD_REDUCED_MOTION` | Exactly `1` selects reduced motion; otherwise full |
| `HUD_CONTEXT` | `CODEX_HUD_CONTEXT` | `used`, `remaining`; default `used` |
| `HUD_TREE_WIDTH` | `CODEX_HUD_TREE_WIDTH` | Existing numeric parsing, integer 16–200; otherwise default 48 |
| `HUD_CLEAR_SCROLLBACK` | `CODEX_HUD_CLEAR_SCROLLBACK` | Exactly `1` clears scrollback on the renderer's first frame only |

Enumerated display values still trim whitespace and ignore case. Motion and
scrollback do not. Existing saved display settings retain priority over display
environment defaults. A nonempty `NO_COLOR` remains the final color override.
Tree width here describes the environment fallback; the existing saved-setting
validator is unchanged (including its special value `0`).

For example, `HUD_THEME='' CODEX_HUD_THEME=latte` uses the default theme when no
settings file exists. `HUD_SETTINGS_PATH='' CODEX_HUD_SETTINGS_PATH=/some/file`
selects the existing default settings file, not `/some/file`. A nonempty missing
selected file gives existing defaults; malformed selected JSON still reports an
error. It does not try the shadowed file. Selection/help does not create a file.
An explicit settings save uses only the selected file and retains the existing
validation, unknown-key stripping and atomic private-file replacement behavior.
Paths containing spaces are data, not shell commands.

## Identity and material boundaries

`HUD_SETTINGS_PATH` selects the current settings format, not a universal model
configuration or a new permission. UI reads/saves, the legacy material bridge's
baseline and recipient checks, and deferred model submission all use the same
allowlisted raw selector. The bridge and model use their injected environment.
Changing that effective override after capture or while queued refuses the
request/reuse. A late response cannot become an authorized reusable result.
Changing a shadowed legacy value does not change the effective selector.

`HUD_HOME` still identifies the private universal ledger home. `CODEX_HOME/hud`
still holds the existing Codex cache, and the default settings path remains
under `CODEX_HOME`. No source, run, link, recipient, or cache-home identity moves.
Existing native Codex grants do not authorize same-source delegated material or
other sources. Backend off still means no material extraction and no network.

There is no generic `HUD_*` prefix conversion. This slice adds no model endpoint,
model/key, credential, `CODEX_HOME`, session-tree, executable, profile, socket,
host, runtime-selector, or shell-layout aliases. In particular,
`HUD_BRIEF_API_KEY` and `HUD_BRIEF_MODEL` are **not** supported aliases. Shell
height/position/attach/tmux/mouse controls and Windows wrappers are unchanged.
Migration plan/receipt JSON keeps `settingsEnvironment.CODEX_HUD_SETTINGS_PATH`;
this feature does not rewrite that schema or perform migration.

## Tests and evidence scope

- `tests/unit/hud-env.test.ts`: all ten raw mappings, unknown-name rejection,
  display parsing/defaults/precedence, runtime width/settings priority,
  `NO_COLOR`, and actual renderer first/subsequent frames in isolated processes.
- `tests/unit/settings.test.ts`: selected synthetic B shadows A for read/save,
  spaces, empty/default selection, malformed/missing files, unchanged homes and
  existing settings validation. Legacy fixtures clear/restore both selectors.
- `tests/unit/b17-legacy.test.ts`: neutral off/mismatched/disabled/paused/missing
  authority, injected environment, legacy-only compatibility, shadowed values,
  deferred preflight with delayed capture, captured/queued/late-result refusal,
  same-source delegated denial, and backend-off zero material reads/network.
- `tests/unit/product-cli-routing.test.ts`: help and argument errors with missing
  or unsafe synthetic homes; no settings, ledger, or provider initialization.
- `tests/unit/runtime-package.test.mjs`: **E2 shared helper mapping** checks main
  output, optional emitted MCP output, and absence of an invented MCP file.

The implementation environment has Node 24.22.1 but no pinned TypeScript,
Prettier, or runtime dependencies. The named mapping test passes (1 test).
TypeScript feature suites, builds, formatter, visual/fixture checks, emitted
imports and real package smoke are **NOT_RUN**, not behavioral passes. The
source is a fixed-commit partial materialization, not a complete checkout.
The finite before/after diff and inventory evidence is reported separately.
Natural branch CI is not the new-feature suite unless it actually runs it.
No production capability or real-provider/host claim follows from this package.

## User-local validation checklist

Use the final test-branch commit SHA in a complete checkout on supported Node
22.13+/24 with the normal pinned dependencies. Use disposable private
`HOME`, `HUD_HOME` and `CODEX_HOME`, synthetic data, and backend off for panel
checks. Never use a real provider/account or a real settings file for this list.

1. Run `npm run build`, `npm run build:test`, `npm run build:hud-mcp` (180 s each).
2. Run the focused feature/compatibility suites (120 s):

   ```sh
   node --test dist-test/tests/unit/hud-env.test.js dist-test/tests/unit/settings.test.js dist-test/tests/unit/b17-legacy.test.js dist-test/tests/unit/materials.test.js dist-test/tests/unit/small-model.test.js dist-test/tests/unit/product-cli-routing.test.js dist-test/tests/unit/migration.test.js
   node --test --test-name-pattern='E2 shared helper mapping' tests/unit/runtime-package.test.mjs
   ```

   The new renderer and legacy-material regressions are in `hud-env.test.js` and
   `b17-legacy.test.js` above. Run `npm run test:visual` (180 s),
   `npm run format:check` (120 s), `npm run check:fixtures` (60 s), and
   `git diff --check` (10 s). Record each result separately.
3. Open the existing panel with equivalent legacy-only and neutral-only display
   values. Check theme, density, icons, width and `NO_COLOR`. Keep the same
   synthetic source and data; do not enable a model backend.
4. Set legacy settings A and neutral settings B, then explicitly save one
   harmless display setting. Only B changes. Check empty/conflicting values and
   malformed B without fallback to A. Help must work without creating a home.
5. Track the new helper before a normal build/archive. Verify consumer imports
   resolve to `dist/utils/hud-env.js`, and to
   `packages/hud-mcp/dist/src/utils/hud-env.js` **when that MCP output is emitted**.
   Inspect the fresh ordinary package manifest and run help/panel smoke in the
   disposable environment. A mapping test is not evidence of compilation,
   packaging, installation, or capability qualification.

Installer apply/restore, real Herdr/provider qualification, visible/local-manager
close, reopening and paused chat UI remain separate work. No integration merge,
default replacement or production capability promotion is part of this slice.
