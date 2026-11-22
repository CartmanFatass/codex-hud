# Explicit product entrypoints

After `npm run build`, use `node bin/hud --help`. Package metadata also exposes
`hud`, `hud-run`, `codex-hud`, and `hud-statusline`; building does not install them
or change any user settings. Existing launch, panel and export defaults remain.

## Claude stdin statusline

`node bin/hud statusline --width 80` and `node bin/hud-statusline --width 80`
read the same stdin JSON through the same renderer. They show native supplied
model/context and estimated session USD, not invoice cost, on line one. With an
explicit `--source` or `CLAUDE_CONFIG_DIR`, they first try the shared committed
delegation summary, then a bounded read-only direct-parent index fallback. An
optional second line shows partial direct-child facts, never a full-tree or
model-generated summary. Unavailable evidence leaves line one intact. See the
[summary and fallback boundaries](../statusline/delegation-summary.md).
The `hud` wrapper requires Node 22.13+ (22.x) or Node 24+; Node 23 is unsupported.

Explicit Linux settings workflow, with an absolute private plan path:

```sh
node bin/hud statusline settings preview > /absolute/private/plan.json
node bin/hud statusline settings apply --plan /absolute/private/plan.json
node bin/hud statusline settings restore --backup /absolute/path/from/apply.json
```

Review the plan before apply. The last argument means the backup path returned
in apply's JSON, not the captured stdout file. The installed command targets the
absolute dedicated `bin/hud-statusline`, independent of shell PATH and cwd.
Read [settings safety and recovery](../statusline/product-settings.md) first:
Linux pinned-directory protection, private inputs, current-hash conflict checks,
backups, noncooperating-writer races and uncertain crash outcomes still apply.
No install or restore is run implicitly by help, render, build or packaging.

## Pi footer and panel

The historical standalone `hud-footer.ts` entry is retired. Use the explicitly
activated [ordinary pi package](../reference.md#pi-package-activation-r6a-a5),
which now owns the p10k-style composer/footer and includes the passive delegation
segment. `/hud footer off` restores pi's default editor/footer in the current session;
`/hud on|off|toggle` control only the panel.
Back up/deselect p10k-footer before activation, as described in the package
runbook. No footer setting import, extension discovery change or persistent
registration happens implicitly. This is not a claim of live-provider validation.

`node bin/hud panel` remains the existing delegation panel. A separately developed
unified workbench is not silently substituted or claimed available through this
routing slice. Synthetic workbench scripts remain explicit development tools.

## Neutral panel configuration (bounded E2)

The existing panel and renderer accept `HUD_SETTINGS_PATH`, `HUD_THEME`,
`HUD_DENSITY`, `HUD_GLYPHS`, `HUD_ICONS`, `HUD_LOOK`, `HUD_REDUCED_MOTION`,
`HUD_CONTEXT`, `HUD_TREE_WIDTH`, and `HUD_CLEAR_SCROLLBACK`. Each aliases its
`CODEX_HUD_*` counterpart. A present neutral value wins even when empty or
invalid; saved display settings retain priority and `NO_COLOR` remains final.

```sh
HUD_THEME=latte HUD_DENSITY=focus node bin/hud panel
HUD_SETTINGS_PATH='/absolute/private/settings B.json' node bin/hud panel
```

An empty selected settings override uses the existing `CODEX_HOME` default.
Selecting a file does not migrate it or grant new model/source permissions.
`HUD_HOME`, source identities, model credentials and shell layout are unchanged.
See [the ten supported aliases, safety boundaries and local checks](e2-hud-env.md).
Migration plan/receipt fields retain their legacy names.
