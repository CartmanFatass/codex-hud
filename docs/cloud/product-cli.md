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

The existing foreground launcher already passes native arguments unchanged:

```sh
node bin/hud pi launch --executable /absolute/path/to/pi -- -e /absolute/path/to/codex-hud/extensions/pi/hud-footer.ts
```

This explicitly loads the [version-pinned Pi TUI footer](pi-footer.md); it is not
managed delegation or a claim of live-provider verification. `/hud-footer off`
restores the native footer in that session. The shipped footer can read the
shared committed summary when explicit `HUD_HOME` and `HUD_PI_SOURCE_ROOT` match
the current native Pi identity/location and an existing matching cache is
available. Missing or invalid evidence leaves native footer facts intact; shared
HUD facts remain partial direct-child observations. See the [footer's shared-cache
requirements](pi-footer.md#shared-committed-hud-summary). No settings or persistent
extension registration is performed by HUD.

`node bin/hud panel` remains the existing delegation panel. A separately developed
unified workbench is not silently substituted or claimed available through this
routing slice. Synthetic workbench scripts remain explicit development tools.
