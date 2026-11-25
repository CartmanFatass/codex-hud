# 07: Hotfix: CLI workers start again; the invocation witness survives the owner's shell rc

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none
**Objective:** pi-worker

**What to build:** Regression from pi-worker/03 (landed a34ee9fb), 2026-11-25: every CLI worker (claude, agy, codex, grok in herdr tabs) fails at dispatch with `error: unknown option '--hud-invocation=<uuid>'` (job j04ea7f4d3cd6234f, frontend-imp on claude). Cause: `harness-cli.ts` puts the witness shim dir first in the tab's PATH via `herdr tab create --env PATH=...`, then `herdr agent start ... -- <token> <args>`; the interactive zsh reads the owner's `~/.zshrc`, which prepends `~/.local/bin` (lines 15, 119), so `claude` resolves to the real binary and the argv token reaches it. Tests used shells without an rc. Fix in two commits, first one landable alone: (1) Hotfix: never put the token in the agent's argv. Carry it in the tab env (e.g. `HUD_INVOCATION_TOKEN`) that the shim checks; the witness file's exclusive create already makes it one-use. If the shim is bypassed, the real CLI starts normally and HUD finds no witness: it refuses adoption and reports it, as the fail-closed rule says. (2) Make the shim reachable after the owner's rc without editing any owner file: e.g. start the tab shell with a HUD-owned `ZDOTDIR` whose `.zshenv`/`.zshrc` source the owner's real ones (`$HOME/.zshenv`, `$HOME/.zshrc`, keeping their behaviour) and then put the witness dir first in PATH; other shells: decide the simplest equivalent or leave them on the refusal path and say so. Tests must use a shell rc that prepends a directory containing a fake agent (the real failure shape). Out of scope: any other pi-worker/03 rule. Size: ~80 source lines, 2-3 tests.

- [ ] A CLI worker launched in a tab whose shell rc prepends the real agent's directory starts and runs; the agent's argv never contains a HUD token
- [ ] With the shim reachable, the witness is published and the supervisor adopts exactly that PID; with the shim bypassed, the job runs, adoption is refused and the reason is reported
- [ ] No owner file (~/.zshrc, ~/.zshenv, ~/.bashrc) is written
- [ ] Live try (main): dispatch one frontend-imp job on claude and one general job on agy after landing; both start and settle
- [ ] Land gate passes

## Comments
