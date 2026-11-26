<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh.md">中文</a> ·
  <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a>
</p>

# HUD

One HUD for **Claude Code, Codex, pi, and Antigravity (`agy`)** on Linux/WSL inside herdr:
shared bottom bars, an opt-in project panel, and MCP tools for local role delegation
and tickets. Lightweight observation and thin execution adapters, not a workflow
engine. The main session decides every next step.

Inspired by [claude-hud](https://github.com/jarrodwatts/claude-hud).

## Quick Start

Requires **Node ≥24.0.0** (Node 24 is the tested supported line), npm, and the clients
you select. `codexH` and tab jobs need the `herdr-hud` fork; pi workers need `pi` on PATH.
Browser roles need their external **jev-*** CLIs configured.
The installer does not install/authenticate those tools. See the
[Node floor evidence](./docs/ARCHITECTURE.md#3-launch-and-installation).

Download `hud-<version>.tar.gz` from the project's
[releases](https://github.com/CartmanFatass/codex-hud/releases), then extract it
(the example uses version 0.2.0):

```sh
tar -xzf hud-0.2.0.tar.gz
cd hud-0.2.0
./install                            # core only on a fresh install
./install --with claude,pi,codex,agy  # example: core plus all four clients

# Add the printed Codex function to your shell, then launch:
codexH() { hud codex "$@"; }
codexH
```

Choose any of `claude`, `claude-mod`, `pi`, `codex`, `agy`, `browser`, and `herdr`;
core is always included. Put `agy` on PATH before selecting its extension.
Browser/herdr extensions check external prerequisites, not install them. Default installation
builds the HUD and MCP. The source archive includes tracked build dependencies,
including TypeScript, so `./install` builds without network access (`npm ci` is
only needed in a checkout without dependencies). `--skip-build` uses existing
outputs. Commands in `~/.local/bin` and client bindings point into this
checkout/extraction: **keep the extracted directory in its installed location**.
The installer never edits shell rc files.

**Moving from a checkout install:** first run that checkout's `./install --uninstall`
(with each extra `CODEX_HOME` as described in the extension guide). `$HUD_HOME`
data is kept. Then run the extracted archive's `./install --with` command above.
Do not delete unrelated colliding commands to make an installation succeed.

Restart clients after registration changes. The Claude Code and Antigravity
installers preserve an existing owner-defined non-HUD statusline.

| Client | Bar | Open the panel | Worker modes when selected as a role place |
| --- | --- | --- | --- |
| Claude Code | Statusline in ordinary `claude` | `/hud` | herdr tab or headless |
| Codex | `codexH` pane-strip bar or opt-in [native status line](./docs/reference.md#codex-native-status-line) | `/hud` | herdr tab |
| pi | Footer and editor ribbon in ordinary `pi` | `/hud` | herdr tab or headless |
| Antigravity (`agy`) | Statusline in ordinary `agy` | `hud panel` from a shell in herdr | herdr tab or headless |

The panel never opens at launch. Headless mode needs a continuable role.
A role's ordered worker places are independent of the client dispatching the job.

**Optional Claude Code mod:** use `./install --with claude,claude-mod` to add
[HUD event wake, merged notices, an owner waiting band, and owner commands](./docs/reference.md#claude-code-mod).
The `claude` extension alone does not install the mod.

```sh
hud uninstall
# Or from the retained checkout:
./install --uninstall
```

Uninstall removes owned commands/registrations, not HUD data or unrelated settings.
See [installer extensions](./install.d/README.md) for backups, optional checks and
multiple Codex homes.

### Font

[MesloLGS NF](https://github.com/romkatv/powerlevel10k-media) gives the optional
powerline glyphs consistent widths. The HUD works without it. Nothing installs it
implicitly:

```sh
bin/codex-hud-fonts --check
bin/codex-hud-fonts
```

On Linux the script installs user fonts; on WSL it only reports Windows font status
and instructions, writing nothing. Select MesloLGS NF in the terminal that draws
WSL. Font downloads use pinned hashes.

## What's on the HUD?

The bars share a field set, showing only available facts:

```text
model effort │ context %/window │ repo branch(dirty) │ quota │ ~N t/s │ notices ··· MCP n  skills n
```

Context follows the client's compaction window when known; quota belongs to that
client alone (pi uses session cost in its editor ribbon). Notices include machine-wide
HUD job counts, local load, and recent client events where available. Open approvals
are pinned first. Narrow bars shorten or drop optional fields; missing data is absent, not zero.

Settings offers two single-row styles: `line` (default) and `p10k`. Saved retired styles load as `line`.
The pi top-right ribbon stays the same in both styles and retains other extensions' statuses.

## Development workbench

The panel has three tabs:

- **Home:** explicit owner requests, STATE handoff notes and, when known, the calling pane's job load. Enter or click a Waiting entry to read it in Project.
- **Project:** progress, local tickets, working trees and docs. It reads project files, not a project-management service.
- **Control:** role chains, harness switches and resource settings.

Use `v` from Home to open **Jobs**, then Enter for **Inspector**. From Jobs or
Inspector, `n` shows native subagents when the panel is bound to a supported session.
All clients use the same standalone panel (`hud panel --here` runs in the current terminal).
Use ←/→, Tab or a click to switch tabs, `,` for Settings and `?` for Help.
Panels reload after a valid new build, keeping their place and waiting for unsaved Settings.

## Delegation

The [main-session MCP](./docs/reference.md#universal-cli-and-mcp) exposes
**hud_roster**, **hud_create**, **hud_read**, **hud_wait**, **hud_peek**, **hud_send**,
**hud_respond**, **hud_close**, **hud_land**, **hud_lease**, **hud_objective**,
**hud_schedule**, and **hud_tickets**. Clients that negotiate MCP tasks receive
settlement notices instead of `hud_wait`.

Start with `hud_roster` for roles, available places and the dispatch convention;
pass `detail: true` for accepted launch options. Roles can use the HUD's native pi worker,
CLI places (`claude`, `codex`, `agy`, `grok`), or browser places (`jev-ask`,
`jev-aistudio`, `jev-flow`). There is no automatic role chaining.
Use `hud_tickets` for the ticket method. Landing records `done` if `Owner try`
is omitted or `no`; only `yes` lands `ready-for-human`. See [hud-mcp](./packages/hud-mcp/README.md).

Jobs/reports live under `$HUD_HOME/jobs`. The on-demand watcher reaps finished jobs
and expires settled directories one day after closure on a later scan. Pi session
history stays in pi's own store; job directories contain links, and legacy real
sessions are preserved before deletion.

## Usage

```sh
codexH                       # Codex with the HUD pane-strip bar (no tmux)
codexH --model gpt-5          # pass Codex arguments
codexH resume                # Codex's resume picker
hud panel --help
hud statusline --help
```

From the checkout, `bin/codex-hud --self-check` and `--json` are available.
`--json` prints the active Codex pane snapshot.

## Configuration

Settings saves to `$HUD_HOME/hud-settings.json` (default `~/.hud`, override
`HUD_SETTINGS_PATH`). Theme, bar style, language, width, Decision API provider and
execution decision cap are current controls. Saved display settings
override environment defaults; `NO_COLOR` still wins. `s` saves; dirty navigation
asks save/discard/continue. `r` resets only the selected group, not all settings.

The display does not call a text model or the Decision API. It shows observed facts
and worker-declared summaries. The execution-side Decision API defaults to OpenAI;
keys come from the environment or private `$HUD_HOME/credentials.env`.

See **[the reference](./docs/reference.md)** for current keys, input bounds, settings,
bar styles, snapshots and environment variables; **[architecture](./docs/ARCHITECTURE.md)**
for collection, rendering and the rules for changes.

## System Support

Linux and Windows WSL are the product target, inside herdr. Native Windows is not
supported; macOS is not a qualified current product profile.

## Development

Development commands need the git repository; the release archive does not ship tests.
`npm run build` stages the HUD and MCP, then publishes to `dist/` and prunes
obsolete output. `npm run dev` is a direct TypeScript watch build: it does not
prune or take the build lock, so stop it before a regular build or cleanup.
After stopping HUD processes, use `npm run clean` to remove build outputs,
including the obsolete `packages/hud-mcp/dist/`.

```sh
npm ci
npm run build
npm run dev
npm test
npm run check:fixtures
# Only for intentional frame updates; inspect the diff:
npm run snapshots:update
```

After `npm run build` and `npm run build:test`, use these subsets for focused checks
(file names below are relative to `tests/unit/`; patterns end in `.test.mjs`):

| Command | Coverage |
| --- | --- |
| `npm run test:mcp` | `thin-mcp-*`, `hud-watch`, `cli-judge`, `job-retention*` |
| `npm run test:panel` | `panel-*`, `project-*`, `home-*`, `control-*`, `role-*`, `kept-pages`, `card-*` |
| `npm run test:fast` | `test:unit` plus `card-*`, `cleanup-views`, `cli-judge`, `home-*`, `html-board`, `kept-pages`, `model-picker*`, `panel-filter`, `panel-footers`, `panel-keys-rows`, `project-hub`, `project-layout-*`, `role-presets`, `roster-invalid`, `skills-tab`, `themes`, `waiting-settled` |

Tests use synthetic data and temporary homes. Frame tests compare terminal cells,
not font pixels. Normal tests verify, never rewrite snapshots. `CODEX_HUD_PROFILE=1`
writes stage timings under `$HUD_HOME/display/profile.log`.

Maintainers create the source archive from a clean, committed HEAD with
`npm run release` (writes `hud-<version>.tar.gz`). `npm run test:release` rehearses
that archive's offline build, isolated client registration, MCP and uninstall.
Tests and historical documents are not shipped. Earlier designs, screenshots and
[dated reviews](https://github.com/CartmanFatass/codex-hud/tree/universal-hud/docs/reviews)
remain in the repository history.

## License and credits

MIT. Inspired by Jarrod Watts' [claude-hud](https://github.com/jarrodwatts/claude-hud).
The HUD's ports are maintained here; see [third-party notices](./THIRD_PARTY_NOTICES.md).
