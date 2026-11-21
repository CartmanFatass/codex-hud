# 03: Verify asynchronous worker dispatch from the pi main session

**Status:** done (accepted by the owner; see STATE ledger)
**Blocked by:** none

**What to demonstrate:** A pi main session dispatches an available HUD role, receives the job handle after launch (not after the report), and continues independent work. The role is data: sonic is an example, not a dedicated worker API. Reuse `hud_create`, native watch, `hud_respond` and `hud_read`; do not expand nested-worker permissions.

- [ ] Use a non-sonic role (e.g. `imp`). Distinguish launch latency from waiting for settlement. Show the caller doing unrelated work before the report exists, without a foreground wait or status polling.
- [ ] A question or report-ready event reaches the correct main session at the supported model boundary or wakes it when idle; no editor input or automatic report consumption. Collect the result explicitly.
- [ ] Record which portions were demonstrated by a synthetic fixture, isolated checks or a live session; do not treat a worker-side helper test as evidence for the main-session path.

## Comments

Use the matching journey evidence from `hud-mcp-lean` and the monitor checks from 01; do not dispatch a second implementation of the same path. The earlier worker-to-sonic prototype was paused and is not an integration candidate for this requirement.
