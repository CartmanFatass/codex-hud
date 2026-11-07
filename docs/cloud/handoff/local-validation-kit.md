# Local validation kit

Isolated launchers for the real Codex, Claude and Pi clients with hud-mcp attached for one session. They do not edit `~/.claude.json`, `~/.claude/settings*.json`, `~/.codex/` (including `config.toml`) or `~/.pi/agent/`.

Build first, from the checkout:

```sh
npm run build && npm run build:hud-mcp
node scripts/local-validation/setup-home.mjs
```

The default home is `tmp/lv-home` under the current directory (or `HUD_HOME`). It is mode `0700`. Pass `--force` to replace generated files whose content changed, including after `LV_CLAUDE_MODEL` or `LV_CODEX_HOME` changes. Switching Codex homes requires `setup-home.mjs --force` because the generated files change.

Codex tests use the owner's `codex2` account. `LV_CODEX_HOME`, when set, is that directory; otherwise it is `$HOME/.codex`. `setup-home.mjs` (`codexAccountHome`) and `codex.sh` share that default. The directory must already exist. The kit does not create or modify it. Setup stores its realpath in `native.json` as the Codex profile's `env.CODEX_HOME` and in `delegate.json` as the Codex `source.root`.

Setup loads `hookProfileFingerprint` and `makeHookSettings` from `packages/hud-mcp/dist/packages/hud-mcp/src/hook/record.js`. If that built file is missing, setup stops and names `npm run build:hud-mcp`. The Claude PreToolUse matcher is the one `makeHookSettings` writes, so it follows the tool names exported by the built server.

## What setup writes

`native.json` is the child-backend file. `delegate.json` is caller-source registration. Profile names match the backend ids `codex`, `claude` and `pi`.

| Profile | Child model | Notes |
| --- | --- | --- |
| codex | `options.model` is `gpt-6-luna` | Reasoning effort is not a native.json field. `args` passes `-c model_reasoning_effort="medium"` and the same model, then `app-server`. `env.CODEX_HOME` is the realpath of `LV_CODEX_HOME` or `$HOME/.codex`. `executable` is `codex` on `PATH`. |
| claude | `options.model` is `claude-haiku-5-5`, or `LV_CLAUDE_MODEL` | The SDK options used here have `model` and no effort field. |
| pi | installed `pi`, no model override | |

`delegate.json` points Codex at the realpath of `LV_CODEX_HOME` or `$HOME/.codex` and Claude at `CLAUDE_CONFIG_DIR` or `$HOME/.claude`. Those directories must already exist. Pi's source root is `$HUD_HOME/pi-sessions`, because this Pi build erases `/proc` argv and the extension channel carries the root. The Pi profile sets `callSource.kind` to `pi_extension_v1`. Claude sets `callSource.kind` to `claude_pre_tool_use_v1` and setup writes a private hook under `$HUD_HOME/launch/`. The default transcript path does not authorize calls.

## Launchers

Run them from a shell. They call setup, then the real client. They are interactive; the discovery smoke does not start them.

- `scripts/local-validation/codex.sh` follows the zsh `codex2` function: `CODEX_HOME` is `LV_CODEX_HOME` or `$HOME/.codex`, then `$HOME/codex/codex-hud/bin/codex-with-herdr-context` and `$HOME/.local/bin/codex`. The parent session is `-m gpt-6-luna` with `-c model_reasoning_effort="medium"`. hud-mcp is attached only by `-c mcp_servers.hud.*` for this process. Codex does not pass the shell environment into a stdio MCP server, so `HUD_HOME` and `HUD_MCP_PROFILE=codex` are in that table.
- `scripts/local-validation/claude.sh` runs `claude --mcp-config <kit file> --strict-mcp-config --settings <kit hook file> --model <LV_CLAUDE_MODEL or claude-haiku-5-5>`. `--settings` adds the PreToolUse hook; it is not a copy of the user's settings file.
- `scripts/local-validation/pi.sh` runs `pi --session-dir <kit sessions> --no-extensions --no-mcp -e <checkout>/extensions/pi/hud-delegate.ts -e <checkout>/integrations/pi/hud-wake.ts`. Each extension is loaded once. `--session-dir` stays the first Pi argument. The process environment has `HUD_HOME` and `HUD_MCP_PROFILE=pi`. Pi's own MCP config is not used.

Extra arguments are appended. `pi.sh` rejects a second session directory or extension flag.

## Discovery smoke

```sh
node scripts/local-validation/smoke-discovery.mjs
```

For Codex and Claude this speaks MCP stdio to `packages/hud-mcp/bin/hud-mcp.mjs` with the environment that launcher would give the server, then checks `tools/list` for `managed_*` and `jev_*` and no `delegate_*`. The Claude case also checks that the PreToolUse matcher in the generated `claude.settings.json` matches every name in that `tools/list` result. It does not call `managed_create`, so the detached native host is not started. The Pi profile refuses to serve until the extension's private fd 3 hello arrives, so the Pi case opens that pipe from a short-lived parent and does not start the `pi` binary.

`--with-model` is optional and is not part of the default check. It runs one short headless prompt each: `codex exec` (luna, medium), `claude -p`, and `pi -p`.
