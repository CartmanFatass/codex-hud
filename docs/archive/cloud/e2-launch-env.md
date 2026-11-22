# E2: neutral Bash launch and layout controls

This slice extends the existing `hud codex` → `codex-hud` Bash wrapper. It is
separate from the ten renderer/settings aliases described in
[e2-hud-env.md](e2-hud-env.md). It does not complete all E2 renaming or change a
package name, source, credential, home, model permission or default launch mode.

## Supported controls

The following ten neutral names select the corresponding `CODEX_HUD_` value:

| Neutral name | Existing behavior after raw selection |
|---|---|
| `HUD_POSITION` | `top` places the compact pane above; otherwise below |
| `HUD_HEIGHT` | Default 1; integer input is clamped to the existing terminal limits; malformed input errors |
| `HUD_HEIGHT_AUTO` | Existing boolean parser; default off |
| `HUD_HEIGHT_MIN` | Existing adaptive-height lower bound; default base height |
| `HUD_HEIGHT_MAX` | Existing adaptive-height upper bound; default 12 |
| `HUD_STATUSLINE` | Existing boolean parser; empty uses the saved preference, then default on |
| `HUD_TREE` | Existing boolean parser; default off |
| `HUD_AUTO_ATTACH` | Existing boolean parser; default off |
| `HUD_ALTERNATE_SCREEN` | Existing boolean parser; default off |
| `HUD_MOUSE` | Existing boolean parser; default on |

A neutral variable wins **when present**, including empty or invalid strings.
Only an absent neutral variable falls back to its legacy counterpart. Existing
validation, errors, defaults and settings fallback run after selection; they do
not revive a shadowed legacy value. The boolean parser accepts `1/0`,
`true/false`, `on/off` and `yes/no`, ignoring case as before.

```sh
HUD_POSITION=top HUD_HEIGHT=3 hud codex
HUD_TREE=1 HUD_TREE_WIDTH=70 codex-hud
HUD_AUTO_ATTACH=1 codex-hud --new-session
HUD_HEIGHT='' CODEX_HUD_HEIGHT=5 codex-hud
```

The last example uses the existing default height, not 5. A malformed neutral
height still reports the existing `CODEX_HUD_HEIGHT` validation error. An empty
neutral statusline control still allows the saved statusline preference.
`--attach` and `--new-session` retain their existing precedence (including
validation before applying the flags). `--` still stops wrapper flag parsing.
The deprecated `CODEX_HUD_NO_ATTACH` keeps its old behavior; there is deliberately
no `HUD_NO_ATTACH` alias. Prefer `--new-session`.

## Shell width and tmux boundaries

`HUD_TREE_WIDTH` was already a renderer alias. It now also selects the initial
shell split and the direct `codex-hud-toggle` split. The shell retains its
existing policy: positive digit strings request that width; other values use
48; the split is bounded below and against the window width, leaving the
existing main-pane allowance. The requested width (or 0 for automatic sizing)
is passed as **both** `HUD_TREE_WIDTH` and `CODEX_HUD_TREE_WIDTH` in the generated
panel command. Renderer/settings validation remains unchanged.

New tmux sessions receive only these two width selectors through quoted argv
`new-session -e` entries. Both carry the effective raw selection. Explicit empty
entries prevent stale server values from reappearing when the caller supplied
no width or an empty neutral width. No global tmux environment is changed. The
later toggle therefore starts with the launcher's selection instead of a
previous client's width. A direct toggle invocation can still supply its own
width selectors. This does not retroactively reconfigure an already running
session when the caller edits their shell environment.

The resize helper normalizes only its three environment fallbacks:
`HUD_HEIGHT_AUTO`, `HUD_HEIGHT_MIN`, `HUD_HEIGHT_MAX`. Nonempty saved
`@codex_hud_*` session policy still wins; invalid bounds, manual drag and
copy-mode/focus guards keep their old behavior. The main wrapper captures
incoming height and position before reusing those variable names internally.

There is no generic prefix conversion. Session metadata, APC commands,
locks, homes, executable selectors, Herdr context, root input bindings and the
ten earlier TypeScript aliases are not renamed. Same-directory/different-home
selection and stored v2 `--json` output retain their existing behavior.

## Evidence and limits

`tests/unit/hud-launch-env.test.mjs` runs byte-identical shell entrypoints and
unchanged key helpers in disposable private installation layouts. It uses Node
built-ins, Bash and ordinary Linux shell utilities, a closed fake PATH, inert
build-presence markers and a finite fake tmux protocol. Fake npm, build,
provider and unexpected operations fail; no renderer module is loaded. The
suite records argv, parses synthetic session metadata, replays generated panel
commands only into a capture-only fake Node, and bounds/reaps each owned process
group. Optional `HUD_LAUNCH_ENV_EVIDENCE_DIR` records synthetic captures outside
the source tree.

Coverage includes all ten raw selection matrices; empty/conflicting/malformed
and shell-control strings; flags/deprecation/unknown names; statusline settings
fallback; launch/direct-toggle widths and stale server overlays; resize saved
policy and focus guards; unchanged keys/APC tags; home-scoped attach and v2 JSON
success/error behavior. This is Linux/Bash simulated process evidence, **not**
live tmux, renderer, provider, packaging or cross-platform qualification.
Native Windows/PowerShell alias expansion remains later work. See the
[handoff and user-local checklist](handoff/e2-launch-env.md) for actual outcomes
and remaining validation.
