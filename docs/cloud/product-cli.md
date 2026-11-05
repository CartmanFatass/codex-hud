# Explicit product entrypoints

After `npm run build`, use `node bin/hud --help`. Package metadata also exposes
`hud`, `hud-run`, `codex-hud`, and `hud-statusline`; building does not install them
or change any user settings. Existing launch, panel and export defaults remain.

## Claude stdin statusline

`node bin/hud statusline --width 80` and `node bin/hud-statusline --width 80`
read the same stdin JSON through the same renderer. They show native supplied
model/context and estimated session USD, not invoice cost. No delegation second
line or fallback reader is added. The `hud` wrapper requires Node 22.13+ (22.x)
or Node 24+; Node 23 is unsupported.

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
restores the native footer in that session. Its default HUD summary is unavailable.
No settings or persistent extension registration is performed by HUD.

`node bin/hud panel` remains the existing delegation panel. A separately developed
unified workbench is not silently substituted or claimed available through this
routing slice. Synthetic workbench scripts remain explicit development tools.
