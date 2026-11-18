# 04: Native silent event wake for pi main sessions and MCP watcher_alive status

**Status:** ready-for-agent
**Blocked by:** 01

**What to build:** `docs/spec.md` §2.1 & `.scratch/mcp-next/spec.md` §4. Deliver async worker questions and settlements natively into pi main sessions without typing into the user's editor draft, and surface `watcher_alive` in MCP responses.

- [ ] In `packages/hud-mcp/src/thin-main.ts`, include `watcher_alive: boolean` (via `watching(callerPane, hudHome)` from `hud-notify.mjs`) on `hud_roster` and `hud_create` responses when `callerPane` is set, and remove the Claude-only `hint` when `watcher_alive` is already true.
- [ ] In the pi HUD package (`src/harness/pi/`), start a session-bound pane watcher when `HERDR_PANE_ID` is present and the session is not a HUD worker (`!env.HUD_JOB_DIR`): write `$HUD_HOME/watchers/<pane>.pid` (so `hud-notify.mjs` suppresses typed fallback) and watch `$HUD_HOME/jobs` + `tries.jsonl` for actionable events matching `watchCommand`'s `actionable()` rules.
- [ ] Deliver actionable lines to the active pi session via `pi.sendMessage({ customType: 'hud-watch', content, display: true }, { deliverAs: 'followUp', triggerTurn: true })` (extend `PiPackageAPI` structural type accordingly), cleaning up the watcher and PID file on `fence()` / `session_shutdown`.
- [ ] Add unit tests verifying pi native delivery, clean shutdown/fence unbinding, `hud-notify` suppression while active, and `watcher_alive` in MCP responses.

## Comments
