# 01: Workers carry a marker and cannot dispatch through the MCP

**Status:** done (e19d45ac); live check passed 2026-11-17 (Claude worker)
**Blocked by:** none

**What to build:** `.scratch/worker-unify/spec.md` decision 2 and the "Worker marker" and "Refusal" design. A Claude
or Codex worker sees the `hud-delegate` skill and the HUD MCP; today nothing stops it from starting another role.

- [ ] Every worker tab the HUD opens (pi `dispatchPi`, CLI `dispatchCli`, browser `dispatchBro` in
      `packages/hud-mcp/src/thin-main.ts`) is created with herdr `tab create --env HUD_JOB_DIR=<job dir>`.
- [ ] With `HUD_JOB_DIR` set in the MCP's environment, `hud_create`, `hud_send`, `hud_close` and `hud_respond` return
      `worker_cannot_dispatch` before any herdr call, tab or quota mark; `hud_roster` and `hud_read` still answer.
- [ ] `install.d/codex.sh` adds `HUD_JOB_DIR` to the HUD MCP entry's `env_vars`; rerunning the installer on an
      existing entry updates it; uninstall unchanged.
- [ ] Tests (temp HOME/HUD_HOME/CODEX_HOME via `tmp/env.sh`): each dispatch path passes the `--env`; each refused tool
      refuses with the marker and works without it; the Codex installer writes the forwarded variable.
- [ ] Live check by the main session after landing (not the imp): a real Claude worker and a real Codex worker each
      try `hud_create` and get `worker_cannot_dispatch`.

## Comments
