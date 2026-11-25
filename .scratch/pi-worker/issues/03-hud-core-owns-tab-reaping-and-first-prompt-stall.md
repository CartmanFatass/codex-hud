# 03: HUD core owns tab reaping and first-prompt stall recovery

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** `.scratch/pi-worker/spec.md` slice 3. Port `pi-role-reap` faithfully into `src/` plus a `hud-reap` bin (same ownership checks: exact pid + start time, protected orchestrator/foreign panes, tab names, stop marker, idle `/quit` + grace, `--after-pid`; keep the stderr text the watcher parses; no pi-roles ledger writes, R1) and switch its three callers (`operations.ts`, `watch-runtime.ts`, `panel-pane.ts`) — it also reaps CLI tab workers. Port `prompt-stall.mjs` to an in-process function used by `harness-pi.ts` (at most one Enter, only for the just-started bound pane with the exact prompt in an idle editor). This code kills processes: ask for a separate reviewer pass in your report.

- [ ] Ported reap tests (protection, renamed tab refusal, idle vs working, pid reuse refusal, --after-pid) and prompt-stall tests; existing watcher-reap, panel and close suites pass with updated command assertions.
- [ ] Land gate passes.

## Comments
