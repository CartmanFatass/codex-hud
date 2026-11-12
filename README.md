<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh.md">中文</a> ·
  <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a>
</p>

# HUD

One HUD for **Claude Code, Codex and pi**, on Linux/WSL inside herdr:
shared bottom status lines, an opt-in Home/Project panel, and six MCP tools for
local role delegation. Lightweight observation and thin execution adapters, not a
workflow engine. The main session decides every next step.

Inspired by [claude-hud](https://github.com/jarrodwatts/claude-hud).

## Quick Start

Requires **Node 22.x ≥22.13.0 or ≥24.0.0** (23 is unsupported), npm, and the clients
you select. Codex's bar also needs tmux. Jobs need herdr, pi and separately installed
**pi-roles** on PATH; browser roles need their external **jev-*** CLIs configured.
The installer does not install/authenticate those tools. See the
[Node floor evidence](./docs/ARCHITECTURE.md#3-launch-and-installation).

```sh
git clone https://github.com/CartmanFatass/codex-hud.git
cd codex-hud
./install --with claude,pi,codex

# Add the printed Codex function to your shell, then launch:
codexH() { hud codex "$@"; }
codexH
```

Choose any of `claude,pi,codex,browser,herdr`; core is always included. Browser/herdr
extensions check external prerequisites, not install them. Default installation
builds the HUD and MCP (`npm ci` if dependencies are absent); `--skip-build` uses
existing outputs. Commands in `~/.local/bin` and client bindings point into this
checkout/extraction: **keep that directory**. The installer never edits shell rc files.

Ordinary `claude` uses the HUD statusline; an existing owner-defined non-HUD
statusline is preserved. Ordinary `pi` loads the HUD footer. `codexH` starts Codex
with its tmux bar. Only the side panel is opt-in: `/hud` in Claude/pi, F12 in Codex;
it never opens at launch. Restart clients after registration changes.

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

The three clients share one field set, showing only available facts:

```text
model effort │ context %/window │ repo branch(dirty) │ quota │ notices ··· MCP n  skills n
```

Context follows the client's compaction window when known; quota belongs to that
client alone (pi uses session cost in its editor ribbon). Agent/job start, completion,
failure and Claude skill-load events stay for three minutes. Open questions/approvals
are pinned. Narrow bars shorten/drop optional fields; missing data is absent, not zero.
No turn clock, output rate, task count or tool-at-work line remains.

Settings offers line, p10k, Gauge Plates, Tide, Micro Glyphs, Stacked, Headline and
Triptych. Stacked is two rows in Claude/pi; Codex's one-row pane falls back to line.
The pi top-right ribbon follows the look and retains other extensions' statuses.

## Development workbench

The panel has **Home** and **Project** tabs:

- **Home:** questions that need you, package lanes with compact job cards, native
  Claude/Codex subagent lanes, and decisions. Enter expands in place, `o` opens a
  file, `v` inspects, `a` reveals older items. Settled cards fold after five minutes
  and hide after fifteen by default; a newly opened panel excludes already-settled
  HUD jobs. Model text is optional and display-only.
- **Project:** STATE/spec progress, local to-tickets issues, working trees, docs and
  the effective roles/convention/key availability. It reads project files, not a
  project-management service, and never changes their state.
- **Settings, Help, Inspector and Changes:** settings edit a draft, Inspector opens
  workflow files/transcripts, Changes is only a Git/worktree summary. There is no
  Timeline, agent-log page, layout selector, picture or status-card footer.

Codex uses F12 to toggle the panel, Shift-F12 to focus it, and the prefix `Ctrl+\`
then a key for commands (`1` Home, `2` Project, `3` Changes, `,` Settings, `?` Help).
Ordinary input forwards to Codex outside modal pages. Claude/pi use `/hud`;
`hud panel --here` runs in the current terminal. Panels reload after a valid new
build, keeping their place and waiting for unsaved Settings.

## Delegation

The MCP exposes **hud_roster**, **hud_create**, **hud_read**, **hud_send**,
**hud_respond**, **hud_close**. Start with the roster for roles, model assignments,
accepted launch options and the dispatch convention. Pi roles use external pi-roles
and herdr; browser jobs use `jev-ask`, `jev-aistudio` or `jev-flow`. There is no
automatic role chaining. See [hud-mcp](./packages/hud-mcp/README.md).

Jobs/reports live under `$HUD_HOME/jobs`. The on-demand watcher reaps finished jobs
and expires settled directories one day after closure on a later scan. Pi session
history stays in pi's own store; job directories contain links, and legacy real
sessions are preserved before deletion.

## Usage

```sh
codexH                       # Codex with the HUD tmux bar
codexH --model gpt-5          # pass Codex arguments
codexH resume                # Codex's resume picker
hud panel --help
hud statusline --help
```

From the checkout, `bin/codex-hud --list`, `--attach`, `--kill`, `--self-check`
and `--json` are available. `--kill` closes this directory's HUD sessions;
`--json` prints the active Codex snapshot.

## Configuration

Settings saves to `$HUD_HOME/hud-settings.json` (default `~/.hud`, override
`HUD_SETTINGS_PATH`). Theme, bar style, language, width, card lifetimes, one model
master, model/call caps and Decision API are current controls. Saved display settings
override environment defaults; `NO_COLOR` still wins. `s` saves; dirty navigation
asks save/discard/continue. `r` resets only the selected group, not all settings.

Optional model text reads public job/native material and writes display overlays,
never instructions for workers. Keys come from the environment or private
`$HUD_HOME/credentials.env`; the chat endpoint receives only its matching provider
key. The separate Decision API defaults to OpenAI. Models off sends no requests.

See **[the reference](./docs/reference.md)** for current keys, input bounds, settings,
bar styles, snapshots and environment variables; **[architecture](./docs/ARCHITECTURE.md)**
for collection, rendering and the rules for changes.

## System Support

Linux and Windows WSL are the product target, inside herdr. Native Windows is not
supported; macOS is not a qualified current product profile.

## Development

```sh
npm ci
npm run build
npm run build:hud-mcp
npm run dev
npm test
npm run check:fixtures
# Only for intentional frame updates; inspect the diff:
npm run snapshots:update
```

Tests use synthetic data and temporary homes. Frame tests compare terminal cells,
not font pixels. Normal tests verify, never rewrite snapshots. `CODEX_HUD_PROFILE=1`
writes stage timings under `$HUD_HOME/display/profile.log`.

Earlier designs and screenshots remain in git history and [dated reviews](./docs/reviews/).

## License and credits

MIT. Inspired by Jarrod Watts' [claude-hud](https://github.com/jarrodwatts/claude-hud).
The HUD's ports are maintained here; see [third-party notices](./THIRD_PARTY_NOTICES.md).
